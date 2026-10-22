"use strict";
/**
 * 原版更新提示（2026-10-22，个人定制版）。
 *
 * 用户：「原版的自动更新去掉，只做原版存在更新提示即可，主要还是使用自己的定制版本。」
 *
 * 以前的 updater.js 用 electron-updater 在后台下载安装包、静默运行 NSIS 安装程序。安装程序升级时会先跑旧版的
 * 卸载程序，把整个安装目录搬空再删掉——这台电脑的安装目录里还放着源码和运维文件，2026-10-21 差点被清空。定制版
 * 也不该被别的版本自动覆盖。所以这里只做一件事：定期看原版（build-config.json 的 upstreamRepo，默认
 * ChisaAlter/ChisaBot）在 GitHub 上的最新正式发布，版本号比定制版所基于的原版（upstreamBase）新，就提示
 * 「原版有新版本」，给出发布页链接。不下载、不安装，要不要同步由人决定。
 *
 * 对外的形状和旧 updater 一样（state / supported / check / schedule / stop / install / installOnQuit），
 * 网页「本机」标签、托盘和 IPC 不用分两套；`install()` 改成打开原版的发布页，`installOnQuit()` 永远什么都不做。
 */

const FIRST_CHECK_MS = 30 * 1000;
const INTERVAL_MS = 12 * 60 * 60 * 1000;

/** 「v0.1.57」「0.1.57」→ [0, 1, 57]；读不出来是 null。 */
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

/** a > b → 1，a < b → -1，相等或读不出来 → 0。 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function cleanMessage(error) {
  const text = error && error.message ? String(error.message) : String(error || "未知错误");
  const first = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|net::ERR_/i.test(first)) return "连不上 GitHub，请检查网络。";
  if (/\b403\b|rate limit/i.test(first)) return "GitHub 暂时限制了查询次数，稍后会再试。";
  if (/\b404\b/.test(first)) return "原版仓库还没有正式发布。";
  return first.slice(0, 160);
}

async function defaultFetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ChisaBot-PC-upstream-notice" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
  return response.json();
}

function createUpstreamNotice({
  repo,
  base,
  currentVersion,
  fetchJson = defaultFetchJson,
  getEnabled = () => true,
  onState,
  onNewVersion,
  openUrl,
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
  now = () => new Date(),
}) {
  const supported = /^[\w.-]+\/[\w.-]+$/.test(String(repo || "")) && Boolean(parseVersion(base));
  const state = { supported, status: "idle", upstream: true, repo: repo || "", base: base || "", current: currentVersion || "" };
  let firstTimer = null;
  let interval = null;
  let checking = null;

  function set(patch) {
    Object.assign(state, patch);
    if (state.status !== "error") delete state.error;
    if (state.status !== "available") {
      delete state.releaseUrl;
      delete state.publishedAt;
    }
    onState?.({ ...state });
  }

  async function check() {
    if (!supported) return { ...state };
    if (checking) return checking;
    checking = (async () => {
      set({ status: "checking" });
      try {
        const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
        const version = String(release?.tag_name || "").replace(/^v/i, "");
        if (!parseVersion(version)) throw new Error("原版的最新发布没有可读的版本号");
        if (compareVersions(version, base) > 0) {
          const releaseUrl = typeof release?.html_url === "string" && /^https:\/\/github\.com\//.test(release.html_url) ? release.html_url : `https://github.com/${repo}/releases/latest`;
          set({ status: "available", version, releaseUrl, publishedAt: release?.published_at || undefined, checkedAt: now().toISOString() });
          onNewVersion?.(version, releaseUrl);
        } else {
          set({ status: "none", version, checkedAt: now().toISOString() });
        }
      } catch (error) {
        set({ status: "error", error: cleanMessage(error), checkedAt: now().toISOString() });
      } finally {
        checking = null;
      }
      return { ...state };
    })();
    return checking;
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (interval) timers.clearInterval(interval);
    firstTimer = null;
    interval = null;
  }

  function schedule() {
    stop();
    if (!supported || !getEnabled()) return;
    firstTimer = timers.setTimeout(() => void check(), FIRST_CHECK_MS);
    interval = timers.setInterval(() => {
      if (getEnabled()) void check();
    }, INTERVAL_MS);
  }

  /** 「查看原版发布」：打开发布页。没有新版本时打开原版的发布列表。不下载、不安装。 */
  function install() {
    if (!supported) return false;
    openUrl?.(state.status === "available" && state.releaseUrl ? state.releaseUrl : `https://github.com/${repo}/releases`);
    return true;
  }

  return {
    get state() {
      return { ...state };
    },
    supported,
    feedUrl: "",
    check,
    schedule,
    stop,
    install,
    installOnQuit: () => false,
  };
}

module.exports = { createUpstreamNotice, parseVersion, compareVersions, cleanMessage, FIRST_CHECK_MS, INTERVAL_MS };

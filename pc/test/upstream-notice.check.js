"use strict";
/* 原版更新提示（src/upstream-notice.js，2026-10-22）：只提示原版的新发布，不下载、不安装。 */
const test = require("node:test");
const assert = require("node:assert");
const { createUpstreamNotice, compareVersions, parseVersion } = require("../src/upstream-notice");

const fakeTimers = () => {
  const calls = [];
  return { calls, setTimeout: (fn, ms) => (calls.push(["timeout", ms]), 1), setInterval: (fn, ms) => (calls.push(["interval", ms]), 2), clearTimeout() {}, clearInterval() {} };
};

test("versions compare numerically, v prefix optional", () => {
  assert.deepStrictEqual(parseVersion("v0.1.57"), [0, 1, 57]);
  assert.strictEqual(compareVersions("0.1.57", "0.1.55"), 1);
  assert.strictEqual(compareVersions("v0.1.9", "0.1.10"), -1);
  assert.strictEqual(compareVersions("0.1.55", "v0.1.55"), 0);
  assert.strictEqual(parseVersion("latest"), null);
});

test("a newer upstream release is announced with its page, nothing is downloaded", async () => {
  const seen = [];
  const opened = [];
  const notice = createUpstreamNotice({
    repo: "ChisaAlter/ChisaBot",
    base: "0.1.55",
    currentVersion: "0.1.56",
    fetchJson: async (url) => {
      seen.push(url);
      return { tag_name: "v0.1.57", html_url: "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.57", published_at: "2026-10-22T02:35:15Z" };
    },
    onNewVersion: (version) => seen.push(`new ${version}`),
    openUrl: (url) => opened.push(url),
  });
  const state = await notice.check();
  assert.strictEqual(state.status, "available");
  assert.strictEqual(state.version, "0.1.57");
  assert.strictEqual(state.upstream, true);
  assert.deepStrictEqual(seen, ["https://api.github.com/repos/ChisaAlter/ChisaBot/releases/latest", "new 0.1.57"]);
  assert.strictEqual(notice.install(), true);
  assert.deepStrictEqual(opened, ["https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.57"]);
  assert.strictEqual(notice.installOnQuit(), false);
});

test("same or older upstream: up to date, no announcement", async () => {
  let announced = false;
  const notice = createUpstreamNotice({ repo: "ChisaAlter/ChisaBot", base: "0.1.55", fetchJson: async () => ({ tag_name: "v0.1.55" }), onNewVersion: () => (announced = true) });
  assert.strictEqual((await notice.check()).status, "none");
  assert.strictEqual(announced, false);
});

test("network trouble is an error state in Chinese, never a crash", async () => {
  const notice = createUpstreamNotice({ repo: "ChisaAlter/ChisaBot", base: "0.1.55", fetchJson: async () => { throw new Error("fetch failed"); } });
  const state = await notice.check();
  assert.strictEqual(state.status, "error");
  assert.strictEqual(state.error, "连不上 GitHub，请检查网络。");
});

test("an off switch or a missing upstream schedules nothing", () => {
  const t1 = fakeTimers();
  createUpstreamNotice({ repo: "ChisaAlter/ChisaBot", base: "0.1.55", getEnabled: () => false, timers: t1 }).schedule();
  assert.deepStrictEqual(t1.calls, []);
  const t2 = fakeTimers();
  const none = createUpstreamNotice({ repo: "", base: "", timers: t2 });
  none.schedule();
  assert.strictEqual(none.supported, false);
  assert.deepStrictEqual(t2.calls, []);
  const t3 = fakeTimers();
  createUpstreamNotice({ repo: "ChisaAlter/ChisaBot", base: "0.1.55", timers: t3 }).schedule();
  assert.deepStrictEqual(t3.calls, [["timeout", 30000], ["interval", 43200000]]);
});

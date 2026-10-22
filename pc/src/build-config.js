"use strict";
/**
 * 构建期默认值（src/build-config.json，CI 打包前写入；仓库里是空的 = 通用版）。
 *  - serverUrl：设置向导里预填的服务器地址。通用版留空，首次运行由用户填写自己的服务器。
 *  - updateFeed：在线更新源（electron-updater generic 目录，里面有 latest.yml）。自建发布可以填自己的
 *    静态 HTTPS 目录。
 *  - githubRepo：owner/repo。updateFeed 为空时退回 GitHub Releases：
 *    https://github.com/<owner>/<repo>/releases/latest/download/（仓库须公开）。
 * 本机 config.json 里的 updateFeed（可选）优先于这里，方便自建更新源的人不重新打包就改。
 *
 * 原版更新提示（upstream-notice.js）：upstreamRepo = 原版仓库，upstreamBase = 定制版所基于的原版版本；同步了新的原版
 * 改动后把 upstreamBase 改成那个版本。
 *
 * 私人构建（2026-10-22）：仓库是公开的，服务器地址不进仓库。把自己的地址写进同目录的
 * build-config.local.json（.gitignore 忽略、打包时随 src/ 一起进 asar），它的非空字段覆盖 build-config.json。
 */
const fs = require("node:fs");
const path = require("node:path");

function load(file = path.join(__dirname, "build-config.json")) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      serverUrl: String(data.serverUrl || ""),
      updateFeed: String(data.updateFeed || ""),
      githubRepo: String(data.githubRepo || ""),
      upstreamRepo: String(data.upstreamRepo || ""),
      upstreamBase: String(data.upstreamBase || ""),
    };
  } catch {
    return { serverUrl: "", updateFeed: "", githubRepo: "", upstreamRepo: "", upstreamBase: "" };
  }
}

/** 运行时用：build-config.json 再叠上本机私有的 build-config.local.json（没有就只用前者）。 */
function loadEffective(file = path.join(__dirname, "build-config.json"), localFile = path.join(__dirname, "build-config.local.json")) {
  const base = load(file);
  if (!fs.existsSync(localFile)) return base;
  const local = load(localFile);
  return {
    serverUrl: local.serverUrl || base.serverUrl,
    updateFeed: local.updateFeed || base.updateFeed,
    githubRepo: local.githubRepo || base.githubRepo,
    upstreamRepo: local.upstreamRepo || base.upstreamRepo,
    upstreamBase: local.upstreamBase || base.upstreamBase,
  };
}

function withSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/** 更新源：本机覆盖 → 构建期 updateFeed → GitHub Releases → 空（不检查更新）。 */
function resolveFeed(build, local = {}) {
  if (local.updateFeed && /^https:\/\//i.test(local.updateFeed)) return withSlash(local.updateFeed);
  if (build.updateFeed) return withSlash(build.updateFeed);
  if (/^[\w.-]+\/[\w.-]+$/.test(build.githubRepo)) return `https://github.com/${build.githubRepo}/releases/latest/download/`;
  return "";
}

module.exports = { load, loadEffective, resolveFeed };

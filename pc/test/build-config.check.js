"use strict";
/* 构建期默认值（src/build-config.js）：通用版不写死任何服务器；更新源的选择顺序。 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { load, resolveFeed } = require("../src/build-config");

test("committed build-config.json is the generic build (no server, no feed)", () => {
  const c = load(path.join(__dirname, "..", "src", "build-config.json"));
  assert.strictEqual(c.serverUrl, "");
  assert.strictEqual(c.updateFeed, "");
});

test("feed order: local override → build feed → GitHub Releases → none", () => {
  const build = { serverUrl: "", updateFeed: "https://example.com/pc", githubRepo: "me/chisabot" };
  assert.strictEqual(resolveFeed(build, { updateFeed: "https://mine.example/feed/" }), "https://mine.example/feed/");
  assert.strictEqual(resolveFeed(build, { updateFeed: "http://insecure/" }), "https://example.com/pc/");
  assert.strictEqual(resolveFeed({ ...build, updateFeed: "" }), "https://github.com/me/chisabot/releases/latest/download/");
  assert.strictEqual(resolveFeed({ serverUrl: "", updateFeed: "", githubRepo: "" }), "");
});

test("missing file falls back to empty defaults", () => {
  assert.deepStrictEqual(load("/nonexistent/build-config.json"), { serverUrl: "", updateFeed: "", githubRepo: "", upstreamRepo: "", upstreamBase: "" });
});

test("a private build-config.local.json fills in what the committed one leaves empty", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  const base = path.join(dir, "build-config.json");
  const local = path.join(dir, "build-config.local.json");
  fs.writeFileSync(base, JSON.stringify({ serverUrl: "", updateFeed: "", githubRepo: "me/chisabot" }));
  const { loadEffective } = require("../src/build-config");
  assert.deepStrictEqual(loadEffective(base, local), { serverUrl: "", updateFeed: "", githubRepo: "me/chisabot", upstreamRepo: "", upstreamBase: "" });
  fs.writeFileSync(local, JSON.stringify({ serverUrl: "https://chat.example.com" }));
  assert.deepStrictEqual(loadEffective(base, local), { serverUrl: "https://chat.example.com", updateFeed: "", githubRepo: "me/chisabot", upstreamRepo: "", upstreamBase: "" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the private local file is ignored by git", () => {
  const ignore = require("node:fs").readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8");
  assert.match(ignore, /^pc\/src\/build-config\.local\.json$/m);
});

test("committed config names the upstream and the upstream version this build is based on", () => {
  const c = load(path.join(__dirname, "..", "src", "build-config.json"));
  assert.strictEqual(c.upstreamRepo, "ChisaAlter/ChisaBot");
  assert.match(c.upstreamBase, /^\d+\.\d+\.\d+$/);
});

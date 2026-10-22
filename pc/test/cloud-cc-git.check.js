"use strict";
// 云端 Claude Code P3（pc/src/cloud-cc/git.js）：对着模拟 GitHub（tests/cloud-cc/mock-github.cjs，git http-backend + Basic 令牌）
// 走一遍克隆、会话工作树 + cc/ 分支、合入工作目录（含冲突不动 work/）、推送、「相对 main」，并检查令牌没有落盘。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { createGitWorkspaces, scrub } = require("../src/cloud-cc/git");

const MOCK = path.resolve(__dirname, "../../tests/cloud-cc/mock-github.cjs");
const TOKEN = "ghp_checktoken_" + Math.random().toString(36).slice(2, 12);
const PORT = 18000 + Math.floor(Math.random() * 2000);

function grepTree(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          if (fs.readFileSync(p).includes(needle)) hits.push(p);
        } catch {}
      }
    }
  };
  walk(dir);
  return hits;
}

let mock;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccgit-root-"));
const repos = fs.mkdtempSync(path.join(os.tmpdir(), "ccgit-repos-"));
const base = `http://127.0.0.1:${PORT}`;

test.before(async () => {
  mock = spawn(process.execPath, [MOCK], { env: { ...process.env, PORT: String(PORT), TOKEN, REPOS: repos }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => mock.stdout.once("data", resolve));
  const r = await fetch(`${base}/_seed?repo=acme/demo`);
  assert.equal(r.status, 200);
});
test.after(() => {
  mock?.kill();
});

const g = createGitWorkspaces({ root });
const WS = "ghw_check";
const write = (file, text) => fs.writeFileSync(file, text);

test("错的令牌克隆失败，目录不留半截", async () => {
  await assert.rejects(g.clone({ workspaceId: "ghw_bad", url: `${base}/git/acme/demo.git`, token: "ghp_wrong_wrong_wrong" }), /拒绝|权限|失效/);
  assert.equal(fs.existsSync(path.join(root, "projects", "ghw_bad", "work")), false);
  assert.equal(fs.existsSync(path.join(root, "projects", "ghw_bad", "work.partial")), false);
});

test("克隆 → 工作树 → 合入 → 冲突 → 推送；令牌不落盘", async () => {
  const info = await g.clone({ workspaceId: WS, url: `${base}/git/acme/demo.git`, token: TOKEN, authorName: "e2e-bot", authorEmail: "e2e-bot@users.noreply.github.com" });
  assert.equal(info.branch, "main");
  assert.ok(info.head);
  const work = g.workDir(WS);
  assert.ok(fs.existsSync(path.join(work, "README.md")));
  assert.equal(execFileSync("git", ["config", "remote.origin.url"], { cwd: work }).toString().trim(), `${base}/git/acme/demo.git`);
  assert.deepEqual(grepTree(root, TOKEN), []);
  const helperBase = process.platform === "win32" ? os.tmpdir() : os.homedir();
  assert.equal(fs.readdirSync(helperBase).filter((n) => n.startsWith("chisabot-git-")).length, 0, "askpass 临时目录应已删除");

  // 会话 A：改 README 第一行 → 合入（快进）
  const a = await g.ensureTree(WS, "ccs_a", "cc/readme-a");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: a }).toString().trim(), "cc/readme-a");
  write(path.join(a, "README.md"), "# 标题 A\n\n测试仓库（模拟 GitHub）。\n");
  write(path.join(a, "new.txt"), "新文件\n");
  const bd = await g.baseDiff({ workspaceId: WS, sessionId: "ccs_a", base: "main" }, 400_000);
  assert.deepEqual(bd.files.map((f) => f.path).sort(), ["README.md", "new.txt"]);
  assert.match(bd.patch, /\+# 标题 A/);
  const m1 = await g.merge({ workspaceId: WS, sessionId: "ccs_a", message: "改标题 A" });
  assert.equal(m1.result, "fast_forward");
  assert.match(fs.readFileSync(path.join(work, "README.md"), "utf8"), /^# 标题 A/);
  assert.equal((await g.merge({ workspaceId: WS, sessionId: "ccs_a" })).result, "up_to_date");

  // 会话 B：从 A 合入之前的提交切？——不，从现在的 work 切；先让它和 main 分叉，再在 main 上改同一行 → 冲突
  const b = await g.ensureTree(WS, "ccs_b", "cc/readme-b");
  const c = await g.ensureTree(WS, "ccs_c", "cc/readme-c");
  write(path.join(b, "README.md"), "# 标题 B\n\n测试仓库（模拟 GitHub）。\n");
  write(path.join(c, "README.md"), "# 标题 C\n\n测试仓库（模拟 GitHub）。\n");
  assert.equal((await g.merge({ workspaceId: WS, sessionId: "ccs_b" })).result, "fast_forward");
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  const m3 = await g.merge({ workspaceId: WS, sessionId: "ccs_c" });
  assert.equal(m3.result, "conflict");
  assert.deepEqual(m3.files, ["README.md"]);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim(), before, "冲突时 work/ 不动");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: work }).toString().trim(), "");
  assert.match(fs.readFileSync(path.join(work, "README.md"), "utf8"), /^# 标题 B/);

  // 推送会话 C 的分支（含自动提交）
  const pv = await g.pushPreview({ workspaceId: WS, sessionId: "ccs_c", base: "main" });
  assert.equal(pv.branch, "cc/readme-c");
  assert.equal(pv.uncommitted, 0); // 合入时已经自动提交了
  assert.equal(pv.commits.length, 2); // 工作目录里合入的 A 还没推到远端，所以也算在里面
  await assert.rejects(g.push({ workspaceId: WS, sessionId: "ccs_c", base: "main", token: TOKEN }), /可信 Git/);
  await assert.rejects(g.push({ workspaceId: WS, sessionId: "ccs_c", base: "main", url: `${base}/git/acme/demo.git`, token: "ghp_wrong_wrong_wrong" }), /拒绝/);
  // A model-controlled remote/push URL and URL rewrite must not redirect the credential.
  execFileSync("git", ["config", "remote.origin.pushurl", "http://127.0.0.1:1/steal.git"], { cwd: c });
  execFileSync("git", ["config", "url.http://127.0.0.1:1/.insteadOf", base], { cwd: c });
  const p = await g.push({ workspaceId: WS, sessionId: "ccs_c", base: "main", url: `${base}/git/acme/demo.git`, token: TOKEN });
  assert.equal(p.branch, "cc/readme-c");
  const remote = execFileSync("git", ["rev-parse", "refs/heads/cc/readme-c"], { cwd: path.join(repos, "acme", "demo.git") }).toString().trim();
  assert.equal(remote.slice(0, 10), p.head.slice(0, 10));
  assert.deepEqual(grepTree(root, TOKEN), []);

  // 归档：删工作树，分支还在
  assert.equal((await g.dropTree(WS, "ccs_a")).removed, true);
  assert.equal(fs.existsSync(a), false);
  execFileSync("git", ["rev-parse", "--verify", "refs/heads/cc/readme-a"], { cwd: work });
  await g.remove(WS);
  assert.equal(fs.existsSync(path.join(root, "projects", WS)), false);
});

test("scrub 抹掉令牌和地址里的凭据", () => {
  assert.equal(scrub(`fatal: https://x:${TOKEN}@github.com/a/b`, TOKEN), "fatal: https://github.com/a/b");
});

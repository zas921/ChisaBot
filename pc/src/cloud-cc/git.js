"use strict";
/**
 * 云端工作区的 GitHub 工作区（docs/cloud-claude-code.md §3.4，P3）：克隆、每个会话一个工作树 + `cc/…` 分支、
 * 合入工作目录、推送。纯 Node + git 命令，节点主进程调用（index.js 的 cc_rpc），不经过 Claude。
 *
 * 目录：projects/<工作区>/work         克隆下来的工作目录（只有「合入工作目录」会写它）
 *       projects/<工作区>/trees/<会话>  会话的工作树，分支 cc/…，Claude 在这里改
 *
 * 令牌：只随这一次 clone / push 下发，放在 git 子进程的环境变量里，由临时 askpass 脚本读出来（脚本里没有令牌，用完删掉）。
 * 远端地址里不带令牌，不写 credential helper，节点磁盘上找不到它。git 的输出里出现令牌一律抹掉。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const BRANCH = /^cc\/[A-Za-z0-9._-]{1,80}$/;
const REF = /^[A-Za-z0-9._\/-]{1,200}$/;

function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile("git", args, { maxBuffer: 32 * 1024 * 1024, timeout: options.timeout || 120_000, cwd: options.cwd, env: options.env || gitEnv() }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", LANG: "C.UTF-8", ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_COMMON_DIR;
  return env;
}

function scrub(text, token) {
  let t = String(text || "");
  if (token && token.length >= 6) t = t.split(token).join("••••");
  return t.replace(/(https?:\/\/)[^\s/@]+@/g, "$1").slice(-1500);
}

/** 临时 askpass：用户名固定 x-access-token，密码从环境变量 CHISABOT_GIT_TOKEN 读。脚本本身不含令牌。 */
function withAskpass(token, fn) {
  if (!token) return fn(gitEnv());
  // Cloud-node /tmp is noexec. Use its private home volume for the executable
  // helper (no token in the file), then remove it in finally. Windows keeps TEMP.
  const base = process.platform === "win32" ? os.tmpdir() : os.homedir();
  const dir = fs.mkdtempSync(path.join(base, "chisabot-git-"));
  fs.chmodSync(dir, 0o700);
  const script = path.join(dir, "askpass.sh");
  fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  Username*) printf "%s\\n" x-access-token ;;\n  *) printf "%s\\n" "$CHISABOT_GIT_TOKEN" ;;\nesac\n', { mode: 0o700 });
  const env = gitEnv({ GIT_ASKPASS: script, CHISABOT_GIT_TOKEN: token, SSH_ASKPASS: script });
  return Promise.resolve()
    .then(() => fn(env))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

/** 不读系统 / 用户的 credential helper，令牌不会被哪个 helper 存下来。 */
const NO_HELPER = ["-c", "credential.helper=", "-c", "core.askPass="];

function createGitWorkspaces({ root, log = () => {} }) {
  function wsDir(workspaceId) {
    return path.join(root, "projects", workspaceId);
  }
  function workDir(workspaceId) {
    return path.join(wsDir(workspaceId), "work");
  }
  function treeDir(workspaceId, sessionId) {
    return path.join(wsDir(workspaceId), "trees", sessionId);
  }
  function isGitWorkspace(workspaceId) {
    return fs.existsSync(path.join(workDir(workspaceId), ".git"));
  }
  async function head(cwd) {
    const r = await run(["rev-parse", "HEAD"], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async function currentBranch(cwd) {
    const r = await run(["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** 克隆到 projects/<ws>/work（先克隆到 work.partial，成功了再改名）。 */
  async function clone(args) {
    const url = String(args.url || "");
    if (!/^(https?:\/\/|file:\/\/)/.test(url) || /\s/.test(url) || /\/\/[^/]*@/.test(url)) throw new Error("仓库地址不对");
    const branch = args.branch ? String(args.branch) : null;
    if (branch && !REF.test(branch)) throw new Error("分支名不对");
    const dest = workDir(args.workspaceId);
    if (fs.existsSync(path.join(dest, ".git"))) return await describe(args.workspaceId);
    const partial = `${dest}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const started = Date.now();
    const r = await withAskpass(args.token, (env) =>
      run([...NO_HELPER, "clone", "--no-tags", ...(branch ? ["--branch", branch] : []), "--", url, partial], { env, timeout: 15 * 60_000 }),
    );
    if (r.code !== 0) {
      fs.rmSync(partial, { recursive: true, force: true });
      const tail = scrub(r.stderr, args.token);
      if (/Authentication failed|could not read Username|403|401|terminal prompts disabled/i.test(tail)) throw new Error("GitHub 拒绝了克隆：令牌没有这个仓库的权限，或者已经失效。");
      if (/not found|does not exist/i.test(tail)) throw new Error(branch ? `找不到这个仓库或分支 ${branch}。` : "找不到这个仓库。");
      throw new Error(`克隆失败：${tail.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    }
    // 云端那份的 Git 配置（§4.5）：换行、权限位不变成假改动；提交署名用 GitHub 账号。
    const cfg = [
      ["core.autocrlf", "input"],
      ["core.filemode", "false"],
      ["user.name", String(args.authorName || "ChisaBot")],
      ["user.email", String(args.authorEmail || "chisabot@localhost")],
      ["advice.detachedHead", "false"],
    ];
    for (const [k, v] of cfg) await run(["config", k, v], { cwd: partial });
    fs.renameSync(partial, dest);
    log(`克隆完成 ${args.workspaceId}（${Math.round((Date.now() - started) / 100) / 10} 秒）`);
    return await describe(args.workspaceId);
  }

  async function describe(workspaceId) {
    const cwd = workDir(workspaceId);
    const branch = await currentBranch(cwd);
    const sha = await head(cwd);
    let bytes = null;
    const du = await new Promise((resolve) => execFile("du", ["-sk", cwd], { timeout: 30_000 }, (e, out) => resolve(e ? null : out)));
    if (du) bytes = Number(String(du).split(/\s/)[0]) * 1024 || null;
    return { branch, head: sha, sizeBytes: bytes };
  }

  function baseFile(workspaceId, branch) {
    return path.join(workDir(workspaceId), ".git", "chisabot-base", String(branch).replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  /**
   * 工作目录现在的样子拍成一个提交（P4，电脑同步）：临时 index，`commit-tree`，**不动** work/ 的 HEAD、分支和 index。
   * 电脑开着同步时 work/ 里常有没提交的改动（电脑上刚改的），会话要从「电脑上现在的样子」开始。
   */
  async function snapshotWork(workspaceId) {
    const work = workDir(workspaceId);
    const parent = await head(work);
    const idx = path.join(os.tmpdir(), `chisabot-snapidx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const env = { ...gitEnv(), GIT_INDEX_FILE: idx };
      if (parent) await run(["read-tree", "HEAD"], { cwd: work, env });
      await run(["add", "-A", "."], { cwd: work, env });
      const tree = (await run(["write-tree"], { cwd: work, env })).stdout.trim();
      if (!tree) throw new Error("给工作目录拍快照失败");
      const ident = gitEnv({ GIT_AUTHOR_NAME: "ChisaBot", GIT_AUTHOR_EMAIL: "chisabot@localhost", GIT_COMMITTER_NAME: "ChisaBot", GIT_COMMITTER_EMAIL: "chisabot@localhost" });
      const r = await run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "ChisaBot：工作目录快照（会话开始时）"], { cwd: work, env: ident });
      const sha = r.stdout.trim();
      if (r.code !== 0 || !sha) throw new Error(`给工作目录拍快照失败：${scrub(r.stderr).slice(-200)}`);
      return sha;
    } finally {
      fs.rmSync(idx, { force: true });
    }
  }

  async function isDirty(cwd) {
    const r = await run(["status", "--porcelain"], { cwd });
    return r.code === 0 && !!r.stdout.trim();
  }

  /** 会话的工作树：第一次用时从工作目录当前的提交切出分支 cc/…（work/ 有没提交的改动 / 还没有提交时，从快照切）。 */
  async function ensureTree(workspaceId, sessionId, branch) {
    const tree = treeDir(workspaceId, sessionId);
    if (fs.existsSync(path.join(tree, ".git"))) return tree;
    if (!BRANCH.test(String(branch || ""))) throw new Error("会话分支名不对");
    const work = workDir(workspaceId);
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    // 目录已经有（比如之前失败过一半）：只有空目录才能接着用
    if (fs.existsSync(tree) && fs.readdirSync(tree).length) throw new Error("会话目录已经有文件，不能变成工作树");
    fs.rmSync(tree, { recursive: true, force: true });
    await run(["worktree", "prune"], { cwd: work });
    const exists = (await run(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: work })).code === 0;
    let start = "HEAD";
    if (!exists && (!(await head(work)) || (await isDirty(work)))) {
      start = await snapshotWork(workspaceId);
      fs.mkdirSync(path.dirname(baseFile(workspaceId, branch)), { recursive: true });
      fs.writeFileSync(baseFile(workspaceId, branch), `${start}\n`);
    }
    const r = await run(["worktree", "add", ...(exists ? [] : ["-b", branch]), tree, ...(exists ? [branch] : [start])], { cwd: work });
    if (r.code !== 0) throw new Error(`建会话工作树失败：${scrub(r.stderr).slice(-300)}`);
    return tree;
  }

  /** 把会话目录里还没提交的改动提交到会话分支（合入 / 推送前）。 */
  async function commitPending(tree, message) {
    const st = await run(["status", "--porcelain"], { cwd: tree });
    if (!st.stdout.trim()) return null;
    await run(["add", "-A", "."], { cwd: tree });
    const r = await run(["commit", "-q", "--no-verify", "-m", message], { cwd: tree });
    if (r.code !== 0) throw new Error(`提交失败：${scrub(r.stderr || r.stdout).slice(-300)}`);
    return await head(tree);
  }

  async function ahead(cwd, base, tip = "HEAD") {
    const r = await run(["log", "--format=%H%x09%s", `${base}..${tip}`, "--max-count=50"], { cwd });
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha: sha.slice(0, 10), subject: rest.join("\t").slice(0, 200) };
      });
  }

  /**
   * 合入工作目录（§3.4 第 3 条）：会话分支合进 work/ 当前分支；有冲突就放弃合并，work/ 保持原样。
   * 「放进工作目录」模式（mode=apply：电脑文件夹工作区，或者 work/ 有电脑同步来的没提交改动）：只把会话的改动
   * （快照 / 分叉点 → 会话分支）写进 work/ 的文件，不提交、不动 HEAD——电脑上自己决定怎么提交。先 `apply --check`，
   * 有一处对不上就一个文件都不写。
   */
  async function merge(args) {
    const tree = treeDir(args.workspaceId, args.sessionId);
    const work = workDir(args.workspaceId);
    if (!fs.existsSync(path.join(tree, ".git"))) throw new Error("这个会话还没有改过文件");
    const branch = await currentBranch(tree);
    if (!branch || !BRANCH.test(branch)) throw new Error("会话目录不在 cc/ 分支上（可能被切走了），先让 Claude 切回来");
    const committed = await commitPending(tree, String(args.message || `ChisaBot 会话「${branch}」的改动`).slice(0, 200));
    const target = (await currentBranch(work)) || "";
    const dirty = await run(["status", "--porcelain", "--untracked-files=no"], { cwd: work });
    const apply = args.mode === "apply" || !target || !!dirty.stdout.trim() || fs.existsSync(baseFile(args.workspaceId, branch));
    if (apply) return await applyInto(args.workspaceId, branch, target, committed);
    const commits = await ahead(work, target, branch);
    if (!commits.length) return { result: "up_to_date", branch, target, head: await head(work), commits: [], committed };
    const before = await head(work);
    const ff = (await run(["merge-base", "--is-ancestor", target, branch], { cwd: work })).code === 0;
    const r = await run(["merge", "--no-edit", ff ? "--ff-only" : "--no-ff", "-m", `合入 ${branch}`, branch], { cwd: work });
    if (r.code !== 0) {
      const u = await run(["diff", "--name-only", "--diff-filter=U"], { cwd: work });
      const files = u.stdout.split("\n").filter(Boolean).slice(0, 100);
      await run(["merge", "--abort"], { cwd: work });
      await run(["reset", "--hard", "-q", before], { cwd: work });
      return { result: "conflict", branch, target, head: before, files, commits, committed };
    }
    return { result: ff ? "fast_forward" : "merged", branch, target, head: await head(work), commits, committed };
  }

  async function applyInto(workspaceId, branch, target, committed) {
    const work = workDir(workspaceId);
    let base = "";
    try {
      base = fs.readFileSync(baseFile(workspaceId, branch), "utf8").trim();
    } catch {}
    if (!base) base = (await run(["merge-base", "HEAD", branch], { cwd: work })).stdout.trim();
    if (!base) throw new Error("找不到会话的起点，没法放进工作目录");
    const commits = await ahead(work, base, branch);
    const names = await run(["diff", "--name-only", "--no-renames", base, branch], { cwd: work });
    const files = names.stdout.split("\n").filter(Boolean).slice(0, 100);
    if (!files.length) return { result: "up_to_date", branch, target, head: await head(work), commits, committed, files: [] };
    const patchFile = path.join(os.tmpdir(), `chisabot-apply-${process.pid}-${Date.now()}.patch`);
    try {
      const p = await run(["diff", "--binary", "--no-renames", "--no-color", base, branch], { cwd: work });
      fs.writeFileSync(patchFile, p.stdout);
      const check = await run(["apply", "--check", "--whitespace=nowarn", patchFile], { cwd: work });
      if (check.code !== 0) {
        const bad = [...new Set([...check.stderr.matchAll(/(?:patch failed|error): ([^:\n]+?)(?::\d+)?(?::|$)/gm)].map((m) => m[1].trim()))].filter((f) => files.includes(f));
        return { result: "conflict", branch, target, head: await head(work), files: bad.length ? bad : files, commits, committed, applied: false };
      }
      const r = await run(["apply", "--whitespace=nowarn", patchFile], { cwd: work });
      if (r.code !== 0) throw new Error(`放进工作目录失败：${scrub(r.stderr).slice(-300)}`);
      // 下次合入从这里接着算（同一个会话再合一次只放新的改动）
      fs.mkdirSync(path.dirname(baseFile(workspaceId, branch)), { recursive: true });
      fs.writeFileSync(baseFile(workspaceId, branch), `${(await run(["rev-parse", branch], { cwd: work })).stdout.trim()}\n`);
      return { result: "applied", branch, target, head: await head(work), files, commits, committed };
    } finally {
      fs.rmSync(patchFile, { force: true });
    }
  }

  /** 电脑同步的 Git（§4.5）：云端 work/ 的分支 / HEAD。 */
  async function gitInfo(workspaceId) {
    const work = workDir(workspaceId);
    if (!fs.existsSync(path.join(work, ".git"))) return { repo: false, branch: null, head: null };
    return { repo: true, branch: await currentBranch(work), head: await head(work) };
  }

  /**
   * 电脑推上来的提交（refs/remotes/pc/<分支>）接到云端 work/：云端是它的祖先（或还没有提交）→ 快进（update-ref +
   * reset --mixed，工作区文件不动，文件本来就由 Mutagen 同步）；一样 → 跳过；电脑落后 → cloud_ahead（电脑去快进）；
   * 分叉 → diverged（不自动合并，进冲突）。
   */
  async function adopt(args) {
    const work = workDir(args.workspaceId);
    const branch = String(args.branch || "");
    const sha = String(args.sha || "");
    if (!REF.test(branch) || branch.startsWith("cc/") || /\.\.|^\/|\/$/.test(branch)) throw new Error("分支名不对");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("提交号不对");
    if (!fs.existsSync(path.join(work, ".git"))) throw new Error("云端工作目录还不是 Git 仓库");
    if ((await run(["cat-file", "-e", `${sha}^{commit}`], { cwd: work })).code !== 0) throw new Error("云端还没有这个提交（先推上来）");
    const cur = await head(work);
    const curBranch = await currentBranch(work);
    const ident = gitEnv({ GIT_COMMITTER_NAME: "ChisaBot", GIT_COMMITTER_EMAIL: "chisabot@localhost" });
    const point = async () => {
      await run(["update-ref", `refs/heads/${branch}`, sha], { cwd: work, env: ident });
      await run(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: work });
      await run(["reset", "-q", "--mixed", sha], { cwd: work });
    };
    if (!cur) {
      await point();
      return { result: "adopted", head: sha, branch };
    }
    if (cur === sha && curBranch === branch) return { result: "same", head: sha, branch };
    if ((await run(["merge-base", "--is-ancestor", cur, sha], { cwd: work })).code === 0) {
      await point();
      return { result: "fast_forward", head: sha, branch, from: cur };
    }
    if ((await run(["merge-base", "--is-ancestor", sha, cur], { cwd: work })).code === 0) return { result: "cloud_ahead", head: cur, branch: curBranch };
    return { result: "diverged", head: cur, branch: curBranch };
  }

  /** 推送前看一眼：要推的提交、还没提交的文件数、目标分支。 */
  async function pushPreview(args) {
    const tree = treeDir(args.workspaceId, args.sessionId);
    if (!fs.existsSync(path.join(tree, ".git"))) return { branch: args.branch || null, base: args.base || null, commits: [], uncommitted: 0, started: false };
    const branch = await currentBranch(tree);
    const base = String(args.base || "main");
    const st = await run(["status", "--porcelain"], { cwd: tree });
    const remoteBase = (await run(["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], { cwd: tree })).code === 0 ? `origin/${base}` : base;
    return { branch, base, commits: await ahead(tree, remoteBase), uncommitted: st.stdout.split("\n").filter(Boolean).length, started: true };
  }

  /** 推送会话分支（§3.4 第 4 条）。不碰 work/。 */
  async function push(args) {
    const tree = treeDir(args.workspaceId, args.sessionId);
    if (!fs.existsSync(path.join(tree, ".git"))) throw new Error("这个会话还没有改过文件");
    const branch = await currentBranch(tree);
    if (!branch || !BRANCH.test(branch)) throw new Error("会话目录不在 cc/ 分支上，先让 Claude 切回来");
    const committed = await commitPending(tree, String(args.message || `ChisaBot 会话「${branch}」的改动`).slice(0, 200));
    const base = String(args.base || "main");
    const remoteBase = (await run(["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], { cwd: tree })).code === 0 ? `origin/${base}` : base;
    const commits = await ahead(tree, remoteBase);
    if (!commits.length) throw new Error(`会话分支相对 ${base} 没有新的提交，没有可推送的`);
    // The model can change its worktree's .git/config. Never hand a token to a Git process
    // using that config (pushurl, insteadOf, helpers and pre-push hooks are executable).
    let r, pushedHead;
    if (args.token) {
      const url = String(args.url || "");
      if (!/^https?:\/\/[^\s/@]+\/[A-Za-z0-9._/-]+\.git$/.test(url)) throw new Error("服务器没有提供可信 Git 仓库地址，请更新服务器和节点。");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-publish-"));
      try {
        const init = await run(["clone", "--bare", "--no-hardlinks", "--single-branch", "--branch", branch, "--", tree, dir], { timeout: 120_000 });
        if (init.code !== 0) throw new Error("无法准备独立推送仓库。");
        pushedHead = await head(dir);
        r = await withAskpass(args.token, (env) => run([...NO_HELPER, "-c", "core.hooksPath=", "-c", "http.followRedirects=false", "push", "--porcelain", url, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: dir, env, timeout: 5 * 60_000 }));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } else {
      // Credential-free local test repositories.
      pushedHead = await head(tree);
      r = await run([...NO_HELPER, "push", "--porcelain", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { cwd: tree, timeout: 5 * 60_000 });
    }
    if (r.code !== 0) {
      const tail = scrub(`${r.stderr}\n${r.stdout}`, args.token);
      if (/non-fast-forward|fetch first|rejected/i.test(tail)) throw new Error(`GitHub 上的 ${branch} 已经有别的提交，推不上去。让 Claude 先 rebase，或者新开一个会话。`);
      if (/Authentication failed|could not read Username|403|401|denied/i.test(tail)) throw new Error("GitHub 拒绝了推送：令牌没有这个仓库的写权限（Contents: Read and write），或者已经失效。");
      throw new Error(`推送失败：${tail.split("\n").filter(Boolean).slice(-2).join(" ")}`);
    }
    // 远端跟踪分支更新一下，下次「相对 main」才准
    return { branch, base, head: pushedHead, commits, committed };
  }

  /** 「相对 main」：会话目录（含没提交、没跟踪的文件）和 main 的分叉点比。用临时 index，不动会话的 index。 */
  async function baseDiff(args, cap) {
    const tree = treeDir(args.workspaceId, args.sessionId);
    const base = String(args.base || "main");
    if (!fs.existsSync(path.join(tree, ".git"))) return { base, files: [], patch: "", started: false };
    const remoteBase = (await run(["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`], { cwd: tree })).code === 0 ? `origin/${base}` : base;
    const mb = await run(["merge-base", remoteBase, "HEAD"], { cwd: tree });
    const from = mb.stdout.trim();
    if (!from) return { base, files: [], patch: "", started: true };
    const idx = path.join(os.tmpdir(), `chisabot-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const env = { ...gitEnv(), GIT_INDEX_FILE: idx };
      await run(["read-tree", "HEAD"], { cwd: tree, env });
      await run(["add", "-A", "."], { cwd: tree, env });
      const ns = await run(["diff", "--cached", "--numstat", "-z", "--no-renames", from], { cwd: tree, env });
      const nst = await run(["diff", "--cached", "--name-status", "-z", "--no-renames", from], { cwd: tree, env });
      const kinds = new Map();
      const st = nst.stdout.split("\0").filter(Boolean);
      for (let i = 0; i + 1 < st.length; i += 2) kinds.set(st[i + 1], st[i]);
      const files = [];
      for (const rec of ns.stdout.split("\0").filter(Boolean)) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
        if (m) files.push({ path: m[3], add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]), status: kinds.get(m[3]) || "M" });
      }
      const p = await run(["diff", "--cached", "--no-renames", "--no-color", from], { cwd: tree, env });
      const patch = p.stdout.length > cap ? `${p.stdout.slice(0, cap)}\n…（diff 太长，已截断）` : p.stdout;
      return { base, files: files.slice(0, 500), patch, started: true, commits: (await ahead(tree, remoteBase)).length };
    } finally {
      fs.rmSync(idx, { force: true });
    }
  }

  /** 删掉整个工作区目录（服务器已经二次确认过）。 */
  async function remove(workspaceId) {
    const dir = wsDir(workspaceId);
    if (!dir.startsWith(path.join(root, "projects") + path.sep)) throw new Error("路径不对");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${workDir(workspaceId)}.partial`, { recursive: true, force: true });
    return { removed: true };
  }

  /** 归档会话：删掉工作树（分支保留，提交都还在）。 */
  async function dropTree(workspaceId, sessionId) {
    const tree = treeDir(workspaceId, sessionId);
    if (!isGitWorkspace(workspaceId) || !fs.existsSync(tree)) return { removed: false };
    await run(["worktree", "remove", "--force", tree], { cwd: workDir(workspaceId) });
    fs.rmSync(tree, { recursive: true, force: true });
    await run(["worktree", "prune"], { cwd: workDir(workspaceId) });
    return { removed: true };
  }

  return { workDir, treeDir, isGitWorkspace, clone, describe, ensureTree, merge, gitInfo, adopt, snapshotWork, push, pushPreview, baseDiff, remove, dropTree, BRANCH };
}

module.exports = { createGitWorkspaces, scrub, BRANCH };

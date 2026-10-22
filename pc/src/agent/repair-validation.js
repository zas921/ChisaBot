"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9._-]{1,100}$/;
const terminal = new Set(["passed", "failed", "incomplete", "cancelled", "error"]);

// Commands come only from a local, operator-owned file. RPC inputs cannot supply commands,
// paths, environment, repository URLs or credentials. Raw output stays on this machine.
function execute(file, args, { cwd, signal, timeoutMs, log, env }) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ code: null, cancelled: true });
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
    let bytes = 0, timedOut = false, stdout = "", outputTruncated = false;
    const write = (buf) => { if (bytes < 1024 * 1024) log(buf.subarray(0, 1024 * 1024 - bytes)); bytes += buf.length; };
    child.stdout.on("data", (buf) => {
      if (stdout.length + buf.length > 1024 * 1024) outputTruncated = true;
      if (!outputTruncated) stdout += buf.toString("utf8");
      write(buf);
    }); child.stderr.on("data", write);
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    };
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const done = (code) => { clearTimeout(timer); signal.removeEventListener("abort", kill); resolve({ code, timedOut, cancelled: signal.aborted, stdout, outputTruncated }); };
    child.on("error", () => done(null)); child.on("close", done);
  });
}

function nunitResult(xml) {
  // Only the aggregate, never test names/messages/stack traces, leaves the device.
  const tag = /<test-run\s[^>]*>/.exec(xml)?.[0];
  const attr = (name) => new RegExp(`\\b${name}=["']([^"']*)["']`).exec(tag || "")?.[1];
  const total = Number(attr("total")), passed = Number(attr("passed")), failed = Number(attr("failed"));
  if (!tag || ![total, passed, failed].every(Number.isSafeInteger) || total < 1 || passed < 0 || failed < 0 || passed + failed > total)
    return { status: "incomplete", reason: "missing_or_empty_test_report" };
  return { status: failed > 0 || attr("result") === "Failed" ? "failed" : passed === total && attr("result") === "Passed" ? "passed" : "incomplete", total, passed, failed };
}

function checkProfile(p) {
  if (!p || !REPO.test(p.repository || "") || !path.isAbsolute(p.workspaceRoot || "")) throw new Error("验收配置缺少 GitHub 仓库或绝对工作目录。");
  if (p.gitAuth && !["system", "github-cli"].includes(p.gitAuth)) throw new Error("Git 授权方式只能是 system 或 github-cli。");
  if (p.originalProjectRoot !== undefined && (!path.isAbsolute(p.originalProjectRoot) || !ID.test(p.originalRemote || "origin")))
    throw new Error("原工程必须是本机绝对路径，originalRemote 必须是有效远程名称。");
  if (p.environment !== undefined && (!p.environment || typeof p.environment !== "object" || Array.isArray(p.environment)
    || Object.entries(p.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))))
    throw new Error("本地环境变量必须是合法名称到字符串的映射。");
  if (p.adapter === "unity") {
    if (!path.isAbsolute(p.unityCli || "") || !path.isAbsolute(p.editorPath || "")) throw new Error("Unity 验收必须配置 Unity CLI 和编辑器绝对路径。");
  } else if (p.adapter === "commands") {
    if (!Array.isArray(p.checks) || !p.checks.length || p.checks.length > 20) throw new Error("请配置 1 至 20 个本地验收命令。");
    for (const c of p.checks) if (!ID.test(c.id || "") || !path.isAbsolute(c.file || "") || !Array.isArray(c.args) || c.args.some((s) => typeof s !== "string")) throw new Error("验收命令配置无效。");
  } else throw new Error("未知验收适配器。");
  return p;
}

function createRepairValidation({ resolveInRoots, run = execute, configFile = process.env.CHISABOT_REPAIR_PROFILES_FILE || path.join(os.homedir(), ".chisabot-node", "repair-profiles.json") }) {
  const jobs = new Map();
  let starting = false;
  const view = (job) => ({ id: job.id, profileId: job.profileId, commit: job.commit, state: job.state, checks: job.checks, reason: job.reason || null,
    updateOriginal: job.updateOriginal, ...(job.update ? { update: job.update } : {}) });
  async function start(args, ctx = {}) {
    if (starting) throw new Error("已有本地验收正在启动。");
    starting = true;
    try {
    if (Object.keys(args).some((k) => !["profileId", "commit", "repository", "updateOriginal"].includes(k)) || !ID.test(args.profileId || "") || !SHA.test(args.commit || "") || !REPO.test(args.repository || "")
      || (args.updateOriginal !== undefined && typeof args.updateOriginal !== "boolean")) throw new Error("验收只接受配置编号、GitHub 仓库名、完整提交 SHA 和原工程更新开关。");
    let config;
    try { config = JSON.parse(await fs.readFile(configFile, "utf8")); } catch { throw new Error("请在本机配置 repair-profiles.json。"); }
    const p = checkProfile(config.profiles?.[args.profileId]);
    if (p.repository.toLowerCase() !== args.repository.toLowerCase()) throw new Error("云端与本地配置的 GitHub 仓库不一致。");
    const root = await resolveInRoots(p.workspaceRoot, ctx.allowedRoots || []);
    let original;
    if (args.updateOriginal) {
      if (!p.originalProjectRoot) throw new Error("本机尚未配置原工程路径，不能直接更新。");
      original = await resolveInRoots(p.originalProjectRoot, ctx.allowedRoots || []);
    }
    if ([...jobs.values()].some((j) => !terminal.has(j.state))) throw new Error("已有本地验收在运行，请等待结束。");
    // Bounded memory, reports remain on disk. Restart never resumes executable work.
    if (jobs.size >= 100) jobs.delete(jobs.keys().next().value);
    const id = randomUUID();
    const dir = path.join(root, id);
    if (ctx.signal?.aborted) throw new Error("验收已取消。");
    await fs.mkdir(dir, { recursive: false });
    const job = { id, profileId: args.profileId, commit: args.commit, updateOriginal: !!args.updateOriginal, state: "running", checks: [], controller: new AbortController() };
    jobs.set(id, job);
    void work(job, p, dir, original).catch((error) => { job.state = job.controller.signal.aborted ? "cancelled" : "error"; job.reason = error.repairReason || "validation_infrastructure_error"; }).finally(async () => {
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(view(job), null, 2)).catch(() => {});
    });
    return view(job);
    } finally { starting = false; }
  }
  async function work(job, p, dir, original) {
    const project = original || path.join(dir, "project"), reports = path.join(dir, "reports");
    await fs.mkdir(reports);
    const hooks = path.join(dir, "disabled-hooks");
    await fs.mkdir(hooks);
    const fail = (reason) => { throw Object.assign(new Error(reason), { repairReason: reason }); };
    const timeoutMs = Math.max(1000, Math.min(Number(p.timeoutMs) || 600000, 3600000));
    const invoke = async (id, file, args, cwd) => {
      const handle = await fs.open(path.join(reports, `${id}.log`), "wx");
      let pending = Promise.resolve();
      try { return await run(file, args, { cwd, signal: job.controller.signal, timeoutMs, env: p.environment, log: (buf) => { pending = pending.then(() => handle.write(buf)).then(() => {}); } }); }
      finally { await pending.catch(() => {}); await handle.close(); }
    };
    const git = async (id, args, cwd) => {
      const credential = p.gitAuth === "github-cli" ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
      const result = await invoke(id, p.git || "git", ["-c", `core.hooksPath=${hooks}`, "-c", "core.longpaths=true", "-c", "http.followRedirects=false", ...credential, ...args], cwd);
      if (result.code !== 0 || result.timedOut || result.cancelled || result.outputTruncated) fail("git_operation_failed");
      return (result.stdout || "").trim();
    };
    let lock, lockPath;
    try {
    if (original) {
      const top = await git("git-root", ["rev-parse", "--show-toplevel"], project);
      const canonical = (s) => process.platform === "win32" ? s.toLowerCase() : s;
      if (canonical(await fs.realpath(top)) !== canonical(await fs.realpath(project))) fail("original_not_repository_root");
      const remote = await git("git-remote", ["remote", "get-url", "--all", p.originalRemote || "origin"], project);
      const repository = remote.replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/^ssh:\/\/git@github\.com\//i, "").replace(/\.git$/, "");
      if (repository.toLowerCase() !== p.repository.toLowerCase()) fail("original_repository_mismatch");
      const gitDir = await git("git-directory", ["rev-parse", "--absolute-git-dir"], project);
      lockPath = path.join(gitDir, "chisabot-repair.lock");
      try { lock = await fs.open(lockPath, "wx"); } catch { fail("original_update_locked"); }
      const ready = async (suffix) => {
        for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
          if (await fs.lstat(path.join(gitDir, state)).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; })) fail("original_git_operation_in_progress");
        }
        if (p.adapter === "unity" && await fs.lstat(path.join(project, "Temp", "UnityLockfile")).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; })) fail("unity_editor_must_be_closed");
        if (await git(`git-clean-${suffix}`, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], project)) fail("original_has_uncommitted_changes");
      };
      await ready("before");
      if (/^[a-zS]/m.test(await git("git-index-flags", ["ls-files", "-v"], project))) fail("original_hidden_index_changes");
      const branch = await git("git-branch", ["symbolic-ref", "--quiet", "HEAD"], project);
      const before = await git("git-before", ["rev-parse", "HEAD"], project);
      if (!SHA.test(before) || !branch.startsWith("refs/heads/")) fail("original_invalid_head");
      await git("git-fetch", ["fetch", "--no-tags", "--no-recurse-submodules", `https://github.com/${p.repository}.git`, job.commit], project);
      if (await git("git-ancestor", ["merge-base", before, job.commit], project) !== before) fail("original_history_diverged");
      await ready("apply");
      if (await git("git-current", ["rev-parse", "HEAD"], project) !== before || await git("git-current-branch", ["symbolic-ref", "--quiet", "HEAD"], project) !== branch) fail("original_changed_during_update");
      const backupRef = `refs/chisabot/repair/${job.id}`;
      await git("git-backup", ["update-ref", backupRef, before, "0".repeat(40)], project);
      job.update = { beforeCommit: before, targetCommit: job.commit, backupRef, state: "prepared" };
      // Durable recovery reference before mutation; do not reset on failure or cancellation.
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(view(job), null, 2));
      await git("git-apply", ["-c", "merge.autostash=false", "merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", job.commit], project);
      const after = await git("git-after", ["rev-parse", "HEAD"], project);
      job.update.afterCommit = after;
      if (after !== job.commit) fail("original_changed_during_update");
      job.update.state = before === after ? "unchanged" : "applied";
      await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(view(job), null, 2));
    } else {
    // New repository, no relationship to the developer's working tree or its configuration.
    await fs.mkdir(project);
    await git("git-init", ["init", project], dir);
    await git("git-fetch", ["fetch", "--no-tags", "--depth=1", `https://github.com/${p.repository}.git`, job.commit], project);
    await git("git-checkout", ["checkout", "--detach", job.commit], project);
    }
    // Git for Windows can return success after failing to materialize long paths.
    // Refuse to validate a checkout with missing or modified tracked files.
    await git("git-verify", ["diff", "--no-ext-diff", "--quiet", "HEAD", "--"], project);
    const editor = ["--editor-path", p.editorPath || "", "--timeout", String(Math.ceil(timeoutMs / 1000)), "--no-accelerator"];
    const checks = p.adapter === "unity" ? [
      { id: "compile", file: p.unityCli, args: ["run", project, ...editor, "--log-file", path.join(reports, "unity-compile.log"), "--", "-nographics"] },
      { id: "editmode", file: p.unityCli, args: ["test", project, "--mode", "EditMode", ...editor, "--output", path.join(reports, "editmode.xml"), "--report-format", "nunit", "--", "-nographics"], nunit: true },
    ] : p.checks;
    for (const check of checks) {
      if (job.controller.signal.aborted) { job.state = "cancelled"; return; }
      const args = check.args.map((a) => a.replaceAll("{project}", project).replaceAll("{reports}", reports));
      const r = await invoke(check.id, check.file, args, project);
      let result = { status: r.cancelled ? "cancelled" : r.timedOut ? "error" : r.code === 0 ? "passed" : "failed", exitCode: r.code };
      if (check.nunit && r.code === 0 && !r.cancelled && !r.timedOut) {
        result = { ...result, ...nunitResult(await fs.readFile(path.join(reports, "editmode.xml"), "utf8").catch(() => "")) };
      }
      job.checks.push({ id: check.id, ...result });
      if (result.status !== "passed") { job.state = result.status; return; }
    }
    if (original) {
      if (await git("git-final-head", ["rev-parse", "HEAD"], project) !== job.commit) fail("original_changed_during_validation");
      if (await git("git-final-status", ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], project)) fail("original_changed_during_validation");
    }
    job.state = "passed";
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockPath); }
    }
  }
  function status(args) {
    if (Object.keys(args).some((k) => k !== "id") || typeof args.id !== "string") throw new Error("无效验收编号。");
    const job = jobs.get(args.id);
    return job ? view(job) : { id: args.id, state: "unknown", reason: "not_found_or_node_restarted" };
  }
  return { table: { repair_validate: start, repair_status: status, repair_cancel: (args) => { const result = status(args); jobs.get(args.id)?.controller.abort(); return result; } },
    stopAll: () => { for (const j of jobs.values()) if (!terminal.has(j.state)) j.controller.abort(); } };
}
module.exports = { createRepairValidation, nunitResult, checkProfile };

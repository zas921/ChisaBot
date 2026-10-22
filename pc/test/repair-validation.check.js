"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRepairValidation, nunitResult, checkProfile } = require("../src/agent/repair-validation");
const sha = "a".repeat(40);
const input = { profileId: "demo", repository: "owner/demo", commit: sha };
async function fixture(t, adapter = "commands", run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "profiles.json");
  await fs.writeFile(configFile, JSON.stringify({ profiles: { demo: { repository: "owner/demo", workspaceRoot: root,
    adapter, checks: [{ id: "unit", file: process.execPath, args: ["-e", "process.exit(0)"] }],
    unityCli: process.execPath, editorPath: process.execPath, environment: { CB_REPAIR_TEST: "local-only" } } } }));
  const calls = [];
  const service = createRepairValidation({ configFile, resolveInRoots: async (p, roots) => {
    assert.deepEqual(roots, [root]); return p;
  }, run: async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env });
    opts.log(Buffer.from("PRIVATE LOCAL LOG - do not return"));
    return run ? run(file, args, opts) : { code: 0 };
  } });
  return { service, root, calls, ctx: { allowedRoots: [root] } };
}
async function finished(service, id) {
  for (let i = 0; i < 200; i++) {
    const result = service.table.repair_status({ id });
    if (result.state !== "running") { await new Promise((r) => setTimeout(r, 20)); return result; }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("validation did not finish");
}
test("pinned GitHub commit, fresh checkout, fixed commands and no local log disclosure", async (t) => {
  const { service, calls, root, ctx } = await fixture(t);
  const started = await service.table.repair_validate(input, ctx);
  const result = await finished(service, started.id);
  assert.equal(result.state, "passed"); assert.equal(result.commit, sha);
  assert(calls[1].args.includes("https://github.com/owner/demo.git"));
  assert.equal(calls[1].args.at(-1), sha); assert.equal(calls[2].args.at(-1), sha);
  assert.equal(calls[4].cwd, path.join(root, started.id, "project"));
  assert(calls[2].args.includes("core.longpaths=true"));
  assert(calls[3].args.includes("--quiet"));
  assert(!JSON.stringify(result).includes("PRIVATE")); assert(!JSON.stringify(result).includes(root));
  assert(calls.every((c) => c.env.CB_REPAIR_TEST === "local-only"));
  assert(!JSON.stringify(result).includes("local-only"));
  assert.match(await fs.readFile(path.join(root, started.id, "reports", "unit.log"), "utf8"), /PRIVATE/);
});
test("rejects arbitrary commands, refs, repository substitution and missing profiles", async (t) => {
  const { service, ctx, calls } = await fixture(t);
  for (const args of [{ ...input, environment: { PATH: "remote" } }, { ...input, command: "whoami" }, { ...input, commit: "main" }, { ...input, repository: "attacker/demo" }, { ...input, profileId: "../../x" }, { ...input, profileId: "missing" }])
    await assert.rejects(service.table.repair_validate(args, ctx));
  assert.equal(calls.length, 0);
  await assert.rejects(service.table.repair_validate({ ...input, updateOriginal: true }, ctx), /原工程/);
  await assert.rejects(service.table.repair_validate({ ...input, updateOriginal: "true" }, ctx));
});

// Real Git history exercises refusal/fast-forward semantics, not just command strings.
async function originalFixture(t, { dirty, diverged, ignored, failCheck, openUnity, mutateCheck } = {}) {
  const { spawnSync } = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-original-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "original"), workspaceRoot = path.join(root, "reports");
  await fs.mkdir(project); await fs.mkdir(workspaceRoot);
  const gitFile = process.env.TEST_GIT || "git";
  const g = (...args) => {
    const r = spawnSync(gitFile, args, { cwd: project, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  g("init", "-b", "main"); g("config", "user.name", "Test"); g("config", "user.email", "test@example.invalid");
  g("remote", "add", "origin", "https://github.com/owner/demo.git");
  await fs.writeFile(path.join(project, "code.txt"), "before");
  await fs.writeFile(path.join(project, ".gitignore"), "ignored.txt\nTemp/\n");
  g("add", "."); g("commit", "-m", "base"); const before = g("rev-parse", "HEAD");
  g("checkout", "-b", "repair"); await fs.writeFile(path.join(project, "code.txt"), "after");
  if (ignored) { await fs.writeFile(path.join(project, "ignored.txt"), "cloud"); g("add", "-f", "ignored.txt"); }
  g("add", "."); g("commit", "-m", "fix"); const commit = g("rev-parse", "HEAD"); g("checkout", "main");
  if (dirty) await fs.writeFile(path.join(project, dirty === "untracked" ? "new.txt" : "code.txt"), "local work");
  if (ignored) await fs.writeFile(path.join(project, "ignored.txt"), "private local");
  if (diverged) { await fs.writeFile(path.join(project, "local.txt"), "local commit"); g("add", "."); g("commit", "-m", "local"); }
  if (openUnity) { await fs.mkdir(path.join(project, "Temp")); await fs.writeFile(path.join(project, "Temp", "UnityLockfile"), "open"); }
  const profile = { repository: "owner/demo", workspaceRoot, originalProjectRoot: project, git: gitFile,
    adapter: openUnity ? "unity" : "commands", unityCli: process.execPath, editorPath: process.execPath,
    checks: [{ id: "unit", file: process.execPath, args: ["-e", mutateCheck ? "require('fs').writeFileSync('code.txt','changed during validation')" : `process.exit(${failCheck ? 1 : 0})`] }] };
  const configFile = path.join(root, "profiles.json");
  await fs.writeFile(configFile, JSON.stringify({ profiles: { demo: profile } }));
  let checkCwd;
  const service = createRepairValidation({ configFile, resolveInRoots: async (p, roots) => { assert(roots.includes(p)); return p; },
    run: async (file, args, opts) => {
      if (file === process.execPath) checkCwd = opts.cwd;
      // Test transport only: fetch the fixture's existing repair branch without networking.
      args = args.map((a) => a === "https://github.com/owner/demo.git" ? project : a);
      const r = spawnSync(file, args, { cwd: opts.cwd, encoding: "utf8", windowsHide: true });
      opts.log(Buffer.from(r.stdout || "")); opts.log(Buffer.from(r.stderr || ""));
      return { code: r.status, stdout: r.stdout || "" };
    } });
  const run = async () => {
    const j = await service.table.repair_validate({ ...input, commit, updateOriginal: true }, { allowedRoots: [workspaceRoot, project] });
    return finished(service, j.id);
  };
  return { root, project, workspaceRoot, before, commit, g, run, checkCwd: () => checkCwd };
}

test("original mode fast-forwards, validates in place and retains a durable backup reference", async (t) => {
  const f = await originalFixture(t); const r = await f.run();
  assert.equal(r.state, "passed"); assert.equal(f.checkCwd(), f.project);
  assert.equal(f.g("rev-parse", "HEAD"), f.commit); assert.equal(f.g("branch", "--show-current"), "main");
  assert.equal(f.g("rev-parse", r.update.backupRef), f.before); assert.equal(r.update.state, "applied");
  assert.equal(await fs.readFile(path.join(f.project, "code.txt"), "utf8"), "after");
  assert(!JSON.stringify(r).includes(f.project));
  const disk = JSON.parse(await fs.readFile(path.join(f.workspaceRoot, r.id, "result.json"), "utf8"));
  assert.deepEqual(disk.update, r.update);
  const second = await f.run(); assert.equal(second.state, "passed"); assert.equal(second.update.state, "unchanged");
});

test("dirty, untracked, divergent and open Unity originals are left untouched", async (t) => {
  for (const [options, reason] of [[{ dirty: true }, "original_has_uncommitted_changes"], [{ dirty: "untracked" }, "original_has_uncommitted_changes"],
    [{ diverged: true }, "original_history_diverged"], [{ openUnity: true }, "unity_editor_must_be_closed"]]) {
    const f = await originalFixture(t, options), head = f.g("rev-parse", "HEAD"), status = f.g("status", "--porcelain");
    const r = await f.run(); assert.equal(r.state, "error"); assert.equal(r.reason, reason);
    assert.equal(f.g("rev-parse", "HEAD"), head); assert.equal(f.g("status", "--porcelain"), status); assert.equal(f.checkCwd(), undefined);
  }
});

test("ignored local files are not overwritten during fast-forward", async (t) => {
  const f = await originalFixture(t, { ignored: true }); const r = await f.run();
  assert.equal(r.state, "error"); assert.equal(f.g("rev-parse", "HEAD"), f.before);
  assert.equal(await fs.readFile(path.join(f.project, "ignored.txt"), "utf8"), "private local");
  assert.equal(r.update.state, "prepared");
});

test("failed validation preserves the applied repair and its backup", async (t) => {
  const f = await originalFixture(t, { failCheck: true }); const r = await f.run();
  assert.equal(r.state, "failed"); assert.equal(r.update.state, "applied");
  assert.equal(f.g("rev-parse", "HEAD"), f.commit); assert.equal(f.g("rev-parse", r.update.backupRef), f.before);
});

test("changes during validation cannot be reported as passing the pinned commit", async (t) => {
  const f = await originalFixture(t, { mutateCheck: true }); const r = await f.run();
  assert.equal(r.state, "error"); assert.equal(r.reason, "original_changed_during_validation");
  assert.equal(await fs.readFile(path.join(f.project, "code.txt"), "utf8"), "changed during validation");
});
test("local environment rejects malformed variable maps", () => {
  const profile = { repository: "owner/demo", workspaceRoot: os.tmpdir(), adapter: "unity", unityCli: process.execPath, editorPath: process.execPath };
  for (const environment of [null, [], "text", { X: 1 }, { "BAD=KEY": "x" }, { X: "bad\0value" }])
    assert.throws(() => checkProfile({ ...profile, environment }));
});
test("Unity missing test report is incomplete even when CLI exits zero", async (t) => {
  const { service, ctx, calls } = await fixture(t, "unity");
  const r = await service.table.repair_validate(input, ctx);
  const result = await finished(service, r.id);
  assert.equal(result.state, "incomplete");
  assert.equal(result.checks[0].status, "passed");
  assert(calls[5].args.includes("EditMode"));
});
test("compile failure stops tests", async (t) => {
  const { service, ctx, calls } = await fixture(t, "unity", async (_, args) => ({ code: args[0] === "run" ? 1 : 0 }));
  const r = await service.table.repair_validate(input, ctx);
  assert.equal((await finished(service, r.id)).state, "failed");
  assert.equal(calls.length, 5);
});
test("incomplete checkout never reaches project execution", async (t) => {
  const { service, ctx, calls } = await fixture(t, "unity", async (_, args) => ({ code: args.includes("diff") ? 1 : 0 }));
  const r = await service.table.repair_validate(input, ctx);
  assert.equal((await finished(service, r.id)).state, "error");
  assert.equal(calls.length, 4);
  assert(!calls.some((c) => c.args[0] === "run"));
});
test("emergency stop aborts background work and concurrent runs are rejected", async (t) => {
  const { service, ctx } = await fixture(t, "commands", async (_, args, opts) => {
    if (args.includes("fetch")) return new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ code: null, cancelled: true }), { once: true }));
    return { code: 0 };
  });
  const r = await service.table.repair_validate(input, ctx);
  await assert.rejects(service.table.repair_validate(input, ctx), /已有/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  service.stopAll();
  assert.equal((await finished(service, r.id)).state, "cancelled");
});
test("NUnit aggregate handles zero/skipped/failed/malformed results conservatively", () => {
  assert.equal(nunitResult('<test-run total="2" passed="2" failed="0" result="Passed">').status, "passed");
  assert.equal(nunitResult('<test-run total="2" passed="1" failed="1" result="Failed">').status, "failed");
  for (const xml of ["", '<test-run total="0" passed="0" failed="0" result="Passed">', '<test-run total="2" passed="1" failed="0" result="Passed">', '<test-run result="Passed">'])
    assert.equal(nunitResult(xml).status, "incomplete");
});

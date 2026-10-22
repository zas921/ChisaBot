import { expect, test } from "bun:test";
import { createRepairService, repairProjectSchema } from "../src/repair/service";
const sha = "b".repeat(40);
function fixture(options: { pushOk?: boolean; lastStatus?: string; mismatch?: boolean; resultState?: string; updateOriginal?: boolean; update?: unknown; reason?: string } = {}) {
  const project = { id: "demo", name: "Demo", workspaceId: "ws", deviceId: "pc", profileId: "local", repository: "owner/demo", allowPush: true, updateOriginal: options.updateOriginal };
  const jobs = new Map<string, any>();
  const calls: any[] = [];
  const database = { $client: { unsafe: async (query: string, params: any[] = []) => {
    if (query.startsWith("SELECT data FROM chisabot_repair_projects")) return params[0] === "owner" ? [{ data: project }] : [];
    if (query.startsWith("INSERT INTO chisabot_repair_jobs")) { jobs.set(params[0], JSON.parse(params[3])); return []; }
    if (query.startsWith("UPDATE chisabot_repair_jobs SET state =")) { jobs.set(params[0], JSON.parse(params[2])); return []; }
    if (query.startsWith("SELECT data FROM chisabot_repair_jobs")) { const j = jobs.get(params[0]); return j?.owner === params[1] ? [{ data: j }] : []; }
    return [];
  } } };
  const cloud = { isCloudNode: () => false, repair: {
    workspace: async () => ({ ready: true, repository: "owner/demo" }),
    createSession: async () => ({ id: "session" }), send: async (...args: any[]) => { calls.push(["send", ...args]); },
    sessionDetail: async () => ({ live: null, session: { status: "idle", title: "Bug" }, messages: [{ role: "assistant", status: options.lastStatus || "done" }] }),
    pushSession: async () => { calls.push(["push"]); return { ok: options.pushOk !== false, head: sha, prUrl: "https://github.com/owner/demo/pull/1" }; },
    addNotice: async () => {}, stop: async () => {},
  } };
  const hub = { invoke: async (input: any) => {
    calls.push([input.operation, input.args]);
    if (input.operation === "repair_validate") return { id: "validation" };
    return { state: options.resultState || "passed", commit: options.mismatch ? "a".repeat(40) : sha, updateOriginal: options.updateOriginal, update: options.update, reason: options.reason, checks: [{ id: "compile", status: "passed", exitCode: 0, secret: "must drop" }] };
  } };
  const devices = { get: async () => ({ ownerUserId: "owner", id: "pc", revoked: false, paused: false }) };
  const service = createRepairService({ database, cloud, hub, devices } as any);
  return { service, calls, jobs };
}
test("repair -> approved GitHub push -> exact SHA acceptance -> sanitized result", async () => {
  const { service, calls, jobs } = fixture();
  try {
    const job = await service.start("owner", "bot", "demo", "Fix issue");
    await service.tick(); await service.tick();
    expect(jobs.get(job.id).state).toBe("passed");
    expect(calls.find((c) => c[0] === "repair_validate")[1]).toEqual({ profileId: "local", repository: "owner/demo", commit: sha });
    expect(JSON.stringify(jobs.get(job.id).result)).not.toContain("secret");
    expect(calls.filter((c) => c[0] === "send")).toHaveLength(1); // No local log feedback into Claude.
  } finally { service.stop(); }
});

test("original mode is explicit, forwarded and requires confirmed application", async () => {
  const update = { beforeCommit: "a".repeat(40), targetCommit: sha, afterCommit: sha, state: "applied", backupRef: "refs/chisabot/repair/12345678-1234-1234-1234-123456789abc", privatePath: "drop me" };
  for (const applied of [true, false]) {
    const { service, calls, jobs } = fixture({ updateOriginal: true, update: applied ? update : undefined });
    try {
      const job = await service.start("owner", "bot", "demo", "Fix issue"); await service.tick(); await service.tick();
      expect(calls.find((c) => c[0] === "repair_validate")[1].updateOriginal).toBe(true);
      expect(jobs.get(job.id).state).toBe(applied ? "passed" : "error");
      expect(JSON.stringify(jobs.get(job.id).result ?? null)).not.toContain("drop me");
    } finally { service.stop(); }
  }
  expect(repairProjectSchema.parse({ id: "a", name: "a", workspaceId: "ws", deviceId: "pc", profileId: "p", allowPush: true }).updateOriginal).toBe(false);
});

test("only known local failure codes are propagated", async () => {
  for (const reason of ["original_has_uncommitted_changes", "C:/private/log"]) {
    const { service, jobs } = fixture({ resultState: "error", reason });
    try {
      const job = await service.start("owner", "bot", "demo", "Fix issue"); await service.tick(); await service.tick();
      expect(jobs.get(job.id).reason).toBe(reason.startsWith("original_") ? reason : undefined);
    } finally { service.stop(); }
  }
});
test("stopped Claude and failed push never trigger local execution", async () => {
  for (const options of [{ lastStatus: "stopped" }, { pushOk: false }]) {
    const { service, calls, jobs } = fixture(options);
    try {
      const job = await service.start("owner", "bot", "demo", "Fix issue"); await service.tick();
      expect(jobs.get(job.id).state).toBe("error");
      expect(calls.some((c) => c[0] === "repair_validate")).toBe(false);
    } finally { service.stop(); }
  }
});
test("commit mismatch is interrupted and missing tests remain incomplete", async () => {
  for (const [options, state] of [[{ mismatch: true }, "interrupted"], [{ resultState: "incomplete" }, "incomplete"]] as const) {
    const { service, jobs } = fixture(options);
    try {
      const job = await service.start("owner", "bot", "demo", "Fix issue"); await service.tick(); await service.tick();
      expect(jobs.get(job.id).state).toBe(state);
    } finally { service.stop(); }
  }
});
test("cross-owner tasks refused; approval cannot be omitted", async () => {
  const { service } = fixture();
  try { await expect(service.start("stranger", "bot", "demo", "Fix issue")).rejects.toThrow(); }
  finally { service.stop(); }
  expect(repairProjectSchema.safeParse({ id: "a", name: "a", workspaceId: "ws", deviceId: "pc", profileId: "p" }).success).toBe(false);
});

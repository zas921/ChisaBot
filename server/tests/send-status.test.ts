import { expect, test } from "bun:test";
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { of } from "rxjs";
import type { Database } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";

const owner = "receipt-owner", bot = "receipt-bot", thread = "receipt-thread";
class NeverRunAgent extends AbstractAgent { protected run() { throw new Error("This test must stop before invoking the model"); return of(); } }
async function fixture() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let row = { agent_id: bot, locked: false, persisted: false, queued: false };
  let failStatus = false;
  let firstThreadRead: (() => Promise<unknown[]>) | undefined;
  const unsafe = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("AS persisted")) {
      if (failStatus) throw new Error("Transient status database failure");
      return params?.[2] === owner ? [row] : [];
    }
    if (sql === "SELECT * FROM openbot_local_threads WHERE id = $1" && firstThreadRead) return firstThreadRead();
    return [];
  };
  const database = { $client: { unsafe, begin: async (callback: (sql: { unsafe: typeof unsafe }) => Promise<unknown>) => callback({ unsafe }) } } as unknown as Database;
  const backend = await createLocalConversations(database);
  calls.length = 0;
  const read = (agentId = bot, actorId = owner, messageId = "question") => backend.handle(new Request(`http://localhost/api/copilotkit/threads/${thread}/send-status?agentId=${encodeURIComponent(agentId)}&messageId=${encodeURIComponent(messageId)}`), actorId);
  return { backend, calls, read, setRow: (next: Partial<typeof row>) => { row = { ...row, ...next }; }, failStatus: () => { failStatus = true; }, blockThreadRead: (read: () => Promise<unknown[]>) => { firstThreadRead = read; } };
}

test("an idle transcript without this ID is unknown, never proof the send failed", async () => {
  const f = await fixture();
  const response = await f.read();
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ threadId: thread, messageId: "question", received: null, persisted: false, running: false, phase: "unknown", runId: null });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.sql).not.toContain("SELECT *");
  expect(f.calls[0]!.sql).toContain("messages @>");
});
test("persisted and queued user IDs are positive receipts without returning history", async () => {
  const f = await fixture();
  f.setRow({ persisted: true });
  expect(await (await f.read())?.json()).toMatchObject({ received: true, persisted: true, phase: "persisted" });
  f.setRow({ persisted: false, queued: true });
  expect(await (await f.read())?.json()).toMatchObject({ received: true, persisted: false, phase: "received" });
});
test("a running lease alone does not claim receipt of another message", async () => {
  const f = await fixture();
  f.setRow({ locked: true });
  expect(await (await f.read())?.json()).toMatchObject({ received: null, running: true, phase: "unknown" });
});
test("ownership and Bot binding apply before exposing any receipt", async () => {
  const f = await fixture();
  f.setRow({ persisted: true });
  expect((await f.read(bot, "other-owner"))?.status).toBe(404);
  expect((await f.read("other-bot"))?.status).toBe(404);
  expect((await f.read(bot, ""))?.status).toBe(401);
  expect((await f.read(bot, owner, ""))?.status).toBe(400);
});
test("status storage failures remain HTTP failures instead of negative receipts", async () => {
  const f = await fixture(); f.failStatus();
  await expect(f.read()).rejects.toThrow("Transient status database failure");
});
test("runner input is acknowledged before any lease or snapshot write finishes", async () => {
  const f = await fixture();
  let failRead!: (reason: Error) => void;
  f.blockThreadRead(() => new Promise((_, reject) => { failRead = reject; }));
  const input = { threadId: thread, runId: "pending-run", messages: [{ id: "question", role: "user", content: "Wait for persistence" }], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
  const stream = f.backend.runner.run({ threadId: thread, agent: new NeverRunAgent({ agentId: bot, threadId: thread }), input });
  const finished = new Promise<void>((resolve) => stream.subscribe({ error: () => resolve(), complete: () => resolve() }));
  try {
    expect(await (await f.read())?.json()).toMatchObject({ received: true, persisted: false, running: true, phase: "received", runId: "pending-run" });
    expect(await (await f.read(bot, owner, "another-message"))?.json()).toMatchObject({ received: null, persisted: false, running: true });
    f.backend.runner.run({ threadId: thread, agent: new NeverRunAgent({ agentId: bot, threadId: thread }), input: { ...input, runId: "joining-run", messages: [{ id: "joining-message", role: "user", content: "Concurrent supplement" }] } });
    expect(await (await f.read(bot, owner, "joining-message"))?.json()).toMatchObject({ received: true, persisted: false, running: true, phase: "received" });
    expect(f.calls.some((call) => call.sql.startsWith("UPDATE openbot_local_threads SET run_id"))).toBe(false);
  } finally {
    failRead(new Error("End simulated stalled pre-persistence read"));
    await finished;
  }
});

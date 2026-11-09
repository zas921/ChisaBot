import { expect, spyOn, test } from "bun:test";
import type { Database } from "../src/db/client";
import { LocalConversationError, type LocalRunControl } from "../src/local-conversations";
import { currentWorkerResultDelivery, type InboxItem, type ThreadInbox } from "../src/thread-inbox";
import { createWorkerService, type WorkerServiceOptions } from "../src/workers/service";

/** A clock that runs the service's real timers, without waiting fifteen real minutes. */
function virtualClock() {
  let now = Date.now();
  const timers = new Map<object, { due: number; fire: () => void }>();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((handler, delay = 0, ...args) => {
    const timer = { unref() {} };
    timers.set(timer, { due: now + Number(delay), fire: () => { if (typeof handler === "function") handler(...args); } });
    return timer as ReturnType<typeof setTimeout>;
  });
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => { timers.delete(timer as object); });
  return {
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].fire();
      }
      now = end;
    },
    restore() { timeout.mockRestore(); clear.mockRestore(); date.mockRestore(); },
  };
}

async function settle() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function harness() {
  type Row = Record<string, unknown> & { id: string; status: string; owner_user_id: string };
  const rows = new Map<string, Row>();
  const inboxRows = new Map<string, InboxItem>();
  const runs = new Map<string, { complete: (result: { replyText: string }) => void; fail: (error: Error) => void }>();
  const deliveries: string[] = [];
  const stopped: string[] = [];
  let parentActive = false, paused = false, waiting = false, lockRefusals = 0, attempts = 0;
  let firstThread: string | undefined;
  let signal: AbortSignal | undefined;
  let onStarted!: () => void;
  const started = new Promise<void>((resolve) => { onStarted = resolve; });
  const sql = {
    async unsafe(statement: string, args: unknown[] = []) {
      const row = rows.get(args[0] as string);
      if (statement.startsWith("SELECT count(*)")) return [{ n: [...rows.values()].filter((item) => ["queued", "running", "waiting"].includes(item.status)).length }];
      if (statement.startsWith("INSERT INTO chisabot_workers")) {
        const inserted = {
          id: args[0] as string, owner_user_id: args[1] as string, parent_thread_id: args[2], agent_id: args[3], thread_id: args[4],
          title: args[5], task: args[6], status: "queued", plan: JSON.parse(args[7] as string), step: null,
          result: null, error: null, result_message_id: null, created_at: new Date(), started_at: null, finished_at: null,
        };
        rows.set(inserted.id, inserted);
        return [{ ...inserted }];
      }
      if (statement.startsWith("SELECT * FROM chisabot_workers WHERE status = 'queued'")) return [...rows.values()].filter((item) => item.status === "queued").map((item) => ({ ...item }));
      if (statement.startsWith("SELECT owner_user_id")) return [{ owner_user_id: "owner", n: [...rows.values()].filter((item) => item.status === "running").length }];
      if (statement.startsWith("SELECT * FROM chisabot_workers WHERE id")) return row?.id === args[0] ? [{ ...row }] : [];
      if (statement.startsWith("SELECT messages")) return [];
      if (statement.includes("SELECT t.archived")) return [{ archived: false, waiting }];
      if (!row) throw new Error(`Missing row for ${statement}`);
      if (statement.startsWith("UPDATE chisabot_workers SET status = 'running'")) {
        row.status = "running";
        if (statement.includes("started_at")) row.started_at = new Date();
        return [{ id: row.id }];
      }
      if (statement.startsWith("UPDATE chisabot_workers SET status = $2")) {
        if (!["queued", "running", "waiting"].includes(row.status)) return [];
        Object.assign(row, { status: args[1], result: args[2], error: args[3], step: args[4], finished_at: new Date() });
        return [{ ...row }];
      }
      if (statement.startsWith("UPDATE chisabot_workers SET result_message_id")) { row.result_message_id = args[1]; return []; }
      if (statement.startsWith("UPDATE chisabot_workers SET status = 'cancelled'")) {
        row.status = "cancelled";
        row.error = args[1];
        row.finished_at = new Date();
        return [{ ...row }];
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
  };
  const options: WorkerServiceOptions = {
    database: { $client: sql } as unknown as Database,
    inbox: {
      enqueue: async ({ threadId, message, kind }: Parameters<ThreadInbox["enqueue"]>[0]) => {
        if (inboxRows.has(message.id)) return false;
        inboxRows.set(message.id, { id: message.id, threadId, message, kind: kind ?? "message", status: paused ? "paused" : "queued", runId: null, createdAt: new Date().toISOString(), readAt: null });
        return true;
      },
      queued: async (threadId: string) => [...inboxRows.values()].filter((item) => item.threadId === threadId && item.status === "queued"),
      retryWorkerResults: async () => {},
      isPaused: async () => paused,
    } as unknown as ThreadInbox,
    control: {
      observe: () => () => {}, isActive: (threadId: string) => threadId === "parent" && parentActive,
      stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return true; },
    } as unknown as LocalRunControl,
    agentOfThread: async () => "bot",
    runTurn: async (input) => {
      return await new Promise<{ replyText: string }>((resolve, reject) => {
        runs.set(input.threadId, { complete: resolve, fail: reject });
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("cancelled")), { once: true });
        if (!firstThread) { firstThread = input.threadId; signal = input.signal; onStarted(); }
      });
    },
    deliverTurn: async (input) => {
      attempts++;
      if (lockRefusals > 0) {
        lockRefusals--;
        throw new LocalConversationError("Thread already running", 409);
      }
      const ids = currentWorkerResultDelivery(input.threadId, input.runId!) ?? new Set();
      const contents: string[] = [];
      for (const id of ids) {
        const item = inboxRows.get(id);
        if (!item || item.status !== "queued" || item.kind !== "worker_result") continue;
        contents.push(String(item.message.content));
        item.status = "answered";
      }
      deliveries.push(contents.join("\n"));
      return { replyText: "delivered" };
    },
  };
  return {
    service: createWorkerService(options), started, deliveries, stopped,
    signal: () => signal!,
    complete: (text: string) => runs.get(firstThread!)!.complete({ replyText: text }),
    fail: (error: Error, workerId?: string) => runs.get(workerId ? `worker-${workerId}` : firstThread!)!.fail(error),
    setParentActive: (value: boolean) => { parentActive = value; },
    setPaused: (value: boolean) => { paused = value; },
    setWaiting: (value: boolean) => { waiting = value; },
    setLockRefusals: (value: number) => { lockRefusals = value; },
    attempts: () => attempts,
    workerRuns: () => runs.size,
    inboxRows,
  };
}

const request = { ownerUserId: "owner", agentId: "bot", parentThreadId: "parent", title: "收集数据", task: "拉取全部分页并汇总。" };

test("a data collection worker survives two hours and delivers the completed result", async () => {
  const clock = virtualClock();
  try {
    const task = harness();
    const worker = await task.service.start(request);
    await task.started;
    clock.advance(2 * 60 * 60_000);
    await settle();
    expect(task.signal().aborted).toBe(false);
    expect((await task.service.get(worker.id))?.status).toBe("running");
    expect(task.deliveries).toHaveLength(0);
    task.complete("全部分页已收集，汇总为 12000 条。");
    await settle();
    expect((await task.service.get(worker.id))?.status).toBe("done");
    expect(task.deliveries).toHaveLength(1);
    expect(task.deliveries[0]).toContain("12000 条");
  } finally { clock.restore(); }
});

test("a long worker still stops when the user cancels it", async () => {
  const clock = virtualClock();
  try {
    const task = harness();
    const worker = await task.service.start(request);
    await task.started;
    clock.advance(2 * 60 * 60_000);
    await task.service.cancel("parent", worker.id, "owner", { quiet: true });
    await settle();
    expect(task.signal().aborted).toBe(true);
    expect((await task.service.get(worker.id))?.status).toBe("cancelled");
    expect(task.stopped).toEqual([`worker-${worker.id}`]);
    expect(task.deliveries).toHaveLength(0);
  } finally { clock.restore(); }
});

test("a real worker failure still fails and explains the cause", async () => {
  const task = harness();
  const worker = await task.service.start(request);
  await task.started;
  task.fail(new Error("数据源拒绝访问"));
  await settle();
  const result = await task.service.get(worker.id);
  expect(result?.status).toBe("failed");
  expect(result?.error).toBe("数据源拒绝访问");
  expect(task.deliveries).toHaveLength(1);
  expect(task.deliveries[0]).toContain("数据源拒绝访问");
});

test("two failed workers wake their idle parent once after a stale lease, without rerunning either worker", async () => {
  const clock = virtualClock();
  try {
    const task = harness();
    task.setParentActive(true);
    const a = await task.service.start(request);
    const b = await task.service.start({ ...request, title: "验证数据" });
    await settle();
    task.fail(new Error("数据源拒绝访问"), a.id);
    task.fail(new Error("校验连接中断"), b.id);
    await settle();
    expect(task.attempts()).toBe(0);
    expect([...task.inboxRows.values()].map((item) => item.status)).toEqual(["queued", "queued"]);

    task.setParentActive(false);
    task.setLockRefusals(1);
    clock.advance(1_000);
    await settle();
    expect(task.attempts()).toBe(1);
    expect(task.deliveries).toHaveLength(0);
    clock.advance(2_000);
    await settle();
    expect(task.attempts()).toBe(2);
    expect(task.deliveries).toHaveLength(1);
    expect(task.deliveries[0]).toContain("数据源拒绝访问");
    expect(task.deliveries[0]).toContain("校验连接中断");
    expect(task.workerRuns()).toBe(2);
    clock.advance(90_000);
    await settle();
    expect(task.attempts()).toBe(2);
  } finally { clock.restore(); }
});

test("an explicit parent pause or pending approval keeps failed worker results without opening the parent", async () => {
  for (const blocked of ["paused", "waiting"] as const) {
    const task = harness();
    if (blocked === "paused") task.setPaused(true); else task.setWaiting(true);
    const worker = await task.service.start(request);
    await task.started;
    task.fail(new Error("失败"));
    await settle();
    expect(task.attempts()).toBe(0);
    expect(task.inboxRows.get(`worker-result-${worker.id}`)?.status).toBe(blocked === "paused" ? "paused" : "queued");
  }
});

test("a worker result wakes after approval resolves without a new child completion", async () => {
  const clock = virtualClock();
  try {
    const task = harness();
    task.setWaiting(true);
    await task.service.start(request);
    await task.started;
    task.complete("finished while waiting");
    await settle();
    expect(task.attempts()).toBe(0);
    task.setWaiting(false);
    clock.advance(1000);
    await settle();
    expect(task.deliveries).toHaveLength(1);
    expect(task.workerRuns()).toBe(1);
  } finally { clock.restore(); }
});

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { Observable, of } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const collect = (source: Observable<BaseEvent>) => new Promise<BaseEvent[]>((resolve, reject) => {
  const events: BaseEvent[] = [];
  source.subscribe({ next: (event) => events.push(event), complete: () => resolve(events), error: reject });
});

suite("conversation pressure does not stall unrelated leases", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  let unsafe: ReturnType<typeof createDatabase>["$client"]["unsafe"];
  let intercept: ((...args: Parameters<typeof unsafe>) => unknown) | undefined;
  const owner = `pressure-${crypto.randomUUID()}`;
  const bot = `${owner}-bot`;
  beforeAll(async () => {
    const real = createDatabase(testDatabaseUrl(), TEST_POOL);
    unsafe = real.$client.unsafe.bind(real.$client);
    const client = new Proxy(real.$client, { get(target, key) {
      if (key === "unsafe") return intercept ?? unsafe;
      return Reflect.get(target, key, target);
    } });
    database = Object.create(real);
    Object.defineProperty(database, "$client", { value: client });
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });
  async function fixture() {
    const threadId = crypto.randomUUID();
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const input: RunAgentInput = { threadId, runId: crypto.randomUUID(), messages: [{ id: "request", role: "user", content: "Continue this task" }], tools: [], context: [], state: {}, forwardedProps: {} };
    return { threadId, input };
  }

  test("lease renewal bypasses a blocked durable event and never renews after completion", async () => {
    const f = await fixture();
    const blocked = deferred(), release = deferred();
    const originalInterval = globalThis.setInterval;
    let heartbeat: (() => void) | undefined;
    let renewals = 0;
    let blockOnce = true;
    const timers = spyOn(globalThis, "setInterval").mockImplementation((fn, delay, ...args) => {
      if (delay === 30_000) heartbeat = () => { if (typeof fn === "function") fn(...args); };
      return originalInterval(fn, delay, ...args);
    });
    intercept = (...args: Parameters<typeof unsafe>) => {
      if (String(args[0]).includes("SET lock_expires_at")) renewals++;
      if (blockOnce && String(args[0]).includes("INSERT INTO openbot_local_events")) {
        blockOnce = false; blocked.resolve();
        return release.promise.then(() => unsafe(...args)) as ReturnType<typeof unsafe>;
      }
      return unsafe(...args);
    };
    const agent = new class extends AbstractAgent {
      run(input: RunAgentInput) { return of(
        { type: EventType.RUN_STARTED, threadId: f.threadId, runId: input.runId },
        { type: EventType.RUN_FINISHED, threadId: f.threadId, runId: input.runId },
      ) as Observable<BaseEvent>; }
    }({ agentId: bot });
    const run = collect(backend.runner.run({ ...f, agent }));
    try {
      await Promise.race([blocked.promise, run.then(() => { throw new Error("Run ended before the blocked write"); })]);
      expect(heartbeat).toBeDefined();
      heartbeat!();
      for (let i = 0; i < 30 && !renewals; i++) await Bun.sleep(5);
      expect(renewals).toBe(1);
      const [lease] = await unsafe("SELECT lock_expires_at > now() AS live FROM openbot_local_threads WHERE id = $1", [f.threadId]);
      expect(lease?.live).toBe(true);
      release.resolve();
      expect((await run).at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(await backend.runner.isRunning({ threadId: f.threadId })).toBe(false);
      const count = renewals;
      await Bun.sleep(30);
      expect(renewals).toBe(count);
    } finally { release.resolve(); await run.catch(() => {}); intercept = undefined; timers.mockRestore(); }
  });

  test("progress and identity reads never fetch history, while authorization remains enforced", async () => {
    const f = await fixture();
    const reads: string[] = [];
    intercept = (...args: Parameters<typeof unsafe>) => {
      reads.push(String(args[0])); return unsafe(...args);
    };
    try {
      expect((await backend.client.getThread({ threadId: f.threadId, userId: owner })).id).toBe(f.threadId);
      const url = `http://localhost/api/copilotkit/threads/${f.threadId}/workers`;
      expect((await backend.handle(new Request(url), owner))?.status).toBe(200);
      expect((await backend.handle(new Request(url + "?agentId=other"), owner))?.status).toBe(404);
      await expect(backend.client.getThread({ threadId: f.threadId, userId: "stranger" })).rejects.toMatchObject({ status: 404 });
      expect(reads.filter((sql) => /SELECT\s+\*|SELECT[^;]*\bmessages\b/i.test(sql))).toEqual([]);
    } finally { intercept = undefined; }
  });

  test("10 MB archived history is compact in the reducer and survives streaming unchanged", async () => {
    const f = await fixture();
    const history: Message[] = Array.from({ length: 100 }, (_, i) => [
      { id: `user-${i}`, role: "user", content: `Completed old task ${i}` },
      { id: `assistant-${i}`, role: "assistant", content: "Archived output " + "字".repeat(100_000) },
    ]).flat() as Message[];
    await database.$client.unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [f.threadId, JSON.stringify(history)]);
    let executionBytes = 0;
    const agent = new class extends AbstractAgent {
      run(input: RunAgentInput) {
        executionBytes = JSON.stringify(input.messages).length;
        return of(
          { type: EventType.RUN_STARTED, threadId: f.threadId, runId: input.runId },
          { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
          ...Array.from({ length: 20 }, () => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "片段" })),
          { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
          { type: EventType.RUN_FINISHED, threadId: f.threadId, runId: input.runId },
        ) as Observable<BaseEvent>;
      }
    }({ agentId: bot });
    expect((await collect(backend.runner.run({ ...f, agent }))).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(executionBytes).toBeLessThan(500_000);
    const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
    expect(saved.messages.slice(0, history.length)).toEqual(history);
    expect(saved.messages.at(-1)?.content).toBe("片段".repeat(20));
  });

  test("parallel long snapshot writes preserve large bigint cursors without driver coercion", async () => {
    await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const f = await fixture();
      const cursor = 9007199254740993n + BigInt(i);
      for (let n = 0; n < 12; n++) {
        const messages = JSON.stringify([{ id: String(n), role: "assistant", content: "字".repeat(20_000 + i) }]);
        await database.$client.unsafe(
          "UPDATE openbot_local_threads SET messages = $2::text::jsonb, snapshot_sequence = $3::text::bigint WHERE id = $1",
          [f.threadId, messages, (cursor + BigInt(n)).toString()],
        );
        const [row] = await database.$client.unsafe("SELECT snapshot_sequence::text AS cursor FROM openbot_local_threads WHERE id = $1", [f.threadId]);
        expect(row?.cursor).toBe((cursor + BigInt(n)).toString());
      }
    }));
  });
});

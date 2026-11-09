import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { of, type Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { withWorkerResultDelivery, WORKER_RESULT_MARKER, type InboxKind } from "../src/thread-inbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { createWorkerService } from "../src/workers/service";
import { currentWorkerResultDelivery } from "../src/thread-inbox";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("worker result only wakes", () => {
  const owner = `worker-wake-test-${randomUUID()}`;
  const bot = `${owner}-bot`;
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const threads: string[] = [];

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
    await database.$client.unsafe("CREATE TABLE IF NOT EXISTS approval_requests (owner_user_id text, action jsonb, status text)");
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_workers WHERE owner_user_id = $1", [owner]);
    for (const threadId of threads) {
      await database.$client.unsafe("DELETE FROM chisabot_thread_inbox WHERE thread_id = $1", [threadId]);
      await database.$client.unsafe("DELETE FROM chisabot_thread_inbox_control WHERE thread_id = $1", [threadId]);
      await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE id = $1", [threadId]);
    }
    await database.$client.close();
  });

  async function fixture(failures = 0) {
    const threadId = randomUUID();
    threads.push(threadId);
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const inputs: string[][] = [];
    class Probe extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        inputs.push(input.messages.map((message) => message.id));
        const messageId = randomUUID();
        return of(
          { type: EventType.RUN_STARTED, threadId, runId: input.runId } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "继续尚未完成的步骤。" } as BaseEvent,
          { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
          inputs.length <= failures
            ? { type: EventType.RUN_ERROR, message: "Transient model stream disconnected" } as BaseEvent
            : { type: EventType.RUN_FINISHED, threadId, runId: input.runId } as BaseEvent,
        );
      }
    }
    return {
      threadId, inputs,
      queue: (id: string, kind: InboxKind = "worker_result") => backend.inbox.enqueue({
        threadId, ownerUserId: owner, kind,
        message: { id, role: "user", content: kind === "worker_result" ? `${WORKER_RESULT_MARKER}${id}:failed⟧\n任务未完成。` : "历史普通补话" } as Message,
      }),
      wake: (ids: string[]) => {
        const input: RunAgentInput = { threadId, runId: randomUUID(), messages: [], state: {}, context: [], tools: [], forwardedProps: {} };
        return withWorkerResultDelivery(threadId, input.runId, new Set(ids), () => new Promise<BaseEvent[]>((resolve, reject) => {
          const events: BaseEvent[] = [];
          backend.runner.run({ threadId, agent: new Probe(), input, persistedInputMessages: [] }).subscribe({
            next: (event) => events.push(event), error: reject, complete: () => resolve(events),
          });
        }));
      },
    };
  }

  test("a single wake reads only its new worker result batch and cannot replay after completion", async () => {
    const f = await fixture();
    await f.queue("ordinary", "message");
    await f.queue("older-worker");
    await f.queue("new-a");
    await f.queue("new-b");
    const events = await f.wake(["new-a", "new-b", "ordinary"]);
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
    expect(f.inputs).toEqual([["new-a", "new-b"]]);
    expect((await backend.inbox.get(f.threadId, "new-a"))?.status).toBe("answered");
    expect((await backend.inbox.get(f.threadId, "new-b"))?.status).toBe("answered");
    expect((await backend.inbox.get(f.threadId, "older-worker"))?.status).toBe("queued");
    expect((await backend.inbox.get(f.threadId, "ordinary"))?.status).toBe("queued");
    expect(await f.wake(["new-a", "new-b"])).toEqual([]);
    expect(f.inputs).toHaveLength(1);
  });

  test("a user stop that holds the result before a wake starts prevents any model call", async () => {
    const f = await fixture();
    await f.queue("worker-notice");
    await backend.inbox.pause(f.threadId);
    expect(await f.wake(["worker-notice"])).toEqual([]);
    expect(f.inputs).toEqual([]);
    expect((await backend.inbox.get(f.threadId, "worker-notice"))?.status).toBe("paused");
  });

  test("a failed parent resumes saved worker results without replaying ordinary notes or duplicating history", async () => {
    const f = await fixture(1);
    await f.queue("ordinary-held", "message");
    await f.queue("result-resume");
    const first = await f.wake(["result-resume"]);
    expect(first.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);
    expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
    expect((await backend.inbox.get(f.threadId, "result-resume"))?.status).toBe("paused");
    await backend.inbox.retryWorkerResults(f.threadId, ["result-resume", "ordinary-held"]);
    expect(await backend.inbox.isPaused(f.threadId)).toBe(false);
    expect((await backend.inbox.get(f.threadId, "ordinary-held"))?.status).toBe("paused");
    const second = await f.wake(["result-resume"]);
    expect(second.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]?.filter((id) => id === "result-resume")).toHaveLength(1);
    expect(f.inputs[1]).not.toContain("ordinary-held");
    expect((await backend.inbox.get(f.threadId, "result-resume"))?.status).toBe("answered");
    const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
    expect(saved.messages.filter((message) => message.id === "result-resume")).toHaveLength(1);
    await backend.inbox.retryWorkerResults(f.threadId, ["result-resume"]);
    expect(await f.wake(["result-resume"])).toEqual([]);
    expect(f.inputs).toHaveLength(2);
  });

  test("explicit Stop after an automatic failure blocks retry and future arrivals", async () => {
    const f = await fixture(1);
    await f.queue("stopped-result");
    await f.wake(["stopped-result"]);
    await backend.inbox.pause(f.threadId);
    await f.queue("late-result");
    await backend.inbox.retryWorkerResults(f.threadId, ["stopped-result", "late-result"]);
    expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
    expect(await f.wake(["stopped-result", "late-result"])).toEqual([]);
    expect(f.inputs).toHaveLength(1);
    expect((await backend.inbox.get(f.threadId, "late-result"))?.status).toBe("paused");
  });

  test("automatic delivery attempts are bounded durably rather than resetting on each scheduler wake", async () => {
    const f = await fixture(20);
    await f.queue("bounded-result");
    for (let attempt = 0; attempt < 5; attempt++) {
      await backend.inbox.retryWorkerResults(f.threadId, ["bounded-result"]);
      await f.wake(["bounded-result"]);
    }
    expect(f.inputs).toHaveLength(3);
    expect((await backend.inbox.get(f.threadId, "bounded-result"))?.status).toBe("paused");
    expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
  });

  test("restart recovery allows unfinished worker results but preserves user Stop and withdrawn results", async () => {
    const resume = await fixture();
    const stopped = await fixture();
    await resume.queue("restart-worker");
    await resume.queue("restart-ordinary", "message");
    await resume.queue("withdrawn-worker");
    await backend.inbox.withdraw(resume.threadId, "withdrawn-worker");
    await stopped.queue("stop-worker");
    await backend.inbox.pause(stopped.threadId);
    await backend.inbox.claim(resume.threadId, "lost-run", new Set(["restart-worker"]));
    await backend.inbox.releaseInterrupted();
    await backend.inbox.retryWorkerResults(resume.threadId, ["restart-worker", "restart-ordinary", "withdrawn-worker"]);
    await backend.inbox.retryWorkerResults(stopped.threadId, ["stop-worker"]);
    expect((await backend.inbox.get(resume.threadId, "restart-ordinary"))?.status).toBe("paused");
    expect((await backend.inbox.get(resume.threadId, "withdrawn-worker"))?.status).toBe("withdrawn");
    expect(await stopped.wake(["stop-worker"])).toEqual([]);
    expect(stopped.inputs).toHaveLength(0);
    await resume.wake(["restart-worker"]);
    expect(resume.inputs).toEqual([["restart-worker"]]);
    expect((await backend.inbox.get(resume.threadId, "restart-worker"))?.status).toBe("answered");
  });

  test("real service recovers a durable completed result and continues after a failed parent without a browser", async () => {
    const f = await fixture(1);
    let children = 0;
    const service = createWorkerService({
      database, inbox: backend.inbox, control: backend.control, agentOfThread: async () => bot,
      runTurn: async () => { children++; return { replyText: "must not rerun child" }; },
      deliverTurn: async (input) => {
        const ids = [...currentWorkerResultDelivery(input.threadId, input.runId!)!];
        const events = await f.wake(ids);
        if (events.some((e) => e.type === EventType.RUN_ERROR)) throw new Error("model disconnected");
        return { replyText: "continued from saved history" };
      },
    });
    await service.ensure();
    const id = randomUUID();
    await database.$client.unsafe(`INSERT INTO chisabot_workers
      (id, owner_user_id, parent_thread_id, agent_id, thread_id, title, task, status, result, finished_at)
      VALUES ($1,$2,$3,$4,$5,'Completed child','Task','done','Saved result',now())`, [id, owner, f.threadId, bot, `worker-${id}`]);
    await service.reconcileDeliveries();
    const deadline = Date.now() + 6500;
    while ((await backend.inbox.get(f.threadId, `worker-result-${id}`))?.status !== "answered" && Date.now() < deadline) await Bun.sleep(30);
    expect((await backend.inbox.get(f.threadId, `worker-result-${id}`))?.status).toBe("answered");
    expect(f.inputs).toHaveLength(2);
    expect(children).toBe(0);
    await service.reconcileDeliveries();
    await Bun.sleep(1200); // Let the completed delivery drain remove its timer.
    expect(f.inputs).toHaveLength(2);
  }, 10000);

  test("an old explicit Stop result stays held after a new turn encounters a different error", async () => {
    const f = await fixture(1);
    await f.queue("old-stopped-result");
    await backend.inbox.pause(f.threadId);
    await backend.inbox.startExplicitTurn(f.threadId);
    await f.queue("new-result");
    await f.wake(["new-result"]);
    await backend.inbox.retryWorkerResults(f.threadId, ["new-result", "old-stopped-result"]);
    expect((await backend.inbox.get(f.threadId, "old-stopped-result"))?.status).toBe("paused");
    expect((await backend.inbox.get(f.threadId, "new-result"))?.status).toBe("queued");
  });
});

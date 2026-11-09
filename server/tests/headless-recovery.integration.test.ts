import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType, HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type { Observable } from "rxjs";
import { HeadlessToolsMiddleware } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const definition = { name: "computer_write_file", description: "Persist one test action", parameters: { type: "object", properties: { text: { type: "string" } } } };
const started = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
const finished = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
const call = (id: string, complete = true): BaseEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: definition.name, parentMessageId: `assistant-${id}` },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: complete ? JSON.stringify({ text: id }) : '{"text":"unfinished' },
  ...(complete ? [{ type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent] : []),
];
const reply = (): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: "recovered-answer", role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "recovered-answer", delta: "Both writes completed without repeating them." },
  { type: EventType.TEXT_MESSAGE_END, messageId: "recovered-answer" },
];

function collect(stream: Observable<BaseEvent>, onEvent?: (event: BaseEvent) => void): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({ next: (event) => { events.push(event); onEvent?.(event); }, error: reject, complete: () => resolve(events) });
  });
}

suite("headless recovery through the real PostgreSQL conversation runner", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `headless-recovery-test-${randomUUID()}`;
  const bot = `${owner}-bot`;
  const threads: string[] = [];

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
  });

  afterAll(async () => {
    if (!database) return;
    for (const threadId of threads) await backend.runner.stop({ threadId }).catch(() => false);
    await database.$client.unsafe("DELETE FROM chisabot_thread_inbox WHERE owner_user_id = $1", [owner]);
    for (const threadId of threads) await database.$client.unsafe("DELETE FROM chisabot_thread_inbox_control WHERE thread_id = $1", [threadId]);
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });

  async function setup(events: (input: RunAgentInput, attempt: number) => BaseEvent[], delayMs = 0) {
    const threadId = `${owner}-${randomUUID()}`;
    threads.push(threadId);
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const input = { threadId, runId: randomUUID(), protocolVersion: "1.0.0", messages: [
      { id: randomUUID(), role: "user", content: "Finish both writes; retain completed actions when the connection recovers." },
    ], state: {}, tools: [], context: [], forwardedProps: {} } as RunAgentInput;
    const requests: RunAgentInput[] = [];
    const executions: string[] = [];
    // Only the remote model transport is faked. HttpAgent verification, middleware,
    // runner locks, durable events/messages and inbox bookkeeping are the real code.
    const agent = new HttpAgent({ agentId: bot, threadId, initialMessages: input.messages, url: "https://model.test/ag-ui",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as RunAgentInput;
        requests.push(request);
        return new Response(events(request, requests.length - 1).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } });
      } });
    agent.use(new HeadlessToolsMiddleware([{ definition, execute: async (_args, context) => {
      executions.push(context.toolCallId);
      return { ok: true, persistedAction: context.toolCallId };
    } }], { kind: "routine", id: "headless-recovery:integration" }, false, { maxRetries: 2, delayMs }));
    return { threadId, input, agent, requests, executions };
  }

  async function inbox(threadId: string) {
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/inbox`), owner);
    expect(response?.status).toBe(200);
    return await response!.json() as { running: boolean; paused: boolean; waiting: boolean };
  }

  async function durableRun(threadId: string, runId: string) {
    const rows = await database.$client.unsafe<{ run_id: string; status: string }[]>(
      "SELECT run_id, status FROM openbot_local_runs WHERE thread_id = $1", [threadId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.run_id).toBe(runId);
    return rows[0]!;
  }

  test("completed action A survives partial B and only one successful outer run is persisted", async () => {
    const h = await setup((input, attempt) => attempt === 0 ? [started(input), ...call("write-a"), finished(input)]
      : attempt === 1 ? [started(input), ...call("partial-b", false), { type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "Arguments were truncated." }]
      : attempt === 2 ? [started(input), ...call("write-b"), finished(input)]
      : [started(input), ...reply(), finished(input)]);
    const events = await collect(backend.runner.run({ threadId: h.threadId, agent: h.agent, input: h.input }));

    expect(h.executions).toEqual(["write-a", "write-b"]);
    expect(h.requests).toHaveLength(4);
    expect(new Set(h.requests.map((request) => request.runId))).toEqual(new Set([h.input.runId]));
    expect(h.requests[2]?.messages.filter((message) => message.role === "tool" && message.toolCallId === "write-a")).toHaveLength(1);
    expect(JSON.stringify(h.requests[2]?.messages)).not.toContain("partial-b");
    expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(0);
    expect(events.filter((event) => event.type === EventType.CUSTOM && event.name === "openbot.headless.recovering")).toHaveLength(1);
    expect(await durableRun(h.threadId, h.input.runId)).toMatchObject({ status: "finished" });
    expect(await inbox(h.threadId)).toMatchObject({ running: false, waiting: false, paused: false });

    // Recreate the backend so this assertion cannot accidentally read only the agent's memory.
    const restored = await createLocalConversations(database);
    const history = (await restored.client.getThreadMessages({ threadId: h.threadId, userId: owner })).messages;
    expect(history.find((message) => message.id === "recovered-answer")?.content).toContain("Both writes completed");
    expect(JSON.stringify(history)).not.toContain("partial-b");
    const calls = history.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((item) => item.id).sort()).toEqual(["write-a", "write-b"]);
    for (const item of calls) {
      expect(JSON.parse(item.args)).toEqual({ text: item.id });
      const results = history.filter((message) => message.role === "tool" && message.toolCallId === item.id);
      expect(results).toHaveLength(1);
      expect(JSON.parse(String(results[0]?.content))).toEqual({ ok: true, persistedAction: item.id });
    }
    const replay = await collect(restored.runner.connect({ threadId: h.threadId, agentId: bot }));
    const snapshot = replay.find((event) => event.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).toContain("recovered-answer");
    expect(JSON.stringify(snapshot)).not.toContain("partial-b");
  }, 15_000);

  test("exhausted reconnects persist one visible error and an error pause", async () => {
    const h = await setup((input, attempt) => [started(input), ...call(`partial-${attempt}`, false),
      { type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "Arguments remain truncated after retries." }]);
    const events = await collect(backend.runner.run({ threadId: h.threadId, agent: h.agent, input: h.input }));
    expect(h.requests).toHaveLength(3);
    expect(h.executions).toHaveLength(0);
    expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
    expect(events.find((event) => event.type === EventType.RUN_ERROR)).toMatchObject({ code: "INCOMPLETE_TOOL_CALL" });
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(0);
    expect(await durableRun(h.threadId, h.input.runId)).toMatchObject({ status: "error" });
    expect(await inbox(h.threadId)).toMatchObject({ running: false, paused: true });
    const [control] = await database.$client.unsafe("SELECT pause_reason FROM chisabot_thread_inbox_control WHERE thread_id = $1", [h.threadId]);
    expect(control?.pause_reason).toBe("error");
    const [persisted] = await database.$client.unsafe("SELECT count(*)::int AS n FROM openbot_local_events WHERE thread_id = $1 AND event->>'type' = 'RUN_ERROR'", [h.threadId]);
    expect(persisted?.n).toBe(1);
  }, 15_000);

  test("explicit Stop during recovery backoff prevents another request and retains the user pause", async () => {
    const h = await setup((input) => [started(input)], 500);
    let recovering!: () => void;
    const reachedRecovery = new Promise<void>((resolve) => { recovering = resolve; });
    const completed = collect(backend.runner.run({ threadId: h.threadId, agent: h.agent, input: h.input }), (event) => {
      if (event.type === EventType.CUSTOM && event.name === "openbot.headless.recovering") recovering();
    });
    await reachedRecovery;
    expect(await backend.runner.stop({ threadId: h.threadId, runId: h.input.runId })).toBe(true);
    const events = await completed;
    // Let the original retry timer's deadline pass to detect a reconnect leaked by cancellation.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.requests).toHaveLength(1);
    expect(h.executions).toHaveLength(0);
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(0);
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } });
    expect(await durableRun(h.threadId, h.input.runId)).toMatchObject({ status: "stopped" });
    expect(await inbox(h.threadId)).toMatchObject({ running: false, paused: true });
    const [control] = await database.$client.unsafe("SELECT pause_reason FROM chisabot_thread_inbox_control WHERE thread_id = $1", [h.threadId]);
    expect(control?.pause_reason).toBe("user");
  }, 15_000);
});

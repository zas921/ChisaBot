import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType, HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { HeadlessToolsMiddleware } from "../src/computer/headless-tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("headless checkpoint recovery through persisted local runner", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `recovery-checkpoint-${randomUUID()}`;
  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });

  test("completed action survives reconnect and successful durable run stays unpaused", async () => {
    const thread = randomUUID();
    const bot = `${owner}-bot`;
    await backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: bot });
    const input: RunAgentInput = { threadId: thread, runId: randomUUID(), state: {}, tools: [], context: [], forwardedProps: {},
      messages: [{ id: randomUUID(), role: "user", content: "Finish the existing task." }] };
    const requests: RunAgentInput[] = [];
    let writes = 0;
    const agent = new HttpAgent({ agentId: bot, threadId: thread, initialMessages: input.messages,
      url: "https://isolated.example/agent", fetch: async (_url, init) => {
        const request = JSON.parse(String(init.body)) as RunAgentInput;
        const attempt = requests.push(request) - 1;
        const events: BaseEvent[] = [{ type: EventType.RUN_STARTED, threadId: thread, runId: request.runId }];
        if (attempt < 2) {
          const id = attempt === 0 ? "saved-action" : "partial-action";
          events.push({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "computer_write_file", parentMessageId: `message-${id}` },
            { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: attempt === 0 ? '{"value":"saved"}' : '{"value":"' });
          if (attempt === 0) events.push({ type: EventType.TOOL_CALL_END, toolCallId: id },
            { type: EventType.RUN_FINISHED, threadId: thread, runId: request.runId });
        } else {
          events.push({ type: EventType.TEXT_MESSAGE_START, messageId: "final-answer", role: "assistant" },
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "final-answer", delta: "The existing task is complete." },
            { type: EventType.TEXT_MESSAGE_END, messageId: "final-answer" },
            { type: EventType.RUN_FINISHED, threadId: thread, runId: request.runId });
        }
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
    agent.use(new HeadlessToolsMiddleware([{ definition: { name: "computer_write_file", description: "Test action", parameters: { type: "object" } },
      execute: async () => { writes++; return { saved: true }; } }], undefined, false, { delayMs: 0 }));
    const events = await lastValueFrom(backend.runner.run({ threadId: thread, agent, input }).pipe(toArray()));
    expect(writes).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.messages.filter(message => message.role === "tool" && message.toolCallId === "saved-action")).toHaveLength(1);
    expect(requests[2]?.messages.some(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === "partial-action"))).toBe(false);
    expect(events.filter(event => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(events.filter(event => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(events.filter(event => event.type === EventType.RUN_ERROR)).toHaveLength(0);
    const persisted = await backend.client.getThreadMessages({ threadId: thread, userId: owner });
    expect(persisted.messages.filter(message => message.role === "tool" && message.toolCallId === "saved-action")).toHaveLength(1);
    expect(persisted.messages.some(message => message.content === "The existing task is complete.")).toBe(true);
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${thread}/inbox`), owner);
    const inbox = await response!.json() as { running: boolean; paused: boolean };
    expect(inbox.running).toBe(false);
    expect(inbox.paused).toBe(false);
  }, 30_000);
});

import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore, ProxiedCopilotRuntimeAgent } from "@copilotkit/react-core/v2";
import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { runContinuingAgent } from "../src/lib/copilot/continue-agent";
import { guardFrontendToolDispatch } from "../src/lib/copilot/frontend-tool-dispatch-guard";

const name = "computer_run_command";
const callId = "server-command-1";
const args = '{"command":"synthetic server test"}';
const result = JSON.stringify({ ok: true, exitCode: 0, stdout: "saved progress", stderr: "", timedOut: false });
const user: Message = { id: "user-1", role: "user", content: "continue work" };
const command: Message = {
  id: "assistant-call", role: "assistant",
  toolCalls: [{ id: callId, type: "function", function: { name, arguments: args } }],
};
const toolResult: Message = { id: "tool-result", role: "tool", toolCallId: callId, content: result };
const reply: Message = { id: "assistant-reply", role: "assistant", content: "Done" };

function toolEvents(complete: boolean): BaseEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: callId, toolCallName: name, parentMessageId: command.id } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: complete ? args : args.slice(0, -2) } as BaseEvent,
    ...(complete ? [{ type: EventType.TOOL_CALL_END, toolCallId: callId } as BaseEvent] : []),
  ];
}

function stream(events: BaseEvent[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function fixture(wire: (input: RunAgentInput, request: number) => BaseEvent[], guarded = true) {
  let snapshot: Message[] = [];
  let browserExecutions = 0;
  let runRequests = 0;
  let otherExecutions = 0;
  const received: RunAgentInput[] = [];
  const issues: string[] = [];
  const agent = new ProxiedCopilotRuntimeAgent({
    agentId: "probe", threadId: crypto.randomUUID(), initialMessages: [user],
    runtimeUrl: "http://127.0.0.1:1/api/copilotkit", transport: "multi",
  });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { probe: agent }, tools: [
    { name, description: "Only an execution counter in this test", parameters: z.object({ command: z.string() }),
      handler: async () => { browserExecutions++; return "unexpected browser execution"; } },
    { name: "computer_list_files", description: "Unchanged frontend tool", parameters: z.object({}),
      handler: async () => { otherExecutions++; return { ok: true }; } },
  ] });
  // The core configures the proxy's fetch during registration. Replace it afterwards to exercise
  // the actual SSE run/connect paths entirely in process, without any HTTP listener.
  agent.fetch = async (url, init) => {
    if (url.endsWith("/connect")) return stream([{ type: EventType.MESSAGES_SNAPSHOT, messages: snapshot } as BaseEvent]);
    if (!url.endsWith("/run")) throw new Error(`Unexpected test request ${url}`);
    const input = JSON.parse(String(init.body)) as RunAgentInput;
    received.push(input);
    return stream([
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      ...wire(input, ++runRequests),
    ]);
  };
  if (guarded) guardFrontendToolDispatch(agent, (issue) => issues.push(issue));
  return {
    core, agent, issues, runRequests: () => runRequests, browserExecutions: () => browserExecutions,
    otherExecutions: () => otherExecutions, received,
    setSnapshot(messages: Message[]) { snapshot = messages; },
  };
}

test.each([false, true])("a server-executed command keeps its result with a same-name browser handler (guard=%s)", async (guarded) => {
  const f = fixture((input) => [
    ...toolEvents(true),
    { type: EventType.TOOL_CALL_RESULT, toolCallId: callId, messageId: toolResult.id, content: result } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: reply.id, role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: reply.id, delta: "Done" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: reply.id } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
  ], guarded);
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.browserExecutions()).toBe(0);
  expect(f.runRequests()).toBe(1);
  expect(f.issues).toEqual([]);
  expect(f.agent.messages).toContainEqual(toolResult);
  expect(f.agent.messages.at(-1)).toMatchObject(reply);
});

test("a mixed batch dispatches only the remaining browser tool and carries the server result into one continuation", async () => {
  const other = "frontend-read-1";
  const f = fixture((input, n) => n > 1 ? [
    { type: EventType.TEXT_MESSAGE_START, messageId: reply.id, role: "assistant" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: reply.id, delta: "Done" } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: reply.id } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
  ] : [
    ...toolEvents(true),
    { type: EventType.TOOL_CALL_START, toolCallId: other, toolCallName: "computer_list_files", parentMessageId: command.id } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: other, delta: "{}" } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: other } as BaseEvent,
    { type: EventType.TOOL_CALL_RESULT, toolCallId: callId, messageId: toolResult.id, content: result } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent,
  ]);
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.browserExecutions()).toBe(0);
  expect(f.otherExecutions()).toBe(1);
  expect(f.runRequests()).toBe(2);
  expect(f.received[1]?.messages.filter((m) => m.role === "user")).toEqual([user]);
  expect(f.received[1]?.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual([callId, other]);
  expect(f.agent.messages.at(-1)).toMatchObject(reply);
});

test("after a browser EOF, read-only sync shows the saved server result without replaying the command or user turn", async () => {
  const f = fixture(() => toolEvents(false));
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.issues).toEqual(["stream-ended"]);

  f.setSnapshot([user, command]);
  await f.core.connectAgent({ agent: f.agent });
  expect(f.agent.messages).toEqual([user, command]);
  expect(f.browserExecutions()).toBe(0);

  f.setSnapshot([user, command, toolResult, reply]);
  await f.core.connectAgent({ agent: f.agent });
  expect(f.agent.messages).toEqual([user, command, toolResult, reply]);
  expect(f.browserExecutions()).toBe(0);
  expect(f.runRequests()).toBe(1);
});

test("an explicit server approval interrupt never dispatches the same command in the browser", async () => {
  const f = fixture((input) => [
    ...toolEvents(true),
    { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: {
      type: "interrupt", interrupts: [{ id: callId, toolCallId: callId, reason: "human_input", message: "await approval" }],
    } } as BaseEvent,
  ]);
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.agent.messages.at(-1)).toMatchObject(command);
  expect(f.agent.pendingInterrupts[0]).toMatchObject({ id: callId });
  expect(f.browserExecutions()).toBe(0);
  expect(f.runRequests()).toBe(1);
  expect(f.issues).toEqual([]);
});

import { expect, test } from "bun:test";
import { AbstractAgent, type BaseEvent, EventType, type Message, type RunAgentInput, type Tool } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { currentApprovalContext } from "../src/approvals/types";
import { PERSON_INITIATOR } from "../src/audit";
import { HeadlessToolSuspension, managedBrowserWorkspace } from "../src/computer/headless-tools";
import { withToolAbort } from "../src/confirmations/context";

const command: Tool = { name: "computer_run_command", description: "Shell", parameters: { type: "object" } };
const other: Tool = { name: "computer_write_file", description: "Write", parameters: { type: "object" } };
const readFile: Tool = { name: "computer_read_file", description: "Read", parameters: { type: "object" } };
const listFiles: Tool = { name: "computer_list_files", description: "List", parameters: { type: "object" } };
const user: Message = { id: "user", role: "user", content: "Read a file" };
const args = '{"command":"cat report.txt"}';
const turn: RunAgentInput = { threadId: "thread", runId: "run", messages: [user], state: {}, tools: [command, other], context: [], forwardedProps: {} };

function call(tool: Tool, id: string, delta: string, end = true): BaseEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: tool.name, parentMessageId: "assistant-" + id },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta },
    ...(end ? [{ type: EventType.TOOL_CALL_END, toolCallId: id } as const] : []),
  ];
}
const start = { type: EventType.RUN_STARTED, threadId: turn.threadId, runId: turn.runId } as const;
const finish = { type: EventType.RUN_FINISHED, threadId: turn.threadId, runId: turn.runId } as const;
const reply = [
  { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Complete" },
  { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
] as const satisfies readonly BaseEvent[];

function collect(
  events: (input: RunAgentInput, segment: number) => BaseEvent[],
  execute: (input: unknown, signal: AbortSignal, name: string) => Promise<unknown>,
  input = turn,
  managed: readonly Tool[] = [command],
) {
  const calls: RunAgentInput[] = [];
  let authorized = 0;
  const source = new class extends AbstractAgent {
    run(request: RunAgentInput) {
      calls.push(request);
      return from(events(request, calls.length));
    }
  }();
  const middleware = managedBrowserWorkspace(async () => {
    authorized++;
    return managed.map((definition) => ({ definition, execute: (args, { signal }) => execute(args, signal, definition.name) }));
  }, PERSON_INITIATOR);
  return { calls, loadCount: () => authorized, result: lastValueFrom(middleware.run(input, source).pipe(toArray())) };
}

test("an approved complete command executes once and its real result drives the next model step", async () => {
  let executed = 0;
  const run = collect((input, n) => {
    expect(input.tools.map((tool) => tool.name).sort()).toEqual([command.name, other.name]);
    if (n === 1) return [start, ...call(command, "command", args), finish];
    expect(input.messages.filter((m) => m.role === "user")).toEqual([user]);
    expect(input.messages.find((m) => m.role === "tool")).toMatchObject({ toolCallId: "command", content: '{"ok":true}' });
    return [start, ...reply, finish];
  }, async (input) => {
    executed++;
    expect(input).toEqual({ command: "cat report.txt" });
    expect(currentApprovalContext()).toMatchObject({ threadId: "thread", runId: "run", toolCallId: "command", toolName: command.name, initiator: PERSON_INITIATOR });
    return { ok: true };
  });
  const events = await run.result;
  expect(run.calls).toHaveLength(2);
  expect(executed).toBe(1);
  expect(events.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(1);
  expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toHaveLength(1);
});

test("a mixed batch returns the native command result and leaves the other computer tool for the browser", async () => {
  let executed = 0;
  const run = collect(() => [start, ...call(command, "managed", args), ...call(other, "browser", "{}"), finish],
    async () => { executed++; return { ok: true }; });
  const events = await run.result;
  expect(run.calls).toHaveLength(1);
  expect(executed).toBe(1);
  expect(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toMatchObject([{ toolCallId: "managed", content: '{"ok":true}' }]);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("a malformed browser sibling prevents the whole batch from executing", async () => {
  let executed = 0;
  const run = collect(() => [start, ...call(command, "valid", args), ...call(other, "bad-sibling", '{"path":"partial'), finish],
    async () => { executed++; return "wrong"; });
  const events = await run.result;
  expect(executed).toBe(0);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL" });
});

test("a snapshot with the same pending command ID twice cannot execute either copy", async () => {
  const duplicate = { id: "duplicate", type: "function", function: { name: command.name, arguments: args } } as const;
  const run = collect(() => [start, ...call(command, "duplicate", args), {
    type: EventType.MESSAGES_SNAPSHOT, messages: [user, {
      id: "assistant-duplicate", role: "assistant", toolCalls: [duplicate],
    }, {
      id: "another-assistant", role: "assistant", toolCalls: [duplicate],
    }],
  }, finish], async () => { throw new Error("duplicate command executed"); });
  const events = await run.result;
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL" });
});

test.each([
  ["before END or terminal", () => [start, ...call(command, "missing-end", args, false)]],
  ["after END but before terminal", () => [start, ...call(command, "missing-finish", args)]],
  ["with malformed complete arguments", () => [start, ...call(command, "invalid", '{"command":"unfinished'), finish]],
  ["with a cancellation", () => [start, ...call(command, "cancelled", args), { ...finish, outcome: { type: "cancelled" } } as BaseEvent]],
] as const)("does not execute a stream that stops %s", async (_description, events) => {
  let executed = 0;
  const run = collect(events, async () => { executed++; return "wrong"; });
  expect((await run.result).some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(false);
  expect(executed).toBe(0);
});

test("a historical unanswered call does not gain execution authority from a new run", async () => {
  const prior: Message = { id: "old", role: "assistant", toolCalls: [{ id: "old-command", type: "function", function: { name: command.name, arguments: args } }] };
  let executed = 0;
  const run = collect(() => [start, ...reply, finish], async () => { executed++; return "wrong"; }, { ...turn, messages: [user, prior] });
  expect((await run.result).some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(false);
  expect(executed).toBe(0);
});

test("the managed command does not become available to a browser that did not offer it", async () => {
  const run = collect(() => [start, ...reply, finish], async () => { throw new Error("unexpected"); }, { ...turn, tools: [other] });
  await run.result;
  expect(run.loadCount()).toBe(0);
  expect(run.calls[0]?.tools).toEqual([other]);
});

test("durable approvals still interrupt and suppress all unexecuted siblings", async () => {
  const run = collect(() => [start, ...call(command, "approval", args), ...call(other, "browser", "{}"), finish],
    async () => { throw new HeadlessToolSuspension("Approval required", { kind: "approval", requestId: "approval-request" }); });
  const events = await run.result;
  expect(events.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "interrupt" } });
});

test("explicit Stop reaches the running command's signal", async () => {
  const stop = new AbortController();
  let reached = false;
  const run = withToolAbort(stop.signal, () => collect(() => [start, ...call(command, "stop", args), finish], async (_args, signal) => {
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => { reached = true; resolve(); }, { once: true }));
    stop.abort();
    await aborted;
    return { ok: false };
  }));
  expect((await run.result).some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(false);
  expect(reached).toBe(true);
});


test.each([readFile, listFiles])("an offered workspace reader continues on the server: $name", async (tool) => {
  const executed: string[] = [];
  const run = collect((input, n) => {
    // Loading the workspace permissions never adds an unadvertised command or reader.
    expect(input.tools.map((item) => item.name)).toEqual([tool.name]);
    if (n === 1) return [start, ...call(tool, "reader", '{"path":"report.txt"}'), finish];
    expect(input.messages.filter((m) => m.role === "user")).toEqual([user]);
    expect(input.messages.find((m) => m.role === "tool")).toMatchObject({ toolCallId: "reader", content: '{"ok":true}' });
    return [start, ...reply, finish];
  }, async (input, _signal, name) => {
    executed.push(name);
    expect(input).toEqual({ path: "report.txt" });
    return { ok: true };
  }, { ...turn, tools: [tool] }, [command, readFile, listFiles, other]);
  const events = await run.result;
  expect(executed).toEqual([tool.name]);
  expect(run.calls).toHaveLength(2);
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject([{ toolCallId: "reader", content: '{"ok":true}' }]);
});

test("multiple workspace tools finish server-side without consuming a browser write", async () => {
  const executed: string[] = [];
  const run = collect(() => [
    start,
    ...call(command, "shell", args),
    ...call(readFile, "read", '{"path":"report.txt"}'),
    ...call(listFiles, "list", '{}'),
    ...call(other, "write", '{"path":"copy.txt","contents":"new"}'),
    finish,
  ], async (_input, _signal, name) => {
    executed.push(name);
    return { ok: true };
  }, { ...turn, tools: [command, readFile, listFiles, other] }, [command, readFile, listFiles, other]);
  const events = await run.result;
  expect(executed).toEqual([command.name, readFile.name, listFiles.name]);
  expect(run.calls).toHaveLength(1);
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject([
    { toolCallId: "shell" }, { toolCallId: "read" }, { toolCallId: "list" },
  ]);
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

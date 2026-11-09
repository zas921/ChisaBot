import { expect, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/react-core/v2";
import { Observable, of } from "rxjs";
import { z } from "zod/v4";
import { runContinuingAgent } from "../src/lib/copilot/continue-agent";
import { guardFrontendToolDispatch } from "../src/lib/copilot/frontend-tool-dispatch-guard";

function command(id: string, args: string, closed = true): BaseEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "computer_run_command", parentMessageId: `message-${id}` } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args.slice(0, 8) } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args.slice(8) } as BaseEvent,
    ...(closed ? [{ type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent] : []),
  ];
}

function finish(input: RunAgentInput): BaseEvent {
  return { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent;
}

const validArgs = '{"command":"safe probe"}';
const prefix = '{"command":"';
const truncatedArgs = prefix + "x".repeat(387 - prefix.length);

function fixture(eventsFor: (run: number, input: RunAgentInput) => BaseEvent[], options: { keepOpen?: boolean; unguarded?: boolean; replay?: boolean } = {}) {
  const executions: string[] = [];
  const issues: string[] = [];
  let runs = 0;
  class Probe extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      const wireInput = options.replay ? { ...input, runId: `old-${input.runId}` } : input;
      const events = [
        { type: EventType.RUN_STARTED, threadId: wireInput.threadId, runId: wireInput.runId } as BaseEvent,
        ...eventsFor(++runs, wireInput),
      ];
      if (!options.keepOpen) return of(...events);
      return new Observable((out) => {
        for (const event of events) out.next(event);
      });
    }
  }
  const agent = new Probe({ agentId: "probe", threadId: crypto.randomUUID(), initialMessages: [
    { id: "user", role: "user", content: "one task" },
  ] });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { probe: agent }, tools: [{
    name: "computer_run_command", description: "In-memory test only", parameters: z.object({ command: z.string() }),
    handler: async (_args, context) => { executions.push(context.toolCall.id); return "done"; },
  }] });
  if (!options.unguarded) guardFrontendToolDispatch(agent, (issue) => issues.push(issue));
  return { core, agent, executions, issues, runs: () => runs };
}

test("the original SDK exposes a syntax error on the 387-character EOF; the guard blocks dispatch and preserves history", async () => {
  const raw = fixture(() => command("broken", truncatedArgs, false), { unguarded: true });
  await runContinuingAgent(raw.core, { agent: raw.agent });
  expect(raw.agent.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "broken", content: expect.stringContaining("Unterminated string") });

  const guarded = fixture(() => command("broken", truncatedArgs, false));
  await runContinuingAgent(guarded.core, { agent: guarded.agent });
  expect(guarded.issues).toEqual(["stream-ended"]);
  expect(guarded.executions).toEqual([]);
  expect(guarded.runs()).toBe(1);
  expect(guarded.agent.messages.filter((message) => message.role === "tool")).toHaveLength(0);
  expect(guarded.agent.messages.at(-1)).toMatchObject({ role: "assistant", toolCalls: [{ id: "broken", function: { arguments: truncatedArgs } }] });
});

test("valid-looking arguments without an END are blocked on EOF and on RUN_ERROR", async () => {
  const eof = fixture(() => command("complete-looking", validArgs, false));
  await runContinuingAgent(eof.core, { agent: eof.agent });
  expect(eof.executions).toEqual([]);
  expect(eof.issues).toEqual(["stream-ended"]);

  const failed = fixture(() => [
    ...command("complete-looking", validArgs, false),
    { type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "stream failed" } as BaseEvent,
  ]);
  await runContinuingAgent(failed.core, { agent: failed.agent });
  expect(failed.executions).toEqual([]);
  expect(failed.issues).toEqual([]); // the real RUN_ERROR remains the cause
});

test("an observed END is still insufficient if the stream detaches before RUN_FINISHED", async () => {
  const f = fixture(() => command("detached", validArgs), { keepOpen: true });
  const ended = Promise.withResolvers<void>();
  const sub = f.agent.subscribe({ onToolCallEndEvent: () => ended.resolve() });
  const running = runContinuingAgent(f.core, { agent: f.agent });
  await ended.promise;
  await f.agent.detachActiveRun();
  await running;
  sub.unsubscribe();
  expect(f.executions).toEqual([]);
  expect(f.runs()).toBe(1);
});

test.each([truncatedArgs, "[]", "null"])("a declared success cannot dispatch a batch with invalid JSON object input: %.12s", async (badArgs) => {
  const f = fixture((_run, input) => [
    ...command("complete", validArgs),
    ...command("broken", badArgs),
    finish(input),
  ]);
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.issues).toEqual(["invalid-tool-input"]);
  expect(f.executions).toEqual([]);
  expect(f.runs()).toBe(1);
});

test("normal SDK follow-ups run authorized tools once and preserve their results if a later stream drops", async () => {
  const f = fixture((run, input) => run < 3
    ? [...command(`valid-${run}`, validArgs), finish(input)]
    : command("broken", truncatedArgs, false));
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.executions).toEqual(["valid-1", "valid-2"]);
  expect(f.issues).toEqual(["stream-ended"]);
  expect(f.runs()).toBe(3);
  expect(f.agent.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(f.agent.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["valid-1", "valid-2"]);
});

test("joining another request's completed wire run is display-only", async () => {
  const f = fixture((_run, input) => [...command("another-client", validArgs), finish(input)], { replay: true });
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.executions).toEqual([]);
  expect(f.issues).toEqual([]);
  expect(f.runs()).toBe(1);
  expect(f.agent.messages.at(-1)).toMatchObject({ role: "assistant", toolCalls: [{ id: "another-client" }] });
});

test("clean EOF after a completed native command still needs read-only recovery", async () => {
  const f = fixture(() => [
    ...command("native", validArgs),
    { type: EventType.TOOL_CALL_RESULT, toolCallId: "native", messageId: "native-result", content: "saved", role: "tool" } as BaseEvent,
  ]);
  await runContinuingAgent(f.core, { agent: f.agent });
  expect(f.issues).toEqual(["stream-closed"]);
  expect(f.executions).toEqual([]);
  expect(f.runs()).toBe(1);
  expect(f.agent.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "native", content: "saved" });
});

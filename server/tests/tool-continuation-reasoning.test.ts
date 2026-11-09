import { expect, test } from "bun:test";
import { type BaseEvent, EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { of } from "rxjs";
import { continueToolRuns } from "../src/agents/tool-continuation";
import { withToolAbort } from "../src/confirmations/context";

function fixture(options: { finalText?: boolean; failed?: boolean; pending?: boolean; cancel?: boolean; stopAfterResult?: boolean } = {}) {
  const requests: RunAgentInput[] = [], output: BaseEvent[] = [];
  const stop = new AbortController();
  let effects = 0;
  const agent = new HttpAgent({ url: "https://unused.test", threadId: "task", initialMessages: [{ id: "user", role: "user", content: "Save, inspect, then continue." }] });
  agent.run = (input) => continueToolRuns(input, (request) => {
    requests.push(structuredClone(request));
    const start: BaseEvent = { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId };
    const end: BaseEvent = { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId,
      metadata: { finishReason: requests.length === 1 ? "tool-calls" : "stop" }, ...(options.cancel ? { outcome: { type: "cancelled" } } : {}) };
    if (requests.length > 1) return of(start, end);
    if (!options.pending) effects++;
    return of(start,
      { type: EventType.TOOL_CALL_START, toolCallId: "saved", toolCallName: "save_file", parentMessageId: "action" } as BaseEvent,
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "saved", delta: "{}" } as BaseEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "saved" } as BaseEvent,
      ...(!options.pending ? [{ type: EventType.TOOL_CALL_RESULT, toolCallId: "saved", messageId: "result", role: "tool", content: options.failed ? '{"ok":false,"error":"no access"}' : '{"saved":true}' } as BaseEvent] : []),
      { type: EventType.REASONING_MESSAGE_START, messageId: "reason", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "reason" } as BaseEvent,
      ...(options.finalText ? [
        { type: EventType.TEXT_MESSAGE_START, messageId: "final", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "final", delta: "The work is complete." } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "final" } as BaseEvent,
      ] : []), end);
  });
  const run = () => withToolAbort(stop.signal, () => agent.runAgent({ runId: "one-outer-run" }, { onEvent: ({ event }) => {
    output.push(event);
    if (options.stopAfterResult && event.type === EventType.TOOL_CALL_RESULT) stop.abort();
  } }));
  return { run, requests, output, effects: () => effects };
}

test("trailing empty reasoning at an answered native-tool boundary resumes without replaying the action", async () => {
  const h = fixture();
  await h.run();
  expect(h.requests).toHaveLength(2);
  expect(h.effects()).toBe(1);
  expect(h.requests[1]?.messages.filter((message) => message.role === "tool" && message.toolCallId === "saved")).toHaveLength(1);
  expect(h.requests[1]?.messages.some((message) => message.role === "reasoning" && message.id === "reason")).toBe(true);
  expect(h.output.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(1);
  expect(h.output.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
  expect(h.output.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
  expect(h.requests[1]?.runId).toBe("one-outer-run");
});

test.each(["finalText", "failed", "pending", "cancel", "stopAfterResult"] as const)("reasoning-tail recovery still stops for %s", async (kind) => {
  const h = fixture({ [kind]: true });
  await h.run();
  expect(h.requests).toHaveLength(1);
  expect(h.effects()).toBe(kind === "pending" ? 0 : 1);
});

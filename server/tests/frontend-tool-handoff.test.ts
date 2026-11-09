import { describe, expect, test } from "bun:test";
import { EventType, type Message } from "@ag-ui/client";
import { FrontendToolHandoff } from "../src/frontend-tool-handoff";

const command = "computer_run_command";
const args = '{"command":"inspect"}';
const toolResult = (id: string): Message => ({ id: `result-${id}`, role: "tool", toolCallId: id, content: "done" });
const message = (id: string, input = args, name = command): Message => ({
  id: `message-${id}`, role: "assistant", toolCalls: [{ id, type: "function", function: { name, arguments: input } }],
});

function open() {
  const handoff = new FrontendToolHandoff([{ name: command }]);
  handoff.observe({ type: EventType.RUN_STARTED, threadId: "thread", runId: "run" });
  return handoff;
}

function call(handoff: FrontendToolHandoff, id: string, input: string, end = true, name = command) {
  handoff.observe({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name });
  handoff.observe({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: input.slice(0, 9) });
  handoff.observe({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: input.slice(9) });
  if (end) handoff.observe({ type: EventType.TOOL_CALL_END, toolCallId: id });
}

function finish(handoff: FrontendToolHandoff) {
  handoff.observe({ type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" });
}

describe("durable frontend tool handoff", () => {
  test("normal committed finish authorizes a complete, unanswered call", () => {
    const handoff = open();
    call(handoff, "tool", args);
    const messages = [message("tool")];
    expect(handoff.inspect(messages)).toEqual({ ready: ["tool"], incomplete: false });
    expect(handoff.pending(messages)).toEqual([]);
    finish(handoff);
    expect(handoff.pending(messages)).toEqual(["tool"]);
  });

  test("a syntactically valid prefix without END cannot be handed off", () => {
    const handoff = open();
    call(handoff, "tool", args, false);
    finish(handoff);
    expect(handoff.inspect([message("tool")]).incomplete).toBe(true);
    expect(handoff.pending([message("tool")])).toEqual([]);
  });

  test("END does not authorize malformed or non-object arguments", () => {
    for (const input of ['{"command":"unterminated', "null", "[]", '"command"', ""]) {
      const handoff = open();
      call(handoff, "tool", input);
      finish(handoff);
      expect(handoff.inspect([message("tool", input)]).incomplete).toBe(true);
      expect(handoff.pending([message("tool", input)])).toEqual([]);
    }
  });

  test("an error or missing terminal does not authorize even an ended call", () => {
    const handoff = open();
    call(handoff, "tool", args);
    expect(handoff.pending([message("tool")])).toEqual([]);
    handoff.observe({ type: EventType.RUN_ERROR, message: "Interrupted" });
    expect(handoff.pending([message("tool")])).toEqual([]);
  });

  test("cancelled and interrupted finish events do not dispatch; success honors the pending call IDs", () => {
    for (const outcome of [{ type: "cancelled" }, { type: "interrupt", interrupts: [{ id: "approval", reason: "approval" }] }]) {
      const handoff = open();
      call(handoff, "tool", args);
      handoff.observe({ type: EventType.RUN_FINISHED, threadId: "thread", runId: "run", outcome });
      expect(handoff.pending([message("tool")])).toEqual([]);
    }
    const handoff = open();
    call(handoff, "omitted", args);
    call(handoff, "allowed", args);
    handoff.observe({ type: EventType.RUN_FINISHED, threadId: "thread", runId: "run", outcome: { type: "success", pendingToolCallIds: ["allowed"] } });
    expect(handoff.pending([message("omitted"), message("allowed")])).toEqual(["allowed"]);
  });

  test("a snapshot cannot substitute new arguments or introduce a call", () => {
    const handoff = open();
    call(handoff, "tool", args);
    finish(handoff);
    expect(handoff.pending([message("tool", '{"command":"other"}')])).toEqual([]);
    expect(handoff.pending([message("new-id")])).toEqual([]);
  });

  test("preserves executed results and leaves unrelated native tools alone", () => {
    const handoff = open();
    call(handoff, "done", args);
    call(handoff, "next", args);
    call(handoff, "native", "{}", true, "native_search");
    finish(handoff);
    const messages = [message("done"), toolResult("done"), message("next"), message("native", "{}", "native_search")];
    expect(handoff.pending(messages)).toEqual(["next"]);
    expect(messages[1]).toEqual(toolResult("done"));
  });
});

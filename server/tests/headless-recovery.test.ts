import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { HeadlessToolsMiddleware, HeadlessToolSuspension } from "../src/computer/headless-tools";
import { withToolAbort } from "../src/confirmations/context";
import { HeadlessStreamCheckpoint, headlessRecovery } from "../src/computer/headless-recovery";
import { Observable } from "rxjs";

const definition = { name: "computer_write_file", description: "Write a file", parameters: { type: "object", properties: { text: { type: "string" } } } };
const started = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
const finished = (input: RunAgentInput): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
const call = (id: string, complete = true): BaseEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: definition.name, parentMessageId: `assistant-${id}` },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: complete ? '{"text":"saved"}' : '{"text":"incomplete' },
  ...(complete ? [{ type: EventType.TOOL_CALL_END, toolCallId: id } as BaseEvent] : []),
];
const reply = (id = "final"): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: "Finished the task." },
  { type: EventType.TEXT_MESSAGE_END, messageId: id },
];

function harness(events: (input: RunAgentInput, attempt: number) => BaseEvent[], options: {
  execute?: () => Promise<unknown>; delayMs?: number; signal?: AbortSignal; onEvent?: (event: BaseEvent) => void;
  stream?: (input: RunAgentInput, attempt: number) => Observable<BaseEvent>;
} = {}) {
  const requests: RunAgentInput[] = [], output: BaseEvent[] = [];
  let executions = 0;
  const agent = new HttpAgent({ agentId: "bot", threadId: "worker-test", initialMessages: [{ id: "task", role: "user", content: "Finish work; do not repeat completed writes." }],
    url: "https://model.test/ag-ui", fetch: async (_url, init) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      requests.push(input);
      return new Response(events(input, requests.length - 1).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } });
  if (options.stream) agent.run = (input) => { requests.push(structuredClone(input)); return options.stream!(input, requests.length - 1); };
  agent.use(new HeadlessToolsMiddleware([{ definition, execute: async () => { executions++; return options.execute ? options.execute() : { ok: true, saved: true }; } }], { kind: "routine", id: "worker:test" }, false, { delayMs: options.delayMs ?? 0 }));
  const run = () => {
    const action = () => agent.runAgent({ runId: "outer-run", tools: [] }, { onEvent: ({ event }) => { output.push(event); options.onEvent?.(event); } });
    return options.signal ? withToolAbort(options.signal, action) : action();
  };
  return { run, requests, output, agent, executions: () => executions };
}

describe("headless incomplete generation recovery", () => {
  test("completed write survives a truncated sibling input; only new completed calls execute", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input), ...call("write-a"), finished(input)]
      : attempt === 1 ? [started(input), ...call("partial-b", false), { type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "partial arguments" }]
      : attempt === 2 ? [started(input), ...call("write-b"), finished(input)] : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.executions()).toBe(2);
    expect(h.requests).toHaveLength(4);
    const resumed = h.requests[2]!;
    expect(resumed.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(resumed.messages.some((message) => message.role === "tool" && message.toolCallId === "write-a")).toBe(true);
    expect(JSON.stringify(resumed.messages)).not.toContain("partial-b");
    expect(h.output.filter((event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "write-a")).toHaveLength(1);
    expect(h.output.filter((event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === "partial-b")).toHaveLength(0);
    expect(h.output.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
    expect(h.output.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1);
    expect(h.output.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(new Set(h.requests.map((request) => request.runId))).toEqual(new Set(["outer-run"]));
  });

  test("silent EOF after saved results resumes from them and preserves completed assistant output", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input), ...call("write-a"), finished(input)]
      : attempt === 1 ? [started(input), ...reply("progress")]
      : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.executions()).toBe(1);
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2]?.messages.some((message) => message.id === "progress")).toBe(true);
    expect(h.requests[2]?.messages.some((message) => message.role === "tool" && message.toolCallId === "write-a")).toBe(true);
    expect(h.output.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(0);
  });

  test("unfinished text and step groups do not poison the next stream's actual AG-UI verifier", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input), { type: EventType.STEP_STARTED, stepName: "analysis" },
      ...reply("unfinished-text").slice(0, 2)] : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.output.some((event) => event.type === EventType.STEP_STARTED)).toBe(false);
    expect(h.output.some((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId === "unfinished-text")).toBe(false);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("a tool result still inside an unclosed group is not treated as a durable checkpoint", async () => {
    const h = harness((input) => [started(input), { type: EventType.STEP_STARTED, stepName: "native" }, ...call("native-a"),
      { type: EventType.TOOL_CALL_RESULT, messageId: "native-result", toolCallId: "native-a", content: "already saved", role: "tool" }]);
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.output.some((event) => event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === "native-a")).toBe(true);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  });

  test("reasoning messages, concurrent reasoning spans and subagents remain buffered until all groups close", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input),
      { type: EventType.REASONING_START, messageId: "span-a" },
      { type: EventType.REASONING_START, messageId: "span-b" },
      { type: EventType.REASONING_END, messageId: "span-b" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "reasoning-a", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reasoning-a", delta: "still thinking" },
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "child-a", name: "Research" },
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "child-b", name: "Write" },
      { type: EventType.STEP_STARTED, stepName: "work", subagentRunId: "child-a" },
      { type: EventType.STEP_STARTED, stepName: "work", subagentRunId: "child-b" },
      { type: EventType.STEP_FINISHED, stepName: "work", subagentRunId: "child-b" },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "child-b" },
    ] : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.output.some((event) => event.type === EventType.SUBAGENT_STARTED || event.type === EventType.REASONING_START)).toBe(false);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("closed subagent and reasoning groups survive a later truncated text group", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input),
      { type: EventType.SUBAGENT_STARTED, subagentRunId: "child", name: "Research" },
      { type: EventType.REASONING_START, messageId: "reason", subagentRunId: "child" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "reason", role: "reasoning", subagentRunId: "child" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "Checked source", subagentRunId: "child" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reason", subagentRunId: "child" },
      { type: EventType.REASONING_END, messageId: "reason", subagentRunId: "child" },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "child" },
      ...reply("unfinished").slice(0, 2),
    ] : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.output.filter((event) => event.type === EventType.SUBAGENT_FINISHED)).toHaveLength(1);
    expect(h.output.some((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId === "unfinished")).toBe(false);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("a completed tool call with no result is an unknown outcome and is not replayed", async () => {
    const h = harness((input) => [started(input), ...call("unknown-write")]);
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.executions()).toBe(0);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "OPENBOT_HEADLESS_TOOL_ERROR" });
  });

  test("backend-executed call result is retained once across the reconnect", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input), ...call("native-a"),
      { type: EventType.TOOL_CALL_RESULT, messageId: "native-result", toolCallId: "native-a", content: "already saved", role: "tool" }]
      : [started(input), ...reply(), finished(input)]);
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.executions()).toBe(0);
    expect(h.requests[1]?.messages.filter((message) => message.role === "tool" && message.toolCallId === "native-a")).toHaveLength(1);
  });

  test("nontransient errors stay terminal and retain their diagnostic", async () => {
    const h = harness((input) => [started(input), { type: EventType.RUN_ERROR, code: "PERMISSION_DENIED", message: "No access to this source" }]);
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "PERMISSION_DENIED", message: "No access to this source" });
  });

  test("known transport errors settle and unsubscribe before reconnecting from completed results", async () => {
    const ended: number[] = [];
    const h = harness(() => [], { stream: (input, attempt) => new Observable((out) => {
      if (attempt > 0) expect(ended).toContain(attempt - 1);
      const events = attempt === 0 ? [started(input), ...call("write-a"), finished(input)]
        : attempt === 1 ? [started(input), ...reply("partial").slice(0, 2)] : [started(input), ...reply(), finished(input)];
      for (const event of events) out.next(event);
      if (attempt !== 1) out.complete();
      const timer = attempt === 1 ? setTimeout(() => out.error(Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" })), 30) : undefined;
      return () => { clearTimeout(timer); ended.push(attempt); };
    }) });
    await h.run();
    expect(h.requests).toHaveLength(3);
    expect(h.executions()).toBe(1);
    expect(h.requests[2]?.messages.filter((message) => message.role === "tool" && message.toolCallId === "write-a")).toHaveLength(1);
    expect(h.requests[2]?.messages.some((message) => message.id === "partial")).toBe(false);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(ended).toEqual([0, 1, 2]);
  });

  test("an immediate transport error drains queued backend effects before selecting a retry checkpoint", async () => {
    let remoteEffects = 0;
    const h = harness(() => [], { stream: (input, attempt) => new Observable((out) => {
      out.next(started(input));
      if (attempt === 0) {
        remoteEffects++;
        for (const event of call("native-a")) out.next(event);
        out.next({ type: EventType.TOOL_CALL_RESULT, messageId: "native-result", toolCallId: "native-a", content: "saved", role: "tool" });
        out.error(Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" }));
      } else { out.next(finished(input)); out.complete(); }
    }) });
    await h.run();
    expect(remoteEffects).toBe(1);
    expect(h.executions()).toBe(0);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.messages.filter((message) => message.role === "tool" && message.toolCallId === "native-a")).toHaveLength(1);
    expect(h.output.filter((event) => event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === "native-a")).toHaveLength(1);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("failure before the first RUN_STARTED does not emit an invalid recovery event", async () => {
    const h = harness(() => [], { stream: (input, attempt) => new Observable((out) => {
      if (attempt === 0) out.error(Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" }));
      else { out.next(started(input)); out.next(finished(input)); out.complete(); }
    }) });
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.output[0]).toMatchObject({ type: EventType.RUN_STARTED });
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("exhausted failures before RUN_STARTED retain a valid terminal error", async () => {
    const h = harness(() => [], { stream: () => new Observable((out) => {
      out.error(Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" }));
    }) });
    await h.run();
    expect(h.requests).toHaveLength(3);
    expect(h.output).toHaveLength(1);
    expect(h.output[0]).toMatchObject({ type: EventType.RUN_ERROR, message: "Connection reset by peer" });
  });

  test("a recovered stream with another run identity cannot execute a tool", async () => {
    const h = harness((input, attempt) => attempt === 0 ? [started(input)] : [
      started({ ...input, runId: "another-run" }), ...call("wrong-run-write"), finished({ ...input, runId: "another-run" }),
    ]);
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.executions()).toBe(0);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "HEADLESS_RUN_MISMATCH" });
  });

  test("transient INCOMPLETE_STREAM waits for the advertised cooldown before retry", async () => {
    const times: number[] = [];
    const h = harness((input, attempt) => {
      times.push(Date.now());
      return attempt === 0 ? [started(input), { type: EventType.RUN_ERROR, code: "INCOMPLETE_STREAM", message: "Model unavailable HTTP 503; retry after 0.01 seconds" }]
        : [started(input), ...reply(), finished(input)];
    });
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(250);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("Stop during a provider cooldown cancels the wait without another request", async () => {
    const stop = new AbortController();
    const h = harness((input) => [started(input), { type: EventType.RUN_ERROR, code: "INCOMPLETE_STREAM", message: "服务暂时不可用，当前模型冷却中，请约 82 秒后重试（HTTP 500）" }], {
      signal: stop.signal, onEvent: (event) => {
        if (event.type === EventType.CUSTOM && event.name === "openbot.headless.recovering") {
          expect(event.value).toMatchObject({ delayMs: 82_250 }); stop.abort();
        }
      },
    });
    await h.run();
    expect(h.requests).toHaveLength(1);
  });

  test("Stop settles and unsubscribes an active generation that never emits a terminal", async () => {
    const stop = new AbortController();
    let tornDown = false;
    const h = harness(() => [], { signal: stop.signal, stream: (input) => new Observable((out) => {
      out.next(started(input));
      const timer = setTimeout(() => stop.abort(), 20);
      return () => { clearTimeout(timer); tornDown = true; };
    }) });
    await h.run();
    expect(tornDown).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.output.some((event) => event.type === EventType.CUSTOM && event.name === "openbot.headless.recovering")).toBe(false);
  });

  test("auth, unknown business failures and excessive cooldowns are not transient", () => {
    for (const failure of [
      { code: "INCOMPLETE_STREAM", message: "HTTP 401 Unauthorized" },
      { code: "INCOMPLETE_STREAM", message: "HTTP 503; quota exhausted" },
      { code: "INCOMPLETE_STREAM", message: "HTTP 503; retry after 900 seconds" },
      { code: "OPENBOT_HEADLESS_TOOL_ERROR", message: "HTTP 500 while running user code" },
      new Error("Unterminated string in JSON"),
      { code: "INCOMPLETE_STREAM", message: "Invalid request" },
      new DOMException("Cancelled by user", "AbortError"),
    ]) expect(headlessRecovery(failure)).toBeUndefined();
  });

  test("checkpoint messages and state are isolated from subsequent in-place mutations", () => {
    const messages: RunAgentInput["messages"] = [{ id: "task", role: "user", content: "original" }];
    const state = { progress: { done: 1 } };
    const checkpoint = new HeadlessStreamCheckpoint(messages, state);
    checkpoint.observe({ type: EventType.STATE_SNAPSHOT, snapshot: state }, messages, state);
    messages[0]!.content = "mutated";
    messages.push({ id: "partial", role: "assistant", content: "discard" });
    state.progress.done = 2;
    expect(checkpoint.messages).toEqual([{ id: "task", role: "user", content: "original" }]);
    expect(checkpoint.state).toEqual({ progress: { done: 1 } });
  });

  test("persistent incomplete arguments use a bounded budget and end with the original error", async () => {
    const h = harness((input, attempt) => [started(input), ...call(`partial-${attempt}`, false), { type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "arguments did not finish" }]);
    await h.run();
    expect(h.requests).toHaveLength(3);
    expect(h.executions()).toBe(0);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL", message: "arguments did not finish" });
    expect(h.output.filter((event) => event.type === EventType.RUN_ERROR)).toHaveLength(1);
  });

  test("Stop during reconnect backoff prevents another model request", async () => {
    const stop = new AbortController();
    const h = harness((input) => [started(input)], { delayMs: 10_000, signal: stop.signal,
      onEvent: (event) => { if (event.type === EventType.CUSTOM && event.name === "openbot.headless.recovering") stop.abort(); } });
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.executions()).toBe(0);
    expect(h.output.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });

  test("approval suspension never reconnects or executes the pending action twice", async () => {
    const h = harness((input) => [started(input), ...call("approval"), finished(input)], {
      execute: async () => { throw new HeadlessToolSuspension("Approval required", { kind: "approval", requestId: "approval1" }); },
    });
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.executions()).toBe(1);
    expect(h.output.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "interrupt" } });
  });
});

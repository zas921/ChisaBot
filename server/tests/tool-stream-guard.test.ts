import { describe, expect, test } from "bun:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { BuiltInAgent, type BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { lastValueFrom, of, toArray } from "rxjs";
import { z } from "zod";
import { continueToolRuns } from "../src/agents/tool-continuation";
import { guardToolCallStream } from "../src/agents/tool-stream-guard";

type ClassicConfig = Extract<BuiltInAgentConfiguration, { model: unknown }>;
type Model = Extract<ClassicConfig["model"], { specificationVersion: "v3" }>;
type Part = Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const finish = (reason: "other" | "tool-calls" | "stop"): Part => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});

const call = (id: string, name: string): Part[] => [
  { type: "tool-input-start", id, toolName: name },
  { type: "tool-input-delta", id, delta: '{"step":' },
  { type: "tool-input-delta", id, delta: '1}' },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: name, input: '{"step":1}' },
  finish("tool-calls"),
];

class LocalAgent extends BuiltInAgent {
  override run(input: RunAgentInput) {
    return continueToolRuns(input, (segment) => super.run(segment));
  }
}

function fixture(steps: Part[][], maxSteps = 2) {
  let requests = 0;
  let executions = 0;
  const events: BaseEvent[] = [];
  const model: Model = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doGenerate() { throw new Error("Expected streaming only"); },
    async doStream() {
      const parts = steps[requests++];
      if (!parts) throw new Error("Unexpected model request");
      return {
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  const agent = new LocalAgent({
    model, maxSteps, maxRetries: 0,
    tools: [{
      name: "record_step",
      description: "Record the requested step",
      parameters: z.object({ step: z.number() }),
      async execute() { executions += 1; return { recorded: true }; },
    }],
  });
  agent.threadId = "thread";
  agent.setMessages([{ id: "user", role: "user", content: "Record this step" }]);
  const run = async (tools: RunAgentInput["tools"] = []) => {
    // A producer RUN_ERROR may reject runAgent; capture both the events and the
    // public verifier failure so replacing it with a generic error cannot pass.
    const error = await agent.runAgent({ runId: "run", tools }, {
      onEvent: ({ event }) => { events.push(event); },
    }).then(() => null, (failure: unknown) => String(failure));
    return { events, error, requests, executions };
  };
  return { run };
}

describe("built-in tool input streaming", () => {
  test("a truncated second call ends honestly and leaves the executed tool alone", async () => {
    const result = await fixture([
      call("recorded", "record_step"),
      [
        { type: "tool-input-start", id: "cut", toolName: "record_step" },
        { type: "tool-input-delta", id: "cut", delta: '{"step":' },
        finish("other"),
      ],
    ]).run();

    expect(result.requests).toBe(2);
    expect(result.executions).toBe(1);
    expect(result.events.filter(({ type }) => type === EventType.TOOL_CALL_RESULT)).toEqual([
      expect.objectContaining({ toolCallId: "recorded", content: '{"recorded":true}' }),
    ]);
    expect(result.events.filter(({ type }) => type === EventType.TOOL_CALL_END)).toEqual([
      expect.objectContaining({ toolCallId: "recorded" }),
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL" });
    expect(result.error ?? "").not.toContain("while tool calls are still active");
    expect(result.events.some(({ type }) => type === EventType.RUN_FINISHED)).toBe(false);
  });

  test("a complete browser call without a result still hands off to the browser", async () => {
    const result = await fixture([call("browser", "browser_probe")], 1).run([{
      name: "browser_probe", description: "Run in the browser",
      parameters: { type: "object", properties: { step: { type: "number" } } },
    }]);

    expect(result.error).toBeNull();
    expect(result.requests).toBe(1);
    expect(result.executions).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({ type: EventType.TOOL_CALL_END, toolCallId: "browser" }));
    expect(result.events.some(({ type }) => type === EventType.TOOL_CALL_RESULT)).toBe(false);
    expect(result.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  test("a completed native tool still hands its result to the next model step", async () => {
    const result = await fixture([
      call("recorded", "record_step"),
      [
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        finish("stop"),
      ],
    ]).run();

    expect(result.error).toBeNull();
    expect(result.requests).toBe(2);
    expect(result.executions).toBe(1);
    expect(result.events.filter(({ type }) => type === EventType.TOOL_CALL_RESULT)).toEqual([
      expect.objectContaining({ toolCallId: "recorded", content: '{"recorded":true}' }),
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });
});

test("EOF with an open input is an error; explicit Stop and an upstream error keep their own outcome", async () => {
  const start: BaseEvent = { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" } as BaseEvent;
  const call: BaseEvent = { type: EventType.TOOL_CALL_START, toolCallId: "cut", toolCallName: "record_step" } as BaseEvent;
  const error: BaseEvent = { type: EventType.RUN_ERROR, code: "UPSTREAM", message: "provider failure" } as BaseEvent;
  const stopped: BaseEvent = { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run", outcome: { type: "cancelled" } } as BaseEvent;

  const collect = (events: BaseEvent[], stop?: () => boolean) =>
    lastValueFrom(guardToolCallStream(of(...events), stop).pipe(toArray()));

  expect((await collect([start, call])).at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: "INCOMPLETE_TOOL_CALL" });
  expect((await collect([start, call, error])).at(-1)).toEqual(error);
  expect((await collect([start, call, stopped], () => true)).some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
});

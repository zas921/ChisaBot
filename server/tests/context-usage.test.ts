import { describe, expect, test } from "bun:test";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { Observable, lastValueFrom, toArray } from "rxjs";
import {
  estimateTokens,
  meterLanguageModel,
  meterRun,
  readStepUsage,
  readingFromRunFinished,
} from "../src/context-usage";

/** 一个两步的假模型：每次 doStream 吐一个 finish，带 V3 形状的用量。 */
function fakeModel(steps: { input: number; output: number; cached?: number }[]) {
  let call = 0;
  return {
    specificationVersion: "v3",
    modelId: "fake/model",
    async doStream() {
      const step = steps[call++]!;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: { total: step.input, noCache: undefined, cacheRead: step.cached, cacheWrite: undefined },
                outputTokens: { total: step.output, text: undefined, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {}
}

describe("context usage", () => {
  test("reads both AI SDK usage shapes", () => {
    expect(readStepUsage({ inputTokens: { total: 10, cacheRead: 4 }, outputTokens: { total: 3 } })).toEqual({ inputTokens: 10, outputTokens: 3, cachedInputTokens: 4 });
    expect(readStepUsage({ inputTokens: 10, outputTokens: 3 })).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(readStepUsage({ inputTokens: { total: undefined } })).toBeUndefined();
    expect(readStepUsage(null)).toBeUndefined();
  });

  test("RUN_FINISHED carries the LAST step, not the run's sum", async () => {
    const model = meterLanguageModel(fakeModel([{ input: 1000, output: 50 }, { input: 1100, output: 80, cached: 900 }]));
    const run = () =>
      new Observable<BaseEvent>((subscriber) => {
        void (async () => {
          for (let i = 0; i < 2; i++) await drain((await model.doStream()).stream);
          subscriber.next({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r", metadata: { finishReason: "stop" } } as BaseEvent);
          subscriber.complete();
        })();
      });
    const events = await lastValueFrom(meterRun(run).pipe(toArray()));
    const finished = events.at(-1) as BaseEvent & { metadata: Record<string, unknown> };
    expect(finished.metadata.finishReason).toBe("stop");
    expect(finished.metadata.contextUsage).toEqual({ inputTokens: 1100, outputTokens: 80, cachedInputTokens: 900, model: "fake/model" });
  });

  test("a model outside a metered run is left alone", async () => {
    const model = meterLanguageModel(fakeModel([{ input: 5, output: 1 }]));
    await drain((await model.doStream()).stream);
    expect(model.modelId).toBe("fake/model");
  });

  test("readings: measured beats run-total; run-total is marked as such", () => {
    const at = new Date("2026-10-12T00:00:00Z");
    expect(readingFromRunFinished({ created_at: at, event: { metadata: { contextUsage: { inputTokens: 100, outputTokens: 20 } }, usage: [{ inputTokens: 999 }] } })).toMatchObject({ tokens: 120, source: "measured" });
    expect(readingFromRunFinished({ created_at: at, event: { usage: [{ inputTokens: 300, outputTokens: 10, model: "m" }] } })).toMatchObject({ tokens: 310, source: "run-total", model: "m" });
    expect(readingFromRunFinished({ created_at: at, event: {} })).toBeUndefined();
  });

  test("estimate counts CJK per character and skips inline images", () => {
    expect(estimateTokens([{ role: "user", content: "你好世界" }])).toBe(4 + 4);
    expect(estimateTokens([{ role: "user", content: [{ type: "image", data: "x".repeat(10_000) }] }])).toBe(4);
  });
});

/*
 * 2026-10-21 模型用量账本：每次模型调用都上报（model-usage/sink.ts），带上是哪个机器人；
 * 不在计量的运行里也报，上下文读数照旧。
 */
describe("model usage ledger feed", () => {
  test("every call is reported with the bot, metered run or not", async () => {
    const { setModelUsageSink } = await import("../src/model-usage/sink");
    const seen: unknown[] = [];
    setModelUsageSink((entry) => seen.push(entry));
    try {
      const model = meterLanguageModel(fakeModel([{ input: 120, output: 30, cached: 100 }]), { botId: "bot_1" });
      await drain((await model.doStream()).stream);
      expect(seen).toEqual([{ inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, model: "fake/model", botId: "bot_1" }]);
    } finally {
      setModelUsageSink(undefined);
    }
  });

  test("a sink that throws never breaks the answer", async () => {
    const { setModelUsageSink } = await import("../src/model-usage/sink");
    setModelUsageSink(() => {
      throw new Error("db down");
    });
    try {
      const model = meterLanguageModel(fakeModel([{ input: 5, output: 1 }]));
      await drain((await model.doStream()).stream);
    } finally {
      setModelUsageSink(undefined);
    }
  });
});

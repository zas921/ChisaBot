import { afterEach, describe, expect, test } from "bun:test";
import {
  allowedOutputLimit,
  outputLimitLanguageModel,
  rejectedOutputLimit,
  resetLearnedOutputLimits,
  setModelOutputLimitResolver,
} from "../src/copilot";

/**
 * OpenAI 兼容线路也要带输出上限（2026-10-22）：ChisaBot 经 Magpie 用 OpenAI 协议连 DeepSeek 一类模型，
 * 不带 max_tokens 时上游默认只给 4096，面板 spec / 写文件的长参数被截在 JSON 中间，工具调用就失败。
 */
afterEach(() => {
  resetLearnedOutputLimits();
  setModelOutputLimitResolver(async () => undefined);
});

function fakeModel(behaviour: (options: { maxOutputTokens?: number }) => unknown = () => ({ ok: true })) {
  const calls: (number | undefined)[] = [];
  const model = {
    modelId: "m",
    doStream: async (options: { maxOutputTokens?: number }) => {
      calls.push(options.maxOutputTokens);
      const result = behaviour(options);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { model, calls };
}
const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

describe("outputLimitLanguageModel（OpenAI 兼容线路）", () => {
  test("目录里有上限就用目录的（封顶），没有就用兜底值", async () => {
    setModelOutputLimitResolver(async (id) => (id === "known" ? 20_000 : undefined));
    const known = fakeModel();
    await (outputLimitLanguageModel(known.model, "known", { includeClaude: true, fallback: 8192 }) as typeof known.model).doStream({});
    expect(known.calls).toEqual([20_000]);
    const unknown = fakeModel();
    await (outputLimitLanguageModel(unknown.model, "unknown", { includeClaude: true, fallback: 8192 }) as typeof unknown.model).doStream({});
    expect(unknown.calls).toEqual([8192]);
  });

  test("调用方自己给了上限就不改；claude-* 在 OpenAI 线路上也补", async () => {
    const own = fakeModel();
    await (outputLimitLanguageModel(own.model, "x", { fallback: 8192 }) as typeof own.model).doStream({ maxOutputTokens: 512 });
    expect(own.calls).toEqual([512]);
    const claude = fakeModel();
    await (outputLimitLanguageModel(claude.model, "claude-sonnet", { includeClaude: true, fallback: 8192 }) as typeof claude.model).doStream({});
    expect(claude.calls).toEqual([8192]);
    const sdk = fakeModel();
    await (outputLimitLanguageModel(sdk.model, "claude-sonnet", { fallback: 8192 }) as typeof sdk.model).doStream({});
    expect(sdk.calls).toEqual([undefined]);
  });

  test("上游 400 说 max_tokens 最大 4096：按它说的重发，并记住，之后直接带 4096", async () => {
    const f = fakeModel(({ maxOutputTokens }) =>
      maxOutputTokens && maxOutputTokens > 4096
        ? badRequest("Invalid max_tokens value, the valid range of max_tokens is [1, 4096]")
        : { ok: true },
    );
    const wrapped = outputLimitLanguageModel(f.model, "small", { includeClaude: true, fallback: 8192 }) as typeof f.model;
    await wrapped.doStream({});
    await wrapped.doStream({});
    expect(f.calls).toEqual([8192, 4096, 4096]);
  });

  test("上游 400 却读不出上限：不带 max_tokens 重发，并记住不再带", async () => {
    const f = fakeModel(({ maxOutputTokens }) => (maxOutputTokens ? badRequest("max_tokens is not supported") : { ok: true }));
    const wrapped = outputLimitLanguageModel(f.model, "odd", { includeClaude: true, fallback: 8192 }) as typeof f.model;
    await wrapped.doStream({});
    await wrapped.doStream({});
    expect(f.calls).toEqual([8192, undefined, undefined]);
  });

  test("和上限无关的错误原样抛出，不重发", async () => {
    const f = fakeModel(() => Object.assign(new Error("rate limited"), { statusCode: 429 }));
    const wrapped = outputLimitLanguageModel(f.model, "any", { includeClaude: true, fallback: 8192 }) as typeof f.model;
    await expect(wrapped.doStream({})).rejects.toThrow("rate limited");
    expect(f.calls).toEqual([8192]);
  });
});

describe("读 400 的报错", () => {
  test("rejectedOutputLimit 只认 400 / 422 且提到上限", () => {
    expect(rejectedOutputLimit(badRequest("max_tokens must be <= 8192"))).toBe(true);
    expect(rejectedOutputLimit(badRequest("invalid api key"))).toBe(false);
    expect(rejectedOutputLimit(Object.assign(new Error("max_tokens too large"), { statusCode: 500 }))).toBe(false);
  });
  test("allowedOutputLimit 取比我们带的小、像上限的最大数字", () => {
    expect(allowedOutputLimit(badRequest("valid range of max_tokens is [1, 8192]"), 16_384)).toBe(8192);
    expect(allowedOutputLimit(badRequest("max_tokens: 100000 > 65,536"), 100_000)).toBe(65_536);
    expect(allowedOutputLimit(badRequest("no numbers here"), 8192)).toBeUndefined();
  });
});

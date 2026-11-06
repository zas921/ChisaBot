import { beforeEach, describe, expect, test } from "bun:test";
import {
  cooldownMs,
  coolingDown,
  explainModelError,
  type FallbackUse,
  fallbackCandidates,
  fallbackLanguageModel,
  fallbackNotice,
  fallbackReason,
  isQuotaError,
  modelCooldownScope,
  providerReason,
  resetModelCooldowns,
  withFallbackListener,
} from "../src/agents/model-fallback";

function apiError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody: message });
}
const DAILY = apiError(429, "ClinePass: Error 429: Daily free limit reached on model xiaomi/mimo-v2.6-flash. Try again in 19h 51m");

function fakeModel(id: string, behaviour: () => Promise<unknown>) {
  const calls: unknown[] = [];
  return {
    calls,
    model: {
      modelId: id,
      provider: "test",
      async doStream(options: unknown) {
        calls.push(options);
        return behaviour();
      },
      async doGenerate(options: unknown) {
        calls.push(options);
        return behaviour();
      },
    },
  };
}

describe("model fallback on quota errors", () => {
  beforeEach(() => resetModelCooldowns());

  test("recognises quota errors, not others", () => {
    expect(isQuotaError(DAILY)).toBe(true);
    expect(isQuotaError(apiError(402, "payment required"))).toBe(true);
    expect(isQuotaError({ name: "AI_RetryError", message: "Failed after 3 attempts", lastError: DAILY })).toBe(true);
    expect(isQuotaError(apiError(400, "invalid tool schema"))).toBe(false);
    expect(isQuotaError(apiError(500, "upstream exploded"))).toBe(false);
    expect(isQuotaError(new Error("network down"))).toBe(false);
  });

  test("reads the retry hint", () => {
    expect(cooldownMs(DAILY)).toBe((19 * 3600 + 51 * 60) * 1000);
    expect(cooldownMs(apiError(429, "rate limited, retry after 30s"))).toBe(30_000);
    // 没写原因的 429 是一时限流：1 分钟；写着额度 / 每日限额的 10 分钟（§101）。
    expect(cooldownMs(apiError(429, "slow down"))).toBe(60_000);
    expect(cooldownMs(apiError(429, "quota exceeded"))).toBe(10 * 60_000);
  });

  test("switches to the next candidate, then skips the cooled model on later turns", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const backup = fakeModel("b", async () => ({ stream: "ok-from-b" }));
    const logs: Record<string, unknown>[] = [];
    let t = 1_000;
    const wrapped = fallbackLanguageModel(primary.model, "clinepass/p", {
      candidates: async () => ["clinepass/b"],
      build: (id) => (id === "clinepass/b" ? backup.model : null),
      now: () => t,
      log: (line) => logs.push(line),
    });
    expect(await wrapped.doStream({ prompt: 1 })).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(1);
    expect(coolingDown("clinepass/p", t)).toBe(true);
    // next turn: primary not called at all
    expect(await wrapped.doGenerate({ prompt: 2 })).toEqual({ stream: "ok-from-b" });
    expect(primary.calls.length).toBe(1);
    expect(backup.calls).toEqual([{ prompt: 1 }, { prompt: 2 }]);
    expect(logs.map((l) => l.event)).toEqual(["primary-quota", "used", "used"]);
    // after the cooldown the primary is tried again
    t += 20 * 3600_000;
    expect(coolingDown("clinepass/p", t)).toBe(false);
    await wrapped.doStream({ prompt: 3 });
    expect(primary.calls.length).toBe(2);
  });

  test("non-quota errors are thrown unchanged and do not fall back", async () => {
    const boom = apiError(400, "bad request");
    const primary = fakeModel("p", async () => {
      throw boom;
    });
    let built = 0;
    const wrapped = fallbackLanguageModel(primary.model, "x/p", {
      candidates: async () => ["x/b"],
      build: () => {
        built++;
        return null;
      },
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toBe(boom);
    expect(built).toBe(0);
  });

  test("all candidates exhausted rethrows the first quota error", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const other = fakeModel("b", async () => {
      throw apiError(429, "Daily free limit reached");
    });
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/b"],
      build: () => other.model,
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toBe(DAILY);
  });

  test("a broken candidate (404 model not found) does not stop the next one (§101)", async () => {
    const primary = fakeModel("p", async () => {
      throw apiError(429, "rate limited");
    });
    const gone = fakeModel("gone", async () => {
      throw apiError(404, "ClinePass: model not found");
    });
    const ok = fakeModel("ok", async () => ({ stream: "ok" }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/gone", "c/ok"],
      build: (id) => (id === "c/gone" ? gone.model : ok.model),
      log: () => {},
    });
    expect(await wrapped.doStream({})).toEqual({ stream: "ok" });
    expect(gone.calls.length).toBe(1);
    // 坏掉的候选冷却 30 分钟，下一轮直接跳过
    expect(await wrapped.doStream({})).toEqual({ stream: "ok" });
    expect(gone.calls.length).toBe(1);
  });

  test("all failed models stay cooled until expiry instead of repeating the same long gateway wait", async () => {
    let primaryFails = true;
    let t = 1_000;
    const primary = fakeModel("p", async () => {
      if (primaryFails) throw apiError(429, "rate limited");
      return { stream: "primary-back" };
    });
    const gone = fakeModel("gone", async () => {
      throw apiError(404, "ClinePass: model not found");
    });
    const wrapped = fallbackLanguageModel(primary.model, "c/p", {
      candidates: async () => ["c/gone"],
      build: () => gone.model,
      now: () => t,
      log: () => {},
    });
    await expect(wrapped.doStream({})).rejects.toMatchObject({ statusCode: 429 });
    primaryFails = false;
    // 候选都失败不绕过冷却；恢复探测等到真实冷却期限。
    await expect(wrapped.doStream({})).rejects.toMatchObject({ statusCode: 429 });
    expect(primary.calls).toHaveLength(1);
    expect(gone.calls).toHaveLength(1);
    t += 60_001;
    expect(await wrapped.doStream({})).toEqual({ stream: "primary-back" });
  });

  test("keeps other properties of the wrapped model", () => {
    const primary = fakeModel("p", async () => ({}));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => [], build: () => null });
    expect(wrapped.modelId).toBe("p");
    expect(wrapped.provider).toBe("test");
  });

  test("candidates: env list, off, or same platform prefix from the catalog", async () => {
    const catalog = async () => ["clinepass/a", "clinepass/p", "opencode-zen/x-free", "clinepass/b", "clinepass/c", "clinepass/d"];
    expect(await fallbackCandidates(catalog, {})("clinepass/p")).toEqual(["clinepass/a", "clinepass/b", "clinepass/c"]);
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "codex/g, clinepass/p ,clinepass/b" })("clinepass/p")).toEqual(["codex/g", "clinepass/b"]);
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "off" })("clinepass/p")).toEqual([]);
    expect(await fallbackCandidates(catalog, {})("gpt-4o")).toEqual([]);
  });

  test("5xx / overloaded fall back too (short cooldown); 400/401/network do not", async () => {
    expect(fallbackReason(DAILY)).toBe("quota");
    expect(fallbackReason(apiError(503, "service unavailable"))).toBe("unavailable");
    expect(fallbackReason(apiError(529, "overloaded"))).toBe("unavailable");
    expect(fallbackReason(apiError(500, "upstream exploded"))).toBe("unavailable");
    expect(fallbackReason(apiError(400, "invalid tool schema"))).toBe(null);
    expect(fallbackReason(apiError(401, "invalid api key"))).toBe(null);
    expect(fallbackReason(new Error("network down"))).toBe(null);
    let t = 0;
    const primary = fakeModel("p", async () => {
      throw apiError(503, "service unavailable");
    });
    const backup = fakeModel("b", async () => ({ ok: "b" }));
    const wrapped = fallbackLanguageModel(primary.model, "m/p", {
      candidates: async () => ["m/b"],
      build: () => backup.model,
      now: () => t,
      log: () => {},
    });
    const seen: FallbackUse[] = [];
    expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))).toEqual({ ok: "b" });
    expect(seen).toEqual([{ from: "m/p", to: "m/b", reason: "unavailable" }]);
    expect(coolingDown("m/p", 60_000)).toBe(true);
    expect(coolingDown("m/p", 2 * 60_000 + 1)).toBe(false);
  });

  test("announces the switch to the listener of this run only, with the cooled reason on later turns", async () => {
    const primary = fakeModel("p", async () => {
      throw DAILY;
    });
    const backup = fakeModel("b", async () => ({ ok: true }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {} });
    const a: FallbackUse[] = [];
    const b: FallbackUse[] = [];
    await withFallbackListener((use) => a.push(use), () => wrapped.doStream({}));
    // 下一轮主模型在冷却，直接用备用模型，提示仍然说「额度用完」。
    await withFallbackListener((use) => b.push(use), () => wrapped.doGenerate({}));
    expect(a).toEqual([{ from: "c/p", to: "c/b", reason: "quota" }]);
    expect(b).toEqual([{ from: "c/p", to: "c/b", reason: "quota" }]);
    // 没有监听者也照常工作。
    expect(await wrapped.doStream({})).toEqual({ ok: true });
  });

  test("a primary that answers announces nothing", async () => {
    const primary = fakeModel("p", async () => ({ ok: "p" }));
    const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => ["c/b"], build: () => null, log: () => {} });
    const seen: FallbackUse[] = [];
    expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))).toEqual({ ok: "p" });
    expect(seen).toEqual([]);
  });

  test("candidates: the admin list wins over env and catalog, keeps its order, drops the primary", async () => {
    const catalog = async () => ["clinepass/a", "clinepass/p", "clinepass/b"];
    const admin = async () => ["codex/x", "clinepass/p", "clinepass/b"];
    expect(await fallbackCandidates(catalog, { CHISABOT_MODEL_FALLBACKS: "off" }, admin)("clinepass/p")).toEqual(["codex/x", "clinepass/b"]);
    // 空的管理员列表 = 不指定，退回环境变量 / 目录。
    expect(await fallbackCandidates(catalog, {}, async () => [])("clinepass/p")).toEqual(["clinepass/a", "clinepass/b"]);
    // 读管理员列表失败也不影响回答。
    expect(await fallbackCandidates(catalog, {}, async () => { throw new Error("db down"); })("clinepass/p")).toEqual(["clinepass/a", "clinepass/b"]);
  });

  test("notice text uses the short model name", () => {
    expect(fallbackNotice({ to: "clinepass/cline-free/step-5-preview", reason: "quota" })).toBe("主模型额度用完，已改用 step-5-preview");
    expect(fallbackNotice({ to: "codex/gpt-5.6-luna", reason: "unavailable" })).toBe("主模型暂时不可用，已改用 gpt-5.6-luna");
  });

  // §101.10：主模型一直不回（不报错）时也换备用模型。
  describe("primary that never answers", () => {
    const parts = (stream: ReadableStream<{ type?: string }>) =>
      (async () => {
        const out: unknown[] = [];
        const reader = stream.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) return out;
          out.push(next.value);
        }
      })();
    const hangs = () =>
      fakeModel("p", () => new Promise(() => {})).model;

    test("doGenerate that hangs past the deadline goes to the backup and cools the primary 1 min", async () => {
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const logs: Record<string, unknown>[] = [];
      const wrapped = fallbackLanguageModel(hangs(), "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: (l) => logs.push(l), firstOutputMs: 30 });
      const seen: FallbackUse[] = [];
      expect(await withFallbackListener((use) => seen.push(use), () => wrapped.doGenerate({}))).toEqual({ ok: "b" });
      expect(seen).toEqual([{ from: "c/p", to: "c/b", reason: "unavailable" }]);
      expect(logs.some((l) => l.event === "primary-timeout")).toBe(true);
      expect(coolingDown("c/p", Date.now() + 30_000)).toBe(true);
      expect(coolingDown("c/p", Date.now() + 61_000)).toBe(false);
    });

    test("doStream whose stream only says stream-start counts as no output; the hung request is aborted", async () => {
      let signal: AbortSignal | undefined;
      const primary = {
        modelId: "p",
        async doStream(options: { abortSignal?: AbortSignal }) {
          signal = options.abortSignal;
          return { stream: new ReadableStream({ start: (c) => c.enqueue({ type: "stream-start" }) }) };
        },
      };
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {}, firstOutputMs: 30 });
      expect(await wrapped.doStream({}) as unknown).toEqual({ ok: "b" });
      expect(signal?.aborted).toBe(true);
    });

    test("a primary that streams in time is untouched: same parts in order, nothing announced", async () => {
      const primary = {
        modelId: "p",
        async doStream(_options?: unknown) {
          return {
            request: { id: 1 },
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "stream-start" });
                c.enqueue({ type: "text-delta", delta: "你" });
                setTimeout(() => {
                  c.enqueue({ type: "text-delta", delta: "好" });
                  c.close();
                }, 60);
              },
            }),
          };
        },
      };
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => null, log: () => {}, firstOutputMs: 30 });
      const seen: FallbackUse[] = [];
      const result = (await withFallbackListener((use) => seen.push(use), () => wrapped.doStream({}))) as { request: unknown; stream: ReadableStream<{ type?: string }> };
      expect(result.request).toEqual({ id: 1 });
      expect(await parts(result.stream)).toEqual([{ type: "stream-start" }, { type: "text-delta", delta: "你" }, { type: "text-delta", delta: "好" }]);
      expect(seen).toEqual([]);
      expect(coolingDown("c/p")).toBe(false);
    });

    test("the person pressing stop is not a timeout: no backup", async () => {
      const backup = fakeModel("b", async () => ({ ok: "b" }));
      const primary = {
        modelId: "p",
        doGenerate: (options: { abortSignal?: AbortSignal }) =>
          new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
      };
      const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => ["c/b"], build: () => backup.model, log: () => {}, firstOutputMs: 5_000 });
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 20);
      await expect(wrapped.doGenerate({ abortSignal: stop.signal })).rejects.toThrow("aborted");
      expect(backup.calls.length).toBe(0);
    });

    test("no backup configured: no deadline, the primary is waited for", async () => {
      const primary = fakeModel("p", () => new Promise((resolve) => setTimeout(() => resolve({ ok: "slow" }), 80)));
      const wrapped = fallbackLanguageModel(primary.model, "c/p", { candidates: async () => [], build: () => null, log: () => {}, firstOutputMs: 20 });
      expect(await wrapped.doGenerate({})).toEqual({ ok: "slow" });
    });

    test("a backup candidate that hangs past the deadline is aborted and falls through to the next candidate", async () => {
      const hungBackup = fakeModel("b1", () => new Promise(() => {})).model;
      const goodBackup = fakeModel("b2", async () => ({ ok: "b2" }));
      const wrapped = fallbackLanguageModel(hangs(), "c/p", {
        candidates: async () => ["c/b1", "c/b2"],
        build: (id) => (id === "c/b1" ? hungBackup : goodBackup.model),
        log: () => {},
        firstOutputMs: 25,
      });
      expect(await wrapped.doGenerate({})).toEqual({ ok: "b2" });
      expect(coolingDown("c/b1")).toBe(true);
    });
  });
});

/*
 * 2026-10-21：模型出错时对话里要看得到原因。AI SDK 的 APICallError 只在 message 里放状态行，
 * 供应商原话在 responseBody；包装层原地补上「（模型 id · HTTP 状态码：原因）」，不换错误对象。
 */
describe("model errors carry the reason to the conversation", () => {
  beforeEach(() => resetModelCooldowns());

  test("status line only → model, status and the provider's own words", async () => {
    const error = Object.assign(new Error("Bad Request"), {
      name: "AI_APICallError",
      statusCode: 400,
      isRetryable: false,
      responseBody: JSON.stringify({ error: { message: "Model glm-9 does not exist", type: "invalid_request_error" } }),
    });
    const primary = fakeModel("p", async () => {
      throw error;
    });
    const wrapped = fallbackLanguageModel(primary.model, "clinepass/glm-9", { candidates: async () => [], build: () => null, log: () => {} });
    const thrown = await wrapped.doStream({}).catch((e: unknown) => e);
    expect(thrown).toBe(error);
    expect(error.message).toBe("Bad Request（模型 clinepass/glm-9 · HTTP 400：Model glm-9 does not exist）");
    expect((error as { isRetryable?: boolean }).isRetryable).toBe(false);
  });

  test("the same error is not annotated twice", () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401, responseBody: "invalid key" });
    explainModelError(error, "a/b");
    explainModelError(error, "a/b");
    expect(error.message).toBe("Unauthorized（模型 a/b · HTTP 401：invalid key）");
  });

  test("network failure: the cause is the reason", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 172.18.0.3:3425"), { code: "ECONNREFUSED" });
    const error = new TypeError("fetch failed", { cause });
    explainModelError(error, "m/x");
    expect(error.message).toBe("fetch failed（模型 m/x：connect ECONNREFUSED 172.18.0.3:3425）");
  });

  test("keys echoed back by the provider are masked", () => {
    const error = Object.assign(new Error("Unauthorized"), {
      statusCode: 401,
      responseBody: JSON.stringify({ error: { message: "Incorrect API key provided: sk-abcdefghijklmnop1234" } }),
    });
    explainModelError(error, "a/b");
    expect(error.message).not.toContain("abcdefghijklmnop1234");
    expect(error.message).toContain("Incorrect API key provided: sk-abc***");
  });

  test("the person pressing stop is left alone", () => {
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    explainModelError(error, "a/b");
    expect(error.message).toBe("This operation was aborted");
  });

  test("a key echoed in the original message is masked as well as the response body", () => {
    const error = new Error("Incorrect API key provided: sk-TEST_SENTINEL_NEVER_REAL_123456");
    explainModelError(error, "c/p");
    expect(error.message).not.toContain("SENTINEL");
    expect(error.message).toContain("sk-TES***");
  });

  test("providerReason reads common JSON shapes and HTML pages", () => {
    expect(providerReason('{"message":"quota exceeded"}')).toBe("quota exceeded");
    expect(providerReason('{"error":"model not found"}')).toBe("model not found");
    expect(providerReason('{"detail":"Not authenticated"}')).toBe("Not authenticated");
    expect(providerReason("<html><body><h1>502 Bad Gateway</h1></body></html>")).toBe("502 Bad Gateway");
    expect(providerReason("")).toBe("");
  });
});

describe("SSE failures before any model output", () => {
  beforeEach(() => resetModelCooldowns());
  type Part = { type: string; [key: string]: unknown };
  const streamModel = (parts: Part[]) => ({
    async doStream(_options: { abortSignal?: AbortSignal } = {}) {
      return { stream: new ReadableStream<Part>({ start(out) {
        for (const part of parts) out.enqueue(part);
        out.close();
      } }) };
    },
  });
  const drain = async (stream: ReadableStream<Part>) => {
    const parts: Part[] = [];
    for await (const part of stream) parts.push(part);
    return parts;
  };

  test("response.created metadata and empty text markers do not disable an explicit first-output deadline", async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const primary = { async doStream(options: { abortSignal?: AbortSignal }) {
      signal = options.abortSignal;
      return { stream: new ReadableStream<Part>({
        start(out) {
          out.enqueue({ type: "stream-start" });
          out.enqueue({ type: "response-metadata", id: "pending-response" });
          out.enqueue({ type: "text-start", id: "text" });
          out.enqueue({ type: "text-delta", id: "text", delta: "" });
        },
        cancel() { cancelled = true; },
      }) };
    } };
    const backup = fakeModel("b", async () => ({ ok: "b" }));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b"], build: () => backup.model, firstOutputMs: 20, log: () => {},
    });
    expect(await wrapped.doStream({}) as unknown).toEqual({ ok: "b" });
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("a default untimed stream can be stopped while only metadata has arrived", async () => {
    const stop = new AbortController();
    let cancelled = false;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const primary = { async doStream() {
      entered();
      return { stream: new ReadableStream<Part>({
        start(out) { out.enqueue({ type: "response-metadata" }); },
        cancel() { cancelled = true; },
      }) };
    } };
    const backup = fakeModel("b", async () => ({}));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b"], build: () => backup.model, log: () => {},
    });
    const result = (wrapped.doStream as (options: { abortSignal: AbortSignal }) => Promise<unknown>)({ abortSignal: stop.signal });
    await started;
    // Let the wrapper take ownership of the stream before simulating the stop button.
    await Bun.sleep(1);
    stop.abort(new DOMException("Stopped by user", "AbortError"));
    await expect(result).rejects.toThrow("Stopped by user");
    expect(backup.calls).toHaveLength(0);
    expect(cancelled).toBe(true);
  });

  test.each([
    { name: "chat error", error: { message: "Upstream service unavailable", statusCode: 503 } },
    { name: "Responses failure", error: { type: "response.failed", response: { error: { code: "server_error", message: "Upstream service unavailable" } } } },
    { name: "rate limit", error: { type: "rate_limit_error", message: "Too many requests" } },
  ])("$name inside HTTP 200 falls back without enabling a thinking deadline", async ({ error }) => {
    const primary = streamModel([{ type: "stream-start" }, { type: "response-metadata" }, { type: "error", error }]);
    const backup = fakeModel("b", async () => ({ ok: "b" }));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b"], build: () => backup.model, log: () => {},
    });
    expect(await wrapped.doStream() as unknown).toEqual({ ok: "b" });
    expect(backup.calls).toHaveLength(1);
    expect(coolingDown("c/p")).toBe(true);
  });

  test("an early reader rejection falls back and a failed streaming candidate is cooled", async () => {
    const primary = { async doStream() {
      return { stream: new ReadableStream<Part>({ start(out) { out.error(apiError(504, "Gateway timeout")); } }) };
    } };
    let candidateCalls = 0;
    const failed = streamModel([{ type: "error", error: { statusCode: 503, message: "Unavailable" } }]);
    const backup = { async doStream() { candidateCalls++; return failed.doStream(); } };
    const good = fakeModel("good", async () => ({ ok: "good" }));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b", "c/b", "c/good"],
      build: (id) => id === "c/b" ? backup : good.model, log: () => {},
    });
    expect(await wrapped.doStream() as unknown).toEqual({ ok: "good" });
    expect(await wrapped.doStream() as unknown).toEqual({ ok: "good" });
    expect(candidateCalls).toBe(1);
    expect(coolingDown("c/b")).toBe(true);
  });

  test("a gateway timeout does not exclude a healthy model merely for sharing its provider prefix", async () => {
    const primary = fakeModel("p", async () => { throw apiError(504, "Cloudflare gateway timeout"); });
    const backup = fakeModel("b", async () => ({ ok: "b" }));
    const wrapped = fallbackLanguageModel(primary.model, "api666-zzzcoding/p", {
      candidates: async () => ["api666-zzzcoding/b"], build: () => backup.model, log: () => {},
    });
    expect(await wrapped.doStream({})).toEqual({ ok: "b" });
    expect(primary.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(1);
  });

  test("a non-retryable SSE error surfaces the provider reason without switching", async () => {
    const primary = streamModel([{ type: "error", error: { statusCode: 400, message: "Invalid tool schema" } }]);
    const backup = fakeModel("b", async () => ({}));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b"], build: () => backup.model, log: () => {},
    });
    await expect(wrapped.doStream()).rejects.toThrow("Invalid tool schema（模型 c/p · HTTP 400）");
    expect(backup.calls).toHaveLength(0);
  });

  test("a JSON stream error cannot expose a key in its message", async () => {
    const primary = streamModel([{ type: "error", error: { statusCode: 401, message: "Incorrect API key provided: sk-TEST_SENTINEL_NEVER_REAL_123456" } }]);
    const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => [], build: () => null, log: () => {} });
    const error = await wrapped.doStream().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SENTINEL");
  });

  test("provider failure codes do not invent an HTTP error status for a successful SSE response", async () => {
    const primary = streamModel([{ type: "error", error: { type: "response.failed", response: { error: { code: "server_error", message: "Unavailable" } } } }]);
    const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => [], build: () => null, log: () => {} });
    const error = await wrapped.doStream().catch((error: Error) => error);
    expect((error as Error).message).toContain("Unavailable");
    expect((error as Error).message).not.toContain("HTTP");
  });

  test.each([
    { type: "text-delta", delta: "Already answered" },
    { type: "reasoning-delta", delta: "Already thinking" },
    { type: "tool-input-start", id: "tool-1", toolName: "write_file" },
    { type: "tool-call", toolCallId: "tool-1", toolName: "write_file", input: "{}" },
  ])("a later error after $type is explained but never replays the request", async (output) => {
    const primary = streamModel([
      { type: "stream-start" }, output,
      { type: "error", error: { statusCode: 503, message: "Upstream disconnected" } },
    ]);
    const backup = fakeModel("b", async () => ({}));
    const wrapped = fallbackLanguageModel(primary, "c/p", {
      candidates: async () => ["c/b"], build: () => backup.model, log: () => {},
    });
    const result = await wrapped.doStream();
    const parts = await drain(result.stream);
    expect(parts[1]).toEqual(output);
    expect((parts[2]?.error as Error).message).toBe("Upstream disconnected（模型 c/p · HTTP 503）");
    expect(backup.calls).toHaveLength(0);
  });

  test("empty successful streams preserve their metadata and finish event without inventing a failure", async () => {
    const parts: Part[] = [{ type: "stream-start" }, { type: "response-metadata", id: "empty" }, { type: "finish", finishReason: "stop" }];
    const primary = streamModel(parts);
    const wrapped = fallbackLanguageModel(primary, "c/p", { candidates: async () => [], build: () => null, log: () => {} });
    expect(await drain((await wrapped.doStream()).stream)).toEqual(parts);
  });

  test("the real Responses SDK recovers from an HTTP 200 response.created followed by response.failed", async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const seen: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        seen.push((await request.json() as { model: string }).model);
        const events = [
          { type: "response.created", response: { id: "response-1", model: "gpt-6-astra", created_at: 1 } },
          { type: "response.failed", sequence_number: 1, response: { error: { code: "server_error", message: "Upstream temporarily unavailable" } } },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const primary = createOpenAI({ baseURL: `${upstream.url}v1`, apiKey: "synthetic-test-key" }).responses("gpt-6-astra");
      const backup = streamModel([{ type: "text-delta", id: "reply", delta: "Recovered" }]);
      const notices: FallbackUse[] = [];
      const wrapped = fallbackLanguageModel(primary, "api666-zzzcoding/gpt-6-astra", {
        candidates: async () => ["api666-zzzcoding/gpt-6.1-sol"], build: () => backup, log: () => {},
      });
      const result = await withFallbackListener((use) => notices.push(use), () => wrapped.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }));
      expect(await drain(result.stream as ReadableStream<Part>)).toEqual([{ type: "text-delta", id: "reply", delta: "Recovered" }]);
      expect(seen).toEqual(["gpt-6-astra"]);
      expect(notices).toEqual([{ from: "api666-zzzcoding/gpt-6-astra", to: "api666-zzzcoding/gpt-6.1-sol", reason: "unavailable" }]);
    } finally {
      upstream.stop(true);
    }
  });
});

describe("model cooldowns are isolated by connection", () => {
  beforeEach(() => resetModelCooldowns());

  test("default wrappers with the same model name do not share failures or block a healthy connection", async () => {
    const failed = fakeModel("p", async () => { throw apiError(429, "SENTINEL_PRIVATE_A"); });
    const healthy = fakeModel("p", async () => ({ ok: "healthy" }));
    const deps = { candidates: async () => [], build: () => null, log: () => {} };
    const a = fallbackLanguageModel(failed.model, "same/model", deps);
    const b = fallbackLanguageModel(healthy.model, "same/model", deps);
    await expect(a.doStream({})).rejects.toThrow("SENTINEL_PRIVATE_A");
    expect(await b.doStream({})).toEqual({ ok: "healthy" });
    expect(healthy.calls).toHaveLength(1);
  });

  test("connection fingerprints share a cooldown only for the same provider, endpoint and credential", async () => {
    const connection = { provider: "openai", baseUrl: "https://gateway-a.example/v1" };
    const scope = modelCooldownScope(connection, "synthetic-key-a");
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(scope).not.toContain("synthetic-key");
    expect(modelCooldownScope(connection, "synthetic-key-a")).toBe(scope);
    expect(modelCooldownScope(connection, "synthetic-key-b")).not.toBe(scope);
    expect(modelCooldownScope({ ...connection, baseUrl: "https://gateway-b.example/v1" }, "synthetic-key-a")).not.toBe(scope);
    expect(modelCooldownScope({ ...connection, provider: "anthropic" }, "synthetic-key-a")).not.toBe(scope);
    expect(modelCooldownScope({ ...connection, useApiKey: false }, "synthetic-key-a")).not.toBe(scope);
    const failed = fakeModel("p", async () => { throw apiError(504, "Gateway timeout SENTINEL_PRIVATE_A"); });
    const second = fakeModel("p", async () => ({ ok: "same-connection" }));
    const healthy = fakeModel("p", async () => ({ ok: "rotated-credential" }));
    const deps = { candidates: async () => [], build: () => null, log: () => {}, cooldownScope: scope };
    await expect(fallbackLanguageModel(failed.model, "same/model", deps).doStream({})).rejects.toMatchObject({ statusCode: 504 });
    const cooled = await fallbackLanguageModel(second.model, "same/model", deps).doStream({}).catch((error: Error) => error);
    expect(cooled).toMatchObject({ statusCode: 504 });
    expect((cooled as Error).message).toContain("冷却中");
    expect((cooled as Error).message).not.toContain("SENTINEL_PRIVATE_A");
    expect(second.calls).toHaveLength(0);
    const rotated = fallbackLanguageModel(healthy.model, "same/model", {
      ...deps, cooldownScope: modelCooldownScope(connection, "synthetic-key-b"),
    });
    expect(await rotated.doStream({})).toEqual({ ok: "rotated-credential" });
    expect(healthy.calls).toHaveLength(1);
  });
});

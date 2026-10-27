import { expect, test } from "bun:test";
import { fallbackLanguageModel, FIRST_OUTPUT_MS, resetModelCooldowns } from "../src/agents/model-fallback";

test("a real HTTP model taking over 30 seconds is allowed to return without fallback", async () => {
  resetModelCooldowns();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 60,
    fetch: async () => {
      await Bun.sleep(31_000);
      return Response.json({ text: "Completed after hidden thinking" });
    },
  });
  let fallbackCalls = 0;
  const primary = { doGenerate: async ({ abortSignal }: { abortSignal: AbortSignal }) =>
    await (await fetch(upstream.url, { signal: abortSignal })).json(),
  };
  const wrapped = fallbackLanguageModel(primary, "thinking/slow-http", {
    candidates: async () => ["thinking/backup"],
    build: () => ({ doGenerate: async () => { fallbackCalls++; return { text: "wrong fallback" }; } }),
    log: () => {},
  });
  try {
    expect(await wrapped.doGenerate({ abortSignal: AbortSignal.timeout(38_000) })).toEqual({ text: "Completed after hidden thinking" });
    expect(fallbackCalls).toBe(0);
  } finally {
    upstream.stop(true);
  }
}, 40_000);

test("hidden thinking has no default first-output deadline; user abort still reaches the primary", async () => {
  expect(FIRST_OUTPUT_MS).toBe(0);
  resetModelCooldowns();
  const stop = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let fallbackCalls = 0;
  const primary = {
    doGenerate: ({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
      entered();
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    }),
  };
  const wrapped = fallbackLanguageModel(primary, "thinking/primary", {
    candidates: async () => ["thinking/backup"],
    build: () => ({ doGenerate: async () => { fallbackCalls++; return {}; } }),
    log: () => {},
  });
  const result = wrapped.doGenerate({ abortSignal: stop.signal });
  await started;
  stop.abort(new DOMException("Stopped by user", "AbortError"));
  await expect(result).rejects.toThrow("Stopped by user");
  expect(fallbackCalls).toBe(0);
});

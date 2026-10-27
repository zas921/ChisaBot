import { expect, test } from "bun:test";
import { fallbackLanguageModel, FIRST_OUTPUT_MS, resetModelCooldowns } from "../src/agents/model-fallback";

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

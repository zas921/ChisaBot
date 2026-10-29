import { AsyncLocalStorage } from "node:async_hooks";

// Only the durable scheduler enters this scope. Browser context/forwardedProps cannot authorize it.
const goals = new AsyncLocalStorage<string>();
export const withGoalContinuation = <T>(instruction: string, run: () => T): T =>
  goals.run(instruction, run);
export const currentGoalContinuation = () => goals.getStore();

/** Keep the current server turn directive after history; never persist a synthetic user message. */
export function goalContinuationModel<T>(model: T): T {
  if (!model || typeof model !== "object") return model;
  return new Proxy(model as object, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (
        (key === "doStream" || key === "doGenerate") &&
        typeof value === "function"
      ) {
        return (options: unknown) => {
          const instruction = currentGoalContinuation();
          const input = options as { prompt?: unknown[] } | null;
          if (!instruction || !Array.isArray(input?.prompt))
            return value.call(target, options);
          return value.call(target, {
            ...input,
            prompt: [...input.prompt, { role: "system", content: instruction }],
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

import { requiresResponsesApi } from "../../../shared/model-providers";

const ENCRYPTED_REASONING = "reasoning.encrypted_content";

/**
 * Gateway routes may select another upstream account on every request. Send the
 * complete Responses history instead of references to items stored by one account.
 * Request encrypted reasoning explicitly: SDK capability detection does not know
 * gateway-prefixed GPT model IDs, so store:false alone does not request it.
 */
export function statelessGatewayResponsesLanguageModel<T>(model: T, modelId: string): T {
  if (!model || typeof model !== "object" || modelId.trim().indexOf("/") <= 0 || !requiresResponsesApi(modelId)) return model;
  return new Proxy(model as object, {
    get(target, property) {
      // SDK models can use private fields in getters and methods.
      const value = Reflect.get(target, property, target);
      if ((property === "doStream" || property === "doGenerate") && typeof value === "function") {
        return (options: unknown) => {
          const input = options as {
            providerOptions?: Record<string, Record<string, unknown> | undefined>;
          } | undefined;
          const openai = input?.providerOptions?.openai;
          const include = Array.isArray(openai?.include) ? openai.include : [];
          return value.call(target, {
            ...input,
            providerOptions: {
              ...input?.providerOptions,
              openai: {
                ...openai,
                store: false,
                include: [...new Set([...include, ENCRYPTED_REASONING])],
              },
            },
          });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

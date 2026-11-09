import { expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { statelessGatewayResponsesLanguageModel } from "../src/agents/gateway-responses";
import { thinkTagLanguageModel } from "../src/agents/think-tags";

type WireRequest = {
  store?: boolean;
  include?: string[];
  previous_response_id?: string;
  input: Record<string, unknown>[];
};

test("stateless gateway scope preserves official Responses and chat models", () => {
  const model = { modelId: "unchanged" };
  for (const id of ["gpt-6-astra", "gpt-6.1-sol", "vendor/qwen", "vendor/gpt-4o"]) {
    expect(statelessGatewayResponsesLanguageModel(model, id)).toBe(model);
  }
  for (const id of ["chatflows/gpt-6-astra", "vendor/gpt-6.1-sol"]) {
    expect(statelessGatewayResponsesLanguageModel(model, id)).not.toBe(model);
  }
});

test("both gateway methods merge options without mutation and preserve private this and metadata", () => {
  class Model {
    #id = "private-model";
    get modelId() { return this.#id; }
    get specificationVersion() { return "v3"; }
    identify() { return this.#id; }
    doStream(options?: unknown) { return { model: this.#id, options }; }
    doGenerate(options?: unknown) { return { model: this.#id, options }; }
  }
  const model = statelessGatewayResponsesLanguageModel(new Model(), "vendor/gpt-6-astra");
  const signal = new AbortController().signal;
  const options = {
    prompt: [{ role: "user", content: [] }],
    abortSignal: signal,
    headers: { "x-test": "kept" },
    providerOptions: {
      other: { keep: true },
      openai: {
        store: true,
        reasoningEffort: "high",
        include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
      },
    },
  };
  const before = structuredClone({ ...options, abortSignal: undefined });
  for (const call of [model.doStream, model.doGenerate]) {
    expect(call(options)).toEqual({
      model: "private-model",
      options: {
        ...options,
        providerOptions: {
          other: { keep: true },
          openai: {
            store: false,
            reasoningEffort: "high",
            include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
          },
        },
      },
    });
  }
  expect({ ...options, abortSignal: undefined }).toEqual(before);
  expect(model.modelId).toBe("private-model");
  expect(model.specificationVersion).toBe("v3");
  expect(model.identify()).toBe("private-model");
  expect(model.doGenerate()).toEqual({
    model: "private-model",
    options: { providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } } },
  });
});

function responsesEvents(first: boolean): string {
  const events: Record<string, unknown>[] = [{
    type: "response.created",
    response: { id: first ? "resp_first" : "resp_second", created_at: 0, model: "gpt-6-astra" },
  }];
  if (first) {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_first", encrypted_content: "opaque_encrypted_reasoning" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_first", encrypted_content: "opaque_encrypted_reasoning" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_first", phase: "commentary" } },
      { type: "response.output_text.delta", item_id: "msg_first", delta: "I will use report_ok." },
      { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_first", phase: "commentary" } },
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_first", call_id: "call_first", name: "report_ok", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_first", output_index: 2, delta: "{}" },
      { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_first", call_id: "call_first", name: "report_ok", arguments: "{}", status: "completed" } },
    );
  } else {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_second", phase: "final_answer" } },
      { type: "response.output_text.delta", item_id: "msg_second", delta: "verified-ok" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_second", phase: "final_answer" } },
    );
  }
  events.push({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } });
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("real SDK executes one tool and sends complete second-step history to a stateless gateway", async () => {
  const requests: WireRequest[] = [];
  let executions = 0;
  const api = createOpenAI({
    apiKey: "isolated-test-only",
    baseURL: "https://mock.invalid/v1",
    fetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string) as WireRequest;
      requests.push(body);
      expect(body.store).toBe(false);
      expect(body.include).toContain("reasoning.encrypted_content");
      if (requests.length === 2) {
        // This gateway has no saved response items; the pre-fix request is refused.
        if (body.input.some((item) => item.type === "item_reference")) {
          return Response.json({ error: { message: "No stored response items" } }, { status: 400 });
        }
        expect(body.input.find((item) => item.type === "reasoning")).toEqual({
          type: "reasoning", id: "rs_first", encrypted_content: "opaque_encrypted_reasoning", summary: [],
        });
        expect(body.input.find((item) => item.role === "assistant")).toEqual({
          role: "assistant",
          content: [{ type: "output_text", text: "I will use report_ok." }],
          id: "msg_first",
          phase: "commentary",
        });
        const call = body.input.find((item) => item.type === "function_call");
        const result = body.input.find((item) => item.type === "function_call_output");
        expect(call?.call_id).toBe("call_first");
        expect(result?.call_id).toBe(call?.call_id);
        expect(JSON.parse(String(result?.output))).toEqual({ verified: true, value: 42 });
        expect(body.previous_response_id).toBeUndefined();
      }
      return new Response(responsesEvents(requests.length === 1), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const result = streamText({
    model: thinkTagLanguageModel(statelessGatewayResponsesLanguageModel(
      api.responses("chatflows/gpt-6-astra"), "chatflows/gpt-6-astra",
    )),
    prompt: "Use report_ok once, then answer.",
    tools: {
      report_ok: tool({
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => { executions++; return { verified: true, value: 42 }; },
      }),
    },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  });
  const errors: unknown[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "error") errors.push(part.error);
  }
  expect(errors).toEqual([]);
  expect(await result.finishReason).toBe("stop");
  expect(await result.text).toBe("verified-ok");
  expect(executions).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !request.input.some((item) => item.type === "item_reference"))).toBe(true);
});

test("real SDK non-streaming gateway request also uses stateless options", async () => {
  const requests: WireRequest[] = [];
  const api = createOpenAI({
    apiKey: "isolated-test-only",
    baseURL: "https://mock.invalid/v1",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init?.body as string) as WireRequest);
      return Response.json({
        id: "resp_generate", created_at: 0, model: "gpt-6.1-sol", status: "completed",
        output: [{ type: "message", id: "msg_generate", role: "assistant", content: [{ type: "output_text", text: "generated-ok", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const result = await statelessGatewayResponsesLanguageModel(
    api.responses("chatflows/gpt-6.1-sol"), "chatflows/gpt-6.1-sol",
  ).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
  expect(requests[0]?.store).toBe(false);
  expect(requests[0]?.include).toEqual(["reasoning.encrypted_content"]);
  expect(result.content.find((part) => part.type === "text")?.text).toBe("generated-ok");
});

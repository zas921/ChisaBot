import { expect, test } from "bun:test";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  connectionLanguageModel,
  registeredAgentFromRow,
} from "../src/copilot";
import { runOptionsFromValue } from "../src/agents/model-selection";
type TestModel = ReturnType<typeof connectionLanguageModel>;

test("stored settings reject malformed values and preserve explicit Fast off", () => {
  expect(
    runOptionsFromValue({
      reasoningEffort: "high",
      fastMode: false,
      apiKey: "private",
    }),
  ).toEqual({ reasoningEffort: "high", fastMode: false });
  expect(
    runOptionsFromValue({ reasoningEffort: "bogus", fastMode: "true" }),
  ).toEqual({});
  expect(runOptionsFromValue(null)).toEqual({});
});

test("BOT settings reach both real SDK wires, streaming calls, and inherited models without leaking between BOTs", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({ path, body });
      if (body.stream)
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      if (path.endsWith("/responses"))
        return Response.json({
          id: "resp_test",
          created_at: 1,
          model: body.model,
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      return Response.json({
        id: "test",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const prompt = {
    prompt: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello" }],
      },
    ],
  };
  const base = {
    provider: "openai" as const,
    defaultModel: "vendor/chat-model",
    baseUrl: `${server.url.origin}/v1`,
  };
  try {
    for (const id of ["vendor/chat-model", "vendor/gpt-6-sol"]) {
      const model = connectionLanguageModel(
        { ...base, defaultModel: id, reasoningEffort: "xhigh", fastMode: true },
        "test-key",
      );
      await model.doGenerate(prompt);
      await model.doStream(prompt);
    }
    expect(
      seen
        .slice(0, 2)
        .every(
          ({ path, body }) =>
            path === "/v1/chat/completions" &&
            body.reasoning_effort === "xhigh" &&
            body.service_tier === "priority",
        ),
    ).toBe(true);
    expect(
      seen
        .slice(2, 4)
        .every(
          ({ path, body }) =>
            path === "/v1/responses" &&
            (body.reasoning as { effort: string }).effort === "xhigh" &&
            body.service_tier === "priority",
        ),
    ).toBe(true);
    await connectionLanguageModel(
      { ...base, fastMode: false },
      "test-key",
    ).doGenerate(prompt);
    expect(seen.at(-1)?.body.service_tier).toBe("default");
    expect(seen.at(-1)?.body).not.toHaveProperty("reasoning_effort");
    await connectionLanguageModel(base, "test-key").doGenerate(prompt);
    expect(seen.at(-1)?.body).not.toHaveProperty("service_tier");
    expect(seen.at(-1)?.body).not.toHaveProperty("reasoning_effort");

    const bot = registeredAgentFromRow({
      id: "bot",
      name: "Bot",
      type: "built_in",
      title: "Bot",
      roleDescription: "Reply",
      configuration: { systemPrompt: "Reply" },
      override: { reasoningEffort: "high", fastMode: true },
    })!;
    const resolver = createActorAgentResolver({
      loadAgents: async () => [bot],
      model: base,
      resolveModelApiKey: async () => "test-key",
    });
    const agent = await resolver.resolveAgentForActor(
      { id: "owner", role: "admin" },
      "bot",
    );
    await (
      agent as unknown as { config: { model: TestModel } }
    ).config.model.doGenerate(prompt);
    expect(seen.at(-1)?.body).toMatchObject({
      model: "vendor/chat-model",
      reasoning_effort: "high",
      service_tier: "priority",
    });
    // An already captured per-turn snapshot wins over newer roster values.
    const scoped = createActorAgentResolver({
      loadAgents: async () => [bot],
      model: base,
      resolveModelApiKey: async () => "test-key",
      resolveConnectionForAgent: async () => ({
        model: { ...base, reasoningEffort: "low", fastMode: false },
        apiKey: "test-key",
      }),
    });
    const scopedAgent = await scoped.resolveAgentForActor(
      { id: "owner", role: "admin" },
      "bot",
    );
    await (
      scopedAgent as unknown as { config: { model: TestModel } }
    ).config.model.doGenerate(prompt);
    expect(seen.at(-1)?.body).toMatchObject({
      reasoning_effort: "low",
      service_tier: "default",
    });
  } finally {
    server.stop(true);
  }
});

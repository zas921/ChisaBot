import { expect, test } from "bun:test";
import {
  currentGoalContinuation,
  goalContinuationModel,
  withGoalContinuation,
} from "../src/agents/goal-context";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { registeredAgentFromRow } from "../src/copilot";

test("only the server continuation scope appends a current directive after old round restrictions", async () => {
  const inputs: unknown[] = [];
  const model = goalContinuationModel({
    doGenerate: async (input: unknown) => {
      inputs.push(input);
      return "ok";
    },
  });
  const prompt = [
    { role: "user", content: "End this initial round after starting the job" },
    { role: "assistant", content: "Waiting for the job" },
  ];
  await model.doGenerate({ prompt });
  expect((inputs[0] as { prompt: unknown[] }).prompt).toBe(prompt);
  await withGoalContinuation("Original job exited; now perform phase two", () =>
    model.doGenerate({ prompt }),
  );
  expect((inputs[1] as { prompt: unknown[] }).prompt.at(-1)).toEqual({
    role: "system",
    content: "Original job exited; now perform phase two",
  });
  expect(prompt).toHaveLength(2);
  expect(currentGoalContinuation()).toBeUndefined();
});

test("concurrent owners cannot inherit each other's continuation directive", async () => {
  const model = goalContinuationModel({
    doStream: async (input: { prompt: unknown[] }) => input.prompt.at(-1),
  });
  const results = await Promise.all(
    ["first-owner-goal", "second-owner-goal"].map((id) =>
      withGoalContinuation(id, async () => {
        await Bun.sleep(5);
        return model.doStream({ prompt: [] });
      }),
    ),
  );
  expect(results).toEqual([
    { role: "system", content: "first-owner-goal" },
    { role: "system", content: "second-owner-goal" },
  ]);
});

test("the real built-in provider request carries the current directive last without adding a user or transcript message", async () => {
  let sent: { role: string; content: unknown }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: typeof sent;
        model: string;
      };
      sent = body.messages;
      const chunk = {
        id: "goal-test",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
      };
      return new Response(
        [
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "EXECUTE_NEXT_PHASE" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const row = registeredAgentFromRow({
    id: "goal-wire-test",
    name: "Goal wire test",
    type: "built_in",
    title: "Test",
    roleDescription: "Execute the current task",
    configuration: { systemPrompt: "Execute the current task" },
  });
  const resolver = createActorAgentResolver({
    loadAgents: async () => [row!],
    model: {
      provider: "openai",
      defaultModel: "test-goal",
      baseUrl: `${upstream.url.origin}/v1`,
    },
    resolveModelApiKey: async () => "test-key",
  });
  try {
    await withGoalContinuation(
      "CURRENT_GOAL: original background job exited; execute phase two now",
      async () => {
        const agents = await resolver.resolveAgentsForActor({
          id: "owner",
          role: "admin",
        });
        const agent = agents["goal-wire-test"]!;
        agent.threadId = crypto.randomUUID();
        agent.setMessages([
          {
            id: "old-user",
            role: "user",
            content:
              "Initial round: start the background job and end this round",
          },
          {
            id: "old-reply",
            role: "assistant",
            content: "The background job is running",
          },
        ]);
        await agent.runAgent({
          runId: crypto.randomUUID(),
          context: [
            {
              description: "App context",
              value: "Earlier context goes in the initial prompt",
            },
          ],
        });
        expect(sent.at(-1)).toEqual({
          role: "system",
          content:
            "CURRENT_GOAL: original background job exited; execute phase two now",
        });
        expect(sent.filter((m) => m.role === "user")).toHaveLength(1);
        expect(agent.messages.some((m) => m.role === "system")).toBe(false);
        expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1);
      },
    );
  } finally {
    upstream.stop(true);
  }
});

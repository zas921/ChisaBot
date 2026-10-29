import { describe, expect, test } from "bun:test";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type RunFinishedEvent,
} from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import { z } from "zod";
import { continueToolRuns } from "../src/agents/tool-continuation";
import { withConfirmTurn, withToolAbort } from "../src/confirmations/context";
import { buildAgents } from "../src/copilot";
import { newSteerSession, withSteering } from "../src/thread-inbox";

describe("real built-in SDK tool segments", () => {
  test.each([
    ["probe", 49],
    ["panel_update", 61],
  ] as const)(
    "%s continues through several budgets and answers once",
    async (name, count) => {
      const f = await fixture(name, count);
      try {
        await f.run();
        expect(f.executions).toEqual(
          Array.from({ length: count }, (_, index) => index + 1),
        );
        expect(f.requests).toHaveLength(count + 1);
        expect(
          f.agent.messages.filter((message) => message.role === "user"),
        ).toHaveLength(1);
        expect(f.agent.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: "Task complete",
        });
        expect(
          f.events.filter((event) => event.type === EventType.RUN_STARTED),
        ).toHaveLength(1);
        const finished = f.events.filter(
          (event) => event.type === EventType.RUN_FINISHED,
        ) as RunFinishedEvent[];
        expect(finished).toHaveLength(1);
        expect(
          finished[0]?.usage?.reduce(
            (sum, usage) => sum + (usage.inputTokens ?? 0),
            0,
          ),
        ).toBe((count + 1) * 10);
        expect(JSON.stringify(f.requests)).not.toContain("工具步数快用完");
      } finally {
        f.close();
      }
    },
  );

  test.each([12, 24])(
    "Stop at native batch boundary %s prevents the next model request",
    async (stopAt) => {
      const f = await fixture("probe", 49, stopAt);
      try {
        await f.run();
        expect(f.executions).toHaveLength(stopAt);
        expect(f.requests).toHaveLength(stopAt);
      } finally {
        f.close();
      }
    },
  );

  test("a correction received mid-task remains visible across native batch boundaries", async () => {
    const f = await fixture("probe", 25);
    const queue = [
      {
        id: "correction",
        role: "user" as const,
        content: "Keep the requested correction",
      },
    ];
    const session = newSteerSession(
      async () => (f.executions.length >= 5 ? queue.splice(0) : []),
      () => {},
    );
    try {
      await withSteering(session, () => f.run());
      for (const request of f.requests.slice(5)) {
        expect(
          request.messages.filter((message) =>
            JSON.stringify(message.content).includes(
              "Keep the requested correction",
            ),
          ),
        ).toHaveLength(1);
      }
      expect(f.executions).toHaveLength(25);
    } finally {
      f.close();
    }
  });

  test("an approved tool result survives later native batches without executing the approved action again", async () => {
    const f = await fixture("probe", 25);
    f.agent.addMessage({
      id: "approved-message",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "approved-call",
          type: "function",
          function: { name: "probe", arguments: '{"n":1}' },
        },
      ],
    });
    try {
      await f.run([
        {
          interruptId: "approved-call",
          status: "resolved",
          payload: { completed: 1 },
        },
      ]);
      expect(f.executions).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 2),
      );
      expect(f.agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Task complete",
      });
      for (const request of f.requests) {
        expect(
          request.messages.filter(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "approved-call",
          ),
        ).toHaveLength(1);
        expect(
          request.messages.filter((message) => message.role === "tool"),
        ).toHaveLength(f.requests.indexOf(request) + 1);
      }
    } finally {
      f.close();
    }
  });
});

async function fixture(name: string, count: number, stopAt?: number) {
  const requests: {
    messages: { role: string; content: unknown; tool_call_id?: string }[];
  }[] = [];
  const executions: number[] = [];
  const events: BaseEvent[] = [];
  let stopped = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      const done = body.messages.filter(
        (message: { role: string }) => message.role === "tool",
      ).length;
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        id: `completion-${requests.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-tool-model",
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason
          ? {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
              },
            }
          : {}),
      });
      const chunks =
        done < count
          ? [
              chunk({
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${done + 1}`,
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify({ n: done + 1 }),
                    },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
          : [
              chunk({ role: "assistant", content: "Task complete" }),
              chunk({}, "stop"),
            ];
      return new Response(
        `${chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const agents = await buildAgents(
      [
        {
          id: "bot",
          name: "Bot",
          type: "built_in",
          systemPrompt: "Complete the task.",
        },
      ],
      {
        provider: "openai",
        defaultModel: "fixture-tool-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
      "fixture-key",
      undefined,
      async () => [
        {
          name,
          ref: "fixture/probe",
          description: "Complete one step",
          parameters: z.object({ n: z.number() }),
          execute: async ({ n }: { n: number }) => {
            executions.push(n);
            if (n === stopAt) stopped = true;
            return { completed: n };
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Cover attachment preparation too; it must happen before segment continuation.
      name === "panel_update" ? async () => null : undefined,
    );
    const agent = agents.bot!.clone();
    agent.threadId = "long-task";
    agent.setMessages([
      { id: "user", role: "user", content: "Complete all requested steps" },
    ]);
    const controller = new AbortController();
    return {
      agent,
      requests,
      executions,
      events,
      run: (resume?: RunAgentInput["resume"]) =>
        withConfirmTurn(
          { threadId: "long-task", runId: "one-run", stopped: () => stopped },
          () =>
            withToolAbort(controller.signal, () =>
              agent.runAgent(
                { runId: "one-run", resume },
                {
                  onEvent: ({ event }) => {
                    events.push(event);
                  },
                },
              ),
            ),
        ),
      close: () => server.stop(true),
    };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

const input: RunAgentInput = {
  threadId: "thread",
  runId: "run",
  messages: [{ id: "user", role: "user", content: "one task" }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
};
function segment(
  overrides: Partial<RunFinishedEvent> = {},
  result = "ok",
): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call",
      toolCallName: "probe",
      parentMessageId: "message",
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "call", delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId: "call" },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "call",
      messageId: "result",
      role: "tool",
      content: result,
    },
    {
      type: EventType.RUN_FINISHED,
      threadId: "thread",
      runId: "run",
      metadata: { finishReason: "tool-calls" },
      ...overrides,
    },
  ];
}

describe("native continuation boundaries", () => {
  test.each([
    ["normal completion", { metadata: { finishReason: "stop" } }, "ok"],
    ["cancelled", { outcome: { type: "cancelled" } }, "ok"],
    [
      "pending client tool",
      { outcome: { type: "success", pendingToolCallIds: ["external"] } },
      "ok",
    ],
    [
      "approval",
      {
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "call", reason: "human_input" }],
        },
      },
      "ok",
    ],
    ["tool error", {}, "Error: unavailable"],
    ["JSON encoded refusal", {}, JSON.stringify("Refused. Not allowed")],
    ["waiting", {}, '{"waiting":true}'],
    ["failed result", {}, '{"ok":false,"error":"unavailable"}'],
  ] as const)(
    "%s does not start another segment",
    async (_name, terminal, result) => {
      let calls = 0;
      const events = await lastValueFrom(
        continueToolRuns(input, () => {
          calls++;
          return of(...segment(terminal as Partial<RunFinishedEvent>, result));
        }).pipe(toArray()),
      );
      expect(calls).toBe(1);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    },
  );

  test("unanswered frontend tools are left for their executor", async () => {
    let calls = 0;
    const events = segment().filter(
      (event) => event.type !== EventType.TOOL_CALL_RESULT,
    );
    await lastValueFrom(
      continueToolRuns(input, () => {
        calls++;
        return of(...events);
      }).pipe(toArray()),
    );
    expect(calls).toBe(1);
  });

  test("no-progress and error segments cannot spin", async () => {
    for (const events of [
      segment().filter(
        (event) =>
          event.type === EventType.RUN_STARTED ||
          event.type === EventType.RUN_FINISHED,
      ),
      [{ type: EventType.RUN_ERROR, message: "model failed" } as BaseEvent],
    ]) {
      let calls = 0;
      await lastValueFrom(
        continueToolRuns(input, () => {
          calls++;
          return of(...events);
        }).pipe(toArray()),
      );
      expect(calls).toBe(1);
    }
  });

  test("continuation keeps state, context and approval results, and adds no user message", async () => {
    const requests: RunAgentInput[] = [];
    await lastValueFrom(
      continueToolRuns(
        {
          ...input,
          context: [{ description: "project", value: "42" }],
          forwardedProps: { model: "override" },
          resume: [
            { interruptId: "old", status: "resolved", payload: "saved" },
          ],
        },
        (request) => {
          requests.push(request);
          return requests.length === 1
            ? of(
                ...[
                  ...segment().slice(0, -1),
                  {
                    type: EventType.STATE_SNAPSHOT,
                    snapshot: { completed: 1 },
                  },
                  segment().at(-1)!,
                ],
              )
            : of({
                type: EventType.RUN_FINISHED,
                threadId: "thread",
                runId: "run",
                metadata: { finishReason: "stop" },
              });
        },
      ).pipe(toArray()),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      threadId: "thread",
      runId: "run",
      state: { completed: 1 },
      context: [{ description: "project", value: "42" }],
      forwardedProps: { model: "override" },
    });
    expect(requests[1]?.resume).toEqual([
      { interruptId: "old", status: "resolved", payload: "saved" },
    ]);
    expect(
      requests[1]?.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call",
    });
  });
});

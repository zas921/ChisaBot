import { expect, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/react-core/v2";
import { of, type Observable } from "rxjs";
import { z } from "zod/v4";
import { runContinuingAgent } from "../src/lib/copilot/continue-agent";

function fixture(options: { stopAt?: number; failAt?: number; waitingAt?: number; followUp?: boolean } = {}) {
  let runs = 0;
  let stopped = false;
  const executions: string[] = [];
  const forwarded: unknown[] = [];
  class Probe extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      runs++;
      forwarded.push(input.forwardedProps);
      const events: BaseEvent[] = [{ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent];
      if (runs <= 205) events.push(
        { type: EventType.TOOL_CALL_START, toolCallId: `call-${runs}`, toolCallName: "probe", parentMessageId: `message-${runs}` } as BaseEvent,
        { type: EventType.TOOL_CALL_ARGS, toolCallId: `call-${runs}`, delta: "{}" } as BaseEvent,
        { type: EventType.TOOL_CALL_END, toolCallId: `call-${runs}` } as BaseEvent,
      );
      else events.push(
        { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Finished after 205 tools" } as BaseEvent,
        { type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent,
      );
      events.push({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
      return of(...events);
    }
  }
  const agent = new Probe({ agentId: "probe", threadId: crypto.randomUUID(), initialMessages: [{ id: "user", role: "user", content: "one task" }] });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { probe: agent }, tools: [{
    name: "probe", description: "No-op test tool", parameters: z.object({}), followUp: options.followUp,
    handler: async (_args, context) => {
      executions.push(context.toolCall.id);
      if (executions.length === options.stopAt) { stopped = true; core.stopAgent({ agent }); }
      if (executions.length === options.failAt) throw new Error("test tool failed");
      if (executions.length === options.waitingAt) return { waiting: true };
      return "ok";
    },
  }] });
  return { core, agent, executions, forwarded, stopped: () => stopped, runs: () => runs };
}

test("continues past two SDK batch boundaries without repeating tools or user input", async () => {
  const f = fixture();
  await runContinuingAgent(f.core, { agent: f.agent, forwardedProps: { once: true } }, f.stopped);
  expect(f.runs()).toBe(206);
  expect(f.executions).toHaveLength(205);
  expect(new Set(f.executions).size).toBe(205);
  expect(f.agent.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(f.agent.messages.at(-1)).toMatchObject({ role: "assistant", content: "Finished after 205 tools" });
  expect(f.forwarded[100]).not.toMatchObject({ once: true });
});

test("manual Stop at a batch boundary prevents continuation", async () => {
  const f = fixture({ stopAt: 100 });
  await runContinuingAgent(f.core, { agent: f.agent }, f.stopped);
  expect(f.runs()).toBe(100);
  expect(f.executions).toHaveLength(100);
});

test.each(["failAt", "waitingAt"] as const)("%s at the batch boundary is not automatically retried", async (kind) => {
  const f = fixture({ [kind]: 100 });
  await runContinuingAgent(f.core, { agent: f.agent }, f.stopped);
  expect(f.runs()).toBe(100);
});

test("a tool that explicitly disables follow-up is respected", async () => {
  const f = fixture({ followUp: false });
  await runContinuingAgent(f.core, { agent: f.agent }, f.stopped);
  expect(f.runs()).toBe(1);
});

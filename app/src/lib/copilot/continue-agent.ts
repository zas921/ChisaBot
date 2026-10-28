import type { CopilotKitCore } from "@copilotkit/react-core/v2";

type RunOptions = Parameters<CopilotKitCore["runAgent"]>[0];
// CopilotKit 1.77.0 ends its recursive frontend-tool loop after 100 wire runs.
// Start a fresh SDK batch from the existing tool result instead of repeating user input/tools.
export const SDK_FOLLOW_UP_BATCH_SIZE = 100;

export async function runContinuingAgent(
  core: Pick<CopilotKitCore, "runAgent" | "getTool">,
  options: RunOptions,
  stopped: () => boolean = () => false,
) {
  const agent = options.agent;
  const threadId = agent.threadId;
  let next = options;
  for (;;) {
    let runs = 0;
    let failed = false;
    const before = new Set(agent.messages.map((message) => message.id));
    const subscription = agent.subscribe({
      onRunInitialized: () => { runs++; },
      onRunErrorEvent: () => { failed = true; },
      onRunFailed: () => { failed = true; },
      onRunFinishedEvent: ({ event }) => {
        if ((event as { outcome?: { type?: string } }).outcome?.type === "cancelled") failed = true;
      },
    });
    let result: Awaited<ReturnType<CopilotKitCore["runAgent"]>>;
    try {
      result = await core.runAgent(next);
    } finally {
      subscription.unsubscribe();
    }
    const last = agent.messages.at(-1);
    if (failed || stopped() || agent.threadId !== threadId || runs < SDK_FOLLOW_UP_BATCH_SIZE ||
        !last || last.role !== "tool" || before.has(last.id)) return result;
    const content = typeof last.content === "string" ? last.content : "";
    if (content.startsWith("Error:") || /^\s*\{\s*"waiting"\s*:\s*true/.test(content)) return result;
    const call = agent.messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : [])
      .find((call) => call.id === last.toolCallId);
    const tool = call && core.getTool({ toolName: call.function.name, agentId: agent.agentId });
    if (!tool?.handler || tool.followUp === false) return result;
    // Match SDK continuation semantics: one-shot resume/forwarded properties belong to the first request.
    next = { agent };
  }
}

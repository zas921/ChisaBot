import type { useAgent } from "@copilotkit/react-core/v2";

type Agent = ReturnType<typeof useAgent>["agent"];
type GuardIssue = "stream-ended" | "stream-closed" | "invalid-tool-input";

type WireCall = { name: string; args: string; ended: boolean; ambiguous: boolean };
type Terminal = "missing" | "success" | "error" | "interrupt" | "cancelled";

export const INCOMPLETE_FRONTEND_TOOL_REASON =
  "工具参数尚未传完，连接已中断。浏览器没有执行这次不完整的调用，已完成的步骤仍保留。";

export const INVALID_FRONTEND_TOOL_REASON =
  "机器人交给浏览器的工具参数不完整或格式有误，浏览器没有执行这批调用。已完成的步骤仍保留。";

function isJsonObject(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return "";
}

function isFrontendPlaceholder(value: unknown): boolean {
  // CopilotKit treats this sentinel as a handoff, not as an already executed tool.
  const text = Array.isArray(value) ? value.map(textOf).join("") : textOf(value);
  return text.trim() === "Forwarded to client";
}

const installed = new WeakMap<Agent, { notify: (issue: GuardIssue) => void }>();

/**
 * CopilotKit scans runAgent().newMessages for browser tools. AG-UI adds a call to
 * its transcript at START, and an EOF or detach can return those same messages
 * without END or RUN_FINISHED. Only allow an observed, complete handoff into the
 * SDK's dispatch list. Do not mutate the transcript or reconnect/retry a turn.
 */
export function guardFrontendToolDispatch(agent: Agent, notify: (issue: GuardIssue) => void): void {
  const previous = installed.get(agent);
  if (previous) {
    previous.notify = notify;
    return;
  }
  const listeners = { notify };
  installed.set(agent, listeners);
  const runAgent = agent.runAgent.bind(agent);

  agent.runAgent = async (options, subscriber) => {
    const thread = agent.threadId;
    const calls = new Map<string, WireCall>();
    const state: { requestedRun?: string; startedRun?: string; terminal: Terminal; pending?: Set<string> } = { terminal: "missing" };
    const result = await runAgent(options, {
      ...subscriber,
      onRunInitialized(params) {
        state.requestedRun = params.input.runId;
        return subscriber?.onRunInitialized?.(params);
      },
      onRunStartedEvent(params) {
        // A second browser can join an already active run. Its replay is display-only:
        // the backend keeps the original run ID, so it cannot grant fresh dispatch rights.
        if (params.event.threadId === thread && params.event.runId === state.requestedRun && !state.startedRun) {
          state.startedRun = params.event.runId;
        } else state.terminal = "error";
        return subscriber?.onRunStartedEvent?.(params);
      },
      onToolCallStartEvent(params) {
        const { toolCallId: id, toolCallName: name } = params.event;
        const prior = calls.get(id);
        if (prior) prior.ambiguous = true;
        else if (state.startedRun && state.terminal === "missing") {
          calls.set(id, { name, args: "", ended: false, ambiguous: false });
        }
        return subscriber?.onToolCallStartEvent?.(params);
      },
      onToolCallArgsEvent(params) {
        const call = calls.get(params.event.toolCallId);
        if (call) {
          if (call.ended || state.terminal !== "missing") call.ambiguous = true;
          else call.args += params.event.delta;
        }
        return subscriber?.onToolCallArgsEvent?.(params);
      },
      onToolCallEndEvent(params) {
        const call = calls.get(params.event.toolCallId);
        if (call) {
          if (call.ended || state.terminal !== "missing") call.ambiguous = true;
          else call.ended = true;
        }
        return subscriber?.onToolCallEndEvent?.(params);
      },
      onRunFinishedEvent(params) {
        if (state.startedRun === params.event.runId && state.terminal === "missing" && params.event.threadId === thread) {
          state.terminal = params.outcome;
          const outcome = params.event.outcome;
          if (outcome?.type === "success" && outcome.pendingToolCallIds) {
            state.pending = new Set(outcome.pendingToolCallIds);
          }
        } else state.terminal = "error";
        return subscriber?.onRunFinishedEvent?.(params);
      },
      onRunErrorEvent(params) {
        state.terminal = "error";
        return subscriber?.onRunErrorEvent?.(params);
      },
      onRunFailed(params) {
        state.terminal = "error";
        return subscriber?.onRunFailed?.(params);
      },
    });

    // Never let an old run consult the next thread's messages or authorize its tools.
    if (agent.threadId !== thread) return { ...result, newMessages: [] };
    const answered = new Set([...agent.messages, ...result.newMessages].flatMap((message) =>
      message.role === "tool" && !isFrontendPlaceholder(message.content) ? [message.toolCallId] : [],
    ));
    const pending = result.newMessages.flatMap((message) => message.role === "assistant"
      ? (message.toolCalls ?? []).filter((call) => !answered.has(call.id))
      : []);
    const valid = pending.every((pendingCall) => {
      const call = calls.get(pendingCall.id);
      return state.terminal === "success" &&
        (!state.pending || state.pending.has(pendingCall.id)) &&
        call?.ended && !call.ambiguous &&
        call.name === pendingCall.function.name &&
        call.args === pendingCall.function.arguments && isJsonObject(call.args);
    });
    // A failed batch cannot safely run a valid sibling and then follow up while another call is
    // missing. Answered calls never need dispatch, even if a duplicate placeholder precedes the
    // real result in history. Keep all results and change only the SDK's dispatch copy.
    if (state.startedRun && state.terminal === "missing") {
      // A clean EOF can arrive between server-side tools, when there is nothing
      // pending for this browser to dispatch. It still has no run outcome.
      listeners.notify(pending.length ? "stream-ended" : "stream-closed");
    } else if (!valid && state.terminal === "success") {
      listeners.notify("invalid-tool-input");
    }
    const authorized = new Set(valid ? pending.map((call) => call.id) : []);
    return {
      ...result,
      newMessages: result.newMessages.map((message) => {
        if (message.role !== "assistant" || !message.toolCalls?.length) return message;
        const toolCalls = message.toolCalls.filter((call) => authorized.has(call.id));
        return toolCalls.length === message.toolCalls.length ? message : { ...message, toolCalls };
      }),
    };
  };
}

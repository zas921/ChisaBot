import { type BaseEvent, EventType, type Message } from "@ag-ui/client";

type Call = {
  name: string;
  args: string;
  ended: boolean;
  valid: boolean;
  answered: boolean;
};

function isArgumentObject(args: string): boolean {
  try {
    const value: unknown = JSON.parse(args);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** An interrupted or cancelled RUN_FINISHED is not permission to dispatch browser tools. */
export function frontendToolFinish(event: BaseEvent): { ids?: ReadonlySet<string> } | null {
  if (event.type !== EventType.RUN_FINISHED) return null;
  const outcome = event.outcome;
  if (outcome === undefined) return {};
  if (!outcome || typeof outcome !== "object" || !("type" in outcome) || outcome.type !== "success") return null;
  if (!("pendingToolCallIds" in outcome) || outcome.pendingToolCallIds === undefined) return {};
  const ids = outcome.pendingToolCallIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? { ids: new Set(ids) } : null;
}

/** An assistant snapshot can contain an in-progress call; only committed wire events authorize a relay. */
export class FrontendToolHandoff {
  private readonly names: Set<string>;
  private readonly calls = new Map<string, Call>();
  private started = false;
  private terminal: "finished" | "error" | undefined;
  private allowed?: ReadonlySet<string>;

  constructor(tools: readonly { name: string }[]) {
    this.names = new Set(tools.map((tool) => tool.name));
  }

  observe(event: BaseEvent): void {
    switch (event.type) {
      case EventType.RUN_STARTED:
        this.started = true;
        break;
      case EventType.RUN_FINISHED: {
        const finish = frontendToolFinish(event);
        if (this.started && !this.terminal && finish) {
          this.terminal = "finished";
          this.allowed = finish.ids;
        } else {
          this.terminal = "error";
        }
        break;
      }
      case EventType.RUN_ERROR:
        this.terminal = "error";
        break;
      case EventType.TOOL_CALL_START: {
        if (typeof event.toolCallId !== "string" || typeof event.toolCallName !== "string") break;
        const previous = this.calls.get(event.toolCallId);
        if (previous) previous.valid = false;
        else if (this.started && !this.terminal && this.names.has(event.toolCallName)) {
          this.calls.set(event.toolCallId, {
            name: event.toolCallName, args: "", ended: false, valid: true, answered: false,
          });
        }
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        if (typeof event.toolCallId !== "string") break;
        const call = this.calls.get(event.toolCallId);
        if (!call) break;
        if (call.ended || this.terminal || typeof event.delta !== "string") call.valid = false;
        else call.args += event.delta;
        break;
      }
      case EventType.TOOL_CALL_END: {
        if (typeof event.toolCallId !== "string") break;
        const call = this.calls.get(event.toolCallId);
        if (!call) break;
        call.valid &&= !call.ended && !this.terminal && isArgumentObject(call.args);
        call.ended = true;
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        if (typeof event.toolCallId !== "string") break;
        const call = this.calls.get(event.toolCallId);
        if (call) call.answered = true;
        break;
      }
    }
  }

  inspect(messages: readonly Message[], allowed?: ReadonlySet<string>): { ready: string[]; incomplete: boolean } {
    const answered = new Set(messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
    const ready = new Set<string>();
    let incomplete = false;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        if (!this.names.has(call.function.name) || answered.has(call.id) || (allowed && !allowed.has(call.id))) continue;
        const saved = this.calls.get(call.id);
        if (saved?.answered) continue;
        if (saved?.ended && saved.valid && saved.name === call.function.name && saved.args === call.function.arguments) {
          ready.add(call.id);
        } else {
          incomplete = true;
        }
      }
    }
    // A missing transcript row cannot authorize an execution either.
    for (const [id, call] of this.calls) {
      if (!call.answered && !answered.has(id) && !ready.has(id) && (!allowed || allowed.has(id))) incomplete = true;
    }
    return { ready: [...ready], incomplete };
  }

  pending(messages: readonly Message[]): string[] {
    if (this.terminal !== "finished") return [];
    const { ready, incomplete } = this.inspect(messages, this.allowed);
    return incomplete ? [] : ready;
  }
}

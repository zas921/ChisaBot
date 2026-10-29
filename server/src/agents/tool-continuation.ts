import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { currentConfirmTurn, currentToolAbort } from "../confirmations/context";
import { REFUSAL_MARKER } from "../plugins/tools";

export const LONG_TASK_GUIDANCE =
  "长任务持续执行：按用户要求完成所有步骤并验证结果，再给最终答复。工具步数只是内部批次，达到批次边界后系统会自动从已有结果续跑；不要因为本轮步数结束而收尾，也不要要求用户说‘继续’。已完成的操作不要重复执行。需要审批、登录或关键资料时等待用户；用户停止时立即停止。";

/** Native results are JSON encoded on the AG-UI wire, including plain strings. */
function blockedResult(content: Message["content"]): boolean {
  let value: unknown = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* A plain tool result. */
    }
  }
  if (typeof value === "string")
    return (
      /^(Error:|没有执行|用户已停止)/.test(value.trimStart()) ||
      value.startsWith(REFUSAL_MARKER)
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    result.waiting === true ||
    result.humanHasControl === true ||
    result.ok === false ||
    (typeof result.error === "string" && result.error.length > 0)
  );
}

class SegmentTransport extends AbstractAgent {
  constructor(
    private readonly source: (input: RunAgentInput) => Observable<BaseEvent>,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) {
    return this.source(input);
  }
}

/**
 * A bounded AI SDK tool loop is a segment, not the end of the person's task.
 * Only continue an exhausted native-tool loop with newly answered calls. Frontend
 * calls, interrupts, cancellation, failures and a normal final answer keep their
 * existing lifecycle. One outer run owns persistence, metering and Stop throughout.
 */
class ToolContinuationMiddleware extends Middleware {
  constructor(
    private readonly source: (input: RunAgentInput) => Observable<BaseEvent>,
  ) {
    super();
  }

  run(input: RunAgentInput, _next: AbstractAgent): Observable<BaseEvent> {
    return new Observable((out) => {
      let subscription: Subscription | undefined;
      const signal = currentToolAbort();
      const turn = currentConfirmTurn();
      const stopped = () => out.closed || signal?.aborted || turn?.stopped();
      const usage: NonNullable<RunFinishedEvent["usage"]> = [];
      let started = false;
      const work = async () => {
        let request = input;
        while (!stopped()) {
          let messages = request.messages;
          let state = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          const calls = new Set<string>();
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new SegmentTransport(this.source, request),
            ).subscribe({
              next: ({ event, messages: updated, state: updatedState }) => {
                messages = updated;
                state = updatedState;
                if (event.type === EventType.RUN_FINISHED) {
                  terminal = event as RunFinishedEvent;
                  return;
                }
                if (event.type === EventType.RUN_STARTED) {
                  if (started) return;
                  started = true;
                }
                if (
                  event.type === EventType.TOOL_CALL_START &&
                  typeof event.toolCallId === "string"
                )
                  calls.add(event.toolCallId);
                if (event.type === EventType.RUN_ERROR) failed = true;
                out.next(event);
              },
              error: reject,
              complete: resolve,
            });
          });
          if (out.closed || failed) return;
          if (!terminal) return;
          usage.push(...(terminal.usage ?? []));
          const results = messages.filter(
            (message) =>
              message.role === "tool" && calls.has(message.toolCallId),
          );
          const answered = new Set(
            results.map((message) =>
              message.role === "tool" ? message.toolCallId : "",
            ),
          );
          const last = messages.at(-1);
          // Only the last tool group controls failure here: an earlier recoverable
          // error may already have been fixed by the model inside this segment.
          const lastCall = messages.findLast(
            (message) =>
              message.role === "assistant" && message.toolCalls?.length,
          );
          const lastIds = new Set(
            lastCall?.role === "assistant"
              ? lastCall.toolCalls?.map((call) => call.id)
              : [],
          );
          const canContinue =
            !stopped() &&
            (!terminal.outcome || terminal.outcome.type === "success") &&
            !(
              terminal.outcome?.type === "success" &&
              terminal.outcome.pendingToolCallIds?.length
            ) &&
            (terminal.metadata?.finishReason === "tool-calls" ||
              terminal.metadata?.finishReason === "tool_calls") &&
            calls.size > 0 &&
            [...calls].every((id) => answered.has(id)) &&
            last?.role === "tool" &&
            calls.has(last.toolCallId) &&
            !results.some(
              (message) =>
                message.role === "tool" &&
                lastIds.has(message.toolCallId) &&
                blockedResult(message.content),
            );
          if (!canContinue) {
            out.next({ ...terminal, ...(usage.length ? { usage } : {}) });
            return;
          }
          // BuiltInAgent adds resume results to its model prompt without emitting
          // TOOL_CALL_RESULT. Keep those payloads so a later segment still sees
          // the approved result; the SDK skips any already answered call and
          // never executes the resumed tool again. Keep overrides and run identity.
          request = { ...request, messages, state };
        }
      };
      work().then(
        () => out.complete(),
        (error: unknown) => out.error(error),
      );
      return () => subscription?.unsubscribe();
    });
  }
}

export function continueToolRuns(
  input: RunAgentInput,
  source: (input: RunAgentInput) => Observable<BaseEvent>,
) {
  return new ToolContinuationMiddleware(source).run(
    input,
    new SegmentTransport(source, input),
  );
}

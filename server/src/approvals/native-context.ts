import { AsyncLocalStorage } from "node:async_hooks";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { withApprovalContext } from "./types";

/**
 * 服务端工具执行前要等它的 `TOOL_CALL_END` 先走过 AG-UI 这条线（审批续跑要从消息里找到这次调用）。
 *
 * 以前是固定等 2 秒，等不到就报「The native tool call was not emitted through AG-UI.」（2026-10-22）：AI SDK 在模型这一步
 * 结束后立刻执行工具，而事件要先经 AG-UI 逐条应用（每条都克隆整段消息）才到这里——对话一长、参数事件一多（面板 spec、
 * 写文件的长内容），事件排队就超过 2 秒，工具被判失败，模型重试照样排队照样失败，面板和工具调用因此「经常失败」。
 * 现在按「事件停止流动」计时：只要这条线上还有事件在到达，就一直等；静默超过这个时长才算这次调用真的没有发出。
 */
export let NATIVE_CALL_IDLE_MS = (() => {
  const value = Number(process.env.CHISABOT_NATIVE_CALL_IDLE_MS);
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : 30_000;
})();
/** 测试用：缩短静默时限；返回之前的值。 */
export function setNativeCallIdleMs(ms: number): number {
  const previous = NATIVE_CALL_IDLE_MS;
  NATIVE_CALL_IDLE_MS = ms;
  return previous;
}

type NativeRun = {
  input: RunAgentInput;
  messages: Message[];
  state: unknown;
  waiting?: HeadlessToolSuspension;
  waitForCall(id: string): Promise<void>;
  suspend(error: HeadlessToolSuspension): void;
};
const nativeRuns = new AsyncLocalStorage<NativeRun>();

/** Where a suspended run's waiting details ride on its AG-UI interrupt. */
export const OPENBOT_WAITING_METADATA = "openbotWaiting";

export async function executeNativeApprovalTool<T>(
  name: string,
  args: unknown,
  toolCallId: string | undefined,
  initiator: AuditInitiator | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const run = nativeRuns.getStore();
  if (!run || !toolCallId) return execute();
  if (run.waiting) throw run.waiting;
  await run.waitForCall(toolCallId);
  if (run.waiting) throw run.waiting;
  const callMessage = run.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === toolCallId),
  );
  if (!callMessage)
    throw new Error(
      "The native tool call was not captured in its AG-UI conversation.",
    );
  const continuation = {
    runId: run.input.runId,
    threadId: run.input.threadId,
    toolCallId,
    toolName: name,
    args,
    messages: run.messages,
    state: run.state,
    context: run.input.context,
    forwardedProps: run.input.forwardedProps,
    initiator,
  };
  try {
    return await withApprovalContext(continuation, execute);
  } catch (error) {
    if (error instanceof HeadlessToolSuspension) {
      run.waiting = error;
      run.suspend(error);
    }
    throw error;
  }
}

class NativeStream extends AbstractAgent {
  constructor(
    private readonly source: () => Observable<BaseEvent>,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run() {
    return this.source();
  }
}
class NativeApprovalMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent) {
    return new Observable<BaseEvent>((subscriber) => {
      let subscription: Subscription | undefined;
      const captured = new Set<string>();
      const awaiting = new Map<
        string,
        {
          resolve(): void;
          reject(error: Error): void;
          expire(): void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const run: NativeRun = {
        input,
        messages: input.messages,
        state: input.state,
        waitForCall(id) {
          if (captured.has(id)) return Promise.resolve();
          return new Promise<void>((resolve, reject) => {
            const expire = () => {
              awaiting.delete(id);
              reject(
                new Error(
                  "The native tool call was not emitted through AG-UI.",
                ),
              );
            };
            awaiting.set(id, {
              resolve,
              reject,
              expire,
              timer: setTimeout(expire, NATIVE_CALL_IDLE_MS),
            });
          });
        },
        suspend(error) {
          subscriber.next({
            type: EventType.CUSTOM,
            name: "openbot.headless.waiting",
            value: { ...error.waiting, message: error.message },
          });
          subscriber.next({
            type: EventType.RUN_FINISHED,
            runId: input.runId,
            threadId: input.threadId,
            outcome: {
              type: "interrupt",
              interrupts: [
                {
                  id: String(
                    error.waiting.continuation &&
                      typeof error.waiting.continuation === "object" &&
                      "toolCallId" in error.waiting.continuation
                      ? error.waiting.continuation.toolCallId
                      : (error.waiting.requestId ?? "approval"),
                  ),
                  reason: "human_input",
                  message: error.message,
                  // Also on the interrupt: a run relayed through Intelligence arrives without the
                  // CUSTOM event above, and the interrupt is what a headless turn still sees.
                  metadata: {
                    [OPENBOT_WAITING_METADATA]: {
                      ...error.waiting,
                      message: error.message,
                    },
                  },
                },
              ],
            },
          });
          subscriber.complete();
          subscription?.unsubscribe();
        },
      };
      subscription = nativeRuns.run(run, () =>
        this.runNextWithState(input, next).subscribe({
          next({ event, messages, state }) {
            run.messages = messages;
            run.state = state;
            if (!run.waiting) subscriber.next(event);
            if (
              event.type === EventType.TOOL_CALL_END &&
              typeof event.toolCallId === "string"
            ) {
              captured.add(event.toolCallId);
              const pending = awaiting.get(event.toolCallId);
              if (pending) {
                clearTimeout(pending.timer);
                awaiting.delete(event.toolCallId);
                pending.resolve();
              }
            }
            // 这条线上还有事件在到达：还在排队处理，不是没发出——别的等待者的计时从现在重新算。
            for (const pending of awaiting.values()) {
              clearTimeout(pending.timer);
              pending.timer = setTimeout(pending.expire, NATIVE_CALL_IDLE_MS);
            }
          },
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      );
      return () => {
        subscription?.unsubscribe();
        for (const pending of awaiting.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The native tool run was stopped."));
        }
        awaiting.clear();
      };
    });
  }
}
export function nativeApprovalRun(
  input: RunAgentInput,
  source: () => Observable<BaseEvent>,
) {
  return new NativeApprovalMiddleware().run(
    input,
    new NativeStream(source, input),
  );
}

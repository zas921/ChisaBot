import { afterAll, describe, expect, test } from "bun:test";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";

/**
 * 服务端工具执行前要等 `TOOL_CALL_END` 先走过 AG-UI（approvals/native-context.ts）。
 * 以前固定等 2 秒：对话长 / 参数事件多时事件排队超过 2 秒，工具被判失败（「The native tool call was not
 * emitted through AG-UI.」），面板和工具调用因此经常失败（2026-10-22）。现在按事件停止流动计时。
 * 这里把静默时限压到 1 秒来测。
 */
import { executeNativeApprovalTool, nativeApprovalRun, setNativeCallIdleMs } from "../src/approvals/native-context";

const previousIdle = setNativeCallIdleMs(1_000);
afterAll(() => {
  setNativeCallIdleMs(previousIdle);
});

const input = {
  threadId: "t1",
  runId: "r1",
  messages: [],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
} as unknown as RunAgentInput;

const start = (id: string) =>
  ({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "panel_update", parentMessageId: "m1" }) as BaseEvent;
const args = (id: string, delta: string) => ({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta }) as BaseEvent;
const end = (id: string) => ({ type: EventType.TOOL_CALL_END, toolCallId: id }) as BaseEvent;

function run(source: (emit: (event: BaseEvent) => void, execute: () => Promise<string>) => void, toolCallId: string) {
  const result: { value?: Promise<string> } = {};
  const events = nativeApprovalRun(
    input,
    () =>
      new Observable<BaseEvent>((subscriber) => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent);
        // 工具在模型这一步结束后立刻开始执行，此时它的事件还在排队。
        result.value = executeNativeApprovalTool("panel_update", {}, toolCallId, undefined, async () => "ran");
        result.value.catch(() => undefined);
        source((event) => subscriber.next(event), () => result.value!);
        return () => undefined;
      }),
  );
  const subscription = events.subscribe({ error: () => undefined });
  return { result, stop: () => subscription.unsubscribe() };
}

describe("等工具调用的 AG-UI 事件", () => {
  test("事件在排队、每条间隔不长：总共等得比静默时限还久也照样等到，工具正常执行", async () => {
    const { result, stop } = run((emit) => {
      emit(start("c1"));
      let delay = 0;
      for (const piece of ["a", "b", "c", "d"]) {
        delay += 500;
        setTimeout(() => emit(args("c1", piece)), delay);
      }
      setTimeout(() => emit(end("c1")), delay + 500); // 2.5 秒后才到，已经超过 1 秒的固定时限
    }, "c1");
    await expect(result.value).resolves.toBe("ran");
    stop();
  }, 8_000);

  test("事件已经走过：立刻执行", async () => {
    const { result, stop } = run((emit) => {
      emit(start("c2"));
      emit(end("c2"));
    }, "c2");
    await expect(result.value).resolves.toBe("ran");
    stop();
  });

  test("一直没有任何事件：静默超过时限才报「没有通过 AG-UI 发出」", async () => {
    const { result, stop } = run((emit) => {
      emit(start("c3")); // 没有 END，之后也不再有事件
    }, "c3");
    await expect(result.value).rejects.toThrow("not emitted through AG-UI");
    stop();
  }, 8_000);
});

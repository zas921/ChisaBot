import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MessageEditor } from "@/components/chat/message-actions";
import { MessageActionsContext } from "@/lib/copilot/regenerate";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => { cleanup(); await settleReactWork(); });
afterAll(async () => { await settleReactWork(); GlobalRegistrator.unregister(); });

function editor(edit: (id: string, text: string) => Promise<void>, canAct = true, initial = "请继续完成这个任务") {
  let closes = 0;
  const view = render(<MessageActionsContext.Provider value={{ canAct, edit, regenerate: async () => {} }}>
    <MessageEditor initial={initial} messageId="original-user-id" onClose={() => { closes++; }} />
  </MessageActionsContext.Provider>);
  return { ...view, closes: () => closes };
}

test("opening Edit permits sending the original task without changing any text", async () => {
  const calls: Array<[string, string]> = [];
  const view = editor(async (id, text) => { calls.push([id, text]); });
  const send = view.getByTestId("msg-editor-send") as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(view.closes()).toBe(1));
  expect(calls).toEqual([["original-user-id", "请继续完成这个任务"]]);
});

test("Enter resends unchanged text while an IME composition does not", async () => {
  let calls = 0;
  const view = editor(async () => { calls++; });
  const input = view.getByRole("textbox", { name: "编辑消息" });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(calls).toBe(0);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(calls).toBe(1));
});

test("a pending unchanged resend cannot submit twice", async () => {
  let calls = 0, finish!: () => void;
  const view = editor(async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); });
  const send = view.getByTestId("msg-editor-send") as HTMLButtonElement;
  fireEvent.click(send);
  await waitFor(() => expect(send.disabled).toBe(true));
  fireEvent.click(send);
  fireEvent.keyDown(view.getByRole("textbox", { name: "编辑消息" }), { key: "Enter" });
  expect(calls).toBe(1);
  await act(async () => { finish(); });
  expect(view.closes()).toBe(1);
});

test("empty text and an already busy conversation still block resending", () => {
  let calls = 0;
  const view = editor(async () => { calls++; }, true, "  ");
  expect((view.getByTestId("msg-editor-send") as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  const busy = editor(async () => { calls++; }, false);
  expect((busy.getByTestId("msg-editor-send") as HTMLButtonElement).disabled).toBe(true);
  expect(calls).toBe(0);
});

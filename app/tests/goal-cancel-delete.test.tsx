import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { BotThreadHistoryDialog } from "@/components/agents/bot-thread-history";
import { GoalTaskStatus } from "@/components/channels/goal-task-status";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
let queryClient: QueryClient;
let writes: string[];
let goalStatus: string;
let deleteStatus: number;
let confirmed: boolean;
beforeAll(() => GlobalRegistrator.register({ url: "https://openbot.test/" }));
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  writes = [];
  goalStatus = "paused";
  deleteStatus = 204;
  confirmed = false;
  window.confirm = () => confirmed;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/goal-tasks" && method === "GET") {
      const row = { objective: "验证恢复的目标控制", detail: null, criteria: [{ id: "done", title: "完成验收" }], jobs: [] };
      return Response.json({ tasks: [{ ...row, id: "older", status: "completed" }, { ...row, id: "active-goal", status: goalStatus }] });
    }
    if (path === "/api/goal-tasks/active-goal/cancel" && method === "POST") {
      goalStatus = "cancelled";
      return Response.json({ ok: true });
    }
    if (path === "/api/bot-threads/bot/history") return Response.json({ threads: [{ threadId: "current", title: "当前会话", messages: 5, updatedAt: null }] });
    if (path === "/api/copilotkit/threads/current" && method === "DELETE") return new Response(null, { status: deleteStatus });
    throw new Error(`Unexpected request: ${method} ${path}`);
  }, { preconnect: originalFetch.preconnect });
});
afterEach(async () => {
  cleanup();
  queryClient.clear();
  await settleReactWork();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());
const wrap = (node: ReactNode) => <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;

test("cancel targets the live goal behind a completed row, requires confirmation, then frees its UI slot", async () => {
  const view = render(wrap(<GoalTaskStatus threadId="current" />));
  const status = await view.findByTestId("goal-task-status");
  expect(status.getAttribute("aria-label")).toContain("已暂停");
  await act(async () => { fireEvent.click(status); });
  const cancel = await view.findByTestId("goal-task-cancel");
  await act(async () => { fireEvent.click(cancel); });
  expect(writes).toEqual([]);
  confirmed = true;
  await act(async () => {
    fireEvent.click(cancel);
    // TanStack batches its invalidation notification on the next timer turn.
    // Keep that update inside act before waiting for the dialog to unmount.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(view.queryByTestId("goal-task-status")).toBeNull());
  expect(writes).toEqual(["POST /api/goal-tasks/active-goal/cancel"]);
});

test("deleting the current conversation requires confirmation and returns to a new topic only after success", async () => {
  let closed = false;
  let deletedCurrent = 0;
  let picked = 0;
  const view = render(wrap(<BotThreadHistoryDialog agentId="bot" currentThreadId="current" open onOpenChange={open => { closed = !open; }} onPick={() => { picked += 1; }} onDeletedCurrent={() => { deletedCurrent += 1; }} />));
  const remove = await view.findByRole("button", { name: "删除对话：当前会话" });
  await act(async () => { fireEvent.click(remove); });
  expect(writes).toEqual([]);
  expect(deletedCurrent).toBe(0);
  confirmed = true;
  deleteStatus = 409;
  await act(async () => { fireEvent.click(remove); });
  await view.findByText("对话还在回答，请先停止再删除。");
  expect(closed).toBe(false);
  expect(deletedCurrent).toBe(0);
  deleteStatus = 204;
  await act(async () => { fireEvent.click(remove); });
  await waitFor(() => expect(deletedCurrent).toBe(1));
  expect(closed).toBe(true);
  expect(picked).toBe(0);
  expect(writes).toEqual(["DELETE /api/copilotkit/threads/current", "DELETE /api/copilotkit/threads/current"]);
});

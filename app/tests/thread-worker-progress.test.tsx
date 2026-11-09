import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThreadWorkerProgress } from "@/components/chat/thread-worker-progress";
import { KeptVisibleContext } from "@/lib/kept-visible";
import { useThreadWorkers, useWorkerLiveActivity, type WorkerView } from "@/lib/copilot/workers";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let calls: string[];
let mutations: string[];
let failed: boolean;
let seq: string;
let workers: Map<string, WorkerView[]>;
const makeWorker = (id: string, title = id): WorkerView => ({
  id, title, status: "running", step: "等待数据源返回", plan: [{ text: "读取数据", status: "current" }, { text: "整理结果", status: "pending" }],
  summary: null, error: null, resultMessageId: null,
  createdAt: new Date(Date.now() - 70_000).toISOString(), startedAt: new Date(Date.now() - 62_000).toISOString(), finishedAt: null,
});

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  window.localStorage.clear();
  calls = []; mutations = []; failed = false; seq = "10";
  workers = new Map([["thread-a", [makeWorker("worker-a", "A 的取数任务")]], ["thread-b", [makeWorker("worker-b", "B 的整理任务")]]]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${url.pathname}${url.search}`);
    if (init?.method && init.method !== "GET") mutations.push(`${init.method} ${url.pathname}`);
    if (failed) return Response.json({ error: "temporary" }, { status: 503 });
    const match = url.pathname.match(/\/threads\/([^/]+)\/workers$/);
    if (match) return Response.json({ workers: workers.get(match[1]!) ?? [] });
    if (url.pathname.endsWith("/sync")) return Response.json({ current: null, thread: {
      threadId: url.searchParams.get("threadId"), seq, running: true, live: true, waiting: false, workers: null, inbox: null,
    } });
    throw new Error(`Unexpected local request ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  await settleReactWork();
  window.localStorage.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => { await settleReactWork(); GlobalRegistrator.unregister(); });

function queryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return client;
}
function wrapper(client = queryClient()) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

test("progress is available without a delegation tool message and shows honest steps and duration", async () => {
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper() });
  await view.findByText("A 的取数任务");
  expect(view.getByText("后台任务")).toBeTruthy();
  expect(view.getByText("1 项进行中")).toBeTruthy();
  expect(view.getByText("最近上报步骤：等待数据源返回")).toBeTruthy();
  expect(view.getByText("读取数据")).toBeTruthy();
  expect(view.getByText("整理结果")).toBeTruthy();
  expect(view.getByText(/已运行 1 分/)).toBeTruthy();
  await view.findByText("已连接后台，正在追踪新的进展");
  expect(view.queryByText(/检测到进展/)).toBeNull();
  expect(view.container.textContent).not.toContain("%");
});

test("a failed refresh retains the previous tasks and exposes retry", async () => {
  const client = queryClient();
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper(client) });
  await view.findByText("A 的取数任务");
  failed = true;
  await act(async () => { await client.refetchQueries({ queryKey: ["thread-workers", "thread-a"], exact: true }); });
  expect(view.getByText("A 的取数任务")).toBeTruthy();
  await view.findByText("进度暂时无法刷新，正在重试；保留上次记录。");
  expect(view.getByRole("button", { name: "刷新后台任务进度" })).toBeTruthy();
});

test("switching Bots never shows the previous Bot's worker list", async () => {
  const client = queryClient();
  const wrap = wrapper(client);
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrap });
  await view.findByText("A 的取数任务");
  view.rerender(<ThreadWorkerProgress threadId="thread-b" agentId="bot-b" />);
  expect(view.queryByText("A 的取数任务")).toBeNull();
  await view.findByText("B 的整理任务");
  view.rerender(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />);
  expect(view.getByText("A 的取数任务")).toBeTruthy();
  expect(view.queryByText("B 的整理任务")).toBeNull();
  expect(calls.some((path) => path.includes("bot-a/sync?threadId=worker-worker-a"))).toBe(true);
  expect(calls.some((path) => path.includes("bot-b/sync?threadId=worker-worker-b"))).toBe(true);
});

test("refresh updates progress while its original tool message is absent", async () => {
  const client = queryClient();
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper(client) });
  await view.findByText("A 的取数任务");
  workers.set("thread-a", [{ ...workers.get("thread-a")![0]!, step: "已收到数据，正在整理" }]);
  await act(async () => { await client.refetchQueries({ queryKey: ["thread-workers", "thread-a"], exact: true }); });
  await view.findByText("最近上报步骤：已收到数据，正在整理", {}, { timeout: 2_500 });
});

test("cursor polling records activity only when the event sequence changes", async () => {
  const worker = makeWorker("worker-a");
  const hook = renderHook(() => useWorkerLiveActivity(worker, "bot-a"), { wrapper: wrapper() });
  await waitFor(() => expect(hook.result.current.data?.seq).toBe("10"));
  expect(hook.result.current.data?.detectedAt).toBeNull();
  await act(async () => { await hook.result.current.refetch(); });
  expect(hook.result.current.data?.detectedAt).toBeNull();
  const start = Date.now(); seq = "12";
  await act(async () => { await hook.result.current.refetch(); });
  await waitFor(() => expect(hook.result.current.data?.detectedAt).toBeGreaterThanOrEqual(start));
  const detected = hook.result.current.data?.detectedAt;
  await act(async () => { await hook.result.current.refetch(); });
  expect(hook.result.current.data?.detectedAt).toBe(detected);
  expect(calls.every((path) => !path.includes("/messages"))).toBe(true);
});

test("hidden progress slows polling, then refreshes immediately on return", async () => {
  let latest: ReturnType<typeof useThreadWorkers> | undefined;
  function Probe() { latest = useThreadWorkers("thread-a"); return null; }
  const client = queryClient();
  const tree = (visible: boolean) => <QueryClientProvider client={client}><KeptVisibleContext.Provider value={visible}><Probe /></KeptVisibleContext.Provider></QueryClientProvider>;
  const view = render(tree(true));
  await waitFor(() => expect(latest?.data?.[0]?.step).toBe("等待数据源返回"));
  view.rerender(tree(false));
  const hiddenReads = calls.filter((path) => path.endsWith("/workers")).length;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_700)); });
  expect(calls.filter((path) => path.endsWith("/workers"))).toHaveLength(hiddenReads);
  workers.set("thread-a", [{ ...workers.get("thread-a")![0]!, step: "隐藏期间的新进度" }]);
  view.rerender(tree(true));
  await waitFor(() => expect(latest?.data?.[0]?.step).toBe("隐藏期间的新进度"), { timeout: 800 });
});

test("the pinned panel keeps active and failed workers, but excludes completed and cancelled work", async () => {
  workers.set("thread-a", [
    { ...makeWorker("completed", "已完成任务"), status: "done", summary: "结果保留在对话中" },
    { ...makeWorker("cancelled", "已停止任务"), status: "cancelled" },
    { ...makeWorker("queued", "排队任务"), status: "queued" },
    { ...makeWorker("waiting", "待处理任务"), status: "waiting" },
    makeWorker("running", "运行任务"),
    { ...makeWorker("failed", "失败任务"), status: "failed", error: "连接中断" },
  ]);
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper() });
  await view.findByText("运行任务");
  expect(view.getByText("排队任务")).toBeTruthy();
  expect(view.getByText("待处理任务")).toBeTruthy();
  expect(view.getByText("失败任务")).toBeTruthy();
  expect(view.queryByText("已完成任务")).toBeNull();
  expect(view.queryByText("已停止任务")).toBeNull();
  expect(view.getAllByRole("button", { name: /^关闭后台任务：/ })).toHaveLength(1);
});

test("the pinned panel disappears when only completed and cancelled work remains", async () => {
  const client = queryClient();
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper(client) });
  await view.findByText("A 的取数任务");
  expect(view.getByRole("region", { name: "后台任务进度" })).toBeTruthy();
  const current = workers.get("thread-a")![0]!;
  workers.set("thread-a", [
    { ...current, status: "done", summary: "整理完毕" },
    { ...makeWorker("cancelled", "已停止任务"), status: "cancelled" },
  ]);
  await act(async () => { await client.refetchQueries({ queryKey: ["thread-workers", "thread-a"], exact: true }); });
  await waitFor(() => expect(view.queryByRole("region", { name: "后台任务进度" })).toBeNull());
});

test("dismissing a failed worker hides it immediately, through refresh and remount, without changing the server", async () => {
  const client = queryClient();
  const active = makeWorker("running", "仍在运行的任务");
  const oldFailure = { ...makeWorker("failed", "已失败的任务"), status: "failed" as const, error: "连接中断" };
  workers.set("thread-a", [active, oldFailure]);
  const view = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper(client) });
  const close = await view.findByRole("button", { name: "关闭后台任务：已失败的任务" });
  fireEvent.click(close);
  expect(view.queryByText("已失败的任务")).toBeNull();
  expect(view.getByText("仍在运行的任务")).toBeTruthy();
  const saved = Array.from({ length: window.localStorage.length }, (_, index) => {
    const key = window.localStorage.key(index);
    return key === null ? null : window.localStorage.getItem(key);
  });
  expect(saved.some((value) => value?.includes(oldFailure.id))).toBe(true);

  workers.set("thread-a", [active, oldFailure, { ...oldFailure, id: "new-failure", title: "另一项失败任务" }]);
  fireEvent.click(view.getByRole("button", { name: "刷新后台任务进度" }));
  await view.findByText("另一项失败任务");
  expect(view.queryByText("已失败的任务")).toBeNull();
  expect(view.getByText("仍在运行的任务")).toBeTruthy();

  view.unmount();
  const reopened = render(<ThreadWorkerProgress threadId="thread-a" agentId="bot-a" />, { wrapper: wrapper() });
  await reopened.findByText("另一项失败任务");
  expect(reopened.queryByText("已失败的任务")).toBeNull();
  expect(reopened.getByText("仍在运行的任务")).toBeTruthy();
  expect(mutations).toEqual([]);
});

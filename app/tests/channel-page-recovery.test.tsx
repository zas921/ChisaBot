import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { type AgentChannel, type ChannelSummary, channelKeys, channelQueryOptions } from "@/lib/channels/queries";
import { settleReactWork } from "./settle-react-work";

// This file runs in its own process: the real query, router and LRU page lifecycle remain in use.
mock.module("@/components/channels/channel-chat", () => ({ ChannelChat: ({ channel }: { channel: AgentChannel }) => <div data-testid={`chat-${channel.id}`}>{`History for ${channel.id}`}</div> }));
mock.module("@/components/agents/agent-profile", () => ({ AgentProfile: () => null }));
mock.module("@/components/agents/bot-chat-actions", () => ({ RegisterBotChat: () => null }));
mock.module("@/components/agents/bot-thread-history-lazy", () => ({ LazyBotThreadHistoryDialog: () => null }));
mock.module("@/components/app-sidebar/app-sidebar", () => ({ hasUnseenActivity: () => false }));
mock.module("@/components/bot-profile/pause-banner", () => ({ BotPausedBanner: () => null }));
mock.module("@/components/channels/message-find", () => ({ MessageFind: () => null }));
mock.module("@/components/layout/detail-panel", () => ({ DetailPanel: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
mock.module("@/lib/computers/auto-watch", () => ({ useComputerAutoWatch: () => {} }));
const { ChannelPage } = await import("@/components/channels/channel-page");

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => { cleanup(); for (const client of clients.splice(0)) client.clear(); globalThis.fetch = originalFetch; await settleReactWork(); });
afterAll(async () => { await settleReactWork(); GlobalRegistrator.unregister(); });
const channel = (id: string): AgentChannel => ({ id, name: id, agentIds: [`bot-${id}`], threadId: `thread-${id}`, active: true, lastMessageAt: null });
function fixture(withRoster = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client);
  const roster = withRoster ? ["a", "b"].map((id): ChannelSummary => ({ ...channel(id), summary: null, lastMessage: null, lastMessageAgentId: null, createdAt: "2026-01-01T00:00:00Z", pinned: false, lastReadAt: null })) : [];
  client.setQueryData(channelKeys.list(), { pages: [{ channels: roster, nextCursor: null }], pageParams: [""] });
  let read = async (id: string): Promise<Response> => NativeResponse.json({ channel: channel(id) });
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const id = path.split("/").at(-1)!; requests.push(id); return read(id);
  }, originalFetch);
  function Stage() {
    const [selected, select] = useState("a");
    return <><button onClick={() => select("a")}>A</button><button onClick={() => select("b")}>B</button><KeepAliveStage address={selected} keyOf={(id) => id} same={(a, b) => a === b} maxIdlePages={5} renderKept={(id, state) => <ChannelPage channelId={id} visible={state.visible} epoch={state.epoch} />}><Outlet /></KeepAliveStage></>;
  }
  const root = createRootRoute({ component: Stage });
  const route = createRoute({ getParentRoute: () => root, path: "/channel/$channelId", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/channel/a"] }) });
  const mount = () => render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, requests, mount, setRead: (next: typeof read) => { read = next; } };
}

test("a background detail error keeps valid conversation data instead of drawing not-found", async () => {
  const f = fixture();
  f.client.setQueryData(channelKeys.detail("a"), channel("a"));
  const view = f.mount(); await view.findByTestId("chat-a");
  f.setRead(async () => NativeResponse.json({ error: "temporarily unavailable" }, { status: 503 }));
  await act(async () => { await f.client.invalidateQueries({ queryKey: channelKeys.detail("a") }); });
  await view.findByText("会话更新暂时失败，已保留当前内容。");
  expect(view.getByTestId("chat-a")).toBeTruthy();
  expect(view.queryByText("找不到这段对话")).toBeNull();
});
test("a failed initial placeholder read retains the same chat DOM and a successful retry clears the error", async () => {
  const f = fixture();
  f.setRead(async () => NativeResponse.json({ error: "temporary failure" }, { status: 503 }));
  const view = f.mount(); const chat = await view.findByTestId("chat-a");
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(view.getByTestId("chat-a")).toBe(chat);
  expect(view.queryByText("找不到这段对话")).toBeNull();
  f.setRead(async (id) => NativeResponse.json({ channel: channel(id) }));
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(view.queryByText("会话更新暂时失败，已保留当前内容。")).toBeNull());
  expect(view.getByTestId("chat-a")).toBe(chat);
});
test("a late 404 for hidden A cannot replace B and A recovers when shown again", async () => {
  const f = fixture(); let finishA!: (response: Response) => void;
  let first = true;
  f.setRead(async (id) => id === "a" && first ? (first = false, new Promise((resolve) => { finishA = resolve; })) : NativeResponse.json({ channel: channel(id) }));
  const view = f.mount(); await view.findByTestId("chat-a");
  fireEvent.click(view.getByText("B", { exact: true })); await view.findByTestId("chat-b");
  await act(async () => { finishA(NativeResponse.json({ error: "Channel not found." }, { status: 404 })); });
  const visible = () => view.container.querySelector('[data-testid="kept-page"][data-visible="true"]')!;
  expect(visible().textContent).toContain("History for b");
  expect(visible().textContent).not.toContain("找不到这段对话");
  fireEvent.click(view.getByText("A", { exact: true }));
  await waitFor(() => expect(f.client.getQueryData<AgentChannel>(channelKeys.detail("a"))?.id).toBe("a"));
  expect(visible().textContent).toContain("History for a");
  for (let turn = 0; turn < 4; turn++) { fireEvent.click(view.getByText("B", { exact: true })); fireEvent.click(view.getByText("A", { exact: true })); }
  expect(visible().textContent).toContain("History for a");
  expect(f.client.getQueryData<AgentChannel>(channelKeys.detail("b"))?.id).toBe("b");
  expect(f.requests.filter((id) => id === "a")).toHaveLength(2);
});
test("a temporary failure without cached history offers retry and recovers after a 200", async () => {
  const f = fixture(false);
  f.setRead(async () => NativeResponse.json({ error: "offline" }, { status: 503 }));
  const view = f.mount();
  await view.findByText("会话暂时没有加载出来");
  expect(view.queryByText("找不到这段对话")).toBeNull();
  await waitFor(() => expect(f.requests).toHaveLength(2));
  f.setRead(async (id) => NativeResponse.json({ channel: channel(id) }));
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  await view.findByTestId("chat-a");
});
test("a kept old error is replaced by the current successful detail response", async () => {
  const f = fixture(false);
  f.setRead(async () => NativeResponse.json({ error: "Channel not found." }, { status: 404 }));
  await f.client.fetchQuery(channelQueryOptions("a")).catch(() => {});
  f.setRead(async (id) => NativeResponse.json({ channel: channel(id) }));
  const view = f.mount(); await view.findByTestId("chat-a");
  expect(view.queryByText("找不到这段对话")).toBeNull();
});

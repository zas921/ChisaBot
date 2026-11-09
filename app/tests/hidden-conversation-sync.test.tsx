import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { type Observable, of } from "rxjs";
import type { ThreadActivity } from "@/lib/copilot/bot-thread";
import { applyInboxState, queuedFor } from "@/lib/copilot/thread-inbox";
import { useConversationSync } from "@/lib/copilot/use-conversation-sync";
import { workerKeys } from "@/lib/copilot/workers";

const clients: QueryClient[] = [];
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});
afterAll(() => GlobalRegistrator.unregister());

const user = (id: string): Message => ({ id, role: "user", content: id });
class SnapshotAgent extends AbstractAgent {
  snapshot: Message[] = [user("original")];
  run(input: RunAgentInput) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.MESSAGES_SNAPSHOT, messages: this.snapshot },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ) as Observable<BaseEvent>;
  }
}

function mount() {
  const threadId = crypto.randomUUID();
  const agent = new SnapshotAgent({ agentId: "bot", threadId, initialMessages: [user("original")] });
  const client = new QueryClient();
  clients.push(client);
  let setVisible!: (value: boolean) => void;
  let sending = false;
  let connects = 0;
  const listeners = new Set<(activity: ThreadActivity) => void>();
  const onActivity = (listener: (activity: ThreadActivity) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const connect = async () => {
    connects++;
    return agent.runAgent();
  };
  const suppressConnect = () => sending;
  function Probe() {
    const [visible, updateVisible] = useState(true);
    setVisible = updateVisible;
    useConversationSync(threadId, agent as never, connect, onActivity, { visible, suppressConnect });
    return null;
  }
  render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  const emit = async (patch: Partial<ThreadActivity> = {}) => {
    await act(async () => {
      const activity: ThreadActivity = { threadId, seq: "1", running: false, workers: null, inbox: null, revision: "0", ...patch };
      for (const listener of listeners) listener(activity);
      await Promise.resolve();
    });
  };
  return {
    agent, client, threadId, emit,
    hide: () => { act(() => setVisible(false)); },
    show: () => { act(() => setVisible(true)); },
    setSending: (value: boolean) => { sending = value; },
    connects: () => connects,
  };
}

test("hidden idle activity keeps the visible baseline and merges the new turn on return", async () => {
  const chat = mount();
  await chat.emit();
  chat.hide();
  chat.agent.snapshot = [user("original"), user("remote")];
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(0);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original"]);
  chat.show();
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(1);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original", "remote"]);
});

test("a remote truncate is deferred while hidden and rebuilds the transcript on return", async () => {
  const chat = mount();
  await chat.emit();
  chat.hide();
  chat.agent.snapshot = [];
  await chat.emit({ seq: "2", revision: "1" });
  expect(chat.connects()).toBe(0);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original"]);
  chat.show();
  await chat.emit({ seq: "2", revision: "1" });
  expect(chat.connects()).toBe(1);
  expect(chat.agent.messages).toEqual([]);
});

test("a page hidden just after a join still notices a finished remote turn on return", async () => {
  const chat = mount();
  await chat.emit({ running: true });
  expect(chat.connects()).toBe(1);
  chat.hide();
  chat.agent.snapshot = [user("original"), user("remote")];
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(1);
  chat.show();
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(2);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original", "remote"]);
});

test("a quick switch without any hidden poll still observes changes after a join", async () => {
  const chat = mount();
  await chat.emit({ running: true });
  chat.hide();
  chat.agent.snapshot = [user("original"), user("remote")];
  chat.show();
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(2);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original", "remote"]);
});

test("a locally finalized run does not swallow a remote turn received after switching away", async () => {
  const chat = mount();
  await chat.emit();
  await act(async () => { await chat.agent.runAgent(); });
  chat.hide();
  chat.agent.snapshot = [user("original"), user("remote")];
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(0);
  chat.show();
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(1);
  expect(chat.agent.messages.map((message) => message.id)).toEqual(["original", "remote"]);
});

test("local send suppression still establishes a fresh baseline without replaying its own output", async () => {
  const chat = mount();
  await chat.emit();
  chat.setSending(true);
  await chat.emit({ seq: "2", running: true });
  expect(chat.connects()).toBe(0);
  chat.setSending(false);
  await chat.emit({ seq: "2" });
  expect(chat.connects()).toBe(0);
  chat.agent.snapshot = [user("original"), user("remote")];
  await chat.emit({ seq: "3" });
  expect(chat.connects()).toBe(1);
});

for (const revision of ["0", "1"]) {
  test(`resume ${revision === "0" ? "merge" : "revision rebuild"} refreshes worker and inbox stamps before advancing its baseline`, async () => {
    const chat = mount();
    const previousFetch = globalThis.fetch;
    const workerKey = workerKeys.thread(chat.threadId);
    chat.client.setQueryData(workerKey, [{ id: "worker", status: "running" }]);
    let inboxReads = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toContain(`/threads/${chat.threadId}/inbox`);
      inboxReads++;
      return new Response(JSON.stringify({
        running: false,
        items: [{ id: "remote-inbox", status: "queued", kind: "message", message: { content: "Remote follow-up" } }],
      }), { headers: { "content-type": "application/json" } });
    }, { preconnect: previousFetch.preconnect }) as typeof fetch;
    try {
      await chat.emit({ workers: "worker-running", inbox: "empty" });
      chat.hide();
      const update = { seq: "2", revision, workers: "worker-finished", inbox: "remote-queued" };
      await chat.emit(update);
      expect(chat.connects()).toBe(0);
      expect(inboxReads).toBe(0);
      expect(chat.client.getQueryState(workerKey)?.isInvalidated).toBe(false);
      chat.show();
      await chat.emit(update);
      await waitFor(() => expect(queuedFor(chat.threadId).map((item) => [item.id, item.remote])).toEqual([["remote-inbox", true]]));
      expect(chat.client.getQueryState(workerKey)?.isInvalidated).toBe(true);
      expect(chat.connects()).toBe(1);
      expect(inboxReads).toBe(1);
      await chat.emit(update);
      expect(inboxReads).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      applyInboxState(chat.threadId, { running: false, items: [] });
    }
  });
}

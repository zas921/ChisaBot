import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { channelKeys, channelQueryOptions, ChannelReadError } from "@/lib/channels/queries";
import { chatTargetFor } from "@/lib/agents/landing";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const client of clients.splice(0)) client.clear(); });
const client = () => { const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(query); return query; };
const channel = (id: string) => ({ id, name: id, agentIds: ["bot"], threadId: `thread-${id}`, active: true, lastMessageAt: null });

test("detail reads encode their own channel identity and receive query cancellation", async () => {
  let requested: unknown, signal: AbortSignal | null | undefined;
  globalThis.fetch = Object.assign(async (path: Parameters<typeof fetch>[0], options?: RequestInit) => { requested = path; signal = options?.signal; return Response.json({ channel: channel("a/b") }); }, originalFetch);
  expect(await client().fetchQuery(channelQueryOptions("a/b"))).toEqual(channel("a/b"));
  expect(requested).toBe("/api/channels/a%2Fb");
  expect(signal).toBeInstanceOf(AbortSignal);
});
test("a successful response for another channel never enters this channel's cache", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ channel: channel("b") }), originalFetch);
  const query = client();
  await expect(query.fetchQuery(channelQueryOptions("a"))).rejects.toBeInstanceOf(ChannelReadError);
  expect(query.getQueryData(channelKeys.detail("a"))).toBeUndefined();
});
test("transport failures preserve the HTTP distinction between missing and temporarily unavailable", async () => {
  for (const status of [404, 503]) {
    globalThis.fetch = Object.assign(async () => Response.json({ error: "detail failed" }, { status }), originalFetch);
    await expect(client().fetchQuery(channelQueryOptions("a"))).rejects.toMatchObject({ status });
  }
});
test("landing uses the complete Bot lookup for a pinned candidate on a partial roster", () => {
  const pinned = { ...channel("old-pinned"), pinned: true, createdAt: "2026-01-01T00:00:00Z", summary: null, lastMessage: null, lastMessageAgentId: null, lastReadAt: null };
  expect(chatTargetFor("bot", [pinned], true)).toEqual({ to: "/channel/new", search: { agent: "bot" } });
  expect(chatTargetFor("bot", [pinned], false)).toEqual({ to: "/channel/$channelId", params: { channelId: "old-pinned" } });
});

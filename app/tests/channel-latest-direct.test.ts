import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { latestDirectChannelQueryOptions } from "@/lib/channels/queries";

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const client of clients.splice(0)) client.clear(); });
function queryClient() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client); return client; }
test("the Bot lookup reads a dedicated encoded endpoint and preserves a confirmed empty result", async () => {
  let path: unknown;
  globalThis.fetch = (async (input) => { path = input; return Response.json({ channel: null }); }) as typeof fetch;
  expect(await queryClient().fetchQuery(latestDirectChannelQueryOptions("bot/one"))).toBeNull();
  expect(path).toBe("/api/channels/direct/bot%2Fone");
});
test("malformed successful replies cannot turn missing history into an empty chat", async () => {
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  await expect(queryClient().fetchQuery(latestDirectChannelQueryOptions("bot"))).rejects.toThrow("无法加载");
});
test("a reply for another Bot cannot be used as this Bot's conversation", async () => {
  globalThis.fetch = (async () => Response.json({ channel: { id: "wrong", threadId: "wrong-thread", agentIds: ["other"] } })) as unknown as typeof fetch;
  await expect(queryClient().fetchQuery(latestDirectChannelQueryOptions("bot"))).rejects.toThrow("无法加载");
});

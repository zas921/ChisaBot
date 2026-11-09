import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { type AgentChannel, type ChannelStore, createChannelRoutes } from "../src/channels/routes";

const actor = { id: "latest-user", role: "user" } as const;
const channel: AgentChannel = { id: "older-page", name: "Saved", agentIds: ["bot"], threadId: "saved-thread", active: true, lastMessageAt: new Date("2026-01-01T00:00:00Z") };
function appFor(latestDirect?: ChannelStore["latestDirect"], authenticated = true) {
  const store = { latestDirect, create: () => { throw new Error("lookup must never create a conversation"); } } as unknown as ChannelStore;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, async (context, next) => {
    if (!authenticated) return context.json({ error: "Unauthorized" }, 401);
    context.set("actor", actor);
    await next();
  }));
  return app;
}

describe("latest direct conversation lookup", () => {
  test("reads the authenticated Bot conversation without list pagination or channel creation", async () => {
    const calls: unknown[] = [];
    const response = await appFor(async (receivedActor, agentId) => { calls.push([receivedActor, agentId]); return channel; }).request("/direct/bot");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ channel: { ...channel, lastMessageAt: channel.lastMessageAt!.toISOString() } });
    expect(calls).toEqual([[actor, "bot"]]);
  });
  test("a confirmed absent conversation returns null", async () => {
    const response = await appFor(async () => null).request("/direct/missing");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ channel: null });
  });
  test("an unavailable lookup is an error, never an empty conversation", async () => {
    expect((await appFor().request("/direct/bot")).status).toBe(503);
  });
  test("authentication runs before reading any conversation", async () => {
    let called = false;
    const response = await appFor(async () => { called = true; return channel; }, false).request("/direct/bot");
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });
});

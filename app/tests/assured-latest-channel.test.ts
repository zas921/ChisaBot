import { expect, test } from "bun:test";
import { assuredLatestChannelFor, latestChannelFor } from "@/lib/channels/latest";
import type { ChannelSummary } from "@/lib/channels/queries";

function channel(id: string, pinned: boolean, at: string, botId = "bot"): ChannelSummary {
  return { id, name: id, agentIds: [botId], threadId: `thread-${id}`, active: true, lastMessageAt: at, summary: null, lastMessage: null, lastMessageAgentId: botId, createdAt: at, pinned, lastReadAt: null };
}
test("an old pinned match on a partial roster uses the complete Bot lookup", () => {
  const pinned = channel("old-pinned", true, "2026-01-01T00:00:00Z");
  const page = [pinned, channel("recent-other-bot", false, "2026-11-01T00:00:00Z", "other")];
  expect(latestChannelFor("bot", page)).toBe(pinned);
  expect(assuredLatestChannelFor("bot", page, true)).toBeUndefined();
});
test("an unpinned match can open immediately even while older pages remain", () => {
  const latest = channel("recent", false, "2026-11-02T00:00:00Z");
  const page = [channel("pinned", true, "2026-01-01T00:00:00Z"), latest];
  expect(assuredLatestChannelFor("bot", page, true)).toBe(latest);
});
test("a complete roster preserves immediate navigation to a pinned conversation", () => {
  const pinned = channel("only", true, "2026-01-01T00:00:00Z");
  expect(assuredLatestChannelFor("bot", [pinned], false)).toBe(pinned);
});
test("missing and unloaded matches still use the complete lookup", () => {
  expect(assuredLatestChannelFor("bot", undefined, false)).toBeUndefined();
  expect(assuredLatestChannelFor("bot", [channel("other", false, "2026-01-01T00:00:00Z", "other")], true)).toBeUndefined();
});

test("a mobile conversation without an activity preview still opens ahead of an older conversation", () => {
  const old = channel("old", false, "2026-11-06T06:16:47.958Z");
  const mobile = { ...channel("mobile", false, "2026-11-08T12:29:14.814Z"), lastMessageAt: null };
  expect(assuredLatestChannelFor("bot", [old, mobile], true)).toBe(mobile);
  expect(latestChannelFor("bot", [mobile, old])).toBe(mobile);
});

test("equal timestamps use the server's channel id tie breaker", () => {
  const a = channel("a", false, "2026-11-08T12:29:14.814Z");
  const z = { ...a, id: "z", lastMessageAt: null };
  expect(latestChannelFor("bot", [a, z])).toBe(z);
  expect(latestChannelFor("bot", [z, a])).toBe(z);
});

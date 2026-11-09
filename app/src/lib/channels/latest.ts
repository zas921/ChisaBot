import type { ChannelSummary } from "./queries";

/**
 * The conversation a Bot's row opens: its most recent one-to-one channel, or nothing when none is
 * loaded (the caller then opens the Bot's empty chat). Group channels are not any one Bot's chat,
 * so they never count.
 */
export function latestChannelFor(
  botId: string,
  channels: ChannelSummary[] | undefined,
): ChannelSummary | undefined {
  let best: ChannelSummary | undefined;
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== botId) continue;
    const at = channel.lastMessageAt ?? channel.createdAt;
    const bestAt = best?.lastMessageAt ?? best?.createdAt ?? "";
    if (!best || at > bestAt || (at === bestAt && channel.id > best.id)) best = channel;
  }
  return best;
}

/**
 * Pinned conversations lead the roster regardless of recency. Until all pages are loaded, a
 * pinned candidate may hide a newer unpinned conversation; let the complete Bot lookup resolve it.
 * An unpinned candidate is safe: later unpinned pages are older, and all pins have been loaded.
 */
export function assuredLatestChannelFor(
  botId: string,
  channels: ChannelSummary[] | undefined,
  hasNextPage: boolean,
): ChannelSummary | undefined {
  const candidate = latestChannelFor(botId, channels);
  return hasNextPage && candidate?.pinned ? undefined : candidate;
}

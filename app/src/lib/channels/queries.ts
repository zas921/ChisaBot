import { type QueryClient, infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * ISO-8601 when something was last said here, or null for a conversation nobody has used.
   *
   * The conversation screen needs this to tell two silences apart: a new conversation with no
   * history, and one whose history this deployment cannot reach. See `channel-chat.tsx`.
   */
  lastMessageAt: string | null;
};

/** A channel plus what the roster renders about it. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. The roster falls back to `name`. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
  /** Whether this member pinned the channel. Pinned channels sort first in the roster. */
  pinned: boolean;
  /** ISO-8601 when this member last had the channel open, or null for never. The caller's, only. */
  lastReadAt: string | null;
  /**
   * Whether a turn is running in this channel right now.
   *
   * Socket-only and transient: the server never persists it and the roster query never returns it,
   * so it is undefined until a busy event arrives and is dropped whenever the roster is refetched.
   * A headless turn — a handoff hop, a relay — sets it, which is how the roster shows work the
   * browser never streamed.
   */
  busy?: boolean;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
  latestDirect: (agentId: string) => ["channels", "direct", agentId] as const,
};

/** One page of channels, and where the next one starts. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor: string | null;
};

/**
 * The sidebar's channels, a page at a time.
 *
 * It used to ask for every channel this person has, one row per channel-agent pair, on every render.
 * Nothing removes a channel, so somebody who talks to their Bot daily accumulates thousands and the
 * query grows monotonically for as long as they use the product.
 *
 * The pages are flattened for the caller, so the sidebar and the socket that patches it both see one
 * array in recency order and neither has to know this is paged.
 */
export function channelListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: channelKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<ChannelPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/channels${suffix}`, {
        fallback: "无法加载会话",
      });
      return (await response.json()) as ChannelPage;
    },
    getNextPageParam: (page: ChannelPage) => page.nextCursor ?? undefined,
    select: (data): ChannelSummary[] =>
      data.pages.flatMap((page) => page.channels),
  });
}

export class ChannelReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ChannelReadError"; }
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async ({ signal }): Promise<AgentChannel> => {
      const response = await tryClient(`/api/channels/${encodeURIComponent(channelId)}`, { signal });
      const body = await response.json().catch(() => null) as { channel?: AgentChannel; error?: string } | null;
      if (!response.ok) throw new ChannelReadError(body?.error || "无法加载此会话", response.status);
      const channel = body?.channel;
      if (!channel || channel.id !== channelId || typeof channel.threadId !== "string" || !Array.isArray(channel.agentIds))
        throw new ChannelReadError("无法加载此会话", 502);
      return channel;
    },
  });
}

/** A partial roster cannot establish that a Bot has no conversation. Check the complete store. */
export function latestDirectChannelQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: channelKeys.latestDirect(agentId),
    staleTime: 0,
    queryFn: async ({ signal }): Promise<AgentChannel | null> => {
      const channel = await client<AgentChannel | null | undefined>(
        `/api/channels/direct/${encodeURIComponent(agentId)}`,
        "channel",
        { signal, fallback: "无法加载这个机器人的对话，请重试。" },
      );
      if (channel === null) return null;
      if (!channel || typeof channel.id !== "string" || typeof channel.threadId !== "string" ||
          !Array.isArray(channel.agentIds) || channel.agentIds.length !== 1 || channel.agentIds[0] !== agentId)
        throw new Error("无法加载这个机器人的对话，请重试。");
      return channel;
    },
  });
}

/**
 * 左栏列表里已有的这一行，当作对话详情先用（DESIGN.md §83）：`AgentChannel` 的字段列表里都有。
 * 列表还没读到、或者不在已读的那几页里，就是 undefined（照旧等详情）。
 */
export function channelFromRoster(queryClient: QueryClient, channelId: string): AgentChannel | undefined {
  const cache = queryClient.getQueryData<{ pages: ChannelPage[] }>(channelKeys.list());
  const row = cache?.pages.flatMap((page) => page.channels).find((channel) => channel.id === channelId);
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    agentIds: row.agentIds,
    threadId: row.threadId,
    active: row.active,
    lastMessageAt: row.lastMessageAt,
  };
}

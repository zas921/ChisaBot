import { useSyncExternalStore } from "react";

/**
 * The open chat's Bot controls, published by the chat page and read by that Bot's row in the left
 * roster (DESIGN v4.1 §W5: the chat column has no header; the Bot's ⋯ and computer indicator live
 * in its own sidebar row). The page keeps the state (URL flags, thread); the row only calls back.
 */
export type BotChatContext = {
  agentId: string;
  /** Shown when the Bot is not on the roster (a hidden Bot such as the browser Bot). */
  fallbackName?: string;
  settingsOpen: boolean;
  computerOpen: boolean;
  /** The computer asks for the person (takeover, secret, interrupted run). */
  needsYou: boolean;
  /** Already on an empty topic: 新话题 has nothing to clear. */
  freshTopic: boolean;
  canSettings: boolean;
  canComputer: boolean;
  canNewTopic: boolean;
  /** 「历史对话」（DESIGN.md §42.6）：只有正在打开的机器人对话页登记了才有。 */
  canHistory?: boolean;
  openHistory?: () => void;
  /** 删除当前这条对话（含消息与事件）；空话题没有可删内容。 */
  canDeleteThread?: boolean;
  deleteThread?: () => void;
  toggleSettings: () => void;
  toggleComputer: () => void;
  newTopic: () => void;
};

let current: BotChatContext | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function publishBotChat(context: BotChatContext): () => void {
  current = context;
  emit();
  return () => {
    // A newer page may already have published; only clear our own entry.
    if (current === context) {
      current = null;
      emit();
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open chat's controls, whichever Bot they belong to. */
export function useCurrentBotChat(): BotChatContext | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** The open chat's controls when they belong to this Bot, else null. */
export function useBotChat(agentId: string): BotChatContext | null {
  const context = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return context && context.agentId === agentId ? context : null;
}

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

/**
 * 留着但藏起来的聊天 / 右栏（DESIGN.md §98.3）：`false` 时这块不在屏幕上。
 *
 * 外壳留着聊天、藏起右栏时，它们没卸载，轮询和直播画面也还在——藏着的东西不该一直耗流量和 CPU。
 * 读这个的地方在藏着时停下：计算机控制权轮询、浏览器标签轮询、计算机画面（直播 / 截图）、面板列表轮询、
 * 机器人组件授权轮询。回来时（变回 `true`）立刻补读一次。正在写的回答和后台交付（收件箱）不停。
 */
export const KeptVisibleContext = createContext(true);

export function useKeptVisible(): boolean {
  return useContext(KeptVisibleContext);
}

/**
 * 这一页是「换到别的对话时它还在回答，留着等它答完」的那种（DESIGN.md §109）：另一段对话正在主区里。
 * 它不该再声明「现在看着的机器人」、不该收右栏的「问一句」、不该改计算机状态行——这些都属于看着的那段。
 */
export const KeptHeldContext = createContext(false);

export function useKeptHeld(): boolean {
  return useContext(KeptHeldContext);
}

/*
 * 正在回答的对话（频道 id）。外壳据此决定换对话时要不要把离开的那段留着（DESIGN.md §109）：
 * 一轮里用浏览器做事是好几段 run 接力，接力由这页的聊天组件驱动，卸载了就没人接。
 */
const workingChats = new Map<string, number>();
let workingSnapshot: ReadonlySet<string> = new Set();
const workingListeners = new Set<() => void>();
const subscribeWorking = (listener: () => void) => {
  workingListeners.add(listener);
  return () => {
    workingListeners.delete(listener);
  };
};
const EMPTY_WORKING: ReadonlySet<string> = new Set();

/** 聊天在回答（这一轮还没结束，浏览器工具的空档也算）时登记；答完或卸载时撤销。 */
export function useMarkChatWorking(channelId: string | undefined, working: boolean): void {
  useEffect(() => {
    if (!channelId || !working) return;
    workingChats.set(channelId, (workingChats.get(channelId) ?? 0) + 1);
    workingSnapshot = new Set(workingChats.keys());
    for (const listener of workingListeners) listener();
    return () => {
      const left = (workingChats.get(channelId) ?? 1) - 1;
      if (left > 0) workingChats.set(channelId, left);
      else workingChats.delete(channelId);
      workingSnapshot = new Set(workingChats.keys());
      for (const listener of workingListeners) listener();
    };
  }, [channelId, working]);
}

/** 正在回答的对话（频道 id 的集合，没变化时是同一个对象）。 */
export function useWorkingChats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWorking, () => workingSnapshot, () => EMPTY_WORKING);
}

/*
 * 机器人组件授权的轮询挂在全局（CopilotProvider 里的 GalleryTools / SandboxedTools），不在聊天的树里，
 * 读不到上面的 context：藏着的聊天把它的机器人登记成「不在屏幕上」，那两处就不再每 5 秒问一次。
 */
const hiddenBots = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribeHidden = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 聊天藏着时登记它的机器人（卸载或变回可见时撤销）。 */
export function useMarkBotHidden(botId: string | undefined, hidden: boolean): void {
  useEffect(() => {
    if (!botId || !hidden) return;
    hiddenBots.set(botId, (hiddenBots.get(botId) ?? 0) + 1);
    notify();
    return () => {
      const left = (hiddenBots.get(botId) ?? 1) - 1;
      if (left > 0) hiddenBots.set(botId, left);
      else hiddenBots.delete(botId);
      notify();
    };
  }, [botId, hidden]);
}

/** 这个机器人的聊天在屏幕上（没有被藏着的那段登记成不在）。 */
export function useBotOnScreen(botId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeHidden,
    () => !botId || !hiddenBots.has(botId),
    () => true,
  );
}

import { describe, expect, test } from "bun:test";
import type { ThreadActivity } from "@/lib/copilot/bot-thread";
import { pingRelayAlive, RELAY_ALIVE_INTERVAL_MS } from "@/lib/copilot/connection-drop";
import { REJOIN_AFTER_MS, shouldJoin, shouldRejoin } from "@/lib/copilot/use-conversation-sync";

/**
 * 手机和电脑「忙闲不一致」（2026-10-22）。
 *
 * 生产日志（网关访问记录）里同一个对话：一台设备连续 6 次「重新生成」收到 409（服务器说机器人正在回答），
 * 而这台设备的输入框是空闲的。原因有两个：
 *  - 服务器在回答，却是「模型段已结束、在等某个页面里的浏览器工具交结果」（接力，最长 25 分钟）：
 *    接上看不到任何东西，这一页按「没在跑」处理；
 *  - 接入断了（网络抖动）之后，只有事件序号变了才补接，一段没有新事件的长工具调用里这台一直显示空闲。
 */
const activity = (patch: Partial<ThreadActivity> = {}): ThreadActivity => ({
  threadId: "t1",
  seq: "10",
  running: true,
  workers: null,
  inbox: null,
  ...patch,
});

describe("shouldRejoin：接入断了而服务器那一段运行还在写", () => {
  test("服务器明确说有运行在写（live），且离上次接入结束够久：补接", () => {
    expect(shouldRejoin(activity({ live: true, waiting: false }), REJOIN_AFTER_MS)).toBe(true);
    expect(shouldRejoin(activity({ live: true }), 60_000)).toBe(true);
  });
  test("刚结束不久：先等一等，不连着接", () => {
    expect(shouldRejoin(activity({ live: true }), REJOIN_AFTER_MS - 1)).toBe(false);
  });
  test("只是在等浏览器交结果（waiting）、或旧服务器没有这个字段：不补接，免得又回到每 2 秒一次大回放", () => {
    expect(shouldRejoin(activity({ live: false, waiting: true }), 60_000)).toBe(false);
    expect(shouldRejoin(activity({}), 60_000)).toBe(false);
  });
  test("服务器没在回答：不接", () => {
    expect(shouldRejoin(activity({ running: false, live: false }), 60_000)).toBe(false);
  });
  test("不改变 shouldJoin 原有的判断", () => {
    expect(shouldJoin("afterJoin", activity(), activity({ seq: "12" }))).toBe(false);
    expect(shouldJoin("steady", activity(), activity())).toBe(false);
  });
});

describe("pingRelayAlive：页面有一轮在进行时向服务器报平安", () => {
  test("POST 到这个对话的 relay-alive，带登录凭据，失败不抛", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    pingRelayAlive("thread/with space", ((url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Promise.reject(new Error("offline"));
    }) as unknown as typeof fetch);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/api/copilotkit/threads/thread%2Fwith%20space/relay-alive");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.credentials).toBe("include");
  });
  test("空的对话 id 不发请求；间隔远小于服务器的放开时限", () => {
    let called = false;
    pingRelayAlive("", (() => {
      called = true;
      return Promise.resolve(new Response());
    }) as unknown as typeof fetch);
    expect(called).toBe(false);
    expect(RELAY_ALIVE_INTERVAL_MS).toBeLessThan(150_000 / 3);
  });
});

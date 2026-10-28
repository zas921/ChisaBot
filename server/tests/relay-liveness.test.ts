import { describe, expect, test } from "bun:test";
import { PostgresAgentRunner, RELAY_STALE_MS } from "../src/local-conversations";

/**
 * 浏览器工具接力的存活判断（2026-10-22，手机和电脑忙闲不一致）。
 *
 * 前端工具由浏览器执行，模型段结束后服务器保留接力等结果。执行它的页面没了（刷新 / 关掉 / 睡着），
 * 以前要干等满 25 分钟：别的设备一直看到「在回答」，发消息被排队，重新生成直接 409。
 * 现在页面有一轮在进行时每 20 秒报一次平安，静默超过 RELAY_STALE_MS 就放开。
 */
function runner() {
  const settled: { runId: string; outcome: string }[] = [];
  const inbox = {
    settle: async (_thread: string, runId: string, outcome: string) => {
      settled.push({ runId, outcome });
    },
  };
  const instance = new PostgresAgentRunner({} as never, {} as never, inbox as never);
  const frontend = (instance as unknown as { frontend: Map<string, unknown> }).frontend;
  const relay = (overrides: Record<string, unknown> = {}) => ({
    runId: "r1",
    inboxRunIds: ["r1"],
    callIds: ["call-1"],
    aliveAt: 0,
    ...overrides,
  });
  return { instance, frontend, relay, settled };
}

describe("接力的存活判断", () => {
  test("只有接力：isRelay 为真、isLive 为假；有运行在写时反过来", () => {
    const { instance, frontend, relay } = runner();
    expect(instance.isRelay("t1")).toBe(false);
    frontend.set("t1", relay());
    expect(instance.isActive("t1")).toBe(true);
    expect(instance.isRelay("t1")).toBe(true);
    expect(instance.isLive("t1")).toBe(false);
    (instance as unknown as { active: Map<string, unknown> }).active.set("t1", {});
    expect(instance.isRelay("t1")).toBe(false);
    expect(instance.isLive("t1")).toBe(true);
  });

  test("页面守着、却静默超过时限：放开，收件箱里这一轮读进去的记为「欠着」", async () => {
    const { instance, frontend, relay, settled } = runner();
    frontend.set("t1", relay({ aliveAt: 1_000 }));
    expect(instance.sweepRelays(1_000 + RELAY_STALE_MS)).toBe(0); // 刚好到时限，还不放
    expect(instance.sweepRelays(1_001 + RELAY_STALE_MS)).toBe(1);
    await Bun.sleep(20);
    expect(frontend.has("t1")).toBe(false);
    expect(instance.isActive("t1")).toBe(false);
    expect(settled).toEqual([{ runId: "r1", outcome: "owed" }]);
  });

  test("页面一直报平安：不放开", () => {
    const { instance, frontend, relay } = runner();
    frontend.set("t1", relay({ aliveAt: 1_000 }));
    expect(instance.touchRelay("t1", 1_000 + RELAY_STALE_MS - 1)).toBe(true);
    expect(instance.sweepRelays(1_000 + RELAY_STALE_MS + 5_000)).toBe(0);
    expect(frontend.has("t1")).toBe(true);
  });

  test("从未报过平安的页面失联后同样清理，不留下永久占用", async () => {
    const { instance, frontend, relay } = runner();
    frontend.set("t1", relay({ aliveAt: 1_000 }));
    expect(instance.sweepRelays(1_000 + RELAY_STALE_MS * 10)).toBe(1);
    await Bun.sleep(20);
    expect(frontend.has("t1")).toBe(false);
  });

  test("页面持续报平安，两小时后的工具接力仍然有效", () => {
    const { instance, frontend, relay } = runner();
    frontend.set("t1", relay({ aliveAt: 0 }));
    for (let now = 20_000; now <= 2 * 60 * 60_000; now += 20_000) {
      instance.touchRelay("t1", now);
      expect(instance.sweepRelays(now)).toBe(0);
    }
    expect(frontend.has("t1")).toBe(true);
  });

  test("接力出现之前页面就报过平安：touchRelay 返回 false，但记下了", () => {
    const { instance } = runner();
    expect(instance.touchRelay("t9", 5_000)).toBe(false);
  });
});

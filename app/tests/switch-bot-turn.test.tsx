import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActiveBotProvider, useActiveBot, useActiveBotHolder } from "@/lib/copilot/active-bot";
import type { ThreadActivity } from "@/lib/copilot/bot-thread";
import {
  forgetTurnOutcome,
  hasUnansweredToolCall,
  rememberTurnOutcome,
  turnOutcomeFor,
} from "@/lib/copilot/turn-outcome";
import { shouldJoin } from "@/lib/copilot/use-conversation-sync";

/**
 * 换机器人后正在跑的那一轮不被掐断、掐断了也说清为什么（DESIGN.md §109）。
 *
 * 2026-10-22 生产：在一个机器人的对话里让它跑命令，切到别的机器人再切回来——
 *  - 回答区在「思考中」和停顿小点之间来回跳：每 2 秒一次 145 KB 的重新接入；
 *  - 过一会儿只剩「◼ 已停止」：客户端发送看门狗在命令结束后整 12 秒发出 stop（服务器日志两次都对得上），
 *    因为看门狗的「有进展」订阅随聊天卸载撤了，模型在写它也看不见；而且它先停、后查消息有没有落库。
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");

function activity(seq: string, running: boolean): ThreadActivity {
  return { threadId: "t1", seq, running, workers: null, inbox: null } as ThreadActivity;
}

describe("shouldJoin：服务器只是在等浏览器那一步时不反复重接", () => {
  test("刚打开 / 本机刚跑完：服务器在回答就接上", () => {
    expect(shouldJoin("initial", null, activity("10", true))).toBe(true);
    expect(shouldJoin("initial", activity("9", false), activity("10", true))).toBe(true);
    expect(shouldJoin("initial", null, activity("10", false))).toBe(false);
  });
  test("刚接完：这一次只记基线，哪怕服务器还说在回答（接力在等浏览器的结果）", () => {
    expect(shouldJoin("afterJoin", activity("10", true), activity("10", true))).toBe(false);
    expect(shouldJoin("afterJoin", activity("10", true), activity("12", true))).toBe(false);
  });
  test("平时：序号没动、一直在回答 → 不接（以前这里每 2 秒接一次）", () => {
    expect(shouldJoin("steady", activity("10", true), activity("10", true))).toBe(false);
  });
  test("平时：序号动了（那一步在别处做完、接着往下写）→ 接", () => {
    expect(shouldJoin("steady", activity("10", true), activity("11", true))).toBe(true);
    expect(shouldJoin("steady", activity("10", false), activity("11", false))).toBe(true);
  });
  test("平时：从没在回答变成在回答 → 接", () => {
    expect(shouldJoin("steady", activity("10", false), activity("10", true))).toBe(true);
  });
});

describe("中断原因跟着对话走，不跟着组件走", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
  ];
  test("记下的原因：那一轮还是最后一轮时读得回来", () => {
    rememberTurnOutcome("t-reason", "u2", "模型的连接中途断开了");
    expect(turnOutcomeFor("t-reason", messages)).toBe("模型的连接中途断开了");
  });
  test("之后又聊过（最后一条用户消息变了）就不再提", () => {
    rememberTurnOutcome("t-later", "u1", "旧的原因");
    expect(turnOutcomeFor("t-later", messages)).toBeNull();
  });
  test("新的一轮开始时清掉；别的对话互不影响", () => {
    rememberTurnOutcome("t-a", "u2", "A 的原因");
    rememberTurnOutcome("t-b", "u2", "B 的原因");
    forgetTurnOutcome("t-a");
    expect(turnOutcomeFor("t-a", messages)).toBeNull();
    expect(turnOutcomeFor("t-b", messages)).toBe("B 的原因");
  });
  test("hasUnansweredToolCall：这一轮停在一步没有结果的工具调用上", () => {
    const base = [{ role: "user" }, { role: "assistant", toolCalls: [{ id: "c1" }] }];
    expect(hasUnansweredToolCall(base)).toBe(true);
    expect(hasUnansweredToolCall([...base, { role: "tool", toolCallId: "c1" }])).toBe(false);
    // 上一轮没结果的调用不算这一轮的
    expect(hasUnansweredToolCall([...base, { role: "user" }, { role: "assistant" }])).toBe(false);
  });
});

test("留着等它答完的那段不声明「现在看着的机器人」，也不会在卸载时把它改回去", () => {
  let holder: { current: string } | null = null;
  function Chat({ bot, enabled }: { bot: string; enabled: boolean }) {
    useActiveBot(bot, enabled);
    holder = useActiveBotHolder();
    return null;
  }
  const view = render(
    <ActiveBotProvider>
      <Chat bot="agent_a" enabled />
    </ActiveBotProvider>,
  );
  expect(holder!.current).toBe("agent_a");
  // A 还在回答、被留着；B 成了看着的那段。
  view.rerender(
    <ActiveBotProvider>
      <Chat bot="agent_a" enabled={false} />
      <Chat bot="agent_b" enabled />
    </ActiveBotProvider>,
  );
  expect(holder!.current).toBe("agent_b");
  // A 答完被放掉：B 还是 B。
  view.rerender(
    <ActiveBotProvider>
      <Chat bot="agent_b" enabled />
    </ActiveBotProvider>,
  );
  expect(holder!.current).toBe("agent_b");
});

describe("接线", () => {
  const chat = src("components/channels/channel-chat.tsx");

  test("看门狗先查落库再停：静默超时后第一次 stop 在「没落库（hang）」分支里", () => {
    const timeout = chat.indexOf('if (race === "timeout") {');
    const read = chat.indexOf("const stored = await readThreadMessages(", timeout);
    const hang = chat.indexOf('if (first.kind === "hang") {', timeout);
    const firstStop = chat.indexOf("copilotkit.stopAgent({ agent: target });", timeout);
    expect(timeout).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(timeout);
    expect(firstStop).toBeGreaterThan(hang);
    expect(hang).toBeGreaterThan(read);
  });

  test("看门狗的进展订阅挂在这一轮在跑的 agent 上，跑完撤掉", () => {
    expect(chat).toContain("const runWatch = target.subscribe({");
    expect(chat).toContain("onEvent: () => noteRunProgress.current(),");
    expect(chat).toContain("runWatch.unsubscribe();");
  });

  test("正在回答时登记给外壳；留着的那段不声明当前机器人、不收「问一句」、不写状态行", () => {
    expect(chat).toContain("useMarkChatWorking(channel.id, chatBusy);");
    expect(chat).toContain("useActiveBot(runtimeAgentId, !held);");
    expect(chat).toContain("if (heldRef.current) return;");
    expect(chat).toMatch(/if \(held\) return;\s*reportChatRunning\(chatBusy\);/);
  });

  test("中断原因：出错时记下，重新挂上恢复完历史后读回来", () => {
    expect(chat).toContain("rememberTurnOutcome(channel.threadId, lastUser?.id ?? null, message);");
    expect(chat).toContain("turnOutcomeFor(channel.threadId, agentRef.current.messages)");
    expect(chat).toContain("forgetTurnOutcome(channel.threadId);");
  });

  test("外壳把正在回答的对话交给保活舞台", () => {
    const shell = src("components/layout/authed-shell.tsx");
    expect(shell).toContain("keyOf={chatKey}");
    expect(shell).toContain("working={working}");
  });
});

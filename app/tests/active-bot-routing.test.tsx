import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ActiveBotProvider, bindAgentBot, botForAgent, useActiveBot, useActiveBotHolder, useActiveBotId, withRunBot } from "@/lib/copilot/active-bot";

/**
 * 工具调用打到「这次调用所属对话的机器人」（DESIGN.md §101）。
 * 2026-10-17 生产：Asuna 的对话里调用的 computer_navigate 打到了星灵的浏览器（holder 指着后挂载的那段对话）。
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a tool call routes to its own conversation's bot, not the one on screen", () => {
  let holder: { current: string } | null = null;
  function Chat({ bot }: { bot: string }) {
    useActiveBot(bot);
    holder = useActiveBotHolder();
    return null;
  }
  render(
    <ActiveBotProvider>
      <Chat bot="agent_xingling" />
    </ActiveBotProvider>,
  );
  expect(holder!.current).toBe("agent_xingling");

  const asunaAgent = {};
  bindAgentBot(asunaAgent, "agent_asuna");
  expect(botForAgent(asunaAgent)).toBe("agent_asuna");
  expect(botForAgent({})).toBeUndefined();
  expect(botForAgent(undefined)).toBeUndefined();

  // 处理函数同步读 holder.current：在 withRunBot 里读到的是这次调用的机器人，之后立刻还原
  const seen = withRunBot(holder!, botForAgent(asunaAgent), () => holder!.current);
  expect(seen).toBe("agent_asuna");
  expect(holder!.current).toBe("agent_xingling");

  // 不知道属于谁：照旧用 holder
  expect(withRunBot(holder!, undefined, () => holder!.current)).toBe("agent_xingling");
});

test("unrelated provider renders keep the active declaration and holder stable", () => {
  let holder: { current: string } | null = null;
  let value = "";
  function Chat() {
    useActiveBot("bot_a");
    holder = useActiveBotHolder();
    value = useActiveBotId();
    return null;
  }
  const make = (tick: number) => <ActiveBotProvider><i>{tick}</i><Chat /></ActiveBotProvider>;
  const view = render(make(0));
  const originalHolder = holder;
  for (let tick = 1; tick <= 10; tick++) {
    view.rerender(make(tick));
    expect(holder).toBe(originalHolder);
    expect(holder!.current).toBe("bot_a");
    expect(value).toBe("bot_a");
  }
});

test("an older declaration unmounting cannot restore a stale bot after the newer page leaves", () => {
  let holder: { current: string } | null = null;
  let value = "";
  function Chat({ bot }: { bot: string }) {
    useActiveBot(bot);
    return null;
  }
  function Probe() {
    holder = useActiveBotHolder();
    value = useActiveBotId();
    return null;
  }
  const make = (bots: string[]) => <ActiveBotProvider><Probe />{bots.map((bot) => <Chat bot={bot} key={bot} />)}</ActiveBotProvider>;
  const view = render(make(["a", "b"]));
  expect(holder!.current).toBe("b");
  view.rerender(make(["b"]));
  expect(holder!.current).toBe("b");
  expect(value).toBe("b");
  view.rerender(make([]));
  expect(holder!.current).toBe("default");
  expect(value).toBe("default");
});

test("kept A / B pages can swap visibility repeatedly without changing their tool ownership", () => {
  let holder: { current: string } | null = null;
  let value = "";
  const agentA = {};
  const agentB = {};
  bindAgentBot(agentA, "a");
  bindAgentBot(agentB, "b");
  function Chat({ bot, visible }: { bot: string; visible: boolean }) {
    useActiveBot(bot, visible);
    return null;
  }
  function Probe() {
    holder = useActiveBotHolder();
    value = useActiveBotId();
    return null;
  }
  const make = (visible: string) => (
    <ActiveBotProvider>
      <Probe />
      <Chat bot="a" visible={visible === "a"} />
      <Chat bot="b" visible={visible === "b"} />
    </ActiveBotProvider>
  );
  const view = render(make("a"));
  for (const visible of ["b", "a", "b", "a"]) {
    view.rerender(make(visible));
    expect(holder!.current).toBe(visible);
    expect(value).toBe(visible);
    expect(withRunBot(holder!, botForAgent(agentA), () => holder!.current)).toBe("a");
    expect(withRunBot(holder!, botForAgent(agentB), () => holder!.current)).toBe("b");
    expect(holder!.current).toBe(visible);
  }
});

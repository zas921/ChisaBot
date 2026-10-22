import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAliveStage, type KeptState } from "@/components/layout/keep-alive";
import { KeptVisibleContext, useBotOnScreen, useKeptHeld, useKeptVisible, useMarkBotHidden } from "@/lib/kept-visible";
import { useComputerControl } from "@/lib/computers/use-control";
import { settleReactWork } from "./settle-react-work";

/**
 * 切回机器人页总要「刷新一次」（2026-10-17，DESIGN.md §98）：聊天、设置、管理以前各有一个外壳，离开聊天 = 聊天卸载，
 * 回来 = 重新接入、回放、读历史（发送键闪成「停止」、气泡重排、右栏重载）。现在聊天由外壳留着：
 * 离开时只是藏起来，回来还是同一个实例。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Addr = { id: string };
const same = (a: Addr, b: Addr) => a.id === b.id;

function counterPage() {
  const log = { mounts: 0, unmounts: 0, states: [] as Array<{ id: string } & KeptState>, renders: 0 };
  function Page({ id, state }: { id: string; state: KeptState }) {
    const [instance] = useState(() => Math.random());
    log.renders++;
    log.states.push({ id, ...state });
    useEffect(() => {
      log.mounts++;
      return () => {
        log.unmounts++;
      };
    }, []);
    return <div data-instance={instance} data-testid="page">{id}</div>;
  }
  return { log, Page };
}

function stage(Page: (p: { id: string; state: KeptState }) => ReactNode, address: Addr | null, other?: string, idleVisible: boolean | ((kept: Addr) => boolean) = false, ttlMs?: number) {
  return (
    <KeepAliveStage
      address={address}
      idleVisible={idleVisible}
      renderKept={(kept, state) => <Page id={kept.id} state={state} />}
      same={same}
      {...(ttlMs ? { ttlMs } : {})}
    >
      {other ? <section data-testid="other">{other}</section> : null}
    </KeepAliveStage>
  );
}

test("离开聊天再回来：同一个实例，不卸载、不重新挂载", async () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  const instance = view.getByTestId("page").getAttribute("data-instance");
  expect(log.mounts).toBe(1);

  // 去设置：聊天藏起来（不可见、不可点、读屏跳过），设置盖在上面。
  view.rerender(stage(Page, null, "设置"));
  const kept = view.getByTestId("kept-page");
  expect(kept.getAttribute("data-visible")).toBe("false");
  expect(kept.hasAttribute("inert")).toBe(true);
  expect(kept.getAttribute("aria-hidden")).toBe("true");
  expect(kept.style.visibility).toBe("hidden");
  expect(view.getByTestId("route-layer").className).toContain("absolute");
  expect(view.getByTestId("other").textContent).toBe("设置");
  expect(log.states.at(-1)).toMatchObject({ id: "c1", visible: false });

  // 回来：还是那一个。
  view.rerender(stage(Page, { id: "c1" }));
  expect(log.mounts).toBe(1);
  expect(log.unmounts).toBe(0);
  expect(view.getByTestId("page").getAttribute("data-instance")).toBe(instance);
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
  expect(view.getByTestId("kept-page").hasAttribute("inert")).toBe(false);
  expect(view.getByTestId("route-layer").className).toContain("contents");
  // 回来一次，epoch 加一（聊天据此不把离开期间的地址变化当成用户操作）。
  expect(log.states.at(-1)).toMatchObject({ id: "c1", visible: true, epoch: 1 });
});

test("换一段对话：留着的换成新的那段（同一个位置，交给页面自己决定要不要重挂）", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, { id: "c2" }));
  expect(view.getByTestId("page").textContent).toBe("c2");
  expect(log.states.at(-1)).toMatchObject({ id: "c2", visible: true });
});

test("`/` 正在跳到聊天时，留着的聊天先露着（不空一下）", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置"));
  view.rerender(stage(Page, null, undefined, true));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
  expect(view.getByTestId("route-layer").className).toContain("contents");
  expect(log.mounts).toBe(1);
});

test("`/` 跳向的不是留着的那段（别的机器人 / 空聊天）：不露出来，免得闪一下别的对话", () => {
  const { Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置"));
  view.rerender(stage(Page, null, undefined, (kept) => kept.id === "c2"));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("false");
  view.rerender(stage(Page, null, undefined, (kept) => kept.id === "c1"));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe("true");
});

test("一开始就在别的页面：没有留着的聊天，路由照常画", () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, null, "设置"));
  expect(view.queryByTestId("kept-page")).toBeNull();
  expect(view.getByTestId("other").textContent).toBe("设置");
  expect(log.mounts).toBe(0);
});

test("路由那一层是同一个元素：聊天留不留着，别的页面都不会重新挂载", () => {
  function Other() {
    const [instance] = useState(() => Math.random());
    return <i data-instance={instance} data-testid="o" />;
  }
  const make = (address: Addr | null) => (
    <KeepAliveStage address={address} renderKept={(k) => <b>{k.id}</b>} same={same} ttlMs={20}>
      <Other />
    </KeepAliveStage>
  );
  const view = render(make({ id: "c1" }));
  const first = view.getByTestId("o").getAttribute("data-instance");
  view.rerender(make(null));
  view.rerender(make({ id: "c1" }));
  expect(view.getByTestId("o").getAttribute("data-instance")).toBe(first);
});

test("藏够时间就放掉（不再一直问服务器）", async () => {
  const { log, Page } = counterPage();
  const view = render(stage(Page, { id: "c1" }));
  view.rerender(stage(Page, null, "设置", false, 30));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByTestId("kept-page")).toBeNull();
  expect(log.unmounts).toBe(1);
});

test("接线：聊天路由自己不画东西，外壳只有一个，设置 / 管理不再各画一个外壳", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  expect(src("routes/_authed/_app/channel/$channelId.tsx")).toContain("component: () => null");
  expect(src("routes/_authed.tsx")).toContain("<AuthedShell />");
  for (const file of ["routes/_authed/_app.tsx", "routes/_authed/settings/route.tsx", "routes/_authed/admin/route.tsx"]) {
    expect(src(file)).not.toContain("<GlassShell");
  }
  const shell = src("components/layout/authed-shell.tsx");
  expect(shell).toContain("<KeepAliveStage");
  // 右栏在设置里藏起来，不卸载；data-mode 不随设置变（否则回聊天时主区淡入重播）。
  expect(shell).toContain("rightHidden=");
  expect(shell).toContain("mode={switched ? mode : undefined}");
  // 藏着的聊天不改地址、不标已读、不登记左栏「⋯」。
  const page = src("components/channels/channel-page.tsx");
  expect(page).toContain("if (!visibleRef.current) return;");
  expect(page).toContain("if (unseen && visible)");
  // 2026-10-20：JSX 被格式化成了多行，断言改成允许换行（同一件事：藏起来时不登记）。
  expect(page).toMatch(/\{visible \?\s*\(\s*<RegisterBotChat/);
});

/** 换机器人时，正在回答的那段留着等它答完（DESIGN.md §109）。 */
function workingStage(
  Page: (p: { id: string; state: KeptState }) => ReactNode,
  address: Addr | null,
  working: ReadonlySet<string>,
  other?: string,
) {
  return (
    <KeepAliveStage
      address={address}
      keyOf={(kept) => kept.id}
      renderKept={(kept, state) => <Page id={kept.id} state={state} />}
      same={same}
      working={working}
    >
      {other ? <section data-testid="other">{other}</section> : null}
    </KeepAliveStage>
  );
}

test("换机器人时离开的那段还在回答：不卸载，藏着留下；切回来还是同一个实例", () => {
  const { log, Page } = counterPage();
  const busy = new Set(["c1"]);
  const view = render(workingStage(Page, { id: "c1" }, busy));
  const first = view.getByText("c1").getAttribute("data-instance");

  view.rerender(workingStage(Page, { id: "c2" }, busy));
  expect(log.unmounts).toBe(0);
  expect(log.mounts).toBe(2);
  const pages = view.getAllByTestId("kept-page");
  expect(pages).toHaveLength(2);
  const heldPage = pages.find((page) => page.textContent === "c1")!;
  expect(heldPage.getAttribute("data-held")).toBe("true");
  expect(heldPage.getAttribute("data-visible")).toBe("false");
  expect(heldPage.hasAttribute("inert")).toBe(true);
  // 叠在主区里，不占位置。
  expect(heldPage.style.position).toBe("absolute");
  expect(pages.find((page) => page.textContent === "c2")!.getAttribute("data-visible")).toBe("true");

  // 切回来：c1 还是原来那个（c2 没在回答，放掉）。
  view.rerender(workingStage(Page, { id: "c1" }, busy));
  expect(view.getAllByTestId("kept-page")).toHaveLength(1);
  expect(view.getByText("c1").getAttribute("data-instance")).toBe(first);
  expect(log.unmounts).toBe(1);
  expect(log.states.filter((s) => s.id === "c1").at(-1)).toMatchObject({ visible: true });
});

test("留着的那段答完了：放掉；当前那段不受影响", async () => {
  const { log, Page } = counterPage();
  const view = render(workingStage(Page, { id: "c1" }, new Set(["c1"])));
  view.rerender(workingStage(Page, { id: "c2" }, new Set(["c1"])));
  expect(view.getAllByTestId("kept-page")).toHaveLength(2);
  const current = view.getByText("c2").getAttribute("data-instance");

  await act(async () => {
    view.rerender(workingStage(Page, { id: "c2" }, new Set()));
  });
  expect(view.getAllByTestId("kept-page")).toHaveLength(1);
  expect(view.getByText("c2").getAttribute("data-instance")).toBe(current);
  expect(log.unmounts).toBe(1);
});

test("离开的那段没在回答：照旧让出位置（新对话复用它，不多挂一页）", () => {
  const { log, Page } = counterPage();
  const view = render(workingStage(Page, { id: "c1" }, new Set()));
  view.rerender(workingStage(Page, { id: "c2" }, new Set()));
  expect(view.getAllByTestId("kept-page")).toHaveLength(1);
  expect(log.mounts).toBe(1);
  expect(view.getByTestId("page").textContent).toBe("c2");
});

test("两段都在回答，来回切：两页都留着，DOM 里的先后不变（挪节点会丢滚动位置）", () => {
  const { Page } = counterPage();
  const busy = new Set(["c1", "c2"]);
  const view = render(workingStage(Page, { id: "c1" }, busy));
  view.rerender(workingStage(Page, { id: "c2" }, busy));
  const order = () => view.getAllByTestId("kept-page").map((page) => page.textContent);
  expect(order()).toEqual(["c1", "c2"]);
  view.rerender(workingStage(Page, { id: "c1" }, busy));
  expect(order()).toEqual(["c1", "c2"]);
  expect(view.getAllByTestId("kept-page").find((p) => p.textContent === "c2")!.getAttribute("data-held")).toBe("true");
});

test("留着的那段读到 held（不声明当前机器人、不收「问一句」），当前那段不是", () => {
  const seen = new Map<string, boolean>();
  function Probe({ id }: { id: string }) {
    seen.set(id, useKeptHeld());
    return <i>{id}</i>;
  }
  const make = (address: Addr) => (
    <KeepAliveStage
      address={address}
      keyOf={(kept) => kept.id}
      renderKept={(kept) => <Probe id={kept.id} />}
      same={same}
      working={new Set(["c1"])}
    >
      {null}
    </KeepAliveStage>
  );
  const view = render(make({ id: "c1" }));
  expect(seen.get("c1")).toBe(false);
  view.rerender(make({ id: "c2" }));
  expect(seen.get("c1")).toBe(true);
  expect(seen.get("c2")).toBe(false);
});

test("藏在设置后面、还在回答的那段：藏够时间也不放，答完才开始计时", async () => {
  const { log, Page } = counterPage();
  const make = (address: Addr | null, working: ReadonlySet<string>) => (
    <KeepAliveStage
      address={address}
      keyOf={(kept) => kept.id}
      renderKept={(kept, state) => <Page id={kept.id} state={state} />}
      same={same}
      ttlMs={30}
      working={working}
    >
      <section>设置</section>
    </KeepAliveStage>
  );
  const view = render(make({ id: "c1" }, new Set(["c1"])));
  view.rerender(make(null, new Set(["c1"])));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByTestId("kept-page")).not.toBeNull();
  view.rerender(make(null, new Set()));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByTestId("kept-page")).toBeNull();
  expect(log.unmounts).toBe(1);
});

test("藏着的聊天读到「不在屏幕上」（轮询 / 画面据此停下），回来变回在", () => {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useKeptVisible());
    return null;
  }
  const Page = () => <Probe />;
  const view = render(stage(Page, { id: "c1" }));
  expect(seen.at(-1)).toBe(true);
  view.rerender(stage(Page, null, "设置"));
  expect(seen.at(-1)).toBe(false);
  view.rerender(stage(Page, { id: "c1" }));
  expect(seen.at(-1)).toBe(true);
});

test("藏着的聊天登记它的机器人：全局的组件授权轮询为它停下", () => {
  const onScreen: boolean[] = [];
  function Global() {
    onScreen.push(useBotOnScreen("bot_a"));
    return null;
  }
  function Chat({ hidden }: { hidden: boolean }) {
    useMarkBotHidden("bot_a", hidden);
    return null;
  }
  const view = render(<><Global /><Chat hidden={false} /></>);
  expect(onScreen.at(-1)).toBe(true);
  view.rerender(<><Global /><Chat hidden /></>);
  expect(onScreen.at(-1)).toBe(false);
  view.rerender(<><Global /><Chat hidden={false} /></>);
  expect(onScreen.at(-1)).toBe(true);
  view.rerender(<><Global /><Chat hidden /></>);
  view.unmount();
  const again = render(<Global />);
  expect(onScreen.at(-1)).toBe(true);
  again.unmount();
});

test("计算机控制权：只剩藏着的订阅者时不再每秒问，回来马上补读", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ holder: "agent" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  function Control() {
    useComputerControl("bot_ctl");
    return null;
  }
  try {
    const view = render(<KeptVisibleContext.Provider value={true}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    const visibleCalls = calls.length;
    expect(visibleCalls).toBeGreaterThanOrEqual(2);
    view.rerender(<KeptVisibleContext.Provider value={false}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const atHide = calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
    expect(calls.length).toBe(atHide);
    view.rerender(<KeptVisibleContext.Provider value={true}><Control /></KeptVisibleContext.Provider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(calls.length).toBeGreaterThan(atHide);
    view.unmount();
  } finally {
    globalThis.fetch = realFetch;
  }
}, 10_000);

test("接线：藏着的东西不轮询（§98.3）", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  expect(src("components/layout/keep-alive.tsx")).toContain("<KeptVisibleContext.Provider value={visible}>");
  expect(src("components/layout/glass-shell.tsx")).toContain("<KeptVisibleContext.Provider value={!rightHidden}>");
  expect(src("components/computer/preview-visibility.ts")).toContain("return visible && kept;");
  expect(src("lib/computers/tabs.ts")).toContain("const poll = pollWanted && kept;");
  expect(src("components/panels/live-panels.tsx")).toContain("if (!onScreen) return false;");
  for (const f of ["lib/copilot/gallery-tools.tsx", "lib/copilot/sandboxed-tools.tsx"]) expect(src(f)).toContain("useBotOnScreen(declared)");
  expect(src("components/channels/channel-page.tsx")).toContain("useMarkBotHidden(agentId, !visible)");
  expect(src("components/computer/handoff-resume-notice.tsx")).toContain("if (!ready || !onScreen) return;");
  expect(src("lib/copilot/thread-activity.ts")).toContain("if (onScreen) kickRef.current();");
  expect(src("lib/copilot/thread-activity.ts")).toContain("onScreenRef.current ? SYNC_INTERVAL_MS : HIDDEN_SYNC_INTERVAL_MS");
  // 手机抽屉在导航开始前收起（不是新左栏挂上之后的 effect 里），否则透明抽屉盖住页面。
  expect(src("components/layout/glass-shell.tsx")).toContain('router.subscribe("onBeforeNavigate"');
});

test("藏起来那一刻浏览器挪了藏着的滚动容器：还原成离开前的位置（§98.5）", async () => {
  function Scroller() {
    return <div data-slot="message-scroller-viewport" data-testid="scroller" style={{ overflowY: "auto", height: 100 }}><div style={{ height: 1000 }} /></div>;
  }
  const page = () => <Scroller />;
  const view = render(stage(page, { id: "c1" }));
  const scroller = view.getByTestId("scroller");
  scroller.scrollTop = 500;
  scroller.dispatchEvent(new Event("scroll"));
  view.rerender(stage(page, null, "设置"));
  // 浏览器自己挪了（没有脚本调用）：收到 scroll 时还原。
  scroller.scrollTop = 432;
  scroller.dispatchEvent(new Event("scroll"));
  expect(scroller.scrollTop).toBe(500);
  view.rerender(stage(page, { id: "c1" }));
  expect(scroller.scrollTop).toBe(500);
});

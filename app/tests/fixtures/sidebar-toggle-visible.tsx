import { createRootRoute, createRoute, createRouter, RouterProvider, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GlassShell } from "@/components/layout/glass-shell";
import { Sidebar, SidebarContent, useSidebar } from "@/components/ui/sidebar";
import { ThreadWorkerProgress } from "@/components/chat/thread-worker-progress";
import "../../src/styles.css";

type FixtureState = { mounts: number; unmounts: number; instance: string; windowCalls: string[] };
declare global { interface Window { __sidebarFixture: FixtureState } }
window.__sidebarFixture = { mounts: 0, unmounts: 0, instance: "", windowCalls: [] };
const parameters = new URLSearchParams(location.search);
if (parameters.get("phone") === "1") document.documentElement.dataset.phone = "true";
if (parameters.get("desktop") === "1") {
  window.chisabotWindow = {
    platform: "win32",
    minimize: () => { window.__sidebarFixture.windowCalls.push("minimize"); },
    toggleMaximize: () => { window.__sidebarFixture.windowCalls.push("maximize"); },
    close: () => { window.__sidebarFixture.windowCalls.push("close"); },
    isMaximized: async () => false,
    onMaximizedChange: () => () => {},
    ...(parameters.get("compact") === "1" ? {
      toggleCompact: () => { window.__sidebarFixture.windowCalls.push("compact"); },
      isCompact: async () => true,
      onCompactChange: () => () => {},
    } : {}),
  };
}

function FixtureSidebar({ name }: { name: string }) {
  const sidebar = useSidebar();
  return (
    <Sidebar className="glass-sidebar-container" collapsible="icon" variant="floating">
      <SidebarContent>
        <nav aria-label={name} className="glass-rail" id="chisabot-bot-list" style={{ padding: 12, height: "100%" }}>
          <strong>{sidebar.isMobile || sidebar.open ? name : "菜单"}</strong>
          {[
            ["复刻镜", "后台取数仍在运行"],
            ["资料整理", "独立的机器人会话"],
            ["每日助手", "查看已保存的对话"],
          ].map(([title, detail]) => (
            <div key={title} style={{ paddingTop: 18 }}>
              <div>{sidebar.isMobile || sidebar.open ? title : title.slice(0, 1)}</div>
              {sidebar.isMobile || sidebar.open ? <small>{detail}</small> : null}
            </div>
          ))}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}

function PersistentConversation() {
  const [instance] = useState(() => crypto.randomUUID());
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    window.__sidebarFixture.mounts++;
    window.__sidebarFixture.instance = instance;
    const timer = setInterval(() => setTicks((value) => value + 1), 250);
    return () => { clearInterval(timer); window.__sidebarFixture.unmounts++; };
  }, [instance]);
  return (
    <section data-testid="conversation-slot" data-instance={instance} data-ticks={ticks} style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0, padding: 18, overflowY: "auto" }}>
      <nav aria-label="测试区域切换" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {[
          ["机器人", "/chat/sidebar-fixture"], ["设置", "/settings/sidebar-fixture"],
          ["管理", "/admin/sidebar-fixture"], ["Claude Code", "/cc/sidebar-fixture"],
        ].map(([label, to]) => (
          <button key={to} type="button" onClick={() => void router.navigate({ to })} style={{ padding: "6px 9px", border: "1px solid #94a3b8", borderRadius: 7 }}>{`切换至${label}`}</button>
        ))}
      </nav>
      <p>{"此处是保持挂载的对话。菜单开合不应重置输入或中断后台进度。"}</p>
      <ThreadWorkerProgress threadId="fixture-thread" agentId="fixture-bot" />
      <label>{"对话草稿"}<input aria-label="对话草稿" style={{ display: "block", width: "100%", border: "1px solid #94a3b8", padding: 9, borderRadius: 8 }} /></label>
    </section>
  );
}

function Fixture() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope = pathname.startsWith("/settings/") ? "settings" : pathname.startsWith("/admin/") ? "admin" : "app";
  const cc = pathname.startsWith("/cc/");
  const name = scope === "settings" ? "设置分区" : scope === "admin" ? "管理导航" : cc ? "Claude Code" : "机器人列表";
  return (
    <GlassShell scope={scope} mode={cc ? "cc" : "bots"} sidebar={<FixtureSidebar name={name} />} rightHidden={scope !== "app" || cc}
      right={<aside data-testid="right-panel" className="glass-rail hidden md:block" style={{ width: 240, margin: "8px 16px 16px 0", padding: 14 }}><strong>{"辅助面板"}</strong><input aria-label="面板草稿" style={{ width: "100%", marginTop: 14, border: "1px solid #94a3b8" }} /></aside>}>
      <PersistentConversation />
    </GlassShell>
  );
}

const root = createRootRoute({ component: Fixture });
const routes = ["/tests/fixtures/sidebar-toggle-visible.html", "/chat/sidebar-fixture", "/settings/sidebar-fixture", "/admin/sidebar-fixture", "/cc/sidebar-fixture"]
  .map((path) => createRoute({ getParentRoute: () => root, path }));
const router = createRouter({ routeTree: root.addChildren(routes) });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

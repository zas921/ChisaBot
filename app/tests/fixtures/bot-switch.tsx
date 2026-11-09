import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChannelChat } from "@/components/channels/channel-chat";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { useWorkingChats } from "@/lib/kept-visible";
import "../../src/styles.css";

type Bot = "a" | "b";
const lifecycle = { mounts: { a: 0, b: 0 }, unmounts: { a: 0, b: 0 } };
declare global { interface Window { botSwitchLifecycle: typeof lifecycle; } }
window.botSwitchLifecycle = lifecycle;
const channels = Object.fromEntries((["a", "b"] as const).map((bot) => [bot, {
  id: `channel-${bot}`, name: `Bot ${bot.toUpperCase()}`, agentIds: [`bot-${bot}`],
  threadId: `thread-${bot}`, active: true, lastMessageAt: "2026-11-06T00:00:00Z",
} satisfies AgentChannel])) as Record<Bot, AgentChannel>;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
client.setQueryData(channelKeys.list(), { pages: [{ channels: [], nextCursor: null }], pageParams: [""] });
const same = (a: Bot, b: Bot) => a === b;
const keyOf = (bot: Bot) => channels[bot].id;
function Chat({ bot }: { bot: Bot }) {
  const [instance] = useState(() => crypto.randomUUID());
  useEffect(() => { lifecycle.mounts[bot]++; return () => { lifecycle.unmounts[bot]++; }; }, [bot]);
  return <section data-bot={bot} data-instance={instance} style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
    <ChannelChat channel={channels[bot]} runtimeAgentId={`bot-${bot}`} />
  </section>;
}
function Fixture() {
  const [bot, setBot] = useState<Bot>("a");
  const working = useWorkingChats();
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "linear-gradient(150deg,#d4e6f2,#f3f5fb)", color: "#1a293b" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid #a9bacb", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 650, flex: "1 1 140px" }}>会话切换 · 本地验收</span>
      {(["a", "b"] as const).map((id) => <button key={id} data-testid={`open-${id}`} aria-pressed={bot === id} onClick={() => setBot(id)} style={{ borderRadius: 10, padding: "7px 14px", border: "1px solid #9cadc0", background: bot === id ? "#173c69" : "white", color: bot === id ? "white" : "#173c69" }}>Bot {id.toUpperCase()}</button>)}
    </header>
    <KeepAliveStage address={bot} same={same} keyOf={keyOf} working={working} maxIdlePages={5} renderKept={(kept) => <Chat bot={kept} />}><span /></KeepAliveStage>
  </main>;
}
document.documentElement.style.cssText = "height:100%;overflow:hidden";
document.body.style.cssText = "height:100%;margin:0;overflow:hidden";
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ActiveBotProvider><CopilotKitProvider runtimeUrl={`${location.origin}/api/copilotkit`}><Fixture /></CopilotKitProvider></ActiveBotProvider></QueryClientProvider>);

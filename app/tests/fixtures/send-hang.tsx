import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ActiveBotProvider } from "@/lib/copilot/active-bot";
import { channelKeys } from "@/lib/channels/queries";
import "../../src/styles.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
client.setQueryData(channelKeys.list(), { pages: [{ channels: [], nextCursor: null }], pageParams: [""] });
document.documentElement.style.cssText = "height:100%;overflow:hidden";
document.body.style.cssText = "height:100%;margin:0;overflow:hidden";
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><ActiveBotProvider><CopilotKitProvider runtimeUrl={`${location.origin}/api/copilotkit`}>
  <main style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "linear-gradient(150deg,#d4e6f2,#f3f5fb)", color: "#1a293b" }}>
    <header style={{ fontWeight: 650, padding: "14px 20px", borderBottom: "1px solid #a9bacb" }}>发送确认 · 本地验收</header>
    <ChannelChat channel={{ id: "receipt-channel", name: "发送确认", agentIds: ["receipt-bot"], threadId: "receipt-thread", active: true, lastMessageAt: "2026-11-06T00:00:00Z" }} runtimeAgentId="receipt-bot" />
  </main>
</CopilotKitProvider></ActiveBotProvider></QueryClientProvider>);

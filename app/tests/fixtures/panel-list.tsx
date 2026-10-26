import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { LivePanelList } from "@/components/panels/live-panels";
import "../../src/styles.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <div style={{ background: "linear-gradient(#84aee0, #edf4fa)", height: "100dvh", padding: 12 }}>
      <section className="glass-card glass-rail-inner rail-card" style={{ width: "min(356px, 100%)", height: "100%", marginLeft: "auto", display: "flex", flexDirection: "column" }}>
        <header className="rail-head"><h2 className="rail-head-t">面板</h2></header>
        <div className="glass-rail-scroll" style={{ overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <LivePanelList botId="test-bot" />
        </div>
      </section>
    </div>
  </QueryClientProvider>,
);

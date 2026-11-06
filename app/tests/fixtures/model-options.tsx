import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <main
      style={{
        minHeight: "100dvh",
        padding: 20,
        background: "linear-gradient(#a3bedf, #eef3fa)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <section className="glass-rail" style={{ maxWidth: 440, padding: 20 }}>
        <h2>机器人模型设置</h2>
        <BotModelSelector agentId="test-bot" />
      </section>
      <section
        data-testid="composer"
        style={{ alignSelf: "flex-end", maxWidth: "100%" }}
      >
        <BotModelSelector agentId="test-bot" compact />
      </section>
    </main>
  </QueryClientProvider>,
);

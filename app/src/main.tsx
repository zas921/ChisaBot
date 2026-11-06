import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthLoopNotice } from "./components/auth/auth-loop-notice";
import { installLoginRedirect } from "./lib/auth/login-redirect";
import { BootCommitMarker, reportBootStage } from "./lib/boot-status";
import { installPhoneLayout } from "./lib/device";
import { installHaltProbe } from "./lib/halt";
import { installPerfMode } from "./lib/perf-mode";
import { installPwa } from "./lib/pwa";
import { installPreviewWindowBridge } from "./lib/proto-preview";
import { initResizeState } from "./lib/resize-state";
import { installStaleChunkReload } from "./lib/stale-chunk";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import "./perf-noblur.css";
import "./a11y-modes.css";
import "./resize-pause.css";

reportBootStage("entry-executing");
installPhoneLayout();
installPerfMode();
installHaltProbe();
installPwa();
installPreviewWindowBridge();
installStaleChunkReload();
installLoginRedirect();
initResizeState();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ChisaBot 无法找到应用程序根元素。");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BootCommitMarker />
      <AuthLoopNotice />
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { type DeviceView, defaultCapabilities } from "../../shared/devices";
import { defaultAgentSettings } from "../../shared/local-agents";

/**
 * 设置 → 设备 → 本地 agent（2026-10-21）：`useSegmentedKeys` 曾写在加载 / 出错的提前返回之后。
 * 首帧 draft 一定为空只渲染骨架屏，第二帧多出两个钩子，React 抛「Rendered more hooks than during the
 * previous render」，整个标签页崩掉。这里钉住：数据到达后面板正常渲染出权限档位。
 */

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});
afterEach(() => cleanup());
afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const { DeviceAgentsPanel } = await import("@/components/local-agents/device-agents-panel");
const { localAgentKeys } = await import("@/lib/local-agents");

function device(): DeviceView {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "Ayase",
    platform: "linux",
    osVersion: "Ubuntu 24.04",
    hostname: "ayase",
    arch: "x64",
    clientVersion: "0.1.52",
    capabilities: defaultCapabilities(),
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    online: true,
  };
}

test("数据已在缓存里时，面板从骨架屏切到正文不崩", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(localAgentKeys.device("dev_1"), {
    settings: defaultAgentSettings("dev_1"),
    effectiveRoots: [],
    online: true,
    tasks: [],
  });
  const { findByTestId } = render(
    <QueryClientProvider client={client}>
      <DeviceAgentsPanel device={device()} isThisPc={false} />
    </QueryClientProvider>,
  );
  // 修复前第二帧在渲染里抛错，这里要么抛出、要么永远等不到正文。
  const workspace = await findByTestId("profile-workspace");
  expect(workspace.getAttribute("aria-checked")).toBe("true");
});

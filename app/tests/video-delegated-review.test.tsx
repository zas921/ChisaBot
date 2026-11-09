import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { VideoProgressPanel } from "@/components/panels/video-progress-panel";
import type { VideoJob } from "@/lib/video-production/queries";

beforeAll(() => GlobalRegistrator.register({ url: "https://chisabot.test/" }));
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let job: VideoJob;
let writes: string[];
beforeEach(() => {
  writes = [];
  job = {
    id: "job-a", botId: "bot-a", ownerId: "owner-a", threadId: "thread-a", title: "科技解说",
    revision: 3, state: "awaiting_script_approval", scriptHash: "script-3", scriptApproved: false,
    reviewPolicy: { mode: "delegate_export", reviewerBotId: "main-bot", reviewerBotName: "主审核" },
    reviewAttempt: 0, reviewRevisionRequests: 1,
    script: { title: "完整文案", summary: "", tags: [], segments: [{ text: "事实与观点", visual: "card" }] },
    sources: [{ id: "source-1", title: "原片" }], artifacts: [],
    reviews: [{ stage: "script", revision: 3, hash: "script-3", reviewerBotId: "main-bot", reviewAttempt: 0,
      decision: "changes_requested", notes: "第二段原片没有支持该断言，补充依据并调整措辞。" }],
  };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") { writes.push(path); throw new Error("Delegated review must not approve from UI"); }
    if (path === "/api/me") return Response.json({ user: { id: "owner-a", email: "a@example.test", role: "user", onboarding: null } });
    if (path.startsWith("/api/video-production/jobs?")) return Response.json({ jobs: [job] });
    if (path.endsWith("/review-context")) return Response.json({ job, csrf: "csrf" });
    throw new Error(`Unexpected ${path}`);
  }, { preconnect: originalFetch.preconnect });
});
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});
function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}><VideoProgressPanel botId="bot-a" /></QueryClientProvider>) };
}
async function open(view: ReturnType<typeof draw>) {
  const button = await view.findByRole("button", { name: "查看审核与成片" });
  await act(async () => { fireEvent.click(button); });
  const dialog = within(await view.findByTestId("video-review-dialog"));
  await dialog.findByTestId("video-review-delegated");
  return dialog;
}
async function refresh(view: ReturnType<typeof draw>) {
  await act(async () => { await view.client.invalidateQueries({ queryKey: ["video-projects"] }); });
}

test("delegated sidebar and inline dialog show actual rejection and automatic rework without approval controls", async () => {
  const view = draw();
  const panel = await view.findByTestId("video-progress-panel");
  expect(panel.textContent).toContain("主 bot 已退回，制作 bot 返修中");
  expect(panel.textContent).toContain("主 bot 审稿");
  expect(panel.textContent).toContain("导出交付");
  expect(panel.textContent).not.toContain("待你确认");
  expect(panel.querySelector('[data-step="1"]')?.getAttribute("aria-current")).toBe("step");
  const dialog = await open(view);
  expect(dialog.getByTestId("video-review-delegated-notes").textContent).toBe(job.reviews![0].notes!);
  expect(dialog.getAllByTestId("video-review-segment")).toHaveLength(1);
  expect(dialog.queryByRole("checkbox")).toBeNull();
  expect(dialog.queryByRole("button", { name: /确认第/ })).toBeNull();
  expect(dialog.queryByText("稿件和成片分别由你确认。")).toBeNull();
  expect(writes).toHaveLength(0);
});

test("open delegated dialog refreshes same-version evidence rechecks and later verdicts automatically", async () => {
  const view = draw(); const dialog = await open(view);
  job = { ...job, reviewAttempt: 1 };
  await refresh(view);
  await waitFor(() => expect(dialog.getByTestId("video-review-delegated").textContent).toContain("上轮结论"));
  expect(dialog.getByTestId("video-review-delegated").textContent).toContain("已开启同版本复核");
  job = { ...job, reviews: [...job.reviews!, { ...job.reviews![0], reviewAttempt: 1, decision: "evidence_blocked", notes: "缺少必要音轨证据，自动补查。" }] };
  await refresh(view);
  await waitFor(() => expect(dialog.getByTestId("video-review-delegated-notes").textContent).toBe("缺少必要音轨证据，自动补查。"));
  expect(dialog.getByTestId("video-review-delegated").textContent).toContain("证据待补充");
  expect(dialog.queryByRole("checkbox")).toBeNull();
  expect(writes).toHaveLength(0);
});

test("unapproved videos are previews and export is complete only when every approved output has a matching receipt", async () => {
  job = { ...job, state: "awaiting_video_approval", scriptApproved: true, artifactHash: "media-3", videoApproved: false,
    artifacts: [{ name: "landscape.mp4", kind: "video" }, { name: "portrait.mp4", kind: "video" }], reviews: [] };
  const view = draw(); const dialog = await open(view);
  expect(dialog.getByText("待审成片预览")).toBeTruthy();
  expect(dialog.getByText(/预览和下载不代表审核通过或最终交付/)).toBeTruthy();
  expect(dialog.queryByRole("checkbox")).toBeNull();
  job = { ...job, state: "approved", videoApproved: true,
    exportReceipt: { revision: 3, artifactHash: "media-3", botId: "bot-a", artifactNames: ["landscape.mp4"], at: 100 } };
  await refresh(view);
  await waitFor(() => expect(view.getByTestId("video-progress-status").textContent).toContain("审核通过，正在导出"));
  expect(view.getByTestId("video-progress-stages").querySelector('[data-step="5"]')?.getAttribute("data-complete")).toBe("false");
  job = { ...job, exportReceipt: { ...job.exportReceipt!, artifactNames: ["landscape.mp4", "portrait.mp4"] } };
  await refresh(view);
  await waitFor(() => expect(dialog.getByText("当前版本已审核通过并交付导出链接，可下载成片。")).toBeTruthy());
  expect(view.getByTestId("video-progress-status").textContent).toContain("导出链接已交付");
  expect(writes).toHaveLength(0);
});

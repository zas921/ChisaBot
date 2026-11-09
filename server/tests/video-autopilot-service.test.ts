import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { withConfirmToolCall, withConfirmTurn } from "../src/confirmations/context";
import { createVideoProduction } from "../src/video-production/service";
import { videoReviewThreadId } from "../src/video-production/reviewer";
import { videoInspectionContent, videoInspectionRequest, videoInspectionSchema, readVideoInspection } from "../src/video-production/inspection-tool";
import { withVideoInspectionPrompt } from "../src/video-production/inspection-content";
import { renderVideoReviewPage, videoReviewPresentation } from "../src/video-production/page";
import type { VideoJob } from "../src/video-production/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
const thread = videoReviewThreadId("alice", "project_1", "main");
function fixture(extra: Partial<VideoJob> = {}): VideoJob {
  return { id: "project_1", ownerId: "alice", botId: "producer", threadId: "producer-thread", title: "测试", createdAt: 0, updatedAt: 0,
    state: "awaiting_script_approval", revision: 2, scriptHash: "a".repeat(64), artifactHash: "b".repeat(64),
    reviewPolicy: { mode: "delegate_export", reviewerBotId: "main", reviewerThreadId: thread, authorizedBy: "alice", allowPublish: false },
    script: { title: "稿", summary: "说明", tags: [], segments: [{ visual: "source", sourceId: "source_1", start: 1, end: 5, text: "说明" }] },
    sources: [{ id: "source_1", title: "素材", url: "https://youtu.be/abcdefghijk", duration: 10, transcript: [{ start: 0, end: 10, text: "原片字幕" }], scenes: [0, 5] }],
    artifacts: [{ name: "landscape.mp4", kind: "video", sha256: hash("video") }, { name: "frame.jpg", kind: "review_frame", sha256: hash(jpeg) }],
    ...extra };
}
const inspect = { id: "project_1", target: "source" as const, sourceId: "source_1", start: 1, end: 5, maxFrames: 4 };
function response(job: VideoJob, input = inspect) {
  return { ...videoInspectionRequest(job, input), ownerId: undefined, maxFrames: undefined, frames: [1, 3, 5].map((at) => ({ at, mimeType: "image/jpeg", data: jpeg.toString("base64"), sha256: hash(jpeg) })), limitations: ["连续区间的采样图像"] };
}
function harness(initial = fixture()) {
  let job = structuredClone(initial), transform = (value: any) => value;
  const calls: { path: string; body: any }[] = [];
  const packet = { version: 1, revision: job.revision, scriptHash: job.scriptHash, complete: true, errors: [], limitations: ["抽样"],
    audio: { method: "local-asr", transcript: [{ start: 0, end: 5, text: "实际音轨" }] },
    videos: [{ name: "landscape.mp4", sha256: hash("video"), qc: { analysisComplete: true }, frames: [{ name: "frame.jpg", at: 2, sha256: hash(jpeg) }] }] };
  job.artifacts!.push({ name: "review-evidence.json", kind: "review", sha256: hash(JSON.stringify(packet)) });
  const service = createVideoProduction({ baseUrl: "http://worker.test", token: "test-video-token-no-production", resolveMainBot: async () => "main",
    fetch: (async (raw, init) => {
      const url = new URL(String(raw)), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/inspect")) return Response.json(transform(response(job, { id: job.id, target: body.target, sourceId: body.sourceId, start: body.start, end: body.end, maxFrames: body.maxFrames })));
      if (url.pathname.endsWith("/review-evidence.json")) return Response.json(packet);
      if (url.pathname.endsWith("/frame.jpg")) return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      if (url.pathname.endsWith("/exported")) { job.exportReceipt = { ...body, at: 1 }; return Response.json(job); }
      if (url.pathname.endsWith("/request-review")) { job.reviewAttempt = (job.reviewAttempt ?? 0) + 1; return Response.json(job); }
      if (url.pathname.endsWith("/review-decision")) return Response.json({ ...job, state: "approved" });
      return Response.json(job);
    }) as typeof fetch });
  async function tool(name: string, args: unknown, bot = "producer", threadId = "producer-thread", owner = "alice") {
    return withConfirmTurn({ threadId, runId: "test-run", stopped: () => false }, async () => {
      const selected = service.tools(owner, bot).find((t) => t.name === name)!;
      const result = String(await withConfirmToolCall("call-" + name, name, () => selected.execute(args)));
      return JSON.parse(/<untrusted_data[^>]*>\n([\s\S]*)\n<\/untrusted_data>/.exec(result)?.[1] ?? result);
    });
  }
  return { service, calls, tool, job: () => job, setJob: (value: VideoJob) => { job = value; }, transform: (fn: typeof transform) => { transform = fn; } };
}

test("producer and designated reviewer inspect real current images; ordinary output contains only metadata/token", async () => {
  const h = harness();
  for (const [bot, threadId] of [["producer", "producer-thread"], ["main", thread]]) {
    const result = await h.tool("video_project_inspect", inspect, bot, threadId);
    expect(result.executed).toBeUndefined();
    expect(result.frames).toHaveLength(3);
    expect(result.inspectionToken).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.stringify(result)).not.toContain(jpeg.toString("base64"));
    const hydrated = withConfirmTurn({ threadId, runId: "test-run", stopped: () => false }, () => withVideoInspectionPrompt({ prompt: [
      { role: "tool", content: [{ type: "tool-result", toolName: "video_project_inspect", toolCallId: "call-video_project_inspect", output: { type: "json", value: result } }] },
    ] }));
    expect(JSON.stringify(hydrated)).toContain('"mediaType":"image/jpeg"');
  }
  expect(h.calls.filter((c) => c.path.endsWith("/inspect"))[0]!.body).toMatchObject({ ownerId: "alice", revision: 2, scriptHash: "a".repeat(64) });
});

test("unrelated owner/bot/thread and invalid source cannot read inspection frames", async () => {
  const h = harness();
  for (const [bot, threadId, owner] of [["other", "producer-thread", "alice"], ["main", "wrong", "alice"], ["producer", "producer-thread", "bob"]])
    expect((await h.tool("video_project_inspect", inspect, bot, threadId, owner)).executed).toBe(false);
  expect((await h.tool("video_project_inspect", { ...inspect, sourceId: "missing" })).executed).toBe(false);
  expect(h.calls.some((c) => c.path.endsWith("/inspect"))).toBe(false);
});

test("media inspection rejects stale content, mismatched range, malformed image and digest", () => {
  const job = fixture(), parsed = videoInspectionSchema.parse(inspect);
  const good = JSON.parse(JSON.stringify(response(job)));
  expect(videoInspectionContent(job, parsed, good).content.filter((c) => c.type === "image")).toHaveLength(3);
  for (const mutate of [
    (v: any) => { v.revision--; }, (v: any) => { v.scriptHash = "c".repeat(64); },
    (v: any) => { v.artifactHash = "c".repeat(64); }, (v: any) => { v.sourceId = "other"; },
    (v: any) => { v.end++; }, (v: any) => { v.frames[0].at = 0; }, (v: any) => { v.frames[1].at = 1; },
    (v: any) => { v.frames[0].sha256 = "c".repeat(64); }, (v: any) => { v.frames[0].mimeType = "image/png"; },
    (v: any) => { v.frames[0].data += "!"; }, (v: any) => { v.frames = [...v.frames, ...v.frames]; },
  ]) { const value = structuredClone(good); mutate(value); expect(() => videoInspectionContent(job, parsed, value)).toThrow(); }
  for (const input of [{ ...inspect, end: 32 }, { ...inspect, end: 1 }, { ...inspect, maxFrames: 1 }, { ...inspect, artifactName: "video.mp4" }])
    expect(videoInspectionSchema.safeParse(input).success).toBe(false);
});

test("worker JSON is bounded before parsing and media works before first saved draft", async () => {
  await expect(readVideoInspection(new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }))).rejects.toThrow();
  await expect(readVideoInspection(new Response("{}", { headers: { "Content-Type": "text/html" } }))).rejects.toThrow();
  const job = fixture({ revision: 0, scriptHash: null, artifactHash: null });
  expect(videoInspectionContent(job, videoInspectionSchema.parse(inspect), JSON.parse(JSON.stringify(response(job)))).metadata.scriptHash).toBeNull();
});

test("creator reads actual audio evidence for repair but cannot grant reviewer approval receipts", async () => {
  const h = harness(fixture({ state: "awaiting_video_approval", scriptApproved: true }));
  const page = await h.tool("video_project_review_evidence", { id: "project_1", offset: 0 });
  expect(page.error).toBeUndefined(); expect(page.text).toContain("实际音轨");
  await h.service.prepareReview({ job: h.job(), stage: "video", reviewerBotId: "main", threadId: thread });
  const decision = { id: "project_1", stage: "video", revision: 2, hash: "b".repeat(64), decision: "approve", notes: "已检查", evidence: { audioObservations: "音轨", visualObservations: "画面", subtitleObservations: "字幕", checkedArtifacts: ["landscape.mp4"] } };
  expect((await h.tool("video_project_review_decision", decision, "main", thread)).executed).toBe(false);
  await h.tool("video_project_review_evidence", { id: "project_1", offset: 0 }, "main", thread);
  expect((await h.tool("video_project_review_decision", decision, "main", thread)).state).toBe("approved");
  h.job().reviewAttempt = 1;
  expect((await h.tool("video_project_review_decision", { ...decision, reviewAttempt: 1 }, "main", thread)).executed).toBe(false);
  expect((await h.tool("video_project_review_decision", decision)).executed).toBe(false);
});

test("same-version rereview binds creator, exact attempt and tool id without editing content", async () => {
  const h = harness();
  const args = { id: "project_1", stage: "script", revision: 2, hash: "a".repeat(64), reviewAttempt: 0, reason: "已补充原片连续画面证据" };
  expect((await h.tool("video_project_request_review", args, "main", thread)).executed).toBe(false);
  expect((await h.tool("video_project_request_review", { ...args, revision: 1 })).executed).toBe(false);
  expect((await h.tool("video_project_request_review", args)).reviewAttempt).toBe(1);
  expect(h.calls.find((c) => c.path.endsWith("/request-review"))!.body).toMatchObject({ ownerId: "alice", botId: "producer", requestId: "call-video_project_request_review", revision: 2, reviewAttempt: 0 });
  expect(h.calls.some((c) => c.path.endsWith("/script"))).toBe(false);
});

test("only current approved producer exports mark delivery; previews stay incomplete", async () => {
  const h = harness();
  const preview = await h.tool("video_project_export", { id: "project_1" });
  expect(preview.message).toContain("尚未交付完成");
  expect(h.calls.some((c) => c.path.endsWith("/exported"))).toBe(false);
  h.job().state = "approved"; h.job().scriptApproved = true; h.job().videoApproved = true;
  await h.tool("video_project_export", { id: "project_1" }, "main", thread);
  expect(h.calls.some((c) => c.path.endsWith("/exported"))).toBe(false);
  const exported = await h.tool("video_project_export", { id: "project_1" });
  expect(exported.exportReceipt.artifactHash).toBe(h.job().artifactHash);
  expect(exported.message).toContain("不代表文件已下载");
  expect(h.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
});

test("review display identifies current rejection, historical re-review, and actual export completion", () => {
  const job = fixture({ reviews: [{ stage: "script", revision: 2, hash: "a".repeat(64), reviewerBotId: "main", decision: "changes_requested", notes: "镜头需要调整" }] });
  expect(videoReviewPresentation(job)).toMatchObject({ status: "主 bot 已退回，等待制作 bot 返修", reviewer: "main", exported: false });
  job.reviewAttempt = 1;
  expect(videoReviewPresentation(job).status).toContain("等待主 bot 复核");
  job.state = "approved"; job.scriptApproved = true; job.videoApproved = true;
  expect(videoReviewPresentation(job).exported).toBe(false);
  job.exportReceipt = { revision: 2, artifactHash: "b".repeat(64), botId: "producer", artifactNames: ["landscape.mp4"], requestId: "export", at: 1 };
  expect(videoReviewPresentation(job).exported).toBe(true);
  const html = renderVideoReviewPage(job, "csrf", "nonce");
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain("$('approveScript').classList.toggle('hidden',delegated)");
  expect(script).toContain("$('publishSection').classList.toggle('hidden',delegated)");
});

test("outbox preserves version and delivery attempt, defers failed work durably and never acknowledges it", async () => {
  const event = { seq: 4, jobId: "project_1", ownerId: "alice", botId: "producer", threadId: "producer-thread", kind: "revision_requested", message: "返修",
    revision: 2, scriptHash: "a".repeat(64), artifactHash: null, reviewAttempt: 1, deliveryAttempt: 3, nextAttemptAt: 42, lastError: "prior" };
  const called: { path: string; body: any }[] = [];
  let observed: unknown;
  const service = createVideoProduction({ baseUrl: "http://worker.test", token: "test-video-token-no-production", notify: async (value) => { observed = value; throw new Error("no actual project progress"); },
    fetch: (async (raw, init) => {
      const url = new URL(String(raw)); called.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === "/v1/events") return Response.json({ events: [event] });
      if (url.pathname === "/v1/events/4/defer") return Response.json({ deliveryAttempt: 4 });
      return Response.json({ error: "unexpected" }, { status: 400 });
    }) as typeof fetch });
  await expect(service.pollEvents()).rejects.toThrow("no actual project progress");
  expect(observed).toEqual(event);
  expect(called.find((call) => call.path.endsWith("/defer"))?.body.error).toBe("no actual project progress");
  expect(called.some((call) => call.path.endsWith("/ack"))).toBe(false);
});

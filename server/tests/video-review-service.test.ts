import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { withConfirmTurn } from "../src/confirmations/context";
import { createVideoProduction } from "../src/video-production/service";
import { videoReviewThreadId } from "../src/video-production/reviewer";
import type { ReviewPacket } from "../src/video-production/inspection";
import type { VideoJob } from "../src/video-production/types";

const ORIGIN = "https://video.example", PREFIX = "/api/video-production", TOKEN = "video-review-test-token-with-no-production-access";
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34, 0xff, 0xd9]);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const reviewThread = videoReviewThreadId("alice", "video_1", "main");
function fixture(extra: Partial<VideoJob> = {}): VideoJob {
  return { id: "video_1", ownerId: "alice", botId: "producer", threadId: "producer_thread", title: "视频", state: "awaiting_script_approval", revision: 2,
    scriptHash: "a".repeat(64), artifactHash: null, createdAt: 0, updatedAt: 0, scriptApproved: false, videoApproved: false,
    script: { title: "稿件", summary: "摘要", tags: [], segments: [{ text: "核实后的旁白", visual: "source", sourceId: "source_1", start: 1, end: 4 }] },
    sources: [{ id: "source_1", title: "原始来源", url: "https://youtu.be/abcdefghijk", duration: 300,
      transcript: [{ start: 0, end: 150, text: "实际字幕".repeat(3000) }, { start: 150, end: 299, text: "最后一条完整字幕" }], scenes: Array.from({ length: 150 }, (_, i) => i * 2) }], artifacts: [],
    reviewPolicy: { mode: "delegate_export", reviewerBotId: "main", reviewerThreadId: reviewThread, allowPublish: false, authorizedBy: "alice", publishAllowed: false } as VideoJob["reviewPolicy"], ...extra };
}
function rendered() {
  const packet: ReviewPacket = { version: 1, revision: 2, scriptHash: "a".repeat(64), complete: true, limitations: ["采样帧不是逐帧观看"], errors: [],
    audio: { method: "local-asr", transcript: Array.from({ length: 100 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `实际声音 ${i}：` + "解说文字".repeat(20) })) },
    videos: ["landscape.mp4", "portrait.mp4"].map((name, i) => ({ name, sha256: digest(name), qc: { analysisComplete: true, duration: 200, silenceSeconds: 0 }, frames: [{ name: `review-frame-${i}.jpg`, at: 100, sha256: digest(frame) }] })) };
  const job = fixture({ state: "awaiting_video_approval", scriptApproved: true, artifactHash: "b".repeat(64),
    artifacts: [{ name: "review-evidence.json", kind: "review" }, { name: "package.zip", kind: "package" },
      ...packet.videos.map(({ name, sha256 }) => ({ name, sha256, kind: "video" })),
      ...packet.videos.flatMap((v) => v.frames.map(({ name, sha256 }) => ({ name, sha256, kind: "review_frame" })))] });
  return { packet, job };
}
function harness(initial = fixture(), packet?: ReviewPacket) {
  let job = structuredClone(initial), main: string | null = "main";
  if (packet) job.artifacts!.find((a) => a.name === "review-evidence.json")!.sha256 = digest(JSON.stringify(packet));
  const calls: { path: string; method: string; body: any }[] = [], resolvedOwners: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "bad token" }, { status: 401 });
    if (url.pathname.endsWith("/review-policy")) {
      job.reviewPolicy = { ...body, authorizedBy: body.ownerId, allowPublish: false, publishAllowed: false };
      return Response.json(job);
    }
    if (url.pathname.endsWith("/review-decision")) {
      // Deliberately permissive upstream: these tests measure what the service itself refuses.
      job = { ...job, state: body.decision === "approve" ? body.stage === "script" ? "render_queued" : "approved" : job.state };
      return Response.json(job);
    }
    if (url.pathname.includes("/assets/")) {
      if (url.pathname.endsWith("review-evidence.json")) return packet ? Response.json(packet) : Response.json({ error: "missing" }, { status: 404 });
      return new Response(frame, { headers: { "Content-Type": "image/jpeg" } });
    }
    return Response.json(job);
  }) as typeof fetch;
  const service = createVideoProduction({ baseUrl: "http://worker.test", token: TOKEN, fetch: fetcher, allowedOrigins: [ORIGIN],
    resolveMainBot: async (owner) => { resolvedOwners.push(owner); return main; } });
  const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
    const owner = c.req.header("x-test-user");
    if (!owner) return c.json({ error: "login required" }, 401);
    c.set("actor", { id: owner, email: `${owner}@example.test`, role: "user" });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(PREFIX, service.routes(auth));
  const request = (path: string, init: RequestInit = {}, owner = "alice") => app.request(ORIGIN + PREFIX + path, { ...init,
    headers: { "x-test-user": owner, ...Object.fromEntries(new Headers(init.headers)) } });
  const csrf = async () => (await (await request("/jobs/video_1/review-context")).json()).csrf as string;
  const mutate = (action: string, body: unknown, token: string, owner = "alice", origin = ORIGIN) => request(`/jobs/video_1/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Video-CSRF": token }, body: JSON.stringify(body),
  }, owner);
  async function tool(name: string, args: unknown, bot = "main", threadId = reviewThread, owner = "alice") {
    const selected = service.tools(owner, bot).find((t) => t.name === name)!;
    const value = String(await withConfirmTurn({ threadId, runId: "review-run", stopped: () => false }, () => selected.execute(args)));
    const raw = /<untrusted_data[^>]*>\n([\s\S]*)\n<\/untrusted_data>/.exec(value)?.[1] ?? value;
    return JSON.parse(raw);
  }
  return { service, app, calls, resolvedOwners, request, csrf, mutate, tool, current: () => job,
    setJob: (value: VideoJob) => { job = value; }, setMain: (value: string | null) => { main = value; } };
}
type Harness = ReturnType<typeof harness>;
const scriptDecision = (extra: Record<string, unknown> = {}) => ({ id: "video_1", stage: "script", revision: 2, hash: "a".repeat(64), decision: "approve", notes: "字幕时间和原文已核对",
  evidence: { checks: { facts: "原文与数字一致", narration: "叙述准确", storyboard: "切点吻合" }, sourceIds: ["source_1"] }, ...extra });
const videoDecision = () => ({ id: "video_1", stage: "video", revision: 2, hash: "b".repeat(64), decision: "approve", notes: "完整音轨识别与样本帧通过；保留抽样局限",
  evidence: { audioObservations: "全音轨识别完整", visualObservations: "双画幅采样帧清晰", subtitleObservations: "字幕与识别一致", checkedArtifacts: ["landscape.mp4", "portrait.mp4"] } });
async function consumeMaterial(h: Harness, kind: "transcript" | "scenes") {
  let next: { offset: number; textOffset: number } | null = { offset: 0, textOffset: 0 }, pages = 0;
  do {
    const page = await h.tool("video_project_material", { id: "video_1", sourceId: "source_1", kind, limit: 20, ...next });
    expect(page.error).toBeUndefined();
    next = page.next; pages++;
  } while (next && pages < 30);
  expect(next).toBeNull();
  return pages;
}
async function consumeEvidence(h: Harness, start = 0) {
  let offset: number | null = start, pages = 0;
  do {
    const page = await h.tool("video_project_review_evidence", { id: "video_1", offset });
    expect(page.error).toBeUndefined();
    offset = page.nextOffset; pages++;
  } while (offset !== null && pages < 30);
  expect(offset).toBeNull();
  return pages;
}
const decisionCalls = (h: Harness) => h.calls.filter((c) => c.path.endsWith("/review-decision"));

async function consumeDocumentSection(h: Harness, section: "overview" | "script" | "latest_review") {
  let offset: number | null = 0, contentHash: string | undefined, text = "";
  do {
    const page = await h.tool("video_project_document", { id: "video_1", section, offset, contentHash });
    expect(page.error).toBeUndefined();
    text += page.text; contentHash = page.contentHash; offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(text);
}

test("three current document sections authorize complete script reading without consuming historical reviews", async () => {
  const job = fixture({ brief: "要求".repeat(700), reviews: Array.from({ length: 12 }, (_, i) => ({ stage: "script", revision: 1,
    hash: "old", reviewerBotId: "main", decision: "changes_requested", notes: `旧意见${i}`.repeat(1000) })) });
  job.script!.segments[0]!.text = "当前文案".repeat(800);
  const h = harness(job);
  await consumeMaterial(h, "transcript"); await consumeMaterial(h, "scenes");
  await consumeDocumentSection(h, "overview"); await consumeDocumentSection(h, "latest_review");
  const first = await h.tool("video_project_document", { id: job.id, section: "script", offset: 0 });
  await h.tool("video_project_document", { id: job.id, section: "script", offset: first.total - 10, contentHash: first.contentHash });
  expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
  expect(await consumeDocumentSection(h, "script")).toMatchObject({ script: job.script });
  expect((await h.tool("video_project_review_decision", scriptDecision())).state).toBe("render_queued");
  expect(decisionCalls(h)).toHaveLength(1);
});

test("changed same-version notes invalidate section receipt and section reads preserve owner/reviewer scope", async () => {
  const job = fixture({ brief: "制作要求".repeat(800), reviews: [{ stage: "script", revision: 2, hash: "a".repeat(64), reviewerBotId: "main",
    decision: "changes_requested", notes: "当前意见".repeat(300) }] });
  const h = harness(job);
  for (const [bot, thread, owner] of [["other", reviewThread, "alice"], ["main", "wrong", "alice"], ["producer", "producer_thread", "bob"]])
    expect((await h.tool("video_project_document", { id: job.id, section: "script", offset: 0 }, bot, thread, owner)).executed).toBe(false);
  expect((await h.tool("video_project_document", { id: job.id, section: "script", offset: 0 }, "producer", "producer_thread")).error).toBeUndefined();
  await consumeMaterial(h, "transcript"); await consumeMaterial(h, "scenes");
  for (const section of ["overview", "script", "latest_review"] as const) await consumeDocumentSection(h, section);
  h.current().reviews![0]!.notes += "补充影响当前版本的审核依据";
  expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
  await consumeDocumentSection(h, "latest_review");
  expect((await h.tool("video_project_review_decision", scriptDecision())).state).toBe("render_queued");
});

describe("owner-authorized main bot review enrollment", () => {
  test("requires login, same origin, owner/project-bound CSRF and server-resolved main bot", async () => {
    const h = harness(fixture({ reviewPolicy: undefined }));
    expect((await h.app.request(ORIGIN + PREFIX + "/jobs/video_1/review-policy", { method: "POST" })).status).toBe(401);
    const token = await h.csrf();
    expect((await h.mutate("review-policy", { mode: "delegate_export" }, "")).status).toBe(403);
    expect((await h.mutate("review-policy", { mode: "delegate_export" }, token, "bob")).status).toBe(403);
    expect((await h.mutate("review-policy", { mode: "delegate_export" }, token, "alice", "https://other.example")).status).toBe(403);
    expect((await h.mutate("review-policy", { mode: "delegate_export", ownerId: "bob", reviewerBotId: "forged" }, token)).status).toBe(400);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await h.mutate("review-policy", { mode: "delegate_export" }, token)).status).toBe(200);
    expect(h.resolvedOwners).toEqual(["alice"]);
    expect(h.calls.at(-1)!.body).toEqual({ ownerId: "alice", mode: "delegate_export", reviewerBotId: "main", reviewerThreadId: reviewThread });
    expect(h.service.tools("alice", "producer").some((t) => t.name.includes("review_policy"))).toBe(false);
  });

  test("missing main bot and self-review cannot enroll; human revocation clears binding", async () => {
    const h = harness(), token = await h.csrf();
    for (const main of [null, "producer"]) {
      h.setMain(main);
      expect((await h.mutate("review-policy", { mode: "delegate_export" }, token)).status).toBe(409);
    }
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await h.mutate("review-policy", { mode: "human" }, token)).status).toBe(200);
    expect(h.calls.at(-1)!.body).toEqual({ ownerId: "alice", mode: "human", reviewerBotId: null, reviewerThreadId: null });
  });
});

describe("review identity and exact content", () => {
  test("producer, wrong reviewer, wrong thread, other owner and replaced main bot are blocked", async () => {
    const h = harness();
    for (const [bot, thread, owner] of [["producer", "producer_thread", "alice"], ["other", reviewThread, "alice"], ["main", "unrelated_thread", "alice"], ["main", reviewThread, "bob"]]) {
      const result = await h.tool("video_project_review_decision", scriptDecision({ decision: "changes_requested", evidence: {} }), bot, thread, owner);
      expect(result.executed).toBe(false);
    }
    h.setMain("new-main");
    expect((await h.tool("video_project_review_decision", scriptDecision({ decision: "changes_requested", evidence: {} }))).executed).toBe(false);
    expect(decisionCalls(h)).toHaveLength(0);
  });

  test("stale revision/hash and wrong current stage never reach worker mutation", async () => {
    for (const extra of [{ revision: 1 }, { hash: "c".repeat(64) }, { stage: "video", hash: "b".repeat(64) }]) {
      const h = harness();
      const result = await h.tool("video_project_review_decision", scriptDecision({ decision: "changes_requested", evidence: {}, ...extra }));
      expect(result.executed).toBe(false);
      expect(decisionCalls(h)).toHaveLength(0);
    }
  });

  test("script approval needs every transcript fragment and scene page in sequence", async () => {
    const h = harness();
    expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
    await h.tool("video_project_material", { id: "video_1", sourceId: "source_1", kind: "transcript", offset: 1 });
    await h.tool("video_project_material", { id: "video_1", sourceId: "source_1", kind: "scenes", offset: 149 });
    expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
    expect(await consumeMaterial(h, "transcript")).toBeGreaterThan(1);
    expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
    expect(await consumeMaterial(h, "scenes")).toBeGreaterThan(1);
    expect(decisionCalls(h)).toHaveLength(0);
    const approved = await h.tool("video_project_review_decision", scriptDecision());
    expect(approved.state).toBe("render_queued");
    expect(decisionCalls(h)).toHaveLength(1);
    expect(decisionCalls(h)[0]!.body).toMatchObject({ ownerId: "alice", reviewerBotId: "main", revision: 2, hash: "a".repeat(64) });
  });

  test("a new script version invalidates previously consumed material receipt", async () => {
    const h = harness();
    await consumeMaterial(h, "transcript"); await consumeMaterial(h, "scenes");
    h.setJob(fixture({ revision: 3, scriptHash: "c".repeat(64) }));
    expect((await h.tool("video_project_review_decision", scriptDecision({ revision: 3, hash: "c".repeat(64) }))).executed).toBe(false);
    expect(decisionCalls(h)).toHaveLength(0);
  });

  test("an oversized storyboard must be fully paged as a document before approval", async () => {
    const job = fixture();
    job.script!.segments = Array.from({ length: 40 }, (_, i) => ({ text: `第${i}段` + "旁白".repeat(40), visual: "source" as const,
      shots: Array.from({ length: 5 }, (_, shot) => ({ sourceId: "source_1", start: shot * 3, end: shot * 3 + 3 })) }));
    const h = harness(job), compact = await h.tool("video_project_get", { id: job.id });
    expect(compact.documentRequired).toBe(true);
    expect(compact.script).toBeUndefined();
    await consumeMaterial(h, "transcript"); await consumeMaterial(h, "scenes");
    expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
    // A tail page may be displayed, but cannot count as reading the full draft.
    await h.tool("video_project_document", { id: job.id, offset: 3000 });
    expect((await h.tool("video_project_review_decision", scriptDecision())).executed).toBe(false);
    let offset: number | null = 0, full = "", pages = 0;
    do {
      const page = await h.tool("video_project_document", { id: job.id, offset });
      expect(page.error).toBeUndefined();
      expect(JSON.stringify(page).length).toBeLessThan(8000);
      full += page.text; offset = page.nextOffset; pages++;
    } while (offset !== null && pages < 30);
    expect(offset).toBeNull();
    expect(JSON.parse(full).script).toEqual(job.script);
    expect((await h.tool("video_project_review_decision", scriptDecision())).state).toBe("render_queued");
  });
});

describe("actual final video evidence before approval", () => {
  test("packet, actual image delivery and complete ordered audio/QC pages are all required", async () => {
    const { job, packet } = rendered(), h = harness(job, packet);
    expect((await h.tool("video_project_review_decision", videoDecision())).executed).toBe(false);
    const prepared = await h.service.prepareReview({ job, stage: "video", reviewerBotId: "main", threadId: reviewThread });
    expect(prepared.complete).toBe(true);
    expect(prepared.content!.filter((c) => c.type === "image")).toHaveLength(2);
    expect((await h.tool("video_project_review_decision", videoDecision())).executed).toBe(false);
    await consumeEvidence(h, 3000);
    expect((await h.tool("video_project_review_decision", videoDecision())).executed).toBe(false);
    expect(await consumeEvidence(h)).toBeGreaterThan(1);
    expect((await h.tool("video_project_review_decision", videoDecision())).state).toBe("approved");
    expect(decisionCalls(h)).toHaveLength(1);
  });

  test("reading evidence text alone cannot substitute for delivery of actual images", async () => {
    const { job, packet } = rendered(), h = harness(job, packet);
    await consumeEvidence(h);
    expect((await h.tool("video_project_review_decision", videoDecision())).executed).toBe(false);
    expect(decisionCalls(h)).toHaveLength(0);
  });

  test("incomplete inspection produces attention rather than fake media approval", async () => {
    const { job, packet } = rendered();
    packet.complete = false; packet.errors = ["Cannot transcribe actual final audio"];
    const h = harness(job, packet), prepared = await h.service.prepareReview({ job, stage: "video", reviewerBotId: "main", threadId: reviewThread });
    expect(prepared.complete).toBe(false);
    expect(prepared.instruction).toContain("Cannot transcribe actual final audio");
    expect((await h.tool("video_project_review_decision", videoDecision())).executed).toBe(false);
    expect(decisionCalls(h)).toHaveLength(0);
  });

  test("rerendered artifacts invalidate image/audio receipt even without a script revision change", async () => {
    const { job, packet } = rendered(), h = harness(job, packet);
    await h.service.prepareReview({ job, stage: "video", reviewerBotId: "main", threadId: reviewThread });
    await consumeEvidence(h);
    h.setJob({ ...h.current(), artifactHash: "c".repeat(64) });
    expect((await h.tool("video_project_review_decision", { ...videoDecision(), hash: "c".repeat(64) })).executed).toBe(false);
    expect(decisionCalls(h)).toHaveLength(0);
  });

  test("delegated export provides compact download links and never submits publication", async () => {
    const { job, packet } = rendered();
    job.state = "approved"; job.videoApproved = true;
    const h = harness(job, packet), token = await h.csrf();
    const exported = await h.tool("video_project_export", { id: job.id }, "producer", "producer_thread");
    expect(exported.sources[0].transcript).toBeUndefined();
    expect(exported.sources[0].transcriptCount).toBe(2);
    expect(JSON.stringify(exported).length).toBeLessThan(10_000);
    expect(exported.artifacts.find((a: any) => a.name === "package.zip").downloadUrl).toContain("package.zip?download=1");
    const publication = { id: job.id, revision: job.revision, hash: job.artifactHash, platform: "bilibili" };
    expect((await h.tool("video_project_publish", publication, "producer", "producer_thread")).executed).toBe(false);
    const { id, ...body } = publication;
    expect((await h.mutate("publish", body, token)).status).toBe(403);
    expect(h.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
  });
});

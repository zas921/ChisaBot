import { describe, expect, test } from "bun:test";
import { createVideoReviewDispatcher, videoReviewInstruction, videoReviewRoute, reviewerThreadId } from "../src/video-production/reviewer";
import type { VideoReviewDispatcherOptions } from "../src/video-production/reviewer";
import type { VideoEvent, VideoJob } from "../src/video-production/types";

function fixture(overrides: Partial<VideoJob> = {}): VideoJob {
  return { id: "project1", ownerId: "alice", botId: "producer", threadId: "producer-thread", title: "罐体结构", state: "awaiting_script_approval", revision: 2,
    scriptHash: "a".repeat(64), artifactHash: "b".repeat(64), createdAt: 1, updatedAt: 2,
    reviewPolicy: { mode: "delegate_export", reviewerBotId: "main", reviewerThreadId: reviewerThreadId("alice", "project1", "main"), authorizedBy: "alice", publishAllowed: false }, ...overrides };
}
const event = (kind = "script_ready", overrides: Partial<VideoEvent> = {}): VideoEvent => ({ seq: 11, ownerId: "alice", jobId: "project1", botId: "producer", threadId: "producer-thread", kind, message: "项目有更新", ...overrides });

function harness(initial = fixture(), overrides: Partial<VideoReviewDispatcherOptions> = {}) {
  let job = initial;
  const turns: Parameters<VideoReviewDispatcherOptions["runTurn"]>[0][] = [];
  const notices: VideoEvent[] = [];
  const saveDecision = (stage: "script" | "video" = "script", decision = "approve") => {
    job = { ...job, reviews: [{ stage, revision: job.revision, hash: stage === "script" ? job.scriptHash : job.artifactHash, reviewerBotId: "main", decision }],
      state: decision === "approve" ? stage === "script" ? "render_queued" : "approved" : job.state };
  };
  const dispatch = createVideoReviewDispatcher({
    getJob: async () => job,
    resolveMainBot: async () => "main",
    notifyProducer: async (notice) => { notices.push(notice); },
    runTurn: async (input) => { turns.push(input); saveDecision(initial.state === "awaiting_video_approval" ? "video" : "script"); return { replyText: "已保存审核结论" }; },
    ...overrides,
  });
  return { dispatch, turns, notices, saveDecision, setJob: (next: VideoJob) => { job = next; } };
}

describe("delegated video review dispatcher", () => {
  test("routes approved policy to the owner's current main bot in a dedicated persistent chat", async () => {
    const h = harness();
    expect(await h.dispatch(event())).toEqual({ target: "reviewer" });
    expect(h.turns).toHaveLength(1);
    const turn = h.turns[0]!;
    expect(turn.ownerUserId).toBe("alice");
    expect(turn.agentId).toBe("main");
    expect(turn.threadId).toBe(reviewerThreadId("alice", "project1", "main"));
    expect(turn.threadId).not.toBe("producer-thread");
    expect(turn.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(turn.userMessage?.id).toBe("video-review-event-11");
    expect(h.notices).toHaveLength(0);
  });

  test("thread identity includes owner, job and reviewer, while retries reuse it", () => {
    const id = reviewerThreadId("alice", "project1", "main");
    expect(reviewerThreadId("alice", "project1", "main")).toBe(id);
    expect(reviewerThreadId("bob", "project1", "main")).not.toBe(id);
    expect(reviewerThreadId("alice", "project2", "main")).not.toBe(id);
    expect(reviewerThreadId("alice", "project1", "other-main")).not.toBe(id);
  });

  test("human review remains producer-only and stale ready events cannot restart rendering", async () => {
    const h = harness(fixture({ reviewPolicy: undefined }));
    expect(await h.dispatch(event())).toEqual({ target: "producer" });
    expect(h.turns).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
    expect(videoReviewRoute(event(), fixture({ state: "rendering" }))).toEqual({ target: "stale" });
    expect(videoReviewRoute(event(), fixture({ state: "awaiting_video_approval" }))).toEqual({ target: "stale" });
  });

  test("rejects cross-owner, cross-bot, cross-thread and self-review before running a model", async () => {
    const h = harness();
    for (const bad of [{ ownerId: "bob" }, { botId: "other" }, { threadId: "other" }, { jobId: "other" }])
      await expect(h.dispatch(event("script_ready", bad))).rejects.toThrow("不匹配");
    const own = harness(fixture({ reviewPolicy: { mode: "delegate_export", reviewerBotId: "producer", authorizedBy: "alice", publishAllowed: false } }));
    await expect(own.dispatch(event())).rejects.toThrow("审核授权无效");
    expect(h.turns).toHaveLength(0);
    expect(own.turns).toHaveLength(0);
  });

  test("a changed main bot cannot inherit another bot's approval authorization", async () => {
    const h = harness(fixture(), { resolveMainBot: async () => "replacement-main" });
    expect(await h.dispatch(event())).toEqual({ target: "attention" });
    expect(h.turns).toHaveLength(0);
    expect(h.notices[0]?.kind).toBe("needs_attention");
    expect(h.notices[0]?.message).toContain("重新确认审核授权");
  });

  test("network/model failures propagate, and retry keeps message identity with a fresh run ID", async () => {
    const turns: Parameters<VideoReviewDispatcherOptions["runTurn"]>[0][] = [];
    const h = harness(fixture(), { runTurn: async (input) => { turns.push(input); if (turns.length === 1) throw new Error("connection closed"); h.saveDecision(); return { replyText: "ok" }; } });
    await expect(h.dispatch(event())).rejects.toThrow("connection closed");
    await h.dispatch(event());
    expect(turns).toHaveLength(2);
    expect(turns[0]?.runId).not.toBe(turns[1]?.runId);
    expect(turns[0]?.userMessage?.id).toBe(turns[1]?.userMessage?.id);
  });

  test("concurrent deliveries of one event share one turn", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const h = harness(fixture(), { runTurn: async () => { runs++; await barrier; h.saveDecision(); return { replyText: "ok" }; } });
    const a = h.dispatch(event()), b = h.dispatch(event());
    await Promise.resolve(); await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  test("a text-only final answer never acknowledges a pending review, including repeated omissions", async () => {
    let runs = 0;
    const h = harness(fixture(), { runTurn: async () => { runs++; return { replyText: "已通过" }; } });
    await expect(h.dispatch(event())).rejects.toThrow("尚未提交审核结论");
    await expect(h.dispatch(event())).rejects.toThrow("尚未提交审核结论");
    await expect(h.dispatch(event())).rejects.toThrow("仍未批准");
    expect(runs).toBe(3);
    expect(h.notices[0]?.kind).toBe("review_evidence_blocked");
    expect(h.notices[0]?.message).toContain("仍未批准");
  });

  test("an already persisted changes request is idempotent across dispatcher restarts", async () => {
    const h = harness(fixture({ reviews: [{ stage: "script", revision: 2, hash: "a".repeat(64), reviewerBotId: "main", decision: "changes_requested" }] }));
    expect(await h.dispatch(event())).toEqual({ target: "reviewer" });
    expect(h.turns).toHaveLength(0);
  });

  test("incomplete actual media evidence holds the review without inventing an approval", async () => {
    const h = harness(fixture({ state: "awaiting_video_approval" }), {
      prepareReview: async () => ({ complete: false, instruction: "横版成片缺少实际音频识别结果。" }),
    });
    await expect(h.dispatch(event("video_ready"))).rejects.toThrow("实际审核材料不完整");
    expect(h.turns).toHaveLength(0);
    expect(h.notices[0]?.message).toContain("横版成片缺少实际音频识别结果");
    expect(h.notices[0]?.message).toContain("尚未批准");
  });

  test("actual attachment content retains mandatory reviewer instructions and exact version", async () => {
    const h = harness(fixture({ state: "awaiting_video_approval" }), {
      prepareReview: async () => ({ complete: true, instruction: "ASR 结果为实际测量；图像是采样帧。", content: [{ type: "text", text: "00:10: 焊缝画面" }] }),
    });
    await h.dispatch(event("video_ready"));
    const content = h.turns[0]?.userMessage?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(JSON.stringify(content)).toContain("video_project_review_decision");
    expect(JSON.stringify(content)).toContain("ASR 结果为实际测量");
    expect(JSON.stringify(content)).toContain("00:10: 焊缝画面");
    expect(h.turns[0]?.instruction).toContain('"revision":2');
    expect(h.turns[0]?.instruction).toContain("不得假装听过");
  });

  test("video approval resumes producer with export instruction; changes request resumes editing", async () => {
    const approved = harness(fixture({ state: "approved" }));
    await expect(approved.dispatch(event("review_approved"))).rejects.toThrow("尚未完成实际");
    expect(approved.notices[0]?.message).toContain("立即调用 video_project_export");
    expect(approved.notices[0]?.message).toContain("不得投稿");
    const changes = harness();
    await expect(changes.dispatch(event("revisions_requested"))).rejects.toThrow("尚未完成实际");
    expect(changes.notices[0]?.message).toContain("修改当前项目并重新保存");
    expect(changes.turns).toHaveLength(0);
  });

  test("source text is fetched in bounded pages and claims alone cannot pass media review", () => {
    expect(videoReviewInstruction(fixture(), "script")).toContain("直到 next 为 null");
    expect(videoReviewInstruction(fixture(), "video")).toContain("不得假装听过未播放的音频");
    expect(videoReviewInstruction(fixture(), "video")).toContain("全部成片的 evidence.checkedArtifacts");
  });

  test("durable automatic-edit cap stops both review and producer resave instruction", async () => {
    const h = harness(fixture({ reviewPaused: true }));
    expect(await h.dispatch(event())).toEqual({ target: "attention" });
    expect(h.turns).toHaveLength(0);
    await h.dispatch(event("review_needs_attention"));
    expect(h.notices.at(-1)?.message).toContain("不要自动再次保存");
    expect(h.notices.at(-1)?.message).not.toContain("修改当前项目并重新保存");
  });

  test("review conversation must be server-derived and owner/project bound", async () => {
    const job = fixture();
    const h = harness({ ...job, reviewPolicy: { ...(job.reviewPolicy as object), reviewerThreadId: "producer-thread" } });
    await expect(h.dispatch(event())).rejects.toThrow("审核授权无效");
    expect(h.turns).toHaveLength(0);
  });
});

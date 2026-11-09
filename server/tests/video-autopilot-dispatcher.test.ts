import { expect, test } from "bun:test";
import { createVideoReviewDispatcher, reviewerThreadId, videoReviewRoute } from "../src/video-production/reviewer";
import type { VideoEvent, VideoJob } from "../src/video-production/types";

const job = (): VideoJob => ({ id: "job", ownerId: "alice", botId: "maker", threadId: "maker-chat", title: "视频", state: "awaiting_script_approval", revision: 1,
  scriptHash: "script", artifactHash: "film", reviewAttempt: 0, createdAt: 1, updatedAt: 1,
  reviewPolicy: { mode: "delegate_export", reviewerBotId: "main", reviewerThreadId: reviewerThreadId("alice", "job", "main"), authorizedBy: "alice", allowPublish: false, publishAllowed: false },
});
const event = (kind: string, extra: Partial<VideoEvent> = {}): VideoEvent => ({ seq: 1, jobId: "job", ownerId: "alice", botId: "maker", threadId: "maker-chat", kind, message: "继续当前任务", ...extra });

test("same content rereview ignores an immutable rejection from an older attempt", async () => {
  let current = job(), runs = 0;
  current.reviews = [{ stage: "script", revision: 1, hash: "script", reviewAttempt: 0, reviewerBotId: "main", decision: "evidence_blocked", summary: "缺少画面" }];
  current.reviewAttempt = 1;
  const dispatch = createVideoReviewDispatcher({ getJob: async () => current, resolveMainBot: async () => "main", notifyProducer: async () => {}, runTurn: async (input) => {
    runs++;
    expect(input.instruction).toContain('"reviewAttempt":1');
    current = { ...current, state: "render_queued", reviews: [...current.reviews!, { stage: "script", revision: 1, hash: "script", reviewAttempt: 1, reviewerBotId: "main", decision: "approve" }] };
    return { replyText: "已核对实际画面并提交结论" };
  } });
  expect(await dispatch(event("review_requested"))).toEqual({ target: "reviewer" });
  expect(runs).toBe(1);
  expect(current.reviews).toHaveLength(2);
  expect(current.revision).toBe(1);
});

test("producer prose without a mutation remains pending after dispatcher restart", async () => {
  const current = job();
  let notices = 0;
  const options = { getJob: async () => current, resolveMainBot: async () => "main", notifyProducer: async () => { notices++; }, runTurn: async () => ({ replyText: "ok" }) };
  await expect(createVideoReviewDispatcher(options)(event("revisions_requested"))).rejects.toThrow("尚未完成实际");
  await expect(createVideoReviewDispatcher(options)(event("revisions_requested"))).rejects.toThrow("尚未完成实际");
  expect(notices).toBe(2);
  expect(current.revision).toBe(1);
});

test("a durable rereview request or new script revision satisfies producer progress", async () => {
  for (const kind of ["review_evidence_blocked", "revisions_requested"]) {
    let current = job();
    const dispatch = createVideoReviewDispatcher({ getJob: async () => structuredClone(current), resolveMainBot: async () => "main", runTurn: async () => ({ replyText: "unused" }), notifyProducer: async () => {
      current = kind === "review_evidence_blocked" ? { ...current, reviewAttempt: 1 } : { ...current, revision: 2, scriptHash: "revised" };
    } });
    expect(await dispatch(event(kind))).toEqual({ target: "producer" });
  }
});

test("approval is not export completion until exact current artifact links have a receipt", async () => {
  let current = { ...job(), state: "approved", scriptApproved: true, videoApproved: true };
  const make = (mutate: boolean) => createVideoReviewDispatcher({ getJob: async () => structuredClone(current), resolveMainBot: async () => "main", runTurn: async () => ({ replyText: "unused" }), notifyProducer: async () => {
    if (mutate) current.exportReceipt = { revision: 1, artifactHash: "film", botId: "maker", artifactNames: ["film.mp4"], requestId: "export", at: 1 };
  } });
  await expect(make(false)(event("review_approved"))).rejects.toThrow("取得导出链接");
  expect(await make(true)(event("review_approved"))).toEqual({ target: "producer" });
  expect(await make(false)(event("review_approved"))).toEqual({ target: "producer" });
});

test("stale version and review attempt events cannot start redundant actions", () => {
  const current = { ...job(), reviewAttempt: 2 };
  expect(videoReviewRoute(event("review_requested", { revision: 1, scriptHash: "script", reviewAttempt: 1 }), current)).toEqual({ target: "stale" });
  expect(videoReviewRoute(event("revisions_requested", { revision: 0 }), current)).toEqual({ target: "stale" });
  expect(videoReviewRoute(event("review_requested", { revision: 1, scriptHash: "script", reviewAttempt: 2 }), current)).toEqual({ target: "reviewer", stage: "script" });
});

test("persisted retry counts remain actionable after restart and missing decision never acknowledges", async () => {
  const current = job();
  let notices = 0;
  const dispatch = createVideoReviewDispatcher({ getJob: async () => current, resolveMainBot: async () => "main", runTurn: async () => ({ replyText: "我已审核" }), notifyProducer: async () => { notices++; } });
  await expect(dispatch(event("review_requested", { deliveryAttempt: 2 }))).rejects.toThrow("仍未批准");
  expect(notices).toBe(1);
  expect(current.reviews).toBeUndefined();
});

test("Stop or approval hold from producer is propagated without accepting a fluent completion", async () => {
  const current = job();
  const dispatch = createVideoReviewDispatcher({ getJob: async () => current, resolveMainBot: async () => "main", runTurn: async () => ({ replyText: "unused" }), notifyProducer: async () => { throw new Error("Explicit Stop remains paused"); } });
  await expect(dispatch(event("revisions_requested"))).rejects.toThrow("Explicit Stop");
  expect(current.revision).toBe(1);
});

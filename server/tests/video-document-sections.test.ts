import { expect, test } from "bun:test";
import type { VideoJob } from "../src/video-production/types";
import { compactVideoJob, documentSchema, readProjectDocument, type DocumentSection } from "../src/video-production/material";
import { markUntrusted } from "../src/untrusted-content";
import { budgetsForRun, foldToolResultsForModel } from "../src/agents/model-context";

const text = '实际依据\\"\n'.repeat(400);
function fixture(): VideoJob {
  return { id: "project", ownerId: "owner", botId: "producer", threadId: "chat", title: "test", state: "awaiting_script_approval",
    revision: 20, reviewAttempt: 0, scriptHash: "s20", createdAt: 0, updatedAt: 0,
    reviewPolicy: { mode: "delegate_export", reviewerBotId: "main", allowPublish: false },
    brief: text, script: { title: "current", summary: "current summary", tags: ["tag"], segments: [{ text, visual: "card" }] },
    reviews: Array.from({ length: 20 }, (_, i) => ({ stage: "script", revision: i + 1, hash: `s${i + 1}`, reviewerBotId: "main",
      decision: "changes_requested", notes: text, summary: text, evidence: { checks: { facts: text, storyboard: "时间点 8:30" } } })),
    artifacts: [{ name: "output.mp4", kind: "video" }, { name: "frame.jpg", kind: "review_frame" }] };
}
function read(job: VideoJob, section?: DocumentSection) {
  let offset = 0, contentHash: string | undefined, restored = "", pages = 0;
  do {
    const page = readProjectDocument(job, offset, section, contentHash);
    expect(page.text.length).toBeLessThanOrEqual(900);
    const content = markUntrusted(JSON.stringify(page), "video source material");
    expect(content.length).toBeLessThan(3000);
    expect(JSON.stringify(content).length).toBeLessThan(3000);
    const budget = { ...budgetsForRun({ goal: true }), freshToolChars: 3000 };
    expect(foldToolResultsForModel([{ id: "page", role: "tool", toolCallId: "read", content }], budget)[0]!.content).toBe(content);
    expect(contentHash ?? page.contentHash).toBe(page.contentHash);
    contentHash = page.contentHash; restored += page.text; pages++;
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
  } while (pages < 2000);
  return { value: JSON.parse(restored), chars: restored.length, pages };
}

test("legacy full preserves every original script/review/evidence, selected sections reconstruct complete current content at lower cost", () => {
  const job = fixture(), full = read(job), history = read(job, "reviews"), script = read(job, "script"), overview = read(job, "overview"), latest = read(job, "latest_review");
  expect(full.value.reviews).toEqual(job.reviews);
  expect(full.value.script).toEqual(job.script); expect(full.value.brief).toBe(job.brief);
  expect(history.value.reviews).toEqual(job.reviews); expect(script.value.script).toEqual(job.script);
  expect(overview.value.brief).toBe(job.brief); expect(overview.value.artifacts).toEqual([job.artifacts![0]]);
  expect(latest.value.latestReview.notes).toBe(text); expect(latest.value.latestReview.evidence).toEqual((job.reviews!.at(-1) as any).evidence);
  expect(latest.value.latestReview.summary).toBeUndefined(); expect(latest.value.sameContent).toBe(true);
  expect(latest.value.currentAttempt).toBe(true);
  expect(overview.chars + script.chars + latest.chars).toBeLessThan(full.chars / 10);
  expect(compactVideoJob(job).documentHint).toContain("latest_review");
});

test("section hash rejects cross-section, changed same-revision notes/policy/attempt and mismatched cursor versions", () => {
  const job = fixture(), first = readProjectDocument(job, 0, "latest_review");
  expect(first.nextOffset).not.toBeNull();
  expect(() => readProjectDocument(job, first.nextOffset!, "latest_review")).toThrow("contentHash");
  expect(() => readProjectDocument(job, 0, "script", first.contentHash)).toThrow("已变化");
  for (const mutate of [(j: VideoJob) => { j.reviews!.at(-1)!.notes += "补充"; }, (j: VideoJob) => { j.reviewAttempt = 1; },
    (j: VideoJob) => { j.revision++; }, (j: VideoJob) => { j.reviewPolicy!.reviewerBotId = "replacement"; }]) {
    const changed = structuredClone(job); mutate(changed);
    expect(() => readProjectDocument(changed, first.nextOffset!, "latest_review", first.contentHash)).toThrow("已变化");
  }
  expect(() => readProjectDocument(job, -1)).toThrow();
  expect(() => readProjectDocument(job, Number.MAX_SAFE_INTEGER)).toThrow();
});

test("previous-version feedback remains available but explicitly historical and distinct summaries are preserved", () => {
  const job = fixture(); job.revision = 21; job.scriptHash = "s21";
  job.reviews!.at(-1)!.reviewAttempt = 9; job.reviews!.at(-1)!.summary = "独立摘要";
  const latest = read(job, "latest_review").value;
  expect(latest.sameContent).toBe(false); expect(latest.currentAttempt).toBe(false);
  expect(latest.latestReview.revision).toBe(20); expect(latest.latestReview.summary).toBe("独立摘要");
  expect(latest.context).toContain("不是当前版本结论");
  job.reviewPolicy!.reviewerBotId = "replacement";
  expect(read(job, "latest_review").value.latestReview).toBeNull();
  expect(read(job, "reviews").value.reviews).toHaveLength(20);
});

test("video rejection remains actionable after returning to script revision, and retry heartbeats never invalidate required sections", () => {
  const job = fixture(); job.reviews = [{ stage: "video", revision: 19, hash: "old-video", reviewerBotId: "main",
    decision: "changes_requested", notes: "原声结尾切进下一问，请缩短并重译。", reviewAttempt: 4 }];
  const latest = read(job, "latest_review").value;
  expect(latest.latestReview.stage).toBe("video"); expect(latest.sameContent).toBe(false);
  job.reviews.push({ stage: "script", revision: 20, hash: "s20", reviewerBotId: "main", decision: "evidence_blocked", notes: "原片待补查" });
  expect(read(job, "latest_review").value.latestReview.notes).toBe("原片待补查");
  job.reviews.at(-1)!.decision = "approve";
  expect(read(job, "latest_review").value.previousFeedback.notes).toContain("原声结尾");
  for (const section of ["overview", "script", "latest_review"] as const) {
    const first = readProjectDocument(job, 0, section);
    job.autopilot = { status: "retrying", attempts: 20, nextAttemptAt: 999999, lastError: "错误".repeat(4000) }; job.updatedAt = 300;
    job.progress = { label: "heartbeat", percent: 10 };
    expect(readProjectDocument(job, first.nextOffset ?? 0, section, first.contentHash).contentHash).toBe(first.contentHash);
  }
  expect(JSON.stringify(compactVideoJob(job)).length).toBeLessThan(2400);
  expect(documentSchema.safeParse({ id: "project", offset: 0, section: null, contentHash: null }).success).toBe(true);
});

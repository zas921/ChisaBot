import { z } from "zod";
import { createHash } from "node:crypto";
import { idSchema } from "./schema";
import { VideoProductionError } from "./client";
import type { VideoJob, VideoSource } from "./types";

export const materialSchema = z.object({
  id: idSchema,
  sourceId: idSchema.nullish().describe("多来源项目必须指定来源编号；单来源可省略。"),
  kind: z.enum(["transcript", "scenes"]).nullish().describe("字幕 transcript 或镜头切点 scenes；默认字幕。"),
  offset: z.number().int().nonnegative().nullish().describe("记录偏移，首次 0；之后使用 next.offset。"),
  limit: z.number().int().min(1).max(80).nullish().describe("每页最多记录数，默认 30，最多 80。"),
  textOffset: z.number().int().nonnegative().nullish().describe("超长单条字幕的文字偏移；首次 0，之后使用 next.textOffset。"),
}).strict();

function sourceSummary(source: VideoSource) {
  return { id: source.id, title: source.title, url: source.url, duration: source.duration,
    thumbnail: source.thumbnail, transcriptCount: source.transcript?.length ?? 0, sceneCount: source.scenes?.length ?? 0 };
}

function workflowSummary(job: VideoJob, compact = false) {
  const latest = latestProjectReview(job);
  return { reviewAttempt: job.reviewAttempt ?? 0,
    autopilot: compact && job.autopilot ? { ...job.autopilot, lastError: job.autopilot.lastError?.slice(0, 160) } : job.autopilot, exportReceipt: job.exportReceipt,
    latestReview: latest ? { stage: latest.stage, reviewAttempt: latest.reviewAttempt ?? 0, decision: latest.decision,
      revision: latest.revision, sameContent: latest.revision === job.revision && latest.hash === (latest.stage === "script" ? job.scriptHash : job.artifactHash),
      reviewerBotId: latest.reviewerBotId, notes: (latest.notes ?? latest.summary ?? "").slice(0, 350), fullNotesInDocument: true } : null,
    reviewPolicyNotice: job.reviewPolicy?.mode === "delegate_export" ? "主 bot 审核、制作 bot 返修、通过后自动导出；覆盖旧 brief 的人工确认流程。未授权投稿。" : "由用户本人确认当前稿件和成片。" };
}

/** Keep the public job shape, but never bury state or the script under entire source transcripts. */
export function compactVideoJob<T extends VideoJob>(job: T) {
  const result = { ...job, ...workflowSummary(job, true), sources: (job.sources ?? []).map(sourceSummary),
    materialHint: "video_project_material 分页读取字幕/切点至 next=null；video_project_inspect 检查指定原片或成片区间的实际图像。" };
  if (JSON.stringify(result).length <= 2400) return result;
  return { documentRequired: true,
    documentHint: "video_project_document 优先分 section=overview（要求/状态/导出）、script（完整当前稿件）、latest_review（最新相关意见及证据）读取；各节从 offset=0 到 nextOffset=null，续页携带相同 section 和 contentHash。只在追溯时读取 reviews/full，勿每轮重读全部历史；写稿返修完成当前必要读取后直接保存。",
    id: job.id, title: job.title.slice(0, 160), state: job.state, revision: job.revision,
    scriptHash: job.scriptHash, artifactHash: job.artifactHash, scriptApproved: job.scriptApproved, videoApproved: job.videoApproved,
    reviewPolicy: job.reviewPolicy, reviewPaused: job.reviewPaused, reviewUrl: job.reviewUrl, settingsUrl: job.settingsUrl,
    ...workflowSummary(job, true),
    sources: (job.sources ?? []).map((s) => ({ id: s.id, duration: s.duration, transcriptCount: s.transcript?.length ?? 0, sceneCount: s.scenes?.length ?? 0 })),
    artifactCount: job.artifacts?.length ?? 0, scriptSegmentCount: job.script?.segments.length ?? 0, reviewCount: job.reviews?.length ?? 0,
    materialHint: result.materialHint };
}

export const documentSectionSchema = z.enum(["full", "overview", "script", "latest_review", "reviews"]);
export type DocumentSection = z.infer<typeof documentSectionSchema>;
export const documentSchema = z.object({ id: idSchema, offset: z.number().int().nonnegative(),
  section: documentSectionSchema.nullish().describe("优先分别读取 overview、script、latest_review；reviews 为全部历史，省略/null 兼容 full。"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullish().describe("首个请求可省略/null；续页沿用响应的 contentHash，保持同节同版本；非 full 的 offset>0 必须携带。"),
}).strict();

/** Previous-version feedback remains useful during revision; never mislabel it current authority. */
function latestProjectReview(job: VideoJob) {
  const stage = job.scriptApproved ? "video" : "script";
  const relevant = relevantProjectReviews(job);
  return relevant.filter((r) => r.stage === stage && r.revision === job.revision && r.hash === (stage === "script" ? job.scriptHash : job.artifactHash)).at(-1)
    ?? relevant.filter((r) => ["changes_requested", "evidence_blocked"].includes(r.decision)).at(-1)
    ?? relevant.filter((r) => r.stage === stage).at(-1);
}

function relevantProjectReviews(job: VideoJob) {
  return (job.reviews ?? []).filter((r) => r.revision <= job.revision
    && (r.revision < job.revision || (r.reviewAttempt ?? 0) <= (job.reviewAttempt ?? 0))
    && (job.reviewPolicy?.mode !== "delegate_export" || r.reviewerBotId === job.reviewPolicy.reviewerBotId));
}

function reviewWithoutDuplicateSummary(record: NonNullable<VideoJob["reviews"]>[number] | undefined) {
  if (!record) return null;
  const value = { ...record };
  if (value.notes && value.summary === value.notes) delete value.summary;
  return value;
}

function projectDocument(job: VideoJob, section: DocumentSection) {
  const assets = { artifacts: job.artifacts?.filter((item) => item.kind !== "review_frame"),
    inspectionFrameCount: job.artifacts?.filter((item) => item.kind === "review_frame").length ?? 0 };
  let data: unknown;
  if (section === "overview") data = { id: job.id, title: job.title, state: job.state, revision: job.revision,
    scriptHash: job.scriptHash, artifactHash: job.artifactHash, reviewPolicy: job.reviewPolicy, reviewPaused: job.reviewPaused,
    reviewAttempt: job.reviewAttempt ?? 0, brief: job.brief, error: job.error, exportReceipt: job.exportReceipt,
    scriptApproved: job.scriptApproved, videoApproved: job.videoApproved, ...assets };
  else if (section === "script") data = { script: job.script, scriptWarnings: job.scriptWarnings };
  else if (section === "reviews") data = { reviews: job.reviews ?? [] };
  else if (section === "latest_review") {
    const record = latestProjectReview(job);
    const latest = reviewWithoutDuplicateSummary(record);
    // Only carry a preceding video rejection across the return to script review. Earlier
    // same-stage decisions are history; including them here would recreate the read loop.
    const feedback = record?.stage === "script" ? relevantProjectReviews(job).filter((r) => r.stage === "video"
      && r.revision < job.revision && ["changes_requested", "evidence_blocked"].includes(r.decision)).at(-1) : undefined;
    const sameContent = !!latest && latest.revision === job.revision && latest.hash === (latest.stage === "script" ? job.scriptHash : job.artifactHash);
    data = { latestReview: latest, sameContent, currentAttempt: sameContent && (latest?.reviewAttempt ?? 0) === (job.reviewAttempt ?? 0),
      ...(feedback && feedback !== record ? { previousFeedback: reviewWithoutDuplicateSummary(feedback), previousFeedbackNotice: "该意见仅用于核对返修是否解决，不能代替当前版本审核。" } : {}),
      context: latest ? sameContent ? "本内容的审核意见；currentAttempt=false 表示上轮意见，需复核。" : "上一版本的修改意见，仅作返修复核参考，不是当前版本结论。" : "当前阶段无指定审核者的历史结论。" };
  } else data = { reviewPolicy: job.reviewPolicy, ...workflowSummary(job), brief: job.brief, script: job.script, reviews: job.reviews, scriptWarnings: job.scriptWarnings, error: job.error, ...assets };
  const text = JSON.stringify(data);
  const contentHash = createHash("sha256").update(JSON.stringify([job.id, job.revision, job.scriptHash, job.artifactHash,
    job.reviewAttempt ?? 0, job.reviewPolicy, section, text])).digest("hex");
  return { text, contentHash };
}

export function projectDocumentHash(job: VideoJob, section: DocumentSection) {
  return projectDocument(job, section).contentHash;
}

export function readProjectDocument(job: VideoJob, offset: number, section: DocumentSection = "full", expectedHash?: string) {
  const { text, contentHash } = projectDocument(job, section);
  if (expectedHash && expectedHash !== contentHash) throw new VideoProductionError("文档内容或审核版本已变化，请保留已读内容并从该 section 的 offset=0 重新读取。", 409);
  if (section !== "full" && offset > 0 && !expectedHash) throw new VideoProductionError("分节续页必须携带首个响应的 contentHash，避免拼接不同版本。", 400);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new VideoProductionError("文档分页偏移超出范围。", 400);
  const make = (length: number) => ({ id: job.id, revision: job.revision, section, contentHash, text: text.slice(offset, offset + length), offset, total: text.length,
    nextOffset: offset + length < text.length ? offset + length : null });
  let length = Math.min(900, text.length - offset);
  // The tool string is itself JSON-encoded by AG-UI; leave room for that and the untrusted envelope.
  while (length > 1 && JSON.stringify(JSON.stringify(make(length))).length > 2400) length = Math.floor(length * 0.8);
  return make(length);
}

// Even emergency compaction retains only 3000 fresh chars, including the untrusted envelope.
const PAGE_CHARS = 2400;
type TranscriptEntry = { index: number; start: number; end: number; text: string; textOffset?: number; textComplete?: boolean };
type SceneEntry = { index: number; at: number };
type Cursor = { offset: number; textOffset: number };

/** Character-bounded pages keep fresh tool compression from dropping the tail or cutting JSON. */
export function readMaterialPage(job: VideoJob, raw: z.input<typeof materialSchema>) {
  const input = materialSchema.parse(raw);
  if (input.id !== job.id) throw new VideoProductionError("素材项目不匹配，请重新读取项目。", 400);
  const sources = job.sources ?? [];
  const source = input.sourceId ? sources.find((row) => row.id === input.sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (!source) {
    if (input.sourceId) throw new VideoProductionError("素材来源不存在，请使用项目来源列表中的 sourceId。", 400);
    return { id: job.id, revision: job.revision, sources: sources.map(sourceSummary),
      message: "请选择 sourceId，再分别分页读取 transcript 和 scenes。", next: null };
  }
  const kind = input.kind ?? "transcript";
  const rows = kind === "transcript" ? source.transcript ?? [] : source.scenes ?? [];
  const offset = input.offset ?? 0, textOffset = input.textOffset ?? 0, limit = input.limit ?? 30;
  if (offset > rows.length) throw new VideoProductionError("分页偏移超出素材范围，请从 0 读取。", 400);
  if (textOffset && (kind !== "transcript" || offset >= rows.length || textOffset >= (source.transcript![offset]?.text.length ?? 0)))
    throw new VideoProductionError("字幕文字偏移无效，请使用上一页返回的 next。", 400);
  const entries: (TranscriptEntry | SceneEntry)[] = [];
  const base = { id: job.id, revision: job.revision, sourceId: source.id, kind, duration: source.duration, total: rows.length, offset, textOffset };
  let next: Cursor | null = null;
  for (let index = offset; index < rows.length && entries.length < limit; index++) {
    if (kind === "scenes") {
      const entry = { index, at: source.scenes![index]! };
      const cursor = index + 1 < rows.length ? { offset: index + 1, textOffset: 0 } : null;
      if (JSON.stringify({ ...base, entries: [...entries, entry], next: cursor }).length > PAGE_CHARS && entries.length) { next = { offset: index, textOffset: 0 }; break; }
      entries.push(entry); next = cursor;
    } else {
      const row = source.transcript![index]!;
      const startAt = index === offset ? textOffset : 0;
      const remaining = row.text.slice(startAt);
      let take = remaining.length;
      const make = () => ({ index, start: row.start, end: row.end, text: remaining.slice(0, take), textOffset: startAt, textComplete: take === remaining.length });
      const cursor = () => take < remaining.length ? { offset: index, textOffset: startAt + take }
        : index + 1 < rows.length ? { offset: index + 1, textOffset: 0 } : null;
      if (JSON.stringify({ ...base, entries: [...entries, make()], next: cursor() }).length > PAGE_CHARS) {
        if (entries.length) { next = { offset: index, textOffset: startAt }; break; }
        // A single subtitle can exceed a page. Return text slices with explicit cursor,
        // retaining the exact original row identity/timestamps for lossless reconstruction.
        let low = 0, high = remaining.length;
        while (low < high) {
          take = Math.ceil((low + high) / 2);
          if (JSON.stringify({ ...base, entries: [make()], next: cursor() }).length <= PAGE_CHARS) low = take;
          else high = take - 1;
        }
        take = low;
        if (!take) throw new VideoProductionError("素材单条记录过大，无法分页读取。", 400);
      }
      entries.push(make()); next = cursor();
      if (take < remaining.length) break;
    }
  }
  return { ...base, entries, next };
}

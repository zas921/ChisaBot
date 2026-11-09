import { z } from "zod";
import type { VideoSegment } from "./types";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const assetSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/).refine((value) => !value.includes(".."));
const sourceUrl = z.url().max(2048).refine((raw) => {
  const u = new URL(raw);
  return u.protocol === "https:" && !u.username && !u.password && !u.port && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(u.hostname);
}, "第一版仅支持 HTTPS YouTube 视频链接。");
export const createSchema = z.object({
  title: z.string().trim().min(1).max(80),
  urls: z.array(sourceUrl).min(1).max(3),
  brief: z.string().trim().min(1).max(6000),
  targetDurationSeconds: z.number().int().min(60).max(480).default(180),
  voice: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default("zh-CN-XiaoxiaoNeural"),
  aspectRatios: z.array(z.enum(["16:9", "9:16"])).min(1).max(2).default(["16:9", "9:16"]),
}).strict();
const shotSchema = z.object({
  sourceId: idSchema,
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
}).strict().refine((shot) => shot.end - shot.start >= 0.5 && shot.end - shot.start <= 30, "每个镜头长度需在 0.5～30 秒之间。");
// Every variant describes only its applicable values. Strict model providers may require
// optional properties, so inactive fields explicitly accept null instead of invented values.
const commonSegment = {
  text: z.string().trim().min(1).max(1200),
  caption: z.string().max(500).nullish(),
};
const inactiveRange = { sourceId: z.null().optional(), start: z.null().optional(), end: z.null().optional() };
const inactiveCard = { layout: z.null().optional(), items: z.null().optional() };
const rangeFields = { sourceId: idSchema, start: z.number().finite().nonnegative(), end: z.number().finite().positive() };
const sourceShots = z.object({
  ...commonSegment, ...inactiveRange, ...inactiveCard,
  visual: z.literal("source"), shots: z.array(shotSchema).min(1).max(8),
}).strict();
const sourceRange = z.object({
  ...commonSegment, ...rangeFields, ...inactiveCard,
  visual: z.literal("source"), shots: z.null().optional(),
}).strict().refine((value) => value.end > value.start, "素材镜头需要有效的来源、开始和结束时间。");
const quote = z.object({
  ...commonSegment, ...rangeFields, ...inactiveCard,
  visual: z.literal("quote"), shots: z.null().optional(),
}).strict().refine((value) => value.end - value.start >= 1.5 && value.end - value.start <= 20, "原声片段长度需在 1.5～20 秒之间。");
const card = z.object({
  ...commonSegment, ...inactiveRange,
  visual: z.literal("card"), shots: z.null().optional(),
  layout: z.enum(["heading", "stat", "list", "compare"]).nullish(),
  items: z.array(z.string().trim().min(1).max(40)).max(6).nullish(),
}).strict().superRefine((value, ctx) => {
  const items = value.items ?? [];
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.layout === "stat" && items.length < 1) issue("数字卡需要至少一条要点（第一条为醒目数字）。");
  if (value.layout === "list" && items.length < 2) issue("列表卡至少需要 2 条要点。");
  if (value.layout === "compare" && items.length !== 2 && items.length !== 4) issue("对比卡需要 2 条或 4 条要点。");
});
export const segmentSchema = z.union([sourceShots, sourceRange, quote, card]);

/** Normalize only the null placeholders accepted by the schema before the strict worker API. */
export function normalizeScript<T extends { segments: readonly object[] }>(script: T): Omit<T, "segments"> & { segments: VideoSegment[] } {
  return { ...script, segments: script.segments.map((segment) =>
    Object.fromEntries(Object.entries(segment).filter(([, value]) => value !== null && value !== undefined))) as VideoSegment[] };
}
export const scriptSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(80),
  summary: z.string().max(1500),
  tags: z.array(z.string().trim().min(1).max(30).refine((tag) => !tag.includes(","), "单个标签不能包含英文逗号。"))
    .max(10).refine((tags) => tags.join(",").length <= 200, "标签总长度（含分隔符）不能超过 200 字符。"),
  segments: z.array(segmentSchema).min(1).max(40)
    .refine((segments) => segments.reduce((sum, segment) => sum + segment.text.length, 0) <= 4500, "解说稿最多 4500 字符。")
    .refine((segments) => segments.reduce((sum, segment) => sum + (segment.visual === "quote" ? (segment.end ?? 0) - (segment.start ?? 0) : 0), 0) <= 120, "原声片段合计不能超过 120 秒。"),
}).strict();
export const approvalSchema = z.object({ revision: z.number().int().nonnegative(), hash: z.string().min(16).max(128) }).strict();
export const publishSchema = approvalSchema.extend({ platform: z.enum(["bilibili", "douyin"]) });

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContentPart } from "@ag-ui/client";
import { assetSchema } from "./schema";
import type { VideoJob } from "./types";
import { VideoProductionError } from "./client";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const packetSchema = z.object({
  version: z.literal(1), revision: z.number().int(), scriptHash: digest,
  complete: z.boolean(), limitations: z.array(z.string()), errors: z.array(z.string()),
  audio: z.object({ method: z.literal("local-asr"), transcript: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().trim().min(1) }).refine((row) => row.end > row.start)) }),
  videos: z.array(z.object({ name: assetSchema, sha256: digest, qc: z.record(z.string(), z.unknown()),
    frames: z.array(z.object({ name: assetSchema, at: z.number(), sha256: digest.optional() })).min(1) })).min(1),
});
export type ReviewPacket = z.infer<typeof packetSchema>;
type AssetReader = (job: VideoJob, name: string) => Promise<Response>;

async function boundedBytes(response: Response, max: number) {
  if (!response.body) throw new VideoProductionError("审核材料为空。", 409);
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      size += row.value.length;
      if (size > max) throw new VideoProductionError("审核材料超过单项读取限制。", 409);
      parts.push(row.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}
export async function loadReviewPacket(job: VideoJob, read: AssetReader) {
  if (!(job.artifacts ?? []).some((a) => a.name === "review-evidence.json"))
    throw new VideoProductionError("此成片尚无实际配音和画面检查材料，请重新制作以生成审核材料。", 409);
  const raw = await boundedBytes(await read(job, "review-evidence.json"), 2_000_000);
  const evidenceHash = job.artifacts?.find((a) => a.name === "review-evidence.json")?.sha256;
  if (!evidenceHash || createHash("sha256").update(raw).digest("hex") !== evidenceHash)
    throw new VideoProductionError("成片检测材料与保存的内容摘要不一致。", 409);
  let decoded: unknown;
  try { decoded = JSON.parse(raw.toString("utf8")); }
  catch { throw new VideoProductionError("成片检测材料格式损坏。", 409); }
  const parsed = packetSchema.safeParse(decoded);
  if (!parsed.success) throw new VideoProductionError("成片审核材料不完整，不能自动通过。", 409);
  const packet = parsed.data;
  if (packet.revision !== job.revision || packet.scriptHash !== job.scriptHash)
    throw new VideoProductionError("审核材料属于旧版本，请核对当前成片。", 409);
  if (!packet.complete || packet.errors.length || !packet.audio.transcript.length)
    throw new VideoProductionError("实际配音或画面检查未完成：" + packet.errors.join("；").slice(0, 500), 409);
  if (packet.videos.some((v) => v.qc.analysisComplete !== true))
    throw new VideoProductionError("各画幅的画面和音频检测尚未全部完成。", 409);
  const videos = (job.artifacts ?? []).filter((a) => a.kind === "video");
  if (!videos.length || videos.length !== packet.videos.length || videos.some((a) =>
    !packet.videos.some((v) => v.name === a.name && v.sha256 === a.sha256)))
    throw new VideoProductionError("审核材料与当前所有画幅的成片不一致。", 409);
  const names = new Set((job.artifacts ?? []).map((a) => a.name));
  if (packet.videos.some((v) => v.frames.some((f) => !names.has(f.name))) || packet.videos.reduce((n, v) => n + v.frames.length, 0) > 80)
    throw new VideoProductionError("画面抽检材料缺失或超限，不能自动通过。", 409);
  return packet;
}

export async function reviewImages(job: VideoJob, packet: ReviewPacket, read: AssetReader) {
  const content: ContentPart[] = [];
  let total = 0;
  for (const video of packet.videos) for (const frame of video.frames) {
    const response = await read(job, frame.name);
    if (!response.headers.get("content-type")?.startsWith("image/jpeg"))
      throw new VideoProductionError("抽检帧不是有效 JPEG 图像。", 409);
    const bytes = await boundedBytes(response, 2_000_000);
    total += bytes.length;
    if (total > 20_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
      throw new VideoProductionError("抽检图像无效或总量超限。", 409);
    const expected = job.artifacts?.find((a) => a.name === frame.name)?.sha256;
    if (!expected || (frame.sha256 && frame.sha256 !== expected) || createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new VideoProductionError("抽检图像内容已变化。", 409);
    content.push({ type: "text", text: `${video.name} 成片 ${frame.at} 秒的实际抽检帧：` },
      { type: "image", source: { type: "data", mimeType: "image/jpeg", value: bytes.toString("base64") } });
  }
  return content;
}

/** Text slices are lossless, explicit, bounded and safe to reconstruct across tool results. */
export function packetPage(packet: ReviewPacket, offset: number) {
  const value = JSON.stringify({ audio: packet.audio, videos: packet.videos.map(({ frames, ...v }) => ({ ...v, frames: frames.map(({ name, at }) => ({ name, at })) })), limitations: packet.limitations });
  if (offset < 0 || offset > value.length) throw new VideoProductionError("审核材料分页偏移无效。", 400);
  // JSON escaping can at most double this slice (already serialized JSON).
  const text = value.slice(offset, offset + 900);
  return { text, offset, total: value.length, nextOffset: offset + text.length < value.length ? offset + text.length : null };
}

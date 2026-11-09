import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadReviewPacket, packetPage, reviewImages, type ReviewPacket } from "../src/video-production/inspection";
import { VideoProductionError } from "../src/video-production/client";
import { UserMessageSchema } from "@ag-ui/core/schemas";
import type { VideoJob } from "../src/video-production/types";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34, 0xff, 0xd9]);
function fixture() {
  const videos = ["landscape.mp4", "portrait.mp4"].map((name, index) => ({
    name, sha256: hash(name), qc: { analysisComplete: true, duration: 12, blackSeconds: 0, silenceSeconds: 0 },
    frames: [{ name: `review-frame-${index}.jpg`, at: 6, sha256: hash(jpeg) }],
  }));
  const packet: ReviewPacket = { version: 1, revision: 2, scriptHash: "a".repeat(64), complete: true,
    limitations: ["每段抽样画面，并非逐帧检查"], errors: [],
    audio: { method: "local-asr", transcript: [{ start: 0, end: 12, text: "完整成片的实际音轨识别" }] }, videos };
  const job: VideoJob = { id: "video_1", ownerId: "alice", botId: "producer", threadId: "producer_thread", title: "video", state: "awaiting_video_approval", revision: 2,
    scriptHash: packet.scriptHash, artifactHash: "b".repeat(64), createdAt: 0, updatedAt: 0,
    artifacts: [{ name: "review-evidence.json", kind: "review" }, ...videos.map(({ name, sha256 }) => ({ name, sha256, kind: "video" })),
      ...videos.flatMap((v) => v.frames.map(({ name, sha256 }) => ({ name, sha256, kind: "review_frame" })))] };
  const read = async (_job: VideoJob, name: string) => {
    if (name !== "review-evidence.json") return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    // Re-seal altered packets so negative semantic tests reach the relevant validator.
    const artifact = job.artifacts!.find((a) => a.name === name);
    if (artifact) artifact.sha256 = hash(JSON.stringify(packet));
    return Response.json(packet);
  };
  return { job, packet, read };
}

describe("actual video inspection binding", () => {
  test("accepts exact current artifacts and emits verified images with time labels", async () => {
    const { job, packet, read } = fixture();
    expect(await loadReviewPacket(job, read)).toEqual(packet);
    const images = await reviewImages(job, packet, read);
    expect(images).toHaveLength(4);
    expect(images[0]).toEqual({ type: "text", text: "landscape.mp4 成片 6 秒的实际抽检帧：" });
    expect(images[1]).toEqual({ type: "image", source: { type: "data", mimeType: "image/jpeg", value: jpeg.toString("base64") } });
    expect(images[2]).toMatchObject({ type: "text", text: "portrait.mp4 成片 6 秒的实际抽检帧：" });
    expect(UserMessageSchema.safeParse({ id: "actual-frames", role: "user", content: images }).success).toBe(true);
  });

  test("missing, incomplete, errored or empty actual audio evidence cannot pass", async () => {
    const absent = fixture();
    absent.job.artifacts = absent.job.artifacts!.filter((a) => a.name !== "review-evidence.json");
    await expect(loadReviewPacket(absent.job, absent.read)).rejects.toBeInstanceOf(VideoProductionError);
    for (const alter of [(p: ReviewPacket) => { p.complete = false; }, (p: ReviewPacket) => { p.errors = ["ASR unavailable"]; },
      (p: ReviewPacket) => { p.audio.transcript = []; }, (p: ReviewPacket) => { p.videos[0]!.frames = []; }]) {
      const { job, packet, read } = fixture();
      alter(packet);
      await expect(loadReviewPacket(job, read)).rejects.toBeInstanceOf(VideoProductionError);
    }
  });

  test("old revision, script hash or either aspect-ratio hash cannot pass", async () => {
    for (const alter of [(p: ReviewPacket) => { p.revision--; }, (p: ReviewPacket) => { p.scriptHash = "f".repeat(64); },
      (p: ReviewPacket) => { p.videos[1]!.sha256 = "f".repeat(64); }, (p: ReviewPacket) => { p.videos.pop(); },
      (p: ReviewPacket) => { p.videos[1] = structuredClone(p.videos[0]!); }]) {
      const { job, packet, read } = fixture();
      alter(packet);
      await expect(loadReviewPacket(job, read)).rejects.toBeInstanceOf(VideoProductionError);
    }
  });

  test("every sample must name an available artifact and frame count remains bounded", async () => {
    const missing = fixture();
    missing.packet.videos[0]!.frames[0]!.name = "missing-frame.jpg";
    await expect(loadReviewPacket(missing.job, missing.read)).rejects.toBeInstanceOf(VideoProductionError);
    const many = fixture();
    many.packet.videos[0]!.frames = Array.from({ length: 80 }, () => ({ ...many.packet.videos[0]!.frames[0]! }));
    await expect(loadReviewPacket(many.job, many.read)).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("corrupted metadata and oversized packets produce actionable review failure", async () => {
    const { job } = fixture();
    job.artifacts!.find((a) => a.name === "review-evidence.json")!.sha256 = hash("{truncated");
    await expect(loadReviewPacket(job, async () => new Response("{truncated"))).rejects.toBeInstanceOf(VideoProductionError);
    await expect(loadReviewPacket(job, async () => new Response("x".repeat(2_000_001)))).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("missing or changed packet content digest cannot be accepted", async () => {
    const { job, packet } = fixture();
    await expect(loadReviewPacket(job, async () => Response.json(packet))).rejects.toBeInstanceOf(VideoProductionError);
    job.artifacts!.find((a) => a.name === "review-evidence.json")!.sha256 = "f".repeat(64);
    await expect(loadReviewPacket(job, async () => Response.json(packet))).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("blank or invalid actual audio time ranges cannot become completed evidence", async () => {
    for (const entry of [{ start: 0, end: 3, text: " " }, { start: 6, end: 3, text: "invalid range" }, { start: -2, end: 3, text: "invalid range" }]) {
      const { job, packet, read } = fixture();
      packet.audio.transcript = [entry];
      await expect(loadReviewPacket(job, read)).rejects.toBeInstanceOf(VideoProductionError);
    }
  });

  test("image MIME, JPEG bytes, content digest and per-image size are checked", async () => {
    const { job, packet } = fixture();
    const badReaders = [
      async () => new Response(jpeg, { headers: { "Content-Type": "text/plain" } }),
      async () => new Response("not an image", { headers: { "Content-Type": "image/jpeg" } }),
      async () => new Response(Buffer.from([0xff, 0xd8, 0x03]), { headers: { "Content-Type": "image/jpeg" } }),
      async () => new Response(new Uint8Array(2_000_001), { headers: { "Content-Type": "image/jpeg" } }),
    ];
    for (const read of badReaders) await expect(reviewImages(job, packet, read)).rejects.toBeInstanceOf(VideoProductionError);
    const missing = fixture();
    delete missing.packet.videos[0]!.frames[0]!.sha256;
    delete missing.job.artifacts!.find((a) => a.name === "review-frame-0.jpg")!.sha256;
    await expect(reviewImages(missing.job, missing.packet, missing.read)).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("packet frame digest cannot override a conflicting current artifact digest", async () => {
    const { job, packet, read } = fixture();
    job.artifacts!.find((a) => a.name === "review-frame-0.jpg")!.sha256 = "f".repeat(64);
    await expect(reviewImages(job, packet, read)).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("total image bytes remain bounded across individually valid frames", async () => {
    const { job, packet } = fixture(), large = Buffer.alloc(1_900_000, 0);
    large[0] = 0xff; large[1] = 0xd8;
    const sha256 = hash(large);
    packet.videos = [{ ...packet.videos[0]!, frames: Array.from({ length: 11 }, (_, i) => ({ name: `review-large-${i}.jpg`, at: i, sha256 })) }];
    job.artifacts = packet.videos[0]!.frames.map(({ name }) => ({ name, kind: "review_frame", sha256 }));
    await expect(reviewImages(job, packet, async () => new Response(large, { headers: { "Content-Type": "image/jpeg" } }))).rejects.toBeInstanceOf(VideoProductionError);
  });

  test("full audio and limitations survive bounded lossless paging", () => {
    const { packet } = fixture();
    packet.audio.transcript = Array.from({ length: 100 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: `第${i}句\n\"引号\"\\路径` + "内容".repeat(60) }));
    let offset = 0, full = "", pages = 0;
    while (true) {
      const page = packetPage(packet, offset);
      expect(page.offset).toBe(offset);
      expect(JSON.stringify(page).length).toBeLessThan(8000);
      full += page.text; pages++;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(3);
    expect(JSON.parse(full).audio).toEqual(packet.audio);
    expect(JSON.parse(full).limitations).toEqual(packet.limitations);
    expect(JSON.parse(full).videos).toHaveLength(2);
    expect(() => packetPage(packet, -1)).toThrow(VideoProductionError);
    expect(() => packetPage(packet, full.length + 1)).toThrow(VideoProductionError);
  });
});

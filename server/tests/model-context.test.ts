import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { estimateTokens } from "../src/context-usage";
import {
  compactHistoryForModel,
  dropOlderTurnsForModel,
  foldToolResultsForModel,
  shouldContinueToolSegments,
  stripHeavyBlobs,
  budgetsForRun,
  MAX_CONTINUATION_SEGMENTS,
  shrinkOlderTurnsForModel,
} from "../src/agents/model-context";
import { reviewImages, type ReviewPacket } from "../src/video-production/inspection";
import type { VideoJob } from "../src/video-production/types";

function history(rows: unknown[]): Message[] {
  return rows as Message[];
}

function call(id: string, name = "device_run_shell", args = "{}") {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function longThread(turns: number): Message[] {
  const rows: unknown[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    rows.push({
      id: `u${turn}`,
      role: "user",
      content: `please continue step ${turn} ` + "任".repeat(200),
    });
    rows.push({
      id: `a${turn}`,
      role: "assistant",
      content: "working",
      toolCalls: [call(`c${turn}`)],
    });
    rows.push({
      id: `t${turn}`,
      role: "tool",
      toolCallId: `c${turn}`,
      content: JSON.stringify({
        base64: "B".repeat(20_000),
        width: 100,
        height: 100,
        log: "y".repeat(8_000),
      }),
    });
    rows.push({
      id: `a2-${turn}`,
      role: "assistant",
      content: "done " + "结".repeat(400),
    });
  }
  return history(rows);
}

function evidenceReads(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => [
    { id: `evidence-call-${i}`, role: "assistant", content: "", toolCalls: [call(`evidence-${i}`, "video_project_review_evidence")] },
    { id: `evidence-result-${i}`, role: "tool", toolCallId: `evidence-${i}`, content: `page ${i}: ` + "measured narration and shot evidence; ".repeat(500) },
  ]).flat() as Message[];
}

async function reviewImageMessage(): Promise<Message> {
  // Large opaque media bytes exercise the former long-base64 stripping path. The actual
  // production frame loader verifies the source digest and constructs the AG-UI image part.
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16_000, 0x55), Buffer.from([0xff, 0xd9])]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const packet: ReviewPacket = { version: 1, revision: 1, scriptHash: "a".repeat(64), complete: true, errors: [], limitations: ["sampled frame"],
    audio: { method: "local-asr", transcript: [{ start: 0, end: 2, text: "实测音轨" }] },
    videos: [{ name: "landscape.mp4", sha256: "b".repeat(64), qc: { analysisComplete: true }, frames: [{ name: "frame.jpg", at: 1, sha256: digest }] }] };
  const job: VideoJob = { id: "video1", ownerId: "owner", botId: "producer", threadId: "thread", title: "review", state: "awaiting_video_approval", revision: 1,
    createdAt: 0, updatedAt: 0, artifacts: [{ name: "frame.jpg", kind: "review_frame", sha256: digest }] };
  const content = await reviewImages(job, packet, async () => new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }));
  return { id: "current-video-review", role: "user", content: [{ type: "text", text: "请按实际画面和音轨审核当前成片。" }, ...content] };
}

describe("stripHeavyBlobs", () => {
  test("removes screenshot base64 while keeping other fields", () => {
    const raw = JSON.stringify({
      base64: "A".repeat(8000),
      width: 1280,
      height: 800,
      url: "https://example.test/",
    });
    const cleaned = stripHeavyBlobs(raw);
    expect(cleaned).toContain("[omitted from model context]");
    expect(cleaned).toContain('"width":1280');
    expect(cleaned).not.toContain("A".repeat(100));
  });
});

describe("foldToolResultsForModel", () => {
  test("keeps recent tool results longer than older ones", () => {
    const rows: unknown[] = [{ id: "u0", role: "user", content: "go" }];
    for (let i = 0; i < 12; i += 1) {
      rows.push({
        id: `a${i}`,
        role: "assistant",
        content: "",
        toolCalls: [call(`c${i}`)],
      });
      rows.push({
        id: `t${i}`,
        role: "tool",
        toolCallId: `c${i}`,
        content: `shell output ${i} ` + "x".repeat(5_000),
      });
    }
    const folded = foldToolResultsForModel(history(rows));
    const firstTool = folded.find((message) => message.id === "t0");
    const lastTool = folded.find((message) => message.id === "t11");
    expect(contentLen(firstTool)).toBeLessThan(1_200);
    expect(contentLen(lastTool)).toBeGreaterThan(contentLen(firstTool));
    expect(contentLen(lastTool)).toBeLessThan(13_000);
    expect(firstTool?.id).toBe("t0");
    expect(lastTool?.id).toBe("t11");
  });
});

describe("dropOlderTurnsForModel", () => {
  test("keeps first user anchor and recent turns only", () => {
    const messages = longThread(40);
    const budgets = budgetsForRun({ goal: true });
    const dropped = dropOlderTurnsForModel(messages, budgets);
    expect(dropped.length).toBeLessThan(messages.length);
    expect(dropped.length).toBeLessThanOrEqual(budgets.maxKeptMessages + 1);
    expect(dropped[0]?.id).toBe("u0");
    expect(dropped.some((message) => message.id === "u39")).toBe(true);
    expect(dropped.some((message) => message.id === "u5")).toBe(false);
  });
});

describe("compactHistoryForModel", () => {
  test("shrinks a long shell-heavy thread well below the original size", () => {
    const rows = longThread(30);
    const before = estimateTokens(rows);
    const result = compactHistoryForModel(rows);
    expect(result.folded || result.shrunk || result.dropped).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(before);
    expect(result.estimatedTokens).toBeLessThan(before * 0.35);
    // Every kept id existed in the original thread (no synthetic ids).
    const original = new Set(rows.map((message) => message.id));
    for (const message of result.messages) expect(original.has(message.id)).toBe(true);
  });

  test("goal mode drops old turns under the hard budget", () => {
    const rows = longThread(80);
    const goal = compactHistoryForModel(rows, { goal: true });
    expect(goal.dropped).toBe(true);
    expect(goal.messages.length).toBeLessThan(rows.length);
    expect(goal.estimatedTokens).toBeLessThan(goal.budgets.hard);
    expect(goal.budgets.soft).toBeLessThan(budgetsForRun().soft);
  });

  test("a 200+ message thread forces drop even when soft budget is not hit", () => {
    // 50 turns × 4 messages = 200；无超大 tool 结果时粗估可能仍低于 soft，以前不会 drop。
    const rows: Message[] = [];
    for (let turn = 0; turn < 50; turn += 1) {
      rows.push({ id: `u${turn}`, role: "user", content: `step ${turn}` });
      rows.push({
        id: `a${turn}`,
        role: "assistant",
        content: "ok",
        toolCalls: [call(`c${turn}`)],
      });
      rows.push({
        id: `t${turn}`,
        role: "tool",
        toolCallId: `c${turn}`,
        content: "done",
      });
      rows.push({ id: `a2-${turn}`, role: "assistant", content: "next" });
    }
    expect(rows.length).toBe(200);
    const result = compactHistoryForModel(rows);
    expect(result.dropped).toBe(true);
    expect(result.messages.length).toBeLessThan(rows.length);
    expect(result.estimatedTokens).toBeLessThan(estimateTokens(rows));
  });

  test("actual review frame parts survive 17 evidence tool results and repeated compaction", async () => {
    const request = await reviewImageMessage();
    for (const older of [[], longThread(10)]) {
      let messages = [...older, request, ...evidenceReads(17)];
      const original = structuredClone(request);
      for (let pass = 0; pass < 4; pass++) {
        const result = compactHistoryForModel(messages, { forceShrink: true });
        const kept = result.messages.find((message) => message.id === request.id);
        expect(Array.isArray(kept?.content)).toBe(true);
        expect(kept?.content).toEqual(original.content);
        expect(contentLen(result.messages.find((message) => message.id === "evidence-result-0"))).toBeLessThan(1_000);
        messages = result.messages;
      }
      expect(request).toEqual(original);
    }
  });

  test("shrinking text keeps typed media parts and frame labels rather than JSON-stringifying them", async () => {
    const request = await reviewImageMessage();
    if (!Array.isArray(request.content)) throw new Error("Expected multipart review request.");
    const image = request.content.find((part) => part.type === "image");
    const withLargeText = { ...request, content: [...request.content, { type: "text" as const, text: "检查说明。".repeat(2_000) }] } as Message;
    const [shrunk] = shrinkOlderTurnsForModel([withLargeText], budgetsForRun());
    expect(Array.isArray(shrunk?.content)).toBe(true);
    if (!Array.isArray(shrunk?.content)) throw new Error("Media content was converted to text.");
    expect(shrunk.content.find((part) => part.type === "image")).toBe(image);
    expect(shrunk.content.some((part) => part.type === "text" && part.text.includes("landscape.mp4 成片 1 秒"))).toBe(true);
    const last = shrunk.content.at(-1);
    expect(last?.type === "text" && last.text.length < 2_100).toBe(true);
  });

  test("message-cap dropping retains current media while discarding an older media turn", async () => {
    const request = await reviewImageMessage();
    const previous = { ...request, id: "old-video-review" };
    const messages = [previous, ...longThread(6), request, ...evidenceReads(100)];
    const result = compactHistoryForModel(messages, { goal: true });
    expect(result.dropped).toBe(true);
    expect(result.messages.find((message) => message.id === request.id)?.content).toEqual(request.content);
    expect(typeof result.messages.find((message) => message.id === previous.id)?.content).toBe("string");
    expect(result.messages.length).toBeLessThanOrEqual(result.budgets.maxKeptMessages + 3);
    const repeated = compactHistoryForModel(result.messages, { goal: true });
    expect(repeated.messages.find((message) => message.id === request.id)?.content).toEqual(request.content);
    expect(messages[0]?.content).toEqual(previous.content);
  });

  test("inline image bytes are not estimated as megabytes of text or removed to reduce that estimate", () => {
    const image = (size: number): Message => ({ id: "image", role: "user", content: [
      { type: "text", text: "Describe this image." },
      { type: "image", source: { type: "data", mimeType: "image/jpeg", value: "A".repeat(size) } },
    ] });
    const small = compactHistoryForModel([image(100)], { forceShrink: true });
    const largeRequest = image(2_000_000);
    const large = compactHistoryForModel([largeRequest], { forceShrink: true });
    expect(large.estimatedTokens).toBe(small.estimatedTokens);
    expect(large.messages[0]?.content).toEqual(largeRequest.content);
  });
});

describe("shouldContinueToolSegments", () => {
  test("stops after max segments", () => {
    const gate = shouldContinueToolSegments({
      segmentsCompleted: MAX_CONTINUATION_SEGMENTS,
      cumulativeEstimatedTokens: 0,
      nextSegmentEstimatedTokens: 1_000,
    });
    expect(gate.ok).toBe(false);
  });

  test("allows the first segments under budget", () => {
    const gate = shouldContinueToolSegments({
      segmentsCompleted: 0,
      cumulativeEstimatedTokens: 0,
      nextSegmentEstimatedTokens: 10_000,
    });
    expect(gate.ok).toBe(true);
  });
});

function contentLen(message: Message | undefined): number {
  if (!message) return 0;
  const content = message.content;
  return typeof content === "string"
    ? content.length
    : JSON.stringify(content ?? "").length;
}

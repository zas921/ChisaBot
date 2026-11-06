import { describe, expect, test } from "bun:test";
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
} from "../src/agents/model-context";

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

import { expect, test } from "bun:test";
import { z } from "zod";
import { normalizeScript, scriptSchema, segmentSchema } from "../src/video-production/schema";
import { compactVideoJob, materialSchema, readMaterialPage } from "../src/video-production/material";
import type { VideoJob } from "../src/video-production/types";

const base = { expectedRevision: 0, title: "标题", summary: "资料", tags: [] };
const common = { text: "解说。", caption: null };
const inactiveCard = { layout: null, items: null };
const inactiveRange = { sourceId: null, start: null, end: null };
const samples = [
  { ...common, ...inactiveCard, ...inactiveRange, visual: "source", shots: [{ sourceId: "a", start: 0, end: 3 }] },
  { ...common, ...inactiveCard, visual: "source", shots: null, sourceId: "a", start: 0, end: 3 },
  { ...common, ...inactiveCard, visual: "quote", shots: null, sourceId: "a", start: 0, end: 3 },
  { ...common, ...inactiveRange, visual: "card", shots: null, layout: "list", items: ["甲", "乙"] },
];

test("strict-provider branches each admit a complete valid parameter object", () => {
  const schema = z.toJSONSchema(segmentSchema) as { anyOf: { properties: Record<string, unknown> }[] };
  expect(schema.anyOf).toHaveLength(4);
  schema.anyOf.forEach((branch, i) => {
    // Providers promote all object properties to required. All keys have an honest value,
    // and none require fabricated card styling or a fabricated footage range.
    expect(Object.keys(samples[i]!)).toEqual(expect.arrayContaining(Object.keys(branch.properties)));
    expect(segmentSchema.safeParse(samples[i]).success).toBe(true);
  });
  const script = normalizeScript(scriptSchema.parse({ ...base, segments: samples }));
  expect(script.segments[0]).toEqual({ text: "解说。", visual: "source", shots: [{ sourceId: "a", start: 0, end: 3 }] });
  expect(script.segments[3]).toEqual({ text: "解说。", visual: "card", layout: "list", items: ["甲", "乙"] });
  expect(JSON.stringify(script)).not.toContain(":null");
});

test("legacy omitted inactive fields still work while non-null conflicts remain rejected", () => {
  expect(scriptSchema.safeParse({ ...base, segments: [{ text: "素材", visual: "source", sourceId: "a", start: 0, end: 3 }, { text: "卡片", visual: "card" }] }).success).toBe(true);
  for (const bad of [
    { ...samples[0], layout: "heading" }, { ...samples[3], sourceId: "a" },
    { ...samples[2], shots: [{ sourceId: "a", start: 0, end: 3 }] },
    { ...samples[1], end: 0 }, { ...samples[2], end: 21 },
    { ...samples[3], items: ["only one"] },
  ]) expect(segmentSchema.safeParse(bad).success).toBe(false);
});

const transcript = Array.from({ length: 180 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: "原始字幕含引号\"与换行\n".repeat(i === 7 ? 2000 : 12) + i }));
const scenes = Array.from({ length: 1200 }, (_, i) => i * 0.3);
const job = { id: "v", ownerId: "owner", botId: "bot", threadId: "thread", title: "标题", state: "awaiting_script", revision: 0, createdAt: "", updatedAt: "",
  sources: [{ id: "a", url: "https://www.youtube.com/watch?v=abc", title: "来源", transcript, scenes, duration: 700 }] } satisfies VideoJob;

test("all subtitle rows including oversized rows reconstruct exactly below the output budget", () => {
  const seen = new Map<number, string>();
  let cursor = { offset: 0, textOffset: 0 }, requests = 0;
  for (;;) {
    const page = readMaterialPage(job, { id: "v", sourceId: "a", kind: "transcript", limit: 80, ...cursor });
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
    expect(page).toHaveProperty("total", transcript.length);
    if (!("entries" in page)) throw new Error("missing entries");
    for (const entry of page.entries) {
      if (!("text" in entry)) throw new Error("wrong material kind");
      expect(entry.start).toBe(transcript[entry.index]!.start);
      const before = seen.get(entry.index) ?? "";
      expect(entry.textOffset).toBe(before.length);
      seen.set(entry.index, before + entry.text);
    }
    expect(++requests).toBeLessThan(100);
    if (!page.next) break;
    expect(page.next.offset > cursor.offset || page.next.textOffset > cursor.textOffset).toBe(true);
    cursor = page.next;
  }
  expect([...seen.values()]).toEqual(transcript.map((row) => row.text));
});

test("scene pages are complete, compact views omit raw material, invalid cursor is rejected", () => {
  const seen: number[] = [];
  let offset = 0;
  for (;;) {
    const page = readMaterialPage(job, { id: "v", sourceId: "a", kind: "scenes", offset, limit: 80 });
    if (!("entries" in page)) throw new Error("missing entries");
    expect(JSON.stringify(page).length).toBeLessThan(8000);
    for (const entry of page.entries) if ("at" in entry) seen.push(entry.at);
    if (!page.next) break;
    offset = page.next.offset;
  }
  expect(seen).toEqual(scenes);
  const compact = compactVideoJob(job);
  expect(compact.sources[0]).not.toHaveProperty("transcript");
  expect(compact.sources[0]).not.toHaveProperty("scenes");
  expect(compact.sources[0]).toHaveProperty("transcriptCount", 180);
  expect(compact.sources[0]).toHaveProperty("sceneCount", 1200);
  expect(() => readMaterialPage(job, { id: "v", sourceId: "wrong" })).toThrow();
  expect(() => readMaterialPage(job, { id: "v", kind: "scenes", textOffset: 2 })).toThrow();
  expect(() => readMaterialPage(job, { id: "v", offset: 181 })).toThrow();
  expect(materialSchema.safeParse({ id: "v", limit: 10000 }).success).toBe(false);
});

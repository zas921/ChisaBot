import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { budgetsForRun, foldToolResultsForModel } from "../src/agents/model-context";
import { markUntrusted } from "../src/untrusted-content";
import { readMaterialPage, readProjectDocument } from "../src/video-production/material";
import { packetPage, type ReviewPacket } from "../src/video-production/inspection";
import type { VideoJob } from "../src/video-production/types";

function survives(value: unknown) {
  const content = markUntrusted(JSON.stringify(value), "video source material");
  const messages: Message[] = [{ id: "tool-page", role: "tool", toolCallId: "read-page", content }];
  const budget = budgetsForRun({ goal: true });
  expect(content.length).toBeLessThan(budget.freshToolChars);
  expect(foldToolResultsForModel(messages, budget)[0]!.content).toBe(content);
  expect(content.length).toBeLessThan(3000);
  expect(foldToolResultsForModel(messages, { ...budget, freshToolChars: 3000 })[0]!.content).toBe(content);
}
test("full material pages retain their tail cursor in durable-goal model context", () => {
  const job: VideoJob = { id: "project", ownerId: "owner", botId: "producer", threadId: "chat", title: "test", state: "awaiting_script", revision: 0, createdAt: 0, updatedAt: 0,
    sources: [{ id: "source", title: "source", url: "https://youtu.be/abcdefghijk", transcript: [{ start: 0, end: 60, text: "这是实际字幕。".repeat(3000) }] }] };
  let cursor = { offset: 0, textOffset: 0 }, restored = "";
  for (;;) {
    const page = readMaterialPage(job, { id: job.id, ...cursor });
    if (!("entries" in page)) throw new Error("missing material");
    survives(page);
    restored += page.entries.map((entry) => "text" in entry ? entry.text : "").join("");
    if (!page.next) break;
    cursor = page.next;
  }
  expect(restored).toBe(job.sources![0]!.transcript![0]!.text);
});
test("escaped draft and actual evidence pages survive the same goal-context budget", () => {
  const text = '\\"这是配音\n'.repeat(3000);
  const job = { id: "project", revision: 2, brief: text } as VideoJob;
  const packet = { audio: { method: "local-asr", transcript: [{ start: 0, end: 60, text }] }, videos: [], limitations: [text] } as unknown as ReviewPacket;
  for (const read of [(offset: number) => readProjectDocument(job, offset), (offset: number) => packetPage(packet, offset)]) {
    let offset = 0, pages = 0;
    for (;;) {
      const page = read(offset); survives(page); pages++;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(2);
  }
});

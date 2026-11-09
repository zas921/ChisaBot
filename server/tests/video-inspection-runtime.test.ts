import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { builtInAgentConfiguration } from "../src/copilot";
import { currentConfirmToolCall, currentConfirmTurn, withConfirmTurn, withToolAbort } from "../src/confirmations/context";
import { createVideoProduction } from "../src/video-production/service";
import type { VideoJob } from "../src/video-production/types";

// A real 16x16 JPEG, kept inline so the complete wire test has no external files/network dependencies.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDCooorlPnT/9k=", "base64");
const sha = createHash("sha256").update(jpeg).digest("hex");
const args = { id: "runtime_project", target: "source", sourceId: "source-1", start: 1, end: 3, maxFrames: 2 };

function events(responses: boolean, first: boolean): string {
  if (responses) {
    const parts: any[] = [{ type: "response.created", response: { id: `response_${first}`, created_at: 0, model: "gpt-6-astra" } }];
    if (first) parts.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_inspect", call_id: "call_inspect", name: "video_project_inspect", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_inspect", output_index: 0, delta: JSON.stringify(args) },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_inspect", call_id: "call_inspect", name: "video_project_inspect", arguments: JSON.stringify(args), status: "completed" } },
    );
    else parts.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_done", phase: "final_answer" } },
      { type: "response.output_text.delta", item_id: "msg_done", delta: "Actual inspection delivered." },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_done", phase: "final_answer" } },
    );
    parts.push({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } });
    return parts.map((part) => `event: ${part.type}\ndata: ${JSON.stringify(part)}\n\n`).join("");
  }
  const chunk = (delta: any, finish_reason: string | null = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0,
    model: "gpt-4o", choices: [{ index: 0, delta, finish_reason }] });
  const parts = first ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_inspect", type: "function", function: { name: "video_project_inspect", arguments: JSON.stringify(args) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: "Actual inspection delivered." }), chunk({}, "stop")];
  return parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function fixture(modelId: string, stopDuringInspection = false) {
  const responses = modelId.includes("gpt-6"), requests: any[] = [], paths: string[] = [];
  const modelServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push(await request.json()); paths.push(new URL(request.url).pathname);
    if (requests.length > 2) return Response.json({ error: { message: "Unexpected model retry" } }, { status: 400 });
    return new Response(events(responses, requests.length === 1), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const abort = new AbortController(); let stopped = false, inspections = 0;
  const observedScopes: any[] = [];
  const job: VideoJob = { id: args.id, ownerId: "alice", botId: "producer", threadId: "runtime-thread", title: "Runtime",
    state: "awaiting_script_approval", revision: 1, scriptHash: "a".repeat(64), artifactHash: null, createdAt: 0, updatedAt: 0,
    sources: [{ id: "source-1", title: "Source", url: "https://youtu.be/abcdefghijk", duration: 5, transcript: [], scenes: [] }], artifacts: [] };
  const service = createVideoProduction({ baseUrl: "http://worker.test", token: "fixture-only-private-worker-token", fetch: (async (url, init) => {
    if (String(url).endsWith("/inspect")) {
      inspections++;
      observedScopes.push({ ...currentConfirmToolCall(), ...currentConfirmTurn() });
      await Promise.resolve(); // Ensure the scopes survive an actual asynchronous tool operation.
      if (stopDuringInspection) { stopped = true; abort.abort(); }
      const request = JSON.parse(String(init?.body));
      return Response.json({ revision: request.revision, scriptHash: request.scriptHash, target: request.target, sourceId: request.sourceId,
        start: request.start, end: request.end, frames: [1, 3].map((at) => ({ at, mimeType: "image/jpeg", data: jpeg.toString("base64"), sha256: sha })), limitations: ["Sampled frames; no audio."] });
    }
    return Response.json(job);
  }) as typeof fetch });
  const tool = service.tools("alice", "producer").find((tool) => tool.name === "video_project_inspect")!;
  const agent = new BuiltInAgent(builtInAgentConfiguration({ id: "producer", name: "Producer", type: "built_in", systemPrompt: "Inspect once, then report." },
    { provider: "openai", defaultModel: modelId, baseUrl: `http://127.0.0.1:${modelServer.port}/v1` }, "fixture-only-model-key", [tool]));
  agent.threadId = "runtime-thread";
  agent.setMessages([{ id: "ask", role: "user", content: "Inspect the source action." }]);
  const emitted: BaseEvent[] = [];
  try {
    await withConfirmTurn({ threadId: "runtime-thread", runId: "runtime-run", stopped: () => stopped }, () =>
      withToolAbort(abort.signal, () => agent.runAgent({ runId: "runtime-run" }, { onEvent: ({ event }) => { emitted.push(event); } })));
    return { requests, paths, inspections, observedScopes, emitted, messages: agent.messages };
  } finally { modelServer.stop(true); }
}

for (const modelId of ["gpt-4o", "chatflows/gpt-6-astra"]) {
  test(`actual BuiltInAgent inspection delivers JPEGs to the next ${modelId} HTTP request`, async () => {
    const result = await fixture(modelId);
    expect(result.requests).toHaveLength(2);
    expect(result.inspections).toBe(1);
    expect(result.observedScopes).toEqual([expect.objectContaining({ toolCallId: "call_inspect", toolName: "video_project_inspect", threadId: "runtime-thread", runId: "runtime-run" })]);
    const responseWire = modelId.includes("gpt-6");
    expect(result.paths).toEqual(Array(2).fill(responseWire ? "/v1/responses" : "/v1/chat/completions"));
    const body = result.requests[1], history = responseWire ? body.input : body.messages;
    const images = history.filter((item: any) => item.role === "user").flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
      .filter((part: any) => part?.type === (responseWire ? "input_image" : "image_url"));
    expect(images).toHaveLength(2);
    for (const image of images) expect(responseWire ? image.image_url : image.image_url.url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    expect(JSON.stringify(history)).toContain("实际 1.000 秒");
    expect(JSON.stringify(history)).toContain("实际 3.000 秒");
    const toolResult = result.emitted.find((event: any) => event.type === EventType.TOOL_CALL_RESULT) as any;
    // BuiltInAgent serializes a tool's string as JSON in AG-UI events. The
    // provider's tool output unwraps that string independently on its next step.
    const eventValue = JSON.parse(toolResult.content);
    const metadata = typeof eventValue === "string" ? JSON.parse(eventValue) : eventValue;
    expect(metadata.inspectionToken).toMatch(/^[a-f0-9]{48}$/);
    expect(toolResult.content).not.toContain(jpeg.toString("base64"));
    expect(JSON.stringify(result.messages)).not.toContain(jpeg.toString("base64"));
    expect(result.emitted.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
  }, 15000);
}

test("Stop during actual inspection does not register or attach late images", async () => {
  const result = await fixture("gpt-4o", true);
  expect(result.inspections).toBe(1);
  expect(JSON.stringify(result.requests)).not.toContain(jpeg.toString("base64"));
  expect(JSON.stringify(result.messages)).not.toContain("inspectionToken");
}, 15000);

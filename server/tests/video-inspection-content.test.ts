import { describe, expect, test } from "bun:test";
import { withConfirmToolCall, withConfirmTurn, withToolAbort } from "../src/confirmations/context";
import { registerVideoInspection, videoInspectionModel, withVideoInspectionPrompt } from "../src/video-production/inspection-content";

const scope = <T>(run: () => T, threadId = "thread-a", runId = "run-a", stopped = false) =>
  withConfirmTurn({ threadId, runId, stopped: () => stopped }, () => withConfirmToolCall("call-a", "video_project_inspect", run));
const content = [{ type: "text" as const, text: "source-1 3.2 sec" }, { type: "image" as const, source: { type: "data" as const, mimeType: "image/jpeg", value: Buffer.from([255,216,255,217]).toString("base64") } }];
const result = (token: string, overrides: Record<string, unknown> = {}) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "call-a", toolName: "video_project_inspect", output: { type: "json", value: JSON.stringify({ inspectionToken: token, frames: [{ at: 3.2 }] }) }, ...overrides }] });
describe("actual video image model delivery", () => {
  test("normal string tool output becomes real model image bytes with timestamp, without mutating saved transcript", async () => scope(async () => {
    const token = registerVideoInspection(content), prompt = [result(token)];
    let received: any;
    const model = videoInspectionModel({ modelId: "test", doGenerate: async (input: unknown) => { received = input; return "ok"; } });
    expect(await model.doGenerate({ prompt })).toBe("ok");
    expect(prompt).toHaveLength(1);
    expect(received.prompt[1].content[1].text).toContain("3.2");
    expect(received.prompt[1].content[2].data).toEqual(Buffer.from([255,216,255,217]));
    expect(received.prompt[1].content[2].mediaType).toBe("image/jpeg");
    // A provider retry must retain the same evidence; registration is not one-shot consumption.
    await model.doGenerate({ prompt }); expect(received.prompt[1].content[2].type).toBe("file");
  }));
  test("user text, other tool, wrong tool call, thread or run cannot hydrate token", () => {
    const token = scope(() => registerVideoInspection(content));
    for (const message of [
      { role: "user", content: JSON.stringify({ inspectionToken: token }) },
      result(token, { toolName: "web_search" }), result(token, { toolCallId: "call-b" }),
    ]) expect(scope(() => withVideoInspectionPrompt({ prompt: [message] })).prompt).toHaveLength(1);
    expect(scope(() => withVideoInspectionPrompt({ prompt: [result(token)] }), "thread-b").prompt).toHaveLength(1);
    expect(scope(() => withVideoInspectionPrompt({ prompt: [result(token)] }), "thread-a", "run-b").prompt).toHaveLength(1);
  });
  test("Stop prevents both registration and image injection", () => {
    const token = scope(() => registerVideoInspection(content));
    expect(() => scope(() => registerVideoInspection(content), "thread-a", "run-a", true)).toThrow();
    expect(scope(() => withVideoInspectionPrompt({ prompt: [result(token)] }), "thread-a", "run-a", true).prompt).toHaveLength(1);
    expect(() => withToolAbort(AbortSignal.abort(), () => scope(() => registerVideoInspection(content)))).toThrow();
  });
  test("missing cache is explicitly labelled unavailable rather than claimed visual evidence", () => scope(() => {
    const output: any = withVideoInspectionPrompt({ prompt: [result("missing")] });
    expect(output.prompt[1].content[0].text).toContain("再次调用");
    expect(output.prompt[1].content.every((p: any) => p.type === "text")).toBe(true);
  }));
  test("recent image groups are bounded and older entries get a reinspection notice", () => scope(() => {
    const prompt = Array.from({ length: 40 }, () => result(registerVideoInspection(content)));
    const output: any = withVideoInspectionPrompt({ prompt });
    expect(output.prompt.flatMap((m: any) => m.content).filter((p: any) => p.type === "file")).toHaveLength(32);
    expect(output.prompt.filter((m: any) => m.role === "user")).toHaveLength(40);
  }));
  test("registration requires real tool scope and bounded JPEG data", () => {
    expect(() => registerVideoInspection(content)).toThrow();
    expect(() => scope(() => registerVideoInspection([{ type: "text", text: "no images" }]))).toThrow();
    expect(() => scope(() => registerVideoInspection(Array.from({ length: 13 }, () => content[1]!)))).toThrow();
  });
});

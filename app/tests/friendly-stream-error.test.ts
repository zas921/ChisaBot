import { describe, expect, test } from "bun:test";
import { errorReason, friendlyError } from "../src/lib/chat/friendly-error";
import { friendlyStopReason } from "../src/lib/copilot/stopped-turn";

describe("模型回答到一半断开（成熟度扫查 F7）", () => {
  test("频道聊天的出错卡片说中文", () => {
    const f = friendlyError("AI SDK stream error");
    expect(f.title).toBe("模型的连接中途断开了");
    expect(f.retryable).toBe(true);
    expect(friendlyError('ClinePass: connection lost mid-reply (http2: server sent GOAWAY and closed the connection; debug="server_shutting_down")').title).toBe("模型的连接中途断开了");
  });
  test("机器人聊天的停止提示说中文", () => {
    expect(friendlyStopReason("AI SDK stream error")).toContain("连接中途断开");
  });
  test("原来的规则不受影响", () => {
    expect(friendlyError("Error 429: Too Many Requests").title).toContain("限流");
    expect(friendlyError("fetch failed").title).toBe("网络连接中断");
  });
});

/*
 * 2026-10-20 线上：选中的 space-bunny-free 被 OpenCode Zen 下线（HTTP 410
 * 「Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.」）。
 * 以前这条落到兜底「机器人在回答前停止了」，用户以为应用坏了；真实原因是模型没了。
 */
describe("模型被服务商下线", () => {
  const raw =
    "OpenCode Zen: Model space-bunny-free has been deprecated. Use minimax-m3.1-flash-free instead.";

  test("出错卡片说清楚是模型没了，并指到模型选择器", () => {
    const f = friendlyError(raw);
    expect(f.title).toBe("这个模型已经下线了");
    expect(f.hint).toContain("模型名");
    expect(f.retryable).toBe(false);
    expect(f.detail).toBe(raw);
  });

  test("机器人聊天的提示也用中文说清楚", () => {
    expect(friendlyStopReason(raw)).toContain("已经下线");
    expect(friendlyStopReason(raw)).toContain("模型名");
  });

  test("一句话都没收到时，给一条能走的下一步", () => {
    const f = friendlyError("");
    expect(f.title).toBe("这一轮没有收到回答");
    expect(f.hint).toContain("换一个模型");
    expect(f.retryable).toBe(true);
  });
});

/*
 * 2026-10-21：模型出错时要能直接看到原因。服务端在错误末尾补「（模型 id · HTTP 状态码：供应商原话）」
 * （server/src/agents/model-fallback.ts explainModelError），卡片和机器人聊天都把它显示出来。
 */
describe("模型错误显示原因", () => {
  const tagged = "Failed after 3 attempts. Last error: Unauthorized（模型 clinepass/glm-9 · HTTP 401：Invalid API key）";

  test("频道聊天：标题照旧翻译，原因一行直接显示", () => {
    const f = friendlyError(tagged);
    expect(f.title).toBe("模型密钥无效或已过期");
    expect(f.reason).toBe("模型 clinepass/glm-9 · HTTP 401：Invalid API key");
    expect(f.detail).toBe(tagged);
  });

  test("模型 id 里的数字不会被当成状态码", () => {
    const f = friendlyError("Bad Request（模型 qwen/qwen-512b · HTTP 400：unsupported parameter: tools）");
    expect(f.title).toBe("模型调用出错了");
    expect(f.reason).toBe("模型 qwen/qwen-512b · HTTP 400：unsupported parameter: tools");
  });

  test("没有供应商原话时带上原来那句", () => {
    expect(errorReason("model gave no output in 30s（模型 a/b）")).toBe("model gave no output in 30s（模型 a/b）");
  });

  test("没有服务端标记的原文也给一行原因", () => {
    expect(friendlyError("Error 429: Too Many Requests").reason).toBe("Error 429: Too Many Requests");
  });

  test("机器人聊天：中文提示后面接原因", () => {
    const said = friendlyStopReason(tagged);
    expect(said).toContain("密钥");
    expect(said).toContain("（原因：模型 clinepass/glm-9 · HTTP 401：Invalid API key）");
    expect(friendlyStopReason("Bad Request（模型 a/b · HTTP 400：bad tools）")).toBe("这一轮出错了：Bad Request（原因：模型 a/b · HTTP 400：bad tools）");
  });
});

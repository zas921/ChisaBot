import { type BaseEvent, EventType, type Message } from "@ag-ui/client";

/** Only closed protocol groups can escape if this stream may be retried internally. */
export class HeadlessStreamCheckpoint {
  private readonly open = new Set<string>();
  private buffered: BaseEvent[] = [];
  private readonly completed = new Set<string>();
  private readonly observedCalls = new Set<string>();
  private readonly observedResults = new Set<string>();
  private waiting = false;
  messages: Message[];
  state: unknown;

  constructor(messages: Message[], state: unknown) {
    this.messages = structuredClone(messages);
    this.state = structuredClone(state);
  }

  observe(event: BaseEvent, messages: Message[], state: unknown): BaseEvent[] {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (event.type === EventType.TOOL_CALL_START && id) {
      this.observedCalls.add(id);
      this.open.add(`tool:${id}`);
    }
    if (event.type === EventType.TOOL_CALL_END && id) {
      this.completed.add(id);
      this.open.delete(`tool:${id}`);
    }
    if (event.type === EventType.TOOL_CALL_RESULT && id) this.observedResults.add(id);
    if (event.type === EventType.TEXT_MESSAGE_START && typeof event.messageId === "string") this.open.add(`text:${event.messageId}`);
    if (event.type === EventType.TEXT_MESSAGE_END && typeof event.messageId === "string") this.open.delete(`text:${event.messageId}`);
    if (event.type === EventType.REASONING_MESSAGE_START && typeof event.messageId === "string") this.open.add(`reasoning-text:${event.messageId}`);
    if (event.type === EventType.REASONING_MESSAGE_END && typeof event.messageId === "string") this.open.delete(`reasoning-text:${event.messageId}`);
    if (event.type === EventType.REASONING_START && typeof event.messageId === "string") this.open.add(`reasoning:${event.messageId}`);
    if (event.type === EventType.REASONING_END && typeof event.messageId === "string") this.open.delete(`reasoning:${event.messageId}`);
    const step = JSON.stringify([event.subagentRunId ?? null, event.stepName]);
    if (event.type === EventType.STEP_STARTED && typeof event.stepName === "string") this.open.add(`step:${step}`);
    if (event.type === EventType.STEP_FINISHED && typeof event.stepName === "string") this.open.delete(`step:${step}`);
    if (event.type === EventType.SUBAGENT_STARTED && typeof event.subagentRunId === "string") this.open.add(`subagent:${event.subagentRunId}`);
    if ((event.type === EventType.SUBAGENT_FINISHED || event.type === EventType.SUBAGENT_ERROR)
      && typeof event.subagentRunId === "string") this.open.delete(`subagent:${event.subagentRunId}`);
    if (event.type === EventType.CUSTOM && event.name === "openbot.headless.waiting") this.waiting = true;
    if (event.type === EventType.RUN_FINISHED && event.outcome && typeof event.outcome === "object" && "type" in event.outcome
      && event.outcome.type !== "success") this.waiting = true;
    this.buffered.push(event);
    if (this.open.size) return [];
    const ready = this.buffered;
    this.buffered = [];
    this.messages = structuredClone(messages);
    this.state = structuredClone(state);
    return ready;
  }

  /** A completed call without a checkpointed result may already have performed an action. */
  canRetry(latest: readonly Message[]): boolean {
    if (this.waiting) return false;
    const results = new Set(this.messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
    if ([...this.completed, ...this.observedResults].some((id) => !results.has(id))) return false;
    for (const message of latest) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        if (results.has(call.id)) continue;
        // Only a positively observed still-open argument stream is known not to have completed.
        if (!this.observedCalls.has(call.id) || !this.open.has(`tool:${call.id}`)) return false;
      }
    }
    return true;
  }

  /** On final failure expose the original partial output before the terminal error. */
  flush(): BaseEvent[] {
    const buffered = this.buffered;
    this.buffered = [];
    return buffered;
  }
}

export type HeadlessRecovery = { reason: string; delayMs: number };

/** Retry a narrow transport failure, never a business error disguised by a stream wrapper. */
export function headlessRecovery(failure: unknown, baseDelayMs = 1_000): HeadlessRecovery | undefined {
  const delayMs = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : 1_000;
  if (failure === undefined) return { reason: "missing_terminal", delayMs };
  const parts: string[] = [];
  const codes = new Set<string>();
  const statuses = new Set<number>();
  const seen = new Set<unknown>();
  let current: unknown = failure;
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current === "string") { parts.push(current); break; }
    if (typeof current !== "object") break;
    const value = current as Record<string, unknown>;
    for (const key of ["message", "responseBody", "name"]) if (typeof value[key] === "string") parts.push(value[key]);
    if (typeof value.code === "string") codes.add(value.code);
    for (const key of ["status", "statusCode"]) if (typeof value[key] === "number") statuses.add(value[key]);
    current = value.lastError ?? value.cause;
  }
  const text = parts.join(" ");
  if (/AbortError|cancel(?:led|ed)|permission|unauthori[sz]ed|forbidden|invalid.?api.?key|context.{0,20}(?:length|limit)|quota|rate.?limit|approval|user.?stop|已停止|已取消|等待.{0,8}(?:授权|审批)|额度|配额/i.test(text)
    || [...statuses].some((status) => status >= 400 && status < 500)
    || /\bHTTP\s*(?:400|401|403|404|409|422|429)\b/i.test(text)) return undefined;
  if (codes.has("INCOMPLETE_TOOL_CALL")) return { reason: "incomplete_tool_arguments", delayMs };
  // An explicit non-stream error code retains its original semantics, even if its text mentions a network failure.
  const transportCodes = new Set(["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  const transport = [...codes].some((code) => transportCodes.has(code));
  if ([...codes].some((code) => code !== "INCOMPLETE_STREAM" && !transportCodes.has(code))) return undefined;
  const unavailable = [...statuses].some((status) => [500, 502, 503, 504].includes(status))
    || /\bHTTP\s*(?:500|502|503|504)\b|\b(?:connection|socket)\s+(?:was\s+)?(?:reset|closed|terminated)|\bfetch failed\b|\bnetwork (?:error|request failed)\b|\b(?:ECONNRESET|UND_ERR_SOCKET)\b/i.test(text);
  if (!transport && !unavailable) return undefined;
  // Respect the model fallback's remaining cooldown, but do not hold this lease indefinitely.
  const seconds = /(?:约\s*|retry (?:in|after)\s*)(\d+(?:\.\d+)?)\s*(?:秒|seconds?|s\b)/i.exec(text);
  const cooldownMs = seconds ? Math.ceil(Number(seconds[1]) * 1_000) + 250 : 0;
  if (cooldownMs > 125_000 || delayMs > 125_000) return undefined;
  return { reason: "transient_stream_failure", delayMs: Math.max(delayMs, cooldownMs) };
}

export function waitForHeadlessRecovery(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

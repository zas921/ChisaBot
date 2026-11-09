/**
 * 进模型前的上下文压缩（2026-10-30，goal 续跑改为真正丢弃旧消息）。
 *
 * 只改「这一轮喂给模型」的视图。同 id 就地改短，或从数组里拿掉旧消息（不换 id、不写新 id），
 * 所以 local-conversations 的 `project(visible, newOnly)` 仍会把完整原文留在库里和 UI 里。
 *
 * Goal / 超硬预算时会 drop 中间轮次，只保留「首条用户摘要 + 最近 K 个 user 轮」，
 * 否则 1400+ 条就地截断仍会估出 30 万+ token，续段熔断会误杀目标任务。
 */
import type { Message, ToolCall } from "@ag-ui/client";
import { cutAtCodeUnits } from "../channels/text";
import { estimateTokens } from "../context-usage";
import { currentGoalContinuation } from "./goal-context";

const envInt = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};

/** 最近若干条 tool 结果保留较完整（仍有上限）；更早的压成短摘要。 */
export const KEEP_RECENT_TOOL_RESULTS = envInt("CHISABOT_KEEP_RECENT_TOOL_RESULTS", 8);
/** 新近 tool 结果字符上限（与 MCP 同级）。 */
export const FRESH_TOOL_RESULT_CHARS = envInt("CHISABOT_FRESH_TOOL_RESULT_CHARS", 12_000);
/** 旧 tool 结果字符上限。 */
export const OLD_TOOL_RESULT_CHARS = envInt("CHISABOT_OLD_TOOL_RESULT_CHARS", 600);
/** 触发温和压缩的估算 token（estimateTokens，会偏小）。 */
export const SOFT_TOKEN_BUDGET = envInt("CHISABOT_CONTEXT_SOFT_TOKENS", 48_000);
/** 触发强力压缩 / 丢弃旧轮。 */
export const HARD_TOKEN_BUDGET = envInt("CHISABOT_CONTEXT_HARD_TOKENS", 96_000);
/** Goal 续跑更紧。 */
export const GOAL_SOFT_TOKEN_BUDGET = envInt("CHISABOT_GOAL_CONTEXT_SOFT_TOKENS", 24_000);
export const GOAL_HARD_TOKEN_BUDGET = envInt("CHISABOT_GOAL_CONTEXT_HARD_TOKENS", 48_000);
/** 强力压缩 / 丢弃时保留最近多少个 user 边界之后的消息。 */
export const KEEP_RECENT_USER_TURNS = envInt("CHISABOT_KEEP_RECENT_USER_TURNS", 4);
export const GOAL_KEEP_RECENT_USER_TURNS = envInt("CHISABOT_GOAL_KEEP_RECENT_USER_TURNS", 2);
/** 丢弃旧轮后，尾部最多保留多少条消息（含 tool）。 */
export const MAX_KEPT_MESSAGES = envInt("CHISABOT_MAX_KEPT_MESSAGES", 120);
export const GOAL_MAX_KEPT_MESSAGES = envInt("CHISABOT_GOAL_MAX_KEPT_MESSAGES", 48);
/** continueToolRuns 外环最多续几段。 */
export const MAX_CONTINUATION_SEGMENTS = envInt("CHISABOT_TOOL_CONTINUE_MAX_SEGMENTS", 6);
/** 单次外环累计估算 input 上限（各段压缩后之和）。 */
export const MAX_CONTINUATION_CUMULATIVE_TOKENS = envInt(
  "CHISABOT_TOOL_CONTINUE_MAX_TOKENS",
  280_000,
);

export type ModelContextBudgets = {
  soft: number;
  hard: number;
  keepRecentTools: number;
  freshToolChars: number;
  oldToolChars: number;
  keepUserTurns: number;
  maxKeptMessages: number;
};

export function budgetsForRun(options?: {
  goal?: boolean;
}): ModelContextBudgets {
  const goal = options?.goal ?? Boolean(currentGoalContinuation());
  return {
    soft: goal ? GOAL_SOFT_TOKEN_BUDGET : SOFT_TOKEN_BUDGET,
    hard: goal ? GOAL_HARD_TOKEN_BUDGET : HARD_TOKEN_BUDGET,
    keepRecentTools: goal
      ? Math.min(KEEP_RECENT_TOOL_RESULTS, 4)
      : KEEP_RECENT_TOOL_RESULTS,
    freshToolChars: goal
      ? Math.min(FRESH_TOOL_RESULT_CHARS, 6_000)
      : FRESH_TOOL_RESULT_CHARS,
    oldToolChars: OLD_TOOL_RESULT_CHARS,
    keepUserTurns: goal ? GOAL_KEEP_RECENT_USER_TURNS : KEEP_RECENT_USER_TURNS,
    maxKeptMessages: goal ? GOAL_MAX_KEPT_MESSAGES : MAX_KEPT_MESSAGES,
  };
}

function contentText(content: Message["content"]): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toolNameBefore(
  messages: readonly Message[],
  toolIndex: number,
  toolCallId: string,
): string {
  for (let i = toolIndex - 1; i >= 0; i -= 1) {
    const message = messages[i] as Message & { toolCalls?: ToolCall[] };
    if (message.role !== "assistant" || !message.toolCalls) continue;
    const hit = message.toolCalls.find((call) => call.id === toolCallId);
    if (hit?.function?.name) return hit.function.name;
  }
  return "tool";
}

/**
 * 工具结果等纯文本中的 base64 不会作为图片解析，去掉字节而保留尺寸与 url。
 * 真正的多模态 image part 必须保留；它不经过这个字符串过滤器。
 */
export function stripHeavyBlobs(text: string): string {
  let next = text;
  next = next.replace(
    /"base64"\s*:\s*"(?:[^"\\]|\\.)*"/g,
    '"base64":"[omitted from model context]"',
  );
  next = next.replace(
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{256,}/g,
    "data:image;base64,[omitted from model context]",
  );
  next = next.replace(/[A-Za-z0-9+/]{4000,}={0,2}/g, "[omitted long base64]");
  return next;
}

function capToolContent(
  text: string,
  limit: number,
  meta: { name: string; older: boolean },
): string {
  const cleaned = stripHeavyBlobs(text);
  if (cleaned.length <= limit) return cleaned;
  const head = cutAtCodeUnits(cleaned, Math.max(80, limit - 80));
  return `${head}\n\n[truncated ${meta.name} result: kept ${head.length} of ${cleaned.length} chars${meta.older ? "; older tool output folded" : ""}]`;
}

function sameContent(a: Message["content"], b: string): boolean {
  return contentText(a) === b;
}

/** Images/audio are protocol parts, not JSON text. Compact only text while a message is kept. */
function mapTextContent(
  content: Message["content"],
  transform: (text: string) => string,
): Message["content"] {
  if (!Array.isArray(content)) {
    const next = transform(contentText(content));
    return sameContent(content, next) ? content : next;
  }
  let changed = false;
  const parts = content.map((part) => {
    if (part.type !== "text") return part;
    const text = transform(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? parts : content;
}

function hasMediaContent(message: Message): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type !== "text");
}

/** A discarded turn's text anchor never needs to serialize its original media bytes. */
function anchorText(message: Message): string {
  return Array.isArray(message.content)
    ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    : contentText(message.content);
}

/** 就地折叠 tool 结果；返回新数组（未改动的元素保持原引用）。 */
export function foldToolResultsForModel(
  messages: readonly Message[],
  budgets: ModelContextBudgets = budgetsForRun(),
): Message[] {
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "tool") toolIndexes.push(i);
  }
  if (toolIndexes.length === 0) return messages as Message[];

  const recent = new Set(toolIndexes.slice(-budgets.keepRecentTools));
  let changed = false;
  const out = messages.map((message, index) => {
    if (message.role !== "tool") return message;
    const toolCallId =
      typeof (message as { toolCallId?: unknown }).toolCallId === "string"
        ? (message as { toolCallId: string }).toolCallId
        : "";
    const name = toolNameBefore(messages, index, toolCallId);
    const older = !recent.has(index);
    const limit = older ? budgets.oldToolChars : budgets.freshToolChars;
    const next = capToolContent(contentText(message.content), limit, {
      name,
      older,
    });
    if (sameContent(message.content, next)) return message;
    changed = true;
    return { ...message, content: next } as Message;
  });
  return changed ? out : (messages as Message[]);
}

function userBoundaries(messages: readonly Message[]): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") indexes.push(i);
  }
  return indexes;
}

/**
 * 强力压缩：尾部完整保留；更早的 user/assistant 正文就地截短；tool 已在 fold 里处理。
 * 不删除行，避免打断 toolCallId 配对。
 */
export function shrinkOlderTurnsForModel(
  messages: readonly Message[],
  budgets: ModelContextBudgets,
): Message[] {
  const users = userBoundaries(messages);
  if (users.length <= budgets.keepUserTurns) {
    return messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") return message;
      const next = mapTextContent(message.content, (value) => {
        const text = stripHeavyBlobs(value);
        return text.length <= 2_000 ? text : `${cutAtCodeUnits(text, 1_900)}\n\n[truncated older turn]`;
      });
      return next === message.content
        ? message
        : ({ ...message, content: next } as Message);
    });
  }
  const keepFrom = users[users.length - budgets.keepUserTurns] ?? 0;
  let changed = false;
  const out = messages.map((message, index) => {
    if (index >= keepFrom) {
      if (message.role !== "user" && message.role !== "assistant") return message;
      const next = mapTextContent(message.content, stripHeavyBlobs);
      if (next === message.content) return message;
      changed = true;
      return { ...message, content: next } as Message;
    }
    if (message.role === "tool") return message;
    if (message.role !== "user" && message.role !== "assistant") return message;
    const next = mapTextContent(message.content, (value) => {
      const text = stripHeavyBlobs(value);
      return text.length === 0
        ? "[earlier turn omitted from model context]"
        : `${cutAtCodeUnits(text, 240)}\n\n[earlier turn truncated for model context]`;
    });
    if (next === message.content) return message;
    changed = true;
    return { ...message, content: next } as Message;
  });
  return changed ? out : (messages as Message[]);
}

/**
 * 不从 tool 结果中间切开：若 keepFrom 落在 tool 上，回退到对应 assistant。
 */
export function alignKeepFrom(
  messages: readonly Message[],
  keepFrom: number,
): number {
  let i = Math.max(0, Math.min(keepFrom, messages.length));
  while (i > 0 && messages[i]?.role === "tool") i -= 1;
  return i;
}

/**
 * 真正丢掉旧轮（仅模型视图）。保留首条 user 摘要 + 最近 K 个 user 轮 / 最多 N 条。
 * 当前用户的多模态请求若在消息条数上限之外，仍作为一条完整媒体锚点保留。
 * 被丢掉的 id 仍在 DB/UI 的 visible 里；不要生成新 id。
 */
export function dropOlderTurnsForModel(
  messages: readonly Message[],
  budgets: ModelContextBudgets,
): Message[] {
  if (messages.length <= budgets.maxKeptMessages) {
    const users = userBoundaries(messages);
    if (users.length <= budgets.keepUserTurns) return messages as Message[];
  }

  const users = userBoundaries(messages);
  const keepFromUser =
    users.length > budgets.keepUserTurns
      ? (users[users.length - budgets.keepUserTurns] ?? 0)
      : 0;
  const keepFromCap = Math.max(0, messages.length - budgets.maxKeptMessages);
  const keepFrom = alignKeepFrom(
    messages,
    Math.max(keepFromUser, keepFromCap),
  );
  if (keepFrom <= 0) return messages as Message[];

  const tail = messages.slice(keepFrom);
  // A single active review can span more than maxKeptMessages while paging evidence.
  // Keep its actual media request even when we retire the middle of that same turn.
  const latestUserIdx = users.at(-1);
  if (latestUserIdx !== undefined && latestUserIdx < keepFrom && hasMediaContent(messages[latestUserIdx]!))
    tail.unshift(messages[latestUserIdx]!);
  const firstUserIdx = users[0];
  if (firstUserIdx === undefined || firstUserIdx >= keepFrom) return tail;

  const first = messages[firstUserIdx]!;
  if (tail.some((message) => message.id === first.id)) return tail;

  const text = stripHeavyBlobs(anchorText(first));
  const dropped = keepFrom;
  const anchor = {
    ...first,
    content: `${cutAtCodeUnits(text, 500)}\n\n[earlier conversation omitted from model context: ${dropped} messages not sent to the model]`,
  } as Message;
  return [anchor, ...tail];
}

export type CompactHistoryResult = {
  messages: Message[];
  estimatedTokens: number;
  folded: boolean;
  shrunk: boolean;
  dropped: boolean;
  budgets: ModelContextBudgets;
};

/**
 * 进模型前压缩。可重复调用（每段续跑前再压一次）。
 */
export function compactHistoryForModel(
  messages: readonly Message[],
  options?: { goal?: boolean; forceShrink?: boolean },
): CompactHistoryResult {
  const goal = Boolean(options?.goal ?? currentGoalContinuation());
  const budgets = budgetsForRun({ goal });
  let next = foldToolResultsForModel(messages, budgets);
  const folded = next !== messages;
  let tokens = estimateTokens(next);
  let shrunk = false;
  let dropped = false;
  // 超长线程（复刻镜一类 1000+ 条）即便粗估 token 偏低，也强制收口，避免虚高读数与异常收尾。
  const veryLongThread = messages.length >= 200;

  const tooManyTools =
    next.filter((message) => message.role === "tool").length >
    budgets.keepRecentTools * 2;
  if (
    options?.forceShrink ||
    tokens >= budgets.soft ||
    tooManyTools ||
    goal ||
    veryLongThread
  ) {
    const shrunkMessages = shrinkOlderTurnsForModel(next, budgets);
    if (shrunkMessages !== next) {
      next = shrunkMessages;
      shrunk = true;
      tokens = estimateTokens(next);
    }
  }

  // Goal / 硬预算 / 超长线程：丢掉旧轮。就地截断挡不住 1400+ 条消息的估算膨胀。
  const shouldDrop =
    goal ||
    tokens >= budgets.hard ||
    next.length > budgets.maxKeptMessages ||
    veryLongThread;
  if (shouldDrop) {
    const droppedMessages = dropOlderTurnsForModel(next, budgets);
    if (droppedMessages.length !== next.length) {
      next = foldToolResultsForModel(droppedMessages, budgets);
      dropped = true;
      shrunk = true;
      tokens = estimateTokens(next);
    }
  }

  // 仍超硬预算：再收一刀。
  if (tokens >= budgets.hard) {
    const emergency: ModelContextBudgets = {
      ...budgets,
      keepUserTurns: 1,
      keepRecentTools: Math.min(budgets.keepRecentTools, 3),
      freshToolChars: Math.min(budgets.freshToolChars, 3_000),
      oldToolChars: Math.min(budgets.oldToolChars, 200),
      maxKeptMessages: Math.min(budgets.maxKeptMessages, goal ? 32 : 48),
    };
    next = foldToolResultsForModel(next, emergency);
    next = dropOlderTurnsForModel(next, emergency);
    next = foldToolResultsForModel(next, emergency);
    dropped = true;
    shrunk = true;
    tokens = estimateTokens(next);
  }

  if (folded || shrunk || dropped) {
    console.warn(
      JSON.stringify({
        type: "model-context-compacted",
        estimatedTokens: tokens,
        soft: budgets.soft,
        hard: budgets.hard,
        folded,
        shrunk,
        dropped,
        messages: next.length,
        goal,
      }),
    );
  }
  return {
    messages: next,
    estimatedTokens: tokens,
    folded,
    shrunk,
    dropped,
    budgets,
  };
}

/** 续段是否还应继续（在 canContinue 为真的前提下再问一次）。 */
export function shouldContinueToolSegments(state: {
  segmentsCompleted: number;
  cumulativeEstimatedTokens: number;
  nextSegmentEstimatedTokens: number;
}): { ok: true } | { ok: false; reason: string } {
  if (state.segmentsCompleted >= MAX_CONTINUATION_SEGMENTS) {
    return {
      ok: false,
      reason: `tool continuation hit max segments (${MAX_CONTINUATION_SEGMENTS})`,
    };
  }
  const projected =
    state.cumulativeEstimatedTokens + state.nextSegmentEstimatedTokens;
  if (projected > MAX_CONTINUATION_CUMULATIVE_TOKENS) {
    return {
      ok: false,
      reason: `tool continuation hit cumulative token budget (${MAX_CONTINUATION_CUMULATIVE_TOKENS})`,
    };
  }
  return { ok: true };
}

/**
 * 一轮没有正常结束的原因，按对话记在这一页的内存里（DESIGN.md §109）。
 *
 * 原因本来只在聊天组件的 state 里（`runError`）。组件卸载后（换机器人、藏够时间被放掉）这一轮如果才出事，
 * 或者出事时组件刚好不在，回来重新挂上的聊天只剩服务器记下的「◼ 已停止」，看不出为什么停。这里记一份，
 * 重新挂上的聊天在恢复完历史后读回来，画在同一个位置。刷新页面后不在（服务器只记得「停了」）。
 */

/**
 * 这一轮停在一步要在浏览器里执行的操作上（运行命令、写文件、点网页…），却没有页面在执行它：
 * 发起它的那一页刷新了 / 关掉了。服务器会一直等那一步的结果，所以要告诉人怎么结束。
 */
export const STALLED_RELAY_REASON =
  "这一轮停在一步要在浏览器里执行的操作上（比如运行命令、写文件），但执行它的页面已经刷新或关闭，这一步没有结果，机器人不会接着往下做。按「停止」结束这一轮，再重新发送即可。如果它正在另一台设备或另一个窗口里执行，做完会自动接上。";

type Outcome = { userMessageId: string | null; reason: string };

const outcomes = new Map<string, Outcome>();

/** 记下这一轮（`userMessageId` 开启的那一轮）为什么没正常结束。同一段对话只留最近一轮的。 */
export function rememberTurnOutcome(threadId: string, userMessageId: string | null, reason: string): void {
  if (!threadId || !reason) return;
  outcomes.set(threadId, { userMessageId, reason });
}

/** 新的一轮开始了：上一轮的原因不再挂着。 */
export function forgetTurnOutcome(threadId: string): void {
  outcomes.delete(threadId);
}

/**
 * 重新挂上的聊天要不要把记下的原因画出来：只有那一轮还是对话里最后一轮（最后一条用户消息就是它）时才画，
 * 之后又聊过（不管在哪台设备上）就不再提。
 */
export function turnOutcomeFor(
  threadId: string,
  messages: readonly { id: string; role: string }[],
): string | null {
  const outcome = outcomes.get(threadId);
  if (!outcome) return null;
  if (outcome.userMessageId === null) return outcome.reason;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return lastUser?.id === outcome.userMessageId ? outcome.reason : null;
}

type ToolTurn = { role: string; toolCalls?: readonly { id: string }[]; toolCallId?: string };

/** 最后一条用户消息之后，有没有还没拿到结果的工具调用（这一轮停在某一步上）。 */
export function hasUnansweredToolCall(messages: readonly ToolTurn[]): boolean {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  const tail = messages.slice(lastUser + 1);
  const answered = new Set(tail.filter((message) => message.role === "tool").map((message) => message.toolCallId));
  return tail.some((message) => (message.toolCalls ?? []).some((call) => !answered.has(call.id)));
}

import type { Message } from "@ag-ui/core";
import {
  type Attachment,
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { ContextMeter } from "@/components/agents/context-meter";
import { attachmentModality } from "@/components/channels/chat-messages";
import { isPersonSentMessage } from "@/components/channels/chat-transcript";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { PermissionChip } from "@/components/chat/permission-chip";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { useReportBusy } from "@/lib/activity";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { attachmentUrl } from "@/lib/channels/attachments";
import {
  recordChannelActivityMutationOptions,
  setChannelBusy,
} from "@/lib/channels/mutations";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { noteSendWhileBusy } from "@/lib/chat/send-scroll";
import { bindAgentBot, useActiveBot } from "@/lib/copilot/active-bot";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";
import type { ThreadActivity } from "@/lib/copilot/bot-thread";
import { readSync } from "@/lib/copilot/bot-thread";
import { reportChatRunning } from "@/lib/copilot/computer-activity";
import {
  CONNECTION_LOST_REASON,
  decideSendWatchdogAction,
  forceUnlockThread,
  isConnectionDrop,
  raceSendWatchdog,
  reportBudgetEvent,
  SEND_REPLY_LIMIT_REASON,
  SEND_REPLY_WAITING_NOTICE,
  SEND_UNREACHABLE_REASON,
  SEND_WATCHDOG_MS,
  settleDroppedTurn,
  storedTurnAnswered,
  waitForPersistedReply,
  pingRelayAlive,
  RELAY_ALIVE_INTERVAL_MS,
} from "@/lib/copilot/connection-drop";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { frontendToolProgressAt } from "@/lib/copilot/frontend-tool-activity";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import {
  contentText,
  lastUserIndex,
  MessageActionsContext,
  type TruncateMode,
  truncateConversation,
  withEditedText,
} from "@/lib/copilot/regenerate";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import {
  isAbortFailure,
  pausedForApproval,
  stoppedReason,
  unfinishedTurnReason,
} from "@/lib/copilot/stopped-turn";
import {
  useThreadActivity,
  withStoredTail,
} from "@/lib/copilot/thread-activity";
import { queueMessage, queuedFor, restoreQueue } from "@/lib/copilot/thread-inbox";
import {
  HISTORY_RETRY_DELAYS_MS,
  readThreadMessages,
  type StoredThread,
  THREAD_MESSAGES_RETRY_DEADLINE_MS,
} from "@/lib/copilot/thread-messages";
import {
  cachedTranscript,
  rememberTranscript,
} from "@/lib/copilot/transcript-cache";
import {
  useFallbackTurns,
  useLastSentAt,
  useStoppedTurnIds,
} from "@/lib/copilot/turn-compaction";
import {
  forgetTurnOutcome,
  hasUnansweredToolCall,
  rememberTurnOutcome,
  STALLED_RELAY_REASON,
  turnOutcomeFor,
} from "@/lib/copilot/turn-outcome";
import { useConversationSync } from "@/lib/copilot/use-conversation-sync";
import { useThreadInbox } from "@/lib/copilot/use-thread-inbox";
import { readImageDims } from "@/lib/image-dims";
import { useKeptHeld, useMarkChatWorking } from "@/lib/kept-visible";
import { useModelSelectionSaving } from "@/lib/model-selection/hooks";
import { assertModelSelectionNotSaving } from "@/lib/model-selection/mutations";
import { agentModelQueryOptions, modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { modelMissingFromCatalog } from "../../../../shared/model-selection";
import { panelAuthoringForwardedProps, panelKeys } from "@/lib/panels/api";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { queryClient } from "@/query-client";
import { newId } from "../../lib/new-id";

/**
 * How long a stalled thread join is worth waiting for before it is ended.
 *
 * Ended, not outrun. See `lib/copilot/join-thread.ts` for what a connect left in flight does to the
 * next message sent.
 */
const JOIN_DEADLINE_MS = 1500;

/** 服务器说在回答、事件序号却这么久没动、最后一步还没有结果：当成没人在执行那一步（DESIGN.md §109）。 */
const STALLED_RELAY_MS = 30_000;

/**
 * Backstop for a message typed before the runtime agent exists; it must not be discarded.
 */
const SEND_WITHOUT_RUNTIME_AFTER_MS = 1500;

type ChannelActivitySignature = {
  agentId: string;
  at: string;
  text: string;
};

function sameActivity(
  left: ChannelActivitySignature | null,
  right: ChannelActivitySignature | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.agentId === right.agentId &&
    left.at === right.at &&
    left.text === right.text
  );
}

/** Failed frontend handlers do not cause CopilotKit to send a continuation request. */
async function persistFailedFrontendResults(threadId: string, messages: readonly Message[]) {
  // Only the last wire segment can still own a relay. Older errors are ordinary history.
  let callAt = -1;
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message?.role === "assistant") {
      if (!message.toolCalls?.length) return;
      callAt = at;
      break;
    }
    if (message?.role === "user") return;
  }
  if (callAt < 0) return false;
  const results = messages.slice(callAt + 1).filter((message) => message.role === "tool");
  if (!results.some((message) => typeof message.content === "string" && message.content.startsWith("Error:"))) return;
  await fetch(`/api/copilotkit/threads/${encodeURIComponent(threadId)}/frontend-finished`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results }),
  }).catch(() => null);
  return true;
}

/** 恢复中、手里还什么都没有时画的（骨架）。模块级，免得每次渲染一个新数组。 */
const EMPTY_MESSAGES: readonly Message[] = [];

export const HISTORY_UNAVAILABLE_NOTICE = "较早的消息暂时无法加载。";

export function channelHistoryNotice({
  restoring,
  messageCount,
  lastMessageAt,
  historyAvailability,
  historyReadFailed = false,
  unreadable,
}: {
  restoring: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  historyAvailability: "ready" | "unavailable";
  historyReadFailed?: boolean;
  unreadable: number;
}): string | null {
  if (restoring) return null;

  /*
   * 只在「什么都没恢复出来」时才说。读取失败但会话里已经有消息（网关快照、刚发出的消息、后台重试
   * 成功的部分）时，多一句「无法加载」只会让人以为丢了东西；后台还会继续重试。
   */
  if (
    historyAvailability === "unavailable" &&
    messageCount === 0 &&
    (historyReadFailed || lastMessageAt !== null)
  ) {
    return HISTORY_UNAVAILABLE_NOTICE;
  }

  if (unreadable > 0) {
    return unreadable === 1
      ? "有一条较早的消息无法读取，未显示。会话其余部分完整。"
      : `${unreadable} 条较早的消息无法读取，未显示。会话其余部分完整。`;
  }

  return null;
}

/** 一条消息里的文字（多段内容只取文字段）。 */
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/** 左栏「最后一句」（可能被截短、空白被压过）是不是已经在这段对话里了：比较最后几条机器人消息的开头。 */
function saysActivity(messages: readonly Message[], text: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const head = squash(text)
    .replace(/[….]+$/, "")
    .slice(0, 24);
  if (!head) return false;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0 && seen < 3; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    seen += 1;
    if (squash(messageText(message)).startsWith(head)) return true;
  }
  return false;
}

/**
 * Insert missing durable messages before their next shared ID, keeping local content and order.
 * A shorter read can still contain missing turns after unreadable rows are filtered out. Without a
 * following shared anchor, append the missing tail: the store cannot place it among local-only rows.
 * Return the original array when nothing was added so refreshes can wait for the store to catch up.
 */
function mergeStoredMessages(local: Message[], stored: Message[]): Message[] {
  const localIds = new Set(local.map((message) => message.id));
  const seenStored = new Set<string>();
  const before = new Map<string, Message[]>();
  let pending: Message[] = [];
  for (const message of stored) {
    if (seenStored.has(message.id)) continue;
    seenStored.add(message.id);
    if (localIds.has(message.id)) {
      if (pending.length > 0) before.set(message.id, pending);
      pending = [];
    } else {
      pending.push(message);
    }
  }
  if (before.size === 0 && pending.length === 0) return local;
  return [
    ...local.flatMap((message) => [...(before.get(message.id) ?? []), message]),
    ...pending,
  ];
}

/**
 * The uploaded id and filename an `Attachment` carries once it is `ready`, read from the
 * `metadata` the composer's `onUpload` stamped on it — see `composer/attachments.ts`. Not the
 * SDK's own `attachment.id`, which is a client-side handle for the upload placeholder rather than
 * the id this deployment stored the file under.
 */
function uploadedAttachment(attachment: Attachment): {
  attachmentId: string;
  filename?: string;
} {
  const metadata = attachment.metadata as
    | {
        attachmentId?: unknown;
        filename?: unknown;
        width?: unknown;
        height?: unknown;
      }
    | undefined;
  const attachmentId = metadata?.attachmentId;
  if (typeof attachmentId !== "string") {
    throw new Error("附件缺少其上传的 ID。");
  }
  const filename =
    typeof metadata?.filename === "string" ? metadata.filename : undefined;
  return filename ? { attachmentId, filename } : { attachmentId };
}

/**
 * One attachment, turned into the part shape a stored message carries.
 *
 * THE MODALITY COMES FROM THE BYTES, NOT FROM `attachment.type`, AND THIS IS THE ONLY PLACE IT CAN.
 *
 * `attachment.type` is the browser's claim, fixed before the upload and never reconciled with what
 * the file turned out to be. The server stopped trusting it — `resolvePart` decides an attachment's
 * modality with `classifyAttachment` on its own sniffed `mimeType` — but that correction lives on
 * the server and never comes back here. What this function writes IS the stored message, so a
 * `document` written here is what every later render of that message reads, for ever: a screenshot
 * whose part the browser mislabelled drew a grey file card over the picture, and the transcript's
 * document probe then paid a whole-file read per render for the privilege.
 *
 * Narrowed through the source union rather than read straight off, for the reason `parkedTiles` in
 * `chat-transcript.tsx` narrows the same field: a `data` source's `mimeType` is `file.type`, the
 * very claim being refused, and only a `url` source has been past the server. `attachmentModality`
 * falls back to the declared type when there is no corroborated one, so an attachment that somehow
 * arrives unuploaded is written exactly as it used to be.
 *
 * The comment this replaces said only "image" and "document" reach here because the composer's
 * upload config accepts no other kind of file. That reason is no longer true — the config's
 * `accept` is now the wildcard, and it is `screenPickedFiles` that holds the line. The conclusion still
 * holds; the justification had rotted, which is why the modality is now derived rather than cast.
 */
function toAttachmentPart(attachment: Attachment) {
  const { attachmentId, filename } = uploadedAttachment(attachment);
  const { source } = attachment;
  const mimeType =
    source.type === "url" && source.mimeType ? source.mimeType : undefined;
  return {
    type: attachmentModality(attachment.type, mimeType),
    source: { type: "url" as const, value: attachmentUrl(attachmentId) },
    metadata: {
      attachmentId,
      ...(filename ? { filename } : {}),
      // 上传时服务器读出的宽高（DESIGN.md §83.2）：存进消息，以后每次画这张图都能先留好框。
      ...readImageDims(
        (attachment.metadata as { width?: unknown } | undefined)?.width,
        (attachment.metadata as { height?: unknown } | undefined)?.height,
      ),
    },
  };
}

/**
 * A plain string when there is nothing attached, exactly as every message in every channel has
 * always been sent — never a single-element array wrapping the same text, which every existing
 * reader would take a different path for no gain. With attachments, the text goes first as its
 * own part and is left out entirely when empty, since an empty text part is noise the model has
 * to read past.
 *
 * Exported for the test that pins this wire format. Reaching it through `deliver`/`say` would mean
 * standing up `useAgent`'s runtime, the thread join and the ready/join gates around it just to
 * observe a pure string-in-object-out mapping — none of that machinery bears on what this function
 * decides, so a narrow export is the honest way to test the contract without restructuring the
 * module around a test.
 */
export function toMessageContent(
  trimmed: string,
  attachments: readonly Attachment[],
) {
  if (attachments.length === 0) return trimmed;
  const refs = attachments.map(toAttachmentPart);
  return trimmed ? [{ type: "text" as const, text: trimmed }, ...refs] : refs;
}

/** What the roster's "last thing said" reads when a message carried no caption. */
function describeAttachments(attachments: readonly Attachment[]): string {
  if (attachments.length === 1) {
    const { filename } = uploadedAttachment(attachments[0]);
    return filename ? `已发送 ${filename}` : "发送了附件";
  }
  return `已发送 ${attachments.length} 个附件`;
}

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
}) {
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  const modelQueryClient = useQueryClient();
  const modelSaving = useModelSelectionSaving(runtimeAgentId);
  /*
   * 选中的模型还在不在模型列表里（P1，2026-10-20）。space-bunny-free 被下线那天，药丸只是变个颜色，
   * 发出去必然 410、失败卡还说不出原因。现在发送前直接挡下来并说清楚，别浪费一轮。
   * catalog 读不到时不挡（宁可发一次，也不要在网关抽风时把整个输入框锁死）。
   */
  const modelState = useQuery(agentModelQueryOptions(runtimeAgentId));
  const modelCatalog = useQuery(modelCatalogQueryOptions());
  const modelMissing = modelMissingFromCatalog(modelState.data, modelCatalog.data);
  const modelMissingRef = useRef(modelMissing);
  modelMissingRef.current = modelMissing;
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const channelAgentId = `channel:${channel.id}`;
  const { agent, isReady } = useAgent({
    agentId: channelAgentId,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  useEffect(() => observeApprovalAgent(agent), [agent]);
  // 这段对话的工具调用操作这个机器人的计算机，不管用户此刻在看哪段对话（§101）。
  bindAgentBot(agent, runtimeAgentId);

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? seedMessage(pending, newId()) : null;
  });

  /*
   * 打开时先画什么（DESIGN.md §83）：恢复（接入 + 读存储）完成之前，不把接入回放一段段长出来的样子画出来
   * （那会让滚动容器把每一段当成「刚发的一轮」对齐到顶上，停在半截历史）。先画这台设备上次看到的样子
   * （`transcript-cache`），没有就等存储读到——存储读和接入同时开始，谁也不等谁——再没有就是骨架。
   */
  const [cached] = useState(() =>
    seed === null ? cachedTranscript(channel.threadId) : null,
  );
  const [early, setEarly] = useState<readonly Message[] | null>(null);
  const earlyRead = useRef<Promise<StoredThread> | null | undefined>(undefined);
  if (earlyRead.current === undefined) {
    earlyRead.current =
      seed === null
        ? readThreadMessages(channel.threadId, runtimeAgentId)
        : null;
  }
  /** 打开时那次读存储读到了：接入之后不用为「最后一句是机器人说的」再读一遍。 */
  const mountReadOk = useRef(false);
  useEffect(() => {
    const read = earlyRead.current;
    if (!read) return;
    let alive = true;
    void read.then((stored) => {
      if (
        alive &&
        stored.availability === "ready" &&
        stored.messages.length > 0
      )
        setEarly(stored.messages);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /**
   * 本机点了发送、整轮还没从 `say` 出来。比 `agent.isRunning` 早：joinGate / panelAuthoring 空档里
   * sync 不得再开 connect（否则会和即将发出的 `/run` 抢 agent，超大回放时主线程卡住）。
   */
  const sendInFlightRef = useRef(false);

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  /*
   * THE AGENT IS READ WHEN IT IS USED, NEVER CAPTURED BEFORE A WAIT. `useAgent` hands back a
   * provisional agent until the proxied one is registered, and a different object afterwards. The
   * stale one still runs and still reaches the thread, so the answer is stored and shows up on the
   * next reload while the rendered agent sits empty. `say` waits, so it spans that swap.
   */
  const agentRef = useRef(agent);
  agentRef.current = agent;

  /**
   * History has been asked for and has not arrived. True for a channel opened from the roster, where
   * an empty transcript is also a real answer; false for one started from the compose screen, which
   * already has the message that started it.
   */
  const [restoring, setRestoring] = useState(seed === null);
  /**
   * How many stored turns this app could not read.
   *
   * Held rather than derived, because the transcript is the running agent's once history is handed
   * over: `agent.messages` is what was restored, and what was dropped on the way in is not
   * recoverable from it.
   */
  const [unreadable, setUnreadable] = useState(0);
  const [historyAvailability, setHistoryAvailability] = useState<
    "ready" | "unavailable"
  >("ready");
  const [historyReadFailed, setHistoryReadFailed] = useState(false);
  // Mount reads and Bot refreshes share one ordering: only the newest read owns the notice.
  const historyReadVersion = useRef(0);
  /** 首次读取失败后正在后台重试：这期间不提示，空会话继续显示骨架。 */
  const [retryingHistory, setRetryingHistory] = useState(false);
  /**
   * 再读一次历史，读到就并进当前对话。后台重试和「重试」按钮共用。返回是否读到。
   * 与刷新共用 historyReadVersion：更新的一次读取开始后，旧的结果直接作废。
   */
  const retryHistoryRead = useCallback(async (): Promise<boolean> => {
    const version = ++historyReadVersion.current;
    const stored = await readThreadMessages(channel.threadId, runtimeAgentId, {
      deadlineMs: THREAD_MESSAGES_RETRY_DEADLINE_MS,
    });
    if (version !== historyReadVersion.current) return false;
    if (stored.availability === "unavailable") return false;
    const current = agentRef.current;
    const messages = mergeStoredMessages(current.messages, stored.messages);
    if (messages !== current.messages) current.setMessages(messages);
    setUnreadable(stored.unreadable);
    setHistoryAvailability("ready");
    setHistoryReadFailed(false);
    return true;
  }, [channel.threadId, runtimeAgentId]);
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;
    const version = ++historyReadVersion.current;

    void (async () => {
      try {
        // Bounded, and finished when it returns; `join-thread.ts` has why that matters.
        await joinWithin({
          connect: copilotkit.connectAgent({ agent }),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
        });
      } catch {
        /*
         * A join that throws is a join that is over. It must not take the gate with it: everything
         * typed afterwards waits on that gate, so a throw here would silence the conversation
         * rather than degrade it. History is restored below either way.
         */
      }

      try {
        // 打开时已经开始读了（和接入同时）；只用一次，之后重跑这段（agent 换了）照旧重新读。
        const pendingRead = earlyRead.current;
        earlyRead.current = null;
        const stored = await (pendingRead ??
          readThreadMessages(channel.threadId, runtimeAgentId));
        const isCurrent = current && version === historyReadVersion.current;
        if (isCurrent) mountReadOk.current = stored.availability === "ready";
        if (isCurrent) {
          // The gateway snapshot can lag the store. Keep its valid local rows even when the
          // corresponding stored row is unreadable, while restoring other readable additions.
          const messages = mergeStoredMessages(agent.messages, stored.messages);
          if (messages !== agent.messages) agent.setMessages(messages);
        }
        /*
         * Said on screen rather than only counted. A turn the history store holds and this app cannot
         * parse is left out of the transcript, and a record people read back must not have a hole in
         * it that nothing accounts for. Set even when nothing was restored: a thread whose every turn
         * is unreadable is exactly the case where silence would read as "this conversation is empty".
         */
        if (isCurrent) {
          setUnreadable(stored.unreadable);
          setHistoryAvailability(stored.availability);
          // A gateway snapshot may be partial; neither it nor a later send proves this read succeeded.
          setHistoryReadFailed(stored.availability === "unavailable");
          if (stored.availability === "unavailable") {
            /*
             * 不挡输入：下面的 finally 照常放行第一条消息，重试在后台进行。全部失败后才轮到
             * channelHistoryNotice 判断要不要提示（只在什么都没恢复出来时）。
             */
            setRetryingHistory(true);
            void (async () => {
              try {
                for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
                  await new Promise((resolve) => setTimeout(resolve, delayMs));
                  if (!current) return;
                  if (await retryHistoryRead()) return;
                }
              } finally {
                if (current) setRetryingHistory(false);
              }
            })();
          }
        }
      } finally {
        // Cleared on failure too: placeholders over an empty transcript promise messages that are
        // never coming.
        if (current) setRestoring(false);
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [
    copilotkit,
    agent,
    isReady,
    channel.threadId,
    runtimeAgentId,
    retryHistoryRead,
  ]);

  /*
   * 刷新 / 切后台 / 换设备后接着看正在写的回答，别的设备发的消息几秒内出现（DESIGN.md §64，CB-041 / CB-043）。
   *
   * 和 `/bot` 同一套（§42 `useConversationSync`），变化戳由 `useThreadActivity` 每 2 秒问服务器。打开时的接入
   * 只等 JOIN_DEADLINE_MS 就截断（不能挡住第一条消息），截断时服务器可能还在写：接入结束后马上问一次，
   * 服务器说在回答就重新接上、接着实时往下写（`liveTail`：手里那半截回答按回放重建，不当作已有）。
   * 接入结束前收到的戳不处理，免得两个接入同时进行。回答在服务器上写完时再读一次存下的对话，
   * 补上这台没收到的、把截断的半截换成完整的。
   */
  const activity = useThreadActivity(runtimeAgentId, channel.threadId);
  const joinedRef = useRef(false);
  useEffect(() => {
    joinedRef.current = false;
    let alive = true;
    void joinGatePromise.then(() => {
      if (!alive) return;
      joinedRef.current = true;
      activity.kick();
    });
    return () => {
      alive = false;
    };
  }, [joinGatePromise, activity.kick]);
  const onJoinedActivity = useCallback(
    (listener: (value: ThreadActivity) => void) =>
      activity.onActivity((value) => {
        if (joinedRef.current) listener(value);
      }),
    [activity.onActivity],
  );
  const connectChat = useCallback(
    (options: { agent: typeof agent }) => copilotkit.connectAgent(options),
    [copilotkit],
  );
  const suppressConnectDuringSend = useCallback(
    () => sendInFlightRef.current,
    [],
  );
  useConversationSync(
    channel.threadId,
    agent,
    connectChat as never,
    onJoinedActivity,
    {
      liveTail: true,
      suppressConnect: suppressConnectDuringSend,
    },
  );
  useEffect(() => {
    let wasRunning = false;
    return onJoinedActivity((value) => {
      const finished = wasRunning && !value.running;
      wasRunning = value.running;
      if (!finished) return;
      void (async () => {
        // 给回放 / 实时流一点时间收尾；这台自己在跑（刚又发了一句）时不动。
        await new Promise((resolve) => setTimeout(resolve, 600));
        const current = agentRef.current;
        if (current.isRunning) return;
        const stored = await readThreadMessages(
          channel.threadId,
          runtimeAgentId,
        );
        if (stored.availability === "unavailable") return;
        const latest = agentRef.current;
        if (latest.isRunning) return;
        const merged = withStoredTail(
          mergeStoredMessages(latest.messages, stored.messages),
          stored.messages,
        );
        if (merged !== latest.messages) latest.setMessages(merged);
      })();
    });
  }, [onJoinedActivity, channel.threadId, runtimeAgentId]);

  /*
   * A turn nobody here streamed, surfaced while the channel is open.
   *
   * A relayed handoff answer runs on the server and lands in this thread with no browser attached.
   * The roster hears about it — the activity socket patches the channel-list cache — but this
   * transcript restores history once, on mount, and would show the new turn only after leaving and
   * coming back. So it watches that same cache: when this channel's `lastMessageAt` advances to a
   * moment a Bot authored, the durable history is read again. Riding the roster's own cache rather
   * than a second subscription means "the sidebar updated" and "the transcript refreshes" are the
   * one signal, and cannot drift apart.
   *
   * The same merge as mount places a recovered durable prefix before its shared local anchors,
   * preserving current content and local-only messages in both the transcript and the next run.
   *
   * Retried briefly, because the roster is patched when the turn is on record with the runner and
   * the platform's read of the thread can be a beat behind it.
   */
  useEffect(() => {
    const authoredActivity = (): ChannelActivitySignature | null => {
      const cache = queryClient.getQueryData<{
        pages: { channels: ChannelSummary[] }[];
      }>(channelKeys.list());
      const summary = cache?.pages
        .flatMap((page) => page.channels)
        .find((row) => row.id === channel.id);
      // Only a Bot's turn is news here; a person's own line arrives through the run that sent it.
      if (
        !summary ||
        summary.lastMessageAgentId === null ||
        summary.lastMessageAt === null ||
        summary.lastMessage === null
      ) {
        return null;
      }
      return {
        agentId: summary.lastMessageAgentId,
        at: summary.lastMessageAt,
        text: summary.lastMessage,
      };
    };

    const initialActivity = authoredActivity();
    let lastSeen = initialActivity;
    let cancelled = false;

    const pull = () => {
      const version = ++historyReadVersion.current;
      const isCurrent = () =>
        !cancelled && version === historyReadVersion.current;
      void (async () => {
        for (const delayMs of [0, 750, 1500]) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (!isCurrent()) return;
          const stored = await readThreadMessages(
            channel.threadId,
            runtimeAgentId,
          );
          if (!isCurrent()) return;
          if (stored.availability === "unavailable") {
            /*
             * 刷新失败不提示：这只是「别处新到的一条回复」没拉下来，屏幕上的会话完好，下一次
             * 活动还会再拉。以前这里会把「较早的消息暂时无法加载」挂到输入框上方。
             */
            continue;
          }
          // A ready read owns the notice even when every readable id is already on screen.
          setUnreadable(stored.unreadable);
          setHistoryAvailability("ready");
          setHistoryReadFailed(false);
          const current = agentRef.current;
          const messages = mergeStoredMessages(
            current.messages,
            stored.messages,
          );
          if (messages === current.messages) continue;
          current.setMessages(messages);
          return;
        }
      })();
    };

    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      const activity = authoredActivity();
      if (activity && !sameActivity(activity, lastSeen)) {
        lastSeen = activity;
        if (sameActivity(selfReportedBotActivity.current, activity)) return;
        pull();
      }
    });
    void (async () => {
      await joinGatePromise;
      if (
        !cancelled &&
        initialActivity &&
        !sameActivity(selfReportedBotActivity.current, initialActivity) &&
        // 打开时读存储已经读到了左栏说的那一句（DESIGN.md §83）：不再连读三遍。存储落后（还没有这一句）
        // 时照旧重试，等它写进来。之后的新动静照旧由上面的订阅拉。
        !(
          mountReadOk.current &&
          saysActivity(agentRef.current.messages, initialActivity.text)
        )
      ) {
        pull();
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [channel.id, channel.threadId, joinGatePromise, runtimeAgentId]);

  /*
   * 换机器人时这一页还在回答、被外壳留着等它答完（DESIGN.md §109）：另一段对话在主区里，这一页不再声明
   * 「现在看着的机器人」，也不收右栏的「问一句」、不写计算机状态行。它自己的工具调用照样按 bindAgentBot 认机器人。
   */
  const held = useKeptHeld();
  const heldRef = useRef(held);
  heldRef.current = held;
  /** 卸载之后还在跑的那一轮（`deliver` 的 await 不随卸载停下）据此知道组件已经不在了。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId, !held);

  const skillCommands = useSkillCommands(runtimeAgentId);
  /*
   * 记下这段对话的样子，下次切回来先画它（DESIGN.md §83）：恢复完成时记一次，离开（切机器人 / 换对话）时
   * 再记一次最新的。agent 会原地改它的数组，所以 `rememberTranscript` 存的是一份拷贝。
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoring) return;
    restoredRef.current = true;
    rememberTranscript(channel.threadId, agentRef.current.messages);
  }, [restoring, channel.threadId]);
  useEffect(() => {
    const threadId = channel.threadId;
    // 恢复没完成就离开：手里只有回放的一部分，不记（下次会先画出半截）。
    return () => {
      if (restoredRef.current)
        rememberTranscript(threadId, agentRef.current.messages);
    };
  }, [channel.threadId]);

  const historyNotice = channelHistoryNotice({
    restoring: restoring || retryingHistory,
    messageCount: agent.messages.length,
    lastMessageAt: channel.lastMessageAt,
    historyAvailability,
    historyReadFailed,
    unreadable,
  });

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunError] = useState<string | null>(null);
  const [waitingForModel, setWaitingForModel] = useState(false);
  const replyWaitAbort = useRef<AbortController | null>(null);
  /** 服务器说这一轮还在、却停在一步没人执行的浏览器操作上（§109）：给「停止」，并说清原因。 */
  const [relayStalled, setRelayStalled] = useState(false);
  /**
   * 服务器说这一轮还在进行、而这一页自己没在跑（别的设备发的、或执行浏览器工具的页面不是这一页）。
   * 以前这时输入框显示「空闲」：手机上还在转圈、电脑看着可以发，发出去被塞进收件箱排队，
   * 「重新生成」直接 409（2026-10-22 手机和电脑忙闲不一致）。现在这一页也显示在回答中，可以停止。
   * `waiting`：服务器只是在等别处的浏览器工具交结果（接上也看不到东西）。
   */
  const [remoteBusy, setRemoteBusy] = useState<{ waiting: boolean } | null>(null);
  const awaitingReply = useRef(false);
  /**
   * 这一轮最后一次「确实动了」的时刻（DESIGN.md §100 / DOG-01）。
   *
   * 发送看门狗原来只看「整轮多久没结束」。可一轮里用浏览器做事是好几段 run 接力，中间那一段是浏览器里
   * 的工具在跑（`computer_run_command` 最长 600 秒，见 lib/copilot/frontend-tool-activity.ts），
   * 这期间聊天这头一个字节的进展都没有：没有模型输出、没有工具结果。于是 12 秒一到就 `stopAgent()`，
   * CopilotKit 用**不带 reason** 的 `abort()` 掐掉正在跑的命令，工具结果变成
   * `Error: signal is aborted without reason`，这一轮以「运行命令 这一步出错」收尾（2026-10-20 真机）。
   *
   * 现在看门狗看的是**静默**：模型在写、工具在跑、工具结果在回来，都刷新这个时刻；真的什么都没动满
   * 12 秒（首段）查消息是否落库，180 秒静默只探测后台，仍运行就等到最终上限。
   */
  const runProgressAt = useRef(0);
  const noteRunProgress = useRef(() => {
    runProgressAt.current = Date.now();
  });
  /**
   * WHY THIS TURN ENDED WITHOUT AN ANSWER, KEPT WHERE `deliver` CAN STILL SEE IT — because the one
   * thing that knows is a subscriber, and the one thing that has to act on it is an `await`.
   *
   * `copilotkit.runAgent` DOES NOT REJECT ON A FAILED RUN. `CopilotKitCore.runAgent` catches
   * everything the agent throws, reports it through `emitError` as `AGENT_RUN_FAILED`, and returns
   * `{ result: undefined, newMessages: [] }` — a value indistinguishable from a run that finished
   * with nothing to say. So a gateway 503, a stream that dies, a model that refuses the request:
   * every one of them arrived here as a resolved promise, and `say` reported success for a turn
   * that never reached the server.
   *
   * WHAT THAT COST, WHICH IS THE REASON THIS EXISTS. `say` resolving is what every caller reads as
   * "it went". The composer clears the box and gives up the chips it was riding; the queue empties
   * into a draft nothing retries; `conversation-view.tsx` never runs either of the failure paths it
   * has written for exactly this. The person is left with the failed turn in the transcript and a
   * notice under it, the words unretryable, and the files behind them staged rows that nothing on
   * any screen points at any more. The notice is honest and everything under it was not.
   *
   * READ OFF THE SAME `fail` THE NOTICE IS, and deliberately not from a second subscription of its
   * own. `fail` already answers the one question a separate subscriber would get wrong: a turn the
   * PERSON stopped also reaches `onRunFailed`, with an abort, and `onStop` clears `awaitingReply`
   * before it — so Stop is not a failure here and nothing restores a draft somebody chose to end.
   *
   * ONE SLOT FOR ONE TURN AT A TIME, the same assumption `awaitingReply` beside it already makes.
   * Two overlapping turns — a component button pressed during a composer send — would have the
   * second clear the first's reason, which reports the earlier turn as successful. That is the
   * pre-existing shape of `awaitingReply`, not a new one, and narrowing it means giving a run a
   * handle that `copilotkit.runAgent` does not hand back.
   */
  const turnFailure = useRef<string | null>(null);
  /** 这一轮的流在浏览器这头断了（不是模型出错，DESIGN.md §89）：先不报，run 结束后问服务器这一轮怎样了。 */
  const connectionDropped = useRef(false);
  const assistantMessagesBeforeRun = useRef<Set<string>>(new Set());
  const lastReportedReply = useRef<string | null>(null);

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  /* Authoritative once this screen unmounts, where `setTurnsInFlight` becomes a no-op. */
  const turnsRef = useRef(0);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const selfReportedBotActivity = useRef<ChannelActivitySignature | null>(null);

  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = new Date().toISOString();
    if (agentId !== null) {
      selfReportedBotActivity.current = { agentId, at, text: trimmed };
    }
    recordActivity.mutate({
      agentId,
      at,
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    skillInstructions: string[],
    attachments: Attachment[],
    /** 重新生成 / 编辑后重发（§67）：原样发这份内容（带着原来的附件段），不再从文字和附件拼。 */
    contentOverride?: Message["content"],
    inboxSourceId?: string,
  ) => {
    // 模型已经不在列表里：这一轮必失败，先挡下来，别让消息堆在对话里没人回答（P1，2026-10-20）。
    if (modelMissingRef.current)
      throw new Error(
        "这个模型已下线（不在模型列表里），这一条没有发出去。点输入框右下角的模型名换一个再发。",
      );
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        afterMs(SEND_WITHOUT_RUNTIME_AFTER_MS),
      ]);
    }

    /*
     * EVERY TURN WAITS FOR THE JOIN, not just the first of a new channel: a message added while the
     * connect is in flight is erased by it either way. Unbounded only in appearance — the join
     * effect bounds itself and opens this gate from a `finally`. If that effect never ran there is
     * no runtime agent, and no connect in flight to wait on.
     */
    if (isReadyRef.current) {
      await joinGatePromise;
    }

    // Every wait is behind us, so this is the agent the screen is actually rendering. Read once and
    // used throughout, so the message, the repair and the run cannot land on two different agents.
    // A model write may have started while readiness or history was being awaited.
    assertModelSelectionNotSaving(modelQueryClient, runtimeAgentId);
    const target = agentRef.current;
    const existingMessageIds = new Set(
      target.messages.map((message) => message.id),
    );

    setRunError(null);
    setWaitingForModel(false);
    setRelayStalled(false);
    forgetTurnOutcome(channel.threadId);
    turnFailure.current = null;
    connectionDropped.current = false;
    assistantMessagesBeforeRun.current = new Set(
      target.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id),
    );
    awaitingReply.current = true;

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    for (const instruction of skillInstructions) {
      target.addMessage({
        content: instruction,
        id: newId(),
        role: "system",
      });
    }

    // An open custom-panel authoring session for this Bot rides along, so the server hands the Bot
    // its draft tools for that session (see server/src/index.ts handoffForActor).
    const panelAuthoring = await panelAuthoringForwardedProps(
      runtimeAgentId,
      trimmed,
      () =>
        void modelQueryClient.invalidateQueries({
          queryKey: panelKeys.session(runtimeAgentId),
        }),
    );
    // 人在这段等待里按了停止：不要加消息、也不要开 run，把字交回输入框（composer 收到失败会还原）。
    if (stopRequestedRef.current) {
      stopRequestedRef.current = false;
      throw new Error("已停止发送。");
    }
    const userMessageId = newId();
    target.addMessage({
      content: contentOverride ?? toMessageContent(trimmed, attachments),
      id: userMessageId,
      role: "user",
    } as Message);
    report(trimmed || describeAttachments(attachments), null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(target.messages);
    if (repaired !== target.messages) {
      target.setMessages(repaired as typeof target.messages);
    }

    setRunsInFlight((count) => count + 1);
    /*
     * 看门狗的「有进展」挂在这一轮真正在跑的 agent 上，跟着这一轮走、不跟着组件走（DESIGN.md §109）。
     * 组件里那份订阅（下面 failRef 那个 effect）在换机器人卸载聊天时就撤了，之后模型明明在写，看门狗只看得见
     * 浏览器工具：命令一结束、模型再写十几秒就被当成挂住停掉（2026-10-22 生产两次「莫名停止」，都是
     * 命令结束后整 12 秒发出 stop）。组件已经不在时出的错也在这里记下原因，切回来能看到为什么停。
     */
    const runWatch = target.subscribe({
      onEvent: () => noteRunProgress.current(),
      onRunStartedEvent: () => noteRunProgress.current(),
      onRunErrorEvent: ({ event }) => {
        if (!mountedRef.current) failRef.current(stoppedReason(event?.message));
      },
      onRunFailed: ({ error }) => {
        if (mountedRef.current) return;
        if (pausedForApproval() && isAbortFailure(error)) return;
        if (stopRequestedRef.current) return;
        failRef.current(stoppedReason(error));
      },
    });
    const waitAbort = new AbortController();
    replyWaitAbort.current = waitAbort;
    try {
      /*
       * DOG-01 实机 FAIL（v0.1.18）：sync 仍通时 connection-drop 的 10s unreachable 不会触发；
       * `/run` 被同线程超大 connect 回放拖住（或 runAgent 挂起）→ 乐观气泡静默几十秒、刷新消失。
       * 这里给 run 加硬超时：超时后停掉、查落库；没落库就可见失败并让外层把草稿放回输入框。
       */
      noteRunProgress.current();
      const runStartedAt = Date.now();
      const runPromise = copilotkit.runAgent({
        agent: target,
        ...((panelAuthoring || inboxSourceId) ? { forwardedProps: {
          ...panelAuthoring,
          ...(inboxSourceId ? { chisabotInboxResume: { sourceId: inboxSourceId, messageId: userMessageId } } : {}),
        } } : {}),
      });
      /**
       * 看门狗问的「最近一次有进展」：这一轮的 run 事件（模型在写、工具结果在回来…），或者浏览器里
       * 正在跑的前端工具（`computer_run_command` 那种，执行期间没有任何事件）。
       */
      const lastProgressAt = () =>
        Math.max(runProgressAt.current, frontendToolProgressAt());
      const race = await raceSendWatchdog(runPromise, {
        afterMs,
        timeoutMs: SEND_WATCHDOG_MS,
        lastProgressAt,
      });
      if (race === "timeout") {
        /*
         * 先查这条消息有没有进服务器，再决定停不停（DESIGN.md §109）。以前是先 stopAgent 再查：消息早已落库、
         * 服务器正在回答时，这一步就把正在写的回答掐断了，后面「再多等一会儿」等的是一轮已经被停掉的回答。
         * 只有没落库（真的挂住了）才停。
         */
        const stored = await readThreadMessages(
          channel.threadId,
          runtimeAgentId,
        ).catch(() => null);
        const persisted =
          stored != null &&
          stored.availability === "ready" &&
          stored.messages.some((message) => message.id === userMessageId);
        // First-bound decision without reply race yet.
        const first = decideSendWatchdogAction({
          firstRace: "timeout",
          persisted,
        });
        if (first.kind === "hang") {
          try {
            copilotkit.stopAgent({ agent: target });
          } catch {
            /* stop best-effort */
          }
          reportBudgetEvent(first.budget);
          forceUnlockThread(channel.threadId);
          failRef.current(first.reason);
          // Still let runPromise settle in the background so CopilotKit counters clear.
          void runPromise.catch(() => undefined);
          throw new Error(first.reason);
        }
        // 静默不等于失败：确认后台还在运行就继续等，只有墙钟总上限才自动停止。
        const reply = await waitForPersistedReply(runPromise, {
          afterMs,
          startedAt: runStartedAt,
          lastProgressAt,
          stopped: () => waitAbort.signal.aborted,
          onWaiting: (waiting) => {
            if (mountedRef.current && replyWaitAbort.current === waitAbort) setWaitingForModel(waiting);
          },
          running: async () => {
            const state = await readSync(runtimeAgentId, channel.threadId, 5_000);
            if (state === "unsupported") return "unsupported";
            return state?.thread?.threadId === channel.threadId ? state.thread.running : null;
          },
        });
        if (reply === "stopped") {
          void runPromise.catch(() => undefined);
          return;
        }
        if (reply === "timeout") {
          try {
            copilotkit.stopAgent({ agent: target });
          } catch {
            /* stop best-effort */
          }
          reportBudgetEvent("SEND_REPLY_HANG");
          forceUnlockThread(channel.threadId);
          failRef.current(SEND_REPLY_LIMIT_REASON);
          void runPromise.catch(() => undefined);
          throw new Error(SEND_REPLY_LIMIT_REASON);
        }
        if (reply === "unreachable") {
          // 状态未知：不停止后台，也不解锁。重连后由同步恢复。
          const reason = "暂时无法确认服务器上的运行状态。恢复连接或刷新后可继续查看。";
          failRef.current(reason);
          void target.detachActiveRun().catch(() => undefined);
          void runPromise.catch(() => undefined);
          throw new Error(reason);
        }
        if (reply === "server_idle") {
          // 可能只是浏览器丢了结束事件：读回已完成的回答，绝不重发任务。
          const saved = await readThreadMessages(channel.threadId, runtimeAgentId).catch(() => null);
          if (saved?.availability === "ready" && storedTurnAnswered(saved.messages as never, userMessageId)) {
            target.setMessages(withStoredTail(mergeStoredMessages(target.messages, saved.messages), saved.messages));
            awaitingReply.current = false;
            void target.detachActiveRun().catch(() => undefined);
          } else {
            failRef.current(CONNECTION_LOST_REASON);
            void target.detachActiveRun().catch(() => undefined);
            void runPromise.catch(() => undefined);
            throw new Error(CONNECTION_LOST_REASON);
          }
          void runPromise.catch(() => undefined);
        } else {
          await runPromise;
        }
      } else {
        await runPromise;
      }
    } finally {
      runWatch.unsubscribe();
      if (replyWaitAbort.current === waitAbort) {
        replyWaitAbort.current = null;
        if (mountedRef.current) setWaitingForModel(false);
      }
      setRunsInFlight((count) => Math.max(0, count - 1));
    }
    if (!stopRequestedRef.current) await persistFailedFrontendResults(channel.threadId, target.messages);

    /*
     * 流断了而不是模型出错（DESIGN.md §89）：问服务器这一轮怎样了。只读——不重发消息，设备命令不会再跑一遍。
     * 还在跑 → 不报错，接入同步（§64）几秒内接上、接着往下写；已经答完 → 读回存下的回答；
     * 都不是（服务重启 / 一直连不上）→ 说「和 ChisaBot 的连接断了」，并把没有结果的步骤收起来，卡片不再一直转。
     */
    if (connectionDropped.current && awaitingReply.current) {
      connectionDropped.current = false;
      const outcome = await settleDroppedTurn({
        running: async () => {
          const reply = await readSync(runtimeAgentId, channel.threadId);
          if (reply === "unsupported") return "unsupported";
          return reply?.thread && reply.thread.threadId === channel.threadId
            ? reply.thread.running
            : null;
        },
        answered: async () => {
          const stored = await readThreadMessages(
            channel.threadId,
            runtimeAgentId,
          );
          if (stored.availability === "unavailable") return null;
          if (!storedTurnAnswered(stored.messages as never, userMessageId))
            return false;
          const latest = agentRef.current;
          const merged = withStoredTail(
            mergeStoredMessages(latest.messages, stored.messages),
            stored.messages,
          );
          if (merged !== latest.messages) latest.setMessages(merged);
          return true;
        },
      });
      if (outcome === "lost" || outcome === "unreachable") {
        const current = agentRef.current;
        const closed = repairUnansweredToolCalls(current.messages);
        if (closed !== current.messages)
          current.setMessages(closed as typeof current.messages);
        if (outcome === "unreachable") reportBudgetEvent("SEND_UNREACHABLE");
        failRef.current(
          outcome === "unreachable"
            ? SEND_UNREACHABLE_REASON
            : CONNECTION_LOST_REASON,
        );
      } else {
        awaitingReply.current = false;
        activity.kick();
      }
    }

    /*
     * 整轮跑完了，既没报错、也不是断流（§100）：看看是不是「做了几步就没下文」。最后一条是工具结果
     * （工具出错 / 续轮到上限，CopilotKit 不再发起下一轮），或者一条空回复——都要在聊天里说清楚并给「重试」，
     * 不能静默结束。等审批卡、用户自己按停止的不算（awaitingReply 已被放下 / 最后一条是没有结果的工具调用）。
     */
    if (
      awaitingReply.current &&
      turnFailure.current === null &&
      !pausedForApproval()
    ) {
      const unfinished = unfinishedTurnReason(
        agentRef.current.messages as never,
        existingMessageIds,
      );
      if (unfinished) failRef.current(unfinished);
      else awaitingReply.current = false;
    } else if (pausedForApproval()) {
      awaitingReply.current = false;
    }

    /*
     * A TURN THAT DID NOT HAPPEN FAILS THE SEND, which is the only way anything upstream can tell.
     * See `turnFailure` for why the resolved promise above says nothing about that.
     *
     * AFTER the `finally`, not inside the `try`: the run is over either way, so the counter that
     * draws the Stop button must come down before this throws. Throwing from inside would leave
     * `runsInFlight` high for a run that has already ended.
     *
     * WHAT THE THROW REACHES, so it is clear this is a message and not a crash. The composer's
     * `catch` puts the words and the chips back; `conversation-view.tsx` puts a drained queue back
     * as retryable entries carrying their files. Nothing here reports the failure — `runError` was
     * already set from the same `fail` that set this, and the transcript already draws it — so this
     * adds a retry, not a second sentence.
     *
     * THE MESSAGE STAYS ON SCREEN. `deliver` added it above and nothing takes it away: it is what
     * the failed turn WAS, it is what the notice under it is about, and removing it would delete a
     * partial answer that a mid-stream failure had already produced. The restored draft beside it
     * is the retry, the same way a failed composer send has always put its words back while the
     * transcript kept the turn.
     */
    if (turnFailure.current !== null) {
      /*
       * 这一轮已经有了回答 / 工具调用（中途断的，用户反馈截图：「你好?」之后机器人干了几步、然后
       * 「暂时连不上模型服务」）：这条消息已经是对话的一部分，机器人也接着它做了事。再把字放回输入框，
       * 屏幕上就是「气泡里一份、输入框里又一份」，点重试还会把同一句话再发一遍。所以这时算发出去了：
       * 输入框清空、记下的草稿也清掉（DESIGN.md §88.4）；「重试」从这条消息起重新生成（`retryTurn`）。
       * 什么都没回来就失败的，照旧把字放回去（重试 = 再发一次，先拿掉失败的那份）。
       */
      if (!turnAnswered(target.messages)) throw new Error(turnFailure.current);
    }
    return target.messages
      .filter(
        (message) =>
          message.role === "assistant" && !existingMessageIds.has(message.id),
      )
      .map(messageText)
      .filter(Boolean)
      .join("\n\n");
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  /**
   * 停止发生在发送链路中途（消息还没进 agent）时的取消标记。`deliver` 在下一个 await 之后看到它
   * 就放弃这一轮；否则停止只 abort 一个还不存在的 run，消息照发、回答照流（实机复现见 CHAT-01）。
   */
  const stopRequestedRef = useRef(false);

  const say = async (
    text: string,
    skillInstructions: string[] = [],
    attachments: Attachment[] = [],
    contentOverride?: Message["content"],
    inboxSourceId?: string,
  ) => {
    const trimmed = text.trim();
    // A pasted screenshot with no caption is still a message to send: `canSendDraft` already
    // unlocks the button for exactly this case, so refusing it here would leave the button
    // enabled and inert.
    if (!trimmed && attachments.length === 0 && contentOverride === undefined)
      return "";

    stopRequestedRef.current = false;

    // Seeds and component actions share the same gate as the composer.
    assertModelSelectionNotSaving(modelQueryClient, runtimeAgentId);

    // Every request shares this turn boundary, including gaps between frontend tools.
    if (turnsRef.current > 0 || agentRef.current.isRunning) {
      throw new Error("代理仍在处理另一个请求。请等待或先停止该任务。");
    }

    turnsRef.current += 1;
    setTurnsInFlight(turnsRef.current);
    sendInFlightRef.current = true;
    if (turnsRef.current === 1) {
      void setChannelBusy({ channelId: channel.id, busy: true });
    }
    try {
      return await deliver(
        trimmed,
        skillInstructions,
        attachments,
        contentOverride,
        inboxSourceId,
      );
    } finally {
      // 停止会把计数直接清零，这里无条件减会变成负数，导致 sendInFlight 永远卡住（CHAT-02）。
      turnsRef.current = Math.max(0, turnsRef.current - 1);
      setTurnsInFlight(turnsRef.current);
      if (turnsRef.current === 0) sendInFlightRef.current = false;
      // Sent from here rather than from an effect on `turnsInFlight`: this runs after unmount, that
      // does not, and the last turn out is what takes the roster's working indicator down.
      if (turnsRef.current === 0) {
        void setChannelBusy({ channelId: channel.id, busy: false });
      }
    }
  };

  const failRef = useRef<(message: string) => void>(() => {});
  useEffect(() => {
    const fail = (message: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      // Both halves of one fact: the sentence the transcript shows, and the reason `deliver` throws
      // so the draft behind the turn is restored rather than counted as sent. See `turnFailure`.
      turnFailure.current = message;
      setRunError(message);
      // 组件卸载后（换机器人）才出的事，重新挂上的聊天从这里读回原因（DESIGN.md §109）。
      const lastUser = [...agentRef.current.messages].reverse().find((item) => item.role === "user");
      rememberTurnOutcome(channel.threadId, lastUser?.id ?? null, message);
    };
    failRef.current = fail;
    const subscription = agent.subscribe?.({
      /*
       * 任何事件都算「这一轮在动」，看门狗只对静默报警（见 runProgressAt）。文案在写、工具调用在长、
       * 工具结果回来了，都在这里刷新；浏览器里的工具执行没有事件，由 frontend-tool-activity 代言。
       */
      onEvent: () => noteRunProgress.current(),
      onRunStartedEvent: () => noteRunProgress.current(),
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => {
        noteRunProgress.current();
        fail(stoppedReason(event?.message));
      },
      onRunFailed: ({ error }) => {
        noteRunProgress.current();
        // 等审批卡时的那次中止是正常暂停，不是出错（§100）。
        if (pausedForApproval() && isAbortFailure(error)) return;
        // 浏览器这头的连接断了：先别报（更别说成「连不上模型服务」），deliver 里问过服务器再定（§89）。
        if (awaitingReply.current && isConnectionDrop(error)) {
          connectionDropped.current = true;
          return;
        }
        fail(stoppedReason(error));
      },
      onRunFinishedEvent: () => {
        noteRunProgress.current();
        /*
         * 不在这里把 awaitingReply 放下（DESIGN.md §100）。一轮里用浏览器做事是好几个 run 接力：第一个 run
         * 以工具调用结束，浏览器做完再发起下一个。以前第一个 run 一结束就放下，后面接力的 run 出错、断流，
         * `fail` 一看 awaitingReply 是 false 就不报了——这一轮静默结束。现在等 `deliver` 里整轮跑完才放下。
         */
        if (!awaitingReply.current) return;

        const reply = [...agent.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              !assistantMessagesBeforeRun.current.has(message.id),
          );
        const content = typeof reply?.content === "string" ? reply.content : "";
        // 一轮里每个接力的 run 结束都会来这里；同一条回答只报一次。
        if (
          content &&
          reply &&
          lastReportedReply.current !== `${reply.id}:${content.length}`
        ) {
          lastReportedReply.current = `${reply.id}:${content.length}`;
          reportRef.current(content, runtimeAgentId);
        }
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId, channel.threadId]);

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => {
    const onSendPaused = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; id: string; accept: (run: () => Promise<unknown>) => void }>).detail;
      if (!detail || detail.threadId !== channel.threadId || typeof detail.accept !== "function") return;
      detail.accept(async () => {
        const item = queuedFor(channel.threadId).find((item) => item.id === detail.id && item.status === "paused");
        if (!item) throw new Error("这条消息已不再暂停，请刷新后查看。");
        try {
          return await sayRef.current(item.text, [], [], undefined, item.id);
        } finally {
          await restoreQueue(channel.threadId);
        }
      });
    };
    window.addEventListener("chisabot-send-paused", onSendPaused);
    return () => window.removeEventListener("chisabot-send-paused", onSendPaused);
  }, [channel.threadId]);

  // 「已停止」（2026-10-13 第四轮）：本机刚按停止的那一轮 + 服务器记下的（刷新、换设备也在）。
  const [localStops, setLocalStops] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const serverStops = useStoppedTurnIds(channel.threadId);
  // 上一条用户消息的服务器发送时刻（§94：30 分钟内连续发消息不翻页；§94.7 补了「回答中补话」）。
  const lastSentAt = useLastSentAt(channel.threadId);
  const stoppedTurns = useMemo(
    () => new Set([...serverStops, ...localStops]),
    [serverStops, localStops],
  );
  const stopTask = () => {
    // Anchor 「已停止」 on the person-sent user turn that opened this run — skip schedule/worker
    // markers that also wear role=user, otherwise the chip can stick to an earlier completed reply.
    const lastUser =
      [...agent.messages].reverse().find((message) => {
        if (message.role !== "user") return false;
        const text = typeof message.content === "string" ? message.content : "";
        return isPersonSentMessage("user", text);
      }) ??
      [...agent.messages].reverse().find((message) => message.role === "user");
    if (lastUser)
      setLocalStops((previous) => new Set([...previous, lastUser.id]));
    // Also blocks inbox fallback after Stop during a frontend tool handoff.
    stopRequestedRef.current = true;
    replyWaitAbort.current?.abort();
    setWaitingForModel(false);
    awaitingReply.current = false;
    // Track B：停止必须立刻放下 busy，不能干等 runPromise/finally——否则频道永久灰。
    turnsRef.current = 0;
    setTurnsInFlight(0);
    setRunsInFlight(0);
    sendInFlightRef.current = false;
    void setChannelBusy({ channelId: channel.id, busy: false });
    forceUnlockThread(channel.threadId);
    setRemoteBusy(null);
    if (relayStalled) {
      setRelayStalled(false);
      setRunError((previous) => (previous === STALLED_RELAY_REASON ? null : previous));
    }
    try {
      copilotkit.stopAgent({ agent });
    } catch {
      /* stop best-effort */
    }
  };

  /*
   * 切回来（或刷新后）重新挂上的聊天：上一轮在这页不在时没正常结束，把记下的原因画出来（DESIGN.md §109）。
   * 只在恢复完历史之后读一次，而且那一轮还得是最后一轮。
   */
  useEffect(() => {
    if (restoring) return;
    const remembered = turnOutcomeFor(channel.threadId, agentRef.current.messages);
    if (remembered) setRunError((previous) => previous ?? remembered);
  }, [restoring, channel.threadId]);

  /*
   * 这一轮停在一步浏览器操作上，却没有人在执行它（§109）：服务器还在等那一步的结果（最长 25 分钟都算「在回答」），
   * 可执行它的页面已经刷新 / 关掉了。以前这里只会一直转（切回来时还每 2 秒重接一次，图标来回跳）。
   * 服务器说在回答、这一页自己没在跑、事件序号 30 秒没动、最后一条是还没有结果的工具调用：说清楚，并给「停止」。
   * 序号一动（那一步在别处做完了、接着往下写）就收回。
   */
  useEffect(() => {
    let since: { seq: string; at: number } | null = null;
    const clear = () => {
      setRelayStalled(false);
      setRunError((previous) => (previous === STALLED_RELAY_REASON ? null : previous));
    };
    return onJoinedActivity((value) => {
      const local = turnsRef.current > 0 || agentRef.current.isRunning;
      if (!value.running || local) {
        if (since) clear();
        since = null;
        return;
      }
      if (!since || since.seq !== value.seq) {
        if (since) clear();
        since = { seq: value.seq, at: Date.now() };
        return;
      }
      if (Date.now() - since.at < STALLED_RELAY_MS) return;
      if (!hasUnansweredToolCall(agentRef.current.messages)) return;
      setRelayStalled(true);
      setRunError((previous) => previous ?? STALLED_RELAY_REASON);
    });
  }, [onJoinedActivity]);

  /*
   * 服务器说在进行、这一页没在跑：显示「回答中」。连续两次戳都这样才算（本机一轮刚结束时服务器还在收尾的
   * 那一两秒、接入刚断到补接上之间，不闪一下）。接入还在往下写时 `agent.isRunning` 本来就是真的，这里不插手。
   */
  useEffect(() => {
    let seen = 0;
    setRemoteBusy(null);
    return onJoinedActivity((value) => {
      const local = turnsRef.current > 0 || agentRef.current.isRunning;
      if (!value.running || local) {
        seen = 0;
        setRemoteBusy((previous) => (previous ? null : previous));
        return;
      }
      seen += 1;
      if (seen < 2) return;
      const waiting = value.waiting === true;
      setRemoteBusy((previous) => (previous?.waiting === waiting ? previous : { waiting }));
    });
  }, [onJoinedActivity]);

  /*
   * 这一页有一轮在进行（包括浏览器工具在跑）：每 20 秒向服务器报一次平安。服务器在两段模型运行之间保留
   * 「等浏览器工具交结果」的接力；执行工具的这一页刷新 / 关掉 / 睡着之后，结果永远不会来，没有这个心跳就要干等满
   * 25 分钟，期间别的设备一直看到「在回答」。报过平安的接力，静默 150 秒服务器就放开。
   */
  const turnActive = turnsInFlight > 0;
  useEffect(() => {
    if (!turnActive) return;
    pingRelayAlive(channel.threadId);
    const timer = setInterval(() => pingRelayAlive(channel.threadId), RELAY_ALIVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [turnActive, channel.threadId]);

  /*
   * 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：服务器先从那条用户消息起截掉（只认本人的对话、没在回答），
   * 本机截到同一处，再照常发一轮——重新生成原样发原来的内容（新 id），编辑发改过的文字（附件留着）。
   * 回答进行中按钮不出现；万一撞上（别的设备刚发了一句）服务器回 409，按钮 ✕ + 原因。
   */
  const resendFrom = async (
    fromMessageId: string,
    mode: TruncateMode,
    content: Message["content"],
  ) => {
    if (turnsRef.current > 0 || agentRef.current.isRunning)
      throw new Error("机器人正在回答，等它说完再试。");
    await truncateConversation(channel.threadId, fromMessageId, mode);
    const target = agentRef.current;
    const at = target.messages.findIndex(
      (message) => message.id === fromMessageId,
    );
    if (at >= 0)
      target.setMessages(
        target.messages.slice(0, at) as typeof target.messages,
      );
    setRunError(null);
    setLocalStops((previous) => {
      if (!previous.has(fromMessageId)) return previous;
      const next = new Set(previous);
      next.delete(fromMessageId);
      return next;
    });
    // 发送失败时 say 会抛：按钮 ✕，对话里照常显示失败原因（runError），用户那条留着可以再点重新生成。
    await sayRef.current(contentText(content), [], [], content);
  };
  const resendRef = useRef(resendFrom);
  resendRef.current = resendFrom;
  const regenerate = useCallback(async () => {
    const list = agentRef.current.messages;
    const at = lastUserIndex(list);
    if (at < 0) throw new Error("没有可以重新生成的回答。");
    const user = list[at]!;
    await resendRef.current(
      user.id,
      "regenerate",
      user.content as Message["content"],
    );
  }, []);
  /**
   * 重发「发出去但没有回答」的那一条（刷新后才认出来的那种，P1 2026-10-20）：从它那里重发一轮，
   * 走和「重新生成」同一条路（服务器截断 → 本机截断 → 原样再发）。
   */
  const retryUnanswered = useCallback(() => {
    const list = agentRef.current.messages;
    const at = lastUserIndex(list);
    if (at < 0) return;
    const user = list[at]!;
    void resendRef
      .current(user.id, "regenerate", user.content as Message["content"])
      .catch(() => undefined);
  }, []);
  const editAndResend = useCallback(async (messageId: string, text: string) => {
    const user = agentRef.current.messages.find(
      (message) => message.id === messageId,
    );
    if (!user || user.role !== "user")
      throw new Error("这条消息已经不在了，刷新看看。");
    const content = withEditedText(user.content, text);
    if (content === null) throw new Error("消息不能是空的。");
    await resendRef.current(messageId, "edit", content as Message["content"]);
  }, []);

  // 主模型额度用完、这一轮换了备用模型：那一轮末尾一行淡色小字（DESIGN.md §61）。
  const fallbackTurns = useFallbackTurns(channel.threadId);

  /*
   * 回答期间发的消息进服务器收件箱（DESIGN.md §38.1；CB-046 从 `/bot` 搬来）：正在跑的那一轮下一步就读到；
   * 一轮结束时还没被读到的、刷新前 / 别的设备排的，由 useThreadInbox 接回来、按普通消息补发。
   * 补发的那一轮也算「在跑」（Stop 能停、输入框显示在回答）。
   */
  const queueToServer = useCallback(
    (text: string) => queueMessage(channel.threadId, text),
    [channel.threadId],
  );
  const runInboxTurn = useCallback(
    async (options: { agent: typeof agent }) => {
      turnsRef.current += 1;
      setTurnsInFlight(turnsRef.current);
      sendInFlightRef.current = true;
      stopRequestedRef.current = false;
      setRunsInFlight((count) => count + 1);
      try {
        const result = await copilotkit.runAgent(options);
        if (!stopRequestedRef.current && await persistFailedFrontendResults(channel.threadId, options.agent.messages)) {
          turnFailure.current = unfinishedTurnReason(options.agent.messages as never, new Set()) ?? "工具执行失败。";
        }
        return result;
      } finally {
        setRunsInFlight((count) => Math.max(0, count - 1));
        turnsRef.current = Math.max(0, turnsRef.current - 1);
        setTurnsInFlight(turnsRef.current);
        if (turnsRef.current === 0) sendInFlightRef.current = false;
      }
    },
    [copilotkit, channel.threadId],
  );
  useThreadInbox(channel.threadId, agent, runInboxTurn as never, {
    pullServerTurns: false,
    turnRunning: turnsInFlight > 0,
    canFlush: () => turnsRef.current === 0 && !stopRequestedRef.current && turnFailure.current === null,
  });

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   *
   * The rejection is swallowed HERE rather than left to the void, and that is not a style choice:
   * `say` throws on a failed turn now (see `turnFailure`), and a voided promise with nothing on the
   * end of it is an unhandled rejection — in this repository's test runner, a failure attributed to
   * whichever test happened to be running when it surfaced. There is nothing to restore for this
   * caller either way: the words came from a button inside a rendered card, not from a box somebody
   * is still holding, and the failed turn is already reported by `runError` under the transcript.
   */
  const askFromComponent = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said) return;
      // 正在回答时：进收件箱，下一步读到（§38.1），不再报「代理仍在处理另一个请求」。
      if (turnsRef.current > 0 || agentRef.current.isRunning) {
        void queueMessage(channel.threadId, said).then((outcome) => {
          if (outcome === "send")
            void sayRef.current(said).catch(() => undefined);
        });
        return;
      }
      void sayRef.current(said).catch(() => undefined);
    },
    [channel.threadId],
  );
  // 右栏面板（不在这棵组件树里）里的「问一句」发 chisabot-ask 事件（DESIGN.md §29）：发到当前对话。
  useEffect(() => {
    const on = (event: Event) => {
      // 留着等它答完的那段不是「当前对话」（§109）。
      if (heldRef.current) return;
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text === "string") askFromComponent(text);
    };
    window.addEventListener("chisabot-ask", on);
    return () => window.removeEventListener("chisabot-ask", on);
  }, [askFromComponent]);

  /**
   * Send the create-channel seed once. No waiting of its own: `say` owns that for every turn, and a
   * second copy of the ordering here was the one that could disagree with it.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    // Swallowed for the reason `askFromComponent` above records: `say` throws on a failed turn, and
    // the seed has no box to go back into — it was typed on a screen that has already navigated
    // away. The transcript keeps the seeded message and the notice under it says what happened.
    void sayRef
      .current(typeof pending.content === "string" ? pending.content : "")
      .catch(() => undefined);

    // Keep `seed` in state; transcriptMessages gives it up once the agent holds a user turn.
  }, []);

  // 机器人还在回复时，「有新版本」的刷新先确认（lib/activity.ts）。
  useReportBusy(`chat:${channel.id}`, agent.isRunning || turnsInFlight > 0);
  // 计算机状态行在两步之间不退回空闲提示（use-status.ts）。
  const chatBusy = agent.isRunning || turnsInFlight > 0;
  // 这一页自己没在跑、服务器说在进行：输入框也是「回答中」，可以停止、重新生成 / 编辑不可用（不然只会撞 409）。
  const anyBusy = chatBusy || remoteBusy !== null;
  useEffect(() => {
    if (held) return;
    reportChatRunning(chatBusy);
    return () => reportChatRunning(false);
  }, [chatBusy, held]);
  // 这一轮还没结束：外壳换对话时把这页留着，等它答完再放（DESIGN.md §109）。
  useMarkChatWorking(channel.id, chatBusy);
  const canResend = !anyBusy && channel.active && !restoring && !modelSaving;
  const messageActions = useMemo(
    () => ({ canAct: canResend, regenerate, edit: editAndResend }),
    [canResend, regenerate, editAndResend],
  );

  return (
    // Activity renderers resolve their agent through this SDK context. It must match useAgent's
    // channel instance so an action continues this thread instead of looking for a default agent.
    <CopilotChatConfigurationProvider
      agentId={channelAgentId}
      threadId={channel.threadId}
    >
      <ConversationProvider ask={askFromComponent}>
        <MessageActionsContext.Provider value={messageActions}>
          <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
            <ConversationView
              modelControl={
                <BotModelSelector
                  agentId={runtimeAgentId}
                  compact
                  disabled={!channel.active}
                />
              }
              leadingControl={
                <PermissionChip
                  agentId={runtimeAgentId}
                  disabled={!channel.active}
                />
              }
              contextControl={
                <ContextMeter
                  agentId={runtimeAgentId}
                  running={anyBusy}
                  threadId={channel.threadId}
                />
              }
              sendBlocked={modelSaving}
              agents={toAgentOptions(agentProfiles, channel.agentIds)}
              channelId={channel.id}
              draftKey={channel.id}
              scrollKey={channel.id}
              /*
               * THE TURN, not the run. `say` waits for the runtime agent and the join before a run starts,
               * and `agent.isRunning` alone leaves that gap unmarked — which is the one moment the
               * "Thinking" line exists for. Same value as `pending`, deliberately.
               */
              busy={anyBusy}
              // The `/` menu exposes only skills granted to this Bot.
              commands={skillCommands}
              // Readiness is handled by `say`; deletion is the only disabled-chat state.
              disabled={!channel.active}
              messages={transcriptMessages(
                restoring
                  ? (early ?? cached ?? EMPTY_MESSAGES)
                  : agent.messages,
                seed,
              )}
              transcriptNotice={
                historyNotice ? (
                  <HistoryNotice
                    onRetry={
                      historyNotice === HISTORY_UNAVAILABLE_NOTICE
                        ? retryHistoryRead
                        : undefined
                    }
                    text={historyNotice}
                  />
                ) : null
              }
              notice={
                /*
                 * Two things can be worth saying at once — a deleted coworker and a history with holes in
                 * it — and they are independent, so neither is an `else` for the other.
                 */
                <>
                  {waitingForModel ? (
                    <p className="pb-2 text-sm text-muted-foreground" role="status">
                      {SEND_REPLY_WAITING_NOTICE}
                    </p>
                  ) : null}
                  <HandoffResumeNotice
                    botId={runtimeAgentId}
                    agent={agent}
                    ready={isReady && !restoring && channel.active}
                    run={async () => {
                      setRunsInFlight((count) => count + 1);
                      try {
                        await copilotkit.runAgent({ agent });
                      } finally {
                        setRunsInFlight((count) => count - 1);
                      }
                    }}
                  />
                  {channel.active ? null : (
                    <p
                      className="pb-2 text-sm text-muted-foreground"
                      role="status"
                    >
                      {"这个机器人已被删除。对话还能看，但它不会再回复。"}
                    </p>
                  )}
                  {remoteBusy?.waiting && !chatBusy ? (
                    <p
                      className="pb-2 text-sm text-muted-foreground"
                      role="status"
                    >
                      {"这一轮在等另一处（比如另一台设备上的浏览器操作）把结果交回来。太久没动静会自动放开，也可以点「停止」。"}
                    </p>
                  ) : null}
                </>
              }
              onSubmit={async (draft) => {
                assertModelSelectionNotSaving(modelQueryClient, runtimeAgentId);
                // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
                // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
                // per-message mention is a change to that binding, not to the composer.
                //
                // `commandIds` are the `/` chips that survived into the send, in the order they were
                // typed. Resolved against the same list the menu was built from, so a chip left over from
                // a skill that has since been revoked resolves to nothing rather than to a stale
                // instruction — the menu is refetched, and this reads from it.
                const skillInstructions = draft.commandIds
                  .map(
                    (id) =>
                      skillCommands.find((command) => command.id === id)
                        ?.prompt,
                  )
                  .filter((instruction): instruction is string =>
                    Boolean(instruction),
                  );

                // §94.7：提交这一刻机器人还在回答 → 这一句是接着聊，不翻页。busy 在按下发送的同时就变 true，
                // 等这条消息落地、出现在列表里时它已经是 true 了，那时候再判会把每一次发送都当成「回答中」。
                noteSendWhileBusy(anyBusy);
                await say(draft.text, skillInstructions, draft.attachments);
              }}
              /**
               * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
               * unanswered tool call before the next turn.
               */
              onStop={stopTask}
              /*
               * The turn, not the run. A browser action ends one run and starts another, and telling the
               * conversation it is idle in between is what would drain a parked correction into the
               * middle of an answer: a second turn racing the first on one thread, with a fabricated
               * result stitched over a tool call that is still executing.
               */
              pending={anyBusy}
              /*
               * A channel outlives its turns, so it is the screen where waiting is worth offering. A
               * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
               * moment this one is over — including when it is over because somebody pressed the button
               * above.
               */
              queueWhileBusy
              restoring={restoring || retryingHistory}
              hydrating={restoring}
              /*
               * The turn, not only the run. DOG-01：`/run` 被拖住时 runsInFlight 已加、但主线程可能来不及
               * 重绘；更要紧的是 joinGate / panelAuthoring 空档里还没有 run——这时也必须能按停止取消发送，
               * 不能干等 watchdog。Stop 在无 abortController 时仍清 awaitingReply + stopAgent（best-effort）。
               */
              stoppable={
                agent.isRunning ||
                runsInFlight > 0 ||
                turnsInFlight > 0 ||
                remoteBusy !== null ||
                relayStalled
              }
              /*
               * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
               * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
               * appear, and the person is already looking at it; an explanation in the composer area is a
               * different part of the screen from the thing it explains.
               *
               * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
               * streaming says so, because the deployment's stall watchdog writes that sentence into the
               * run before closing it; see server/src/channels/stall-guard.ts.
               */
              stopped={runError ?? undefined}
              stoppedTurns={stoppedTurns}
              fallbacks={fallbackTurns}
              lastSentAt={lastSentAt}
              queueToServer={queueToServer}
              /*
               * The retry resends the restored draft, which adds the message again. Take the failed
               * turn's copy out first, but only when nothing came back under it: a partial answer is
               * part of the conversation and stays.
               */
              onRetryTurn={() => {
                // 中途断的一轮（已经有回答 / 工具调用）：字没放回输入框，重试 = 从这条消息起重新生成（§88.4）。
                if (!turnAnswered(agentRef.current.messages)) return false;
                void regenerate().catch(() => undefined);
                return true;
              }}
              onRetryUnanswered={retryUnanswered}
              onBeforeRetry={() => {
                const target = agentRef.current;
                const list = target.messages;
                let lastUser = -1;
                for (let i = list.length - 1; i >= 0; i -= 1) {
                  if (list[i]?.role === "user") {
                    lastUser = i;
                    break;
                  }
                }
                if (lastUser < 0) return;
                const answered = list
                  .slice(lastUser + 1)
                  .some(
                    (message) =>
                      message.role === "assistant" || message.role === "tool",
                  );
                if (answered) return;
                target.setMessages(list.slice(0, lastUser) as typeof list);
                setRunError(null);
              }}
            />
          </div>
        </MessageActionsContext.Provider>
      </ConversationProvider>
    </CopilotChatConfigurationProvider>
  );
}

/**
 * 会话顶部（不是输入框上方）的一句历史提示；读不到时带「重试」按钮。按钮走 DESIGN.md 的按钮状态机：
 * 重试中… → 已加载 / 仍无法加载。
 */
function HistoryNotice({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => Promise<boolean>;
}) {
  const retry = useAsyncAction(
    async () => {
      if (!onRetry) return;
      if (!(await onRetry())) throw new Error("仍无法加载");
    },
    { errorToast: false },
  );
  return (
    <div className="chat-history-notice" role="status">
      <span>{text}</span>
      {onRetry ? (
        <Button
          feedback={{
            pending: "重试中…",
            success: "已加载",
            error: "仍无法加载",
          }}
          onClick={() => void retry.run()}
          size="sm"
          state={retry.state}
          type="button"
          variant="outline"
        >
          {"重试"}
        </Button>
      ) : null}
    </div>
  );
}

/** 最后一条用户消息之后已经有回答或工具调用（这一轮机器人已经接着它做了事）。 */
export function turnAnswered(list: readonly Message[]): boolean {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]!;
    if (message.role === "user") return false;
    if (message.role === "assistant" || message.role === "tool") return true;
  }
  return false;
}

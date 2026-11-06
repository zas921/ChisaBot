import { IconMessages, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type BotThreadSummary,
  deleteBotThread,
  readThreadHistory,
} from "@/lib/copilot/bot-thread";
import { cn } from "@/lib/utils";

/** 「刚刚 / 3 分钟前 / 5 小时前 / 10月12日」（跨年带年份）。 */
function whenText(at: string | null): string {
  if (!at) return "";
  const ms = Date.now() - Date.parse(at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    "zh-CN",
    sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" },
  );
}

/**
 * 「历史对话」（DESIGN.md §42.6 / §68）：机器人 ⋯ 菜单里打开。列出你和这个机器人的对话（最近 30 条，频道聊天的
 * 和以前 `/bot` 的都在），点一条在频道聊天里打开（没有频道的旧对话由服务器补一个）。
 * 可删除旧对话：服务端级联清消息、事件（含思考片段）和持续任务行，不另建思考表。
 */
export function BotThreadHistoryDialog({
  agentId,
  currentThreadId,
  open,
  onOpenChange,
  onPick,
  onDeletedCurrent,
}: {
  agentId: string;
  currentThreadId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (threadId: string) => void;
  /** 删掉的是当前打开的对话时：外面应切到新话题，避免继续挂已删 id。 */
  onDeletedCurrent?: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["bot-thread-history", agentId],
    queryFn: () => readThreadHistory(agentId),
    enabled: open,
    staleTime: 0,
    gcTime: 60_000,
  });
  const remove = useMutation({
    mutationFn: (threadId: string) => deleteBotThread(threadId),
    onSuccess: (result, threadId) => {
      if (result === "ok") {
        setError(null);
        void queryClient.invalidateQueries({ queryKey: ["bot-thread-history", agentId] });
        if (threadId === currentThreadId) {
          onOpenChange(false);
          onDeletedCurrent?.();
        }
        return;
      }
      if (result === "busy") setError("对话还在回答，请先停止再删除。");
      else if (result === "missing") setError("这条对话已经不在了。");
      else setError("删除失败，请稍后再试。");
    },
    onError: () => setError("删除失败，请稍后再试。"),
  });
  const threads: BotThreadSummary[] = list.data && list.data !== "unsupported" ? list.data : [];
  const pick = (threadId: string) => {
    onOpenChange(false);
    if (threadId !== currentThreadId) onPick(threadId);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="bot-history max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{"历史对话"}</DialogTitle>
          <DialogDescription>
            {"点一条打开接着聊。删除会清掉该对话的消息、思考记录和未完成的持续任务，不可恢复。"}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="bot-history-empty text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bot-history-list" role="list">
          {list.isPending ? (
            [0, 1, 2].map((i) => <div aria-hidden className="bot-history-skel" key={i} />)
          ) : list.isError ? (
            <p className="bot-history-empty">
              {"历史对话没加载出来。"}
              <button className="bot-history-retry" onClick={() => void list.refetch()} type="button">
                {"重试"}
              </button>
            </p>
          ) : list.data === "unsupported" || threads.length === 0 ? (
            <p className="bot-history-empty">{"还没有别的对话。"}</p>
          ) : (
            threads.map((thread) => {
              const current = thread.threadId === currentThreadId;
              return (
                <div
                  className={cn("bot-history-row", current && "is-current")}
                  key={thread.threadId}
                  role="listitem"
                >
                  <button
                    aria-current={current ? "true" : undefined}
                    className="bot-history-open"
                    onClick={() => pick(thread.threadId)}
                    type="button"
                  >
                    <IconMessages aria-hidden className="bot-history-icon" />
                    <span className="bot-history-main">
                      <span className="bot-history-title">{thread.title}</span>
                      <span className="bot-history-sub">
                        {`${thread.messages} 条消息 · ${whenText(thread.updatedAt)}`}
                      </span>
                    </span>
                    {current ? <span className="bot-history-badge">{"当前"}</span> : null}
                  </button>
                  <button
                    aria-label={`删除对话：${thread.title}`}
                    className="bot-history-delete"
                    data-testid="bot-history-delete"
                    disabled={remove.isPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (
                        !window.confirm(
                          `删除「${thread.title}」？消息、思考记录和该对话上的持续任务都会去掉，且不可恢复。`,
                        )
                      )
                        return;
                      setError(null);
                      remove.mutate(thread.threadId);
                    }}
                    type="button"
                  >
                    <IconTrash aria-hidden className="size-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

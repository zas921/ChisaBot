import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { tryClient } from "@/lib/client";
import { useKeptVisible } from "@/lib/kept-visible";
import { readSync } from "./bot-thread";

/**
 * 后台任务（DESIGN.md §38.2；服务器 server/src/workers/service.ts）在界面上的数据：这个对话里委派过的
 * 任务、它们的状态 / 当前步骤 / 清单。有任务在跑时每 1.5 秒取一次，都结束了就停。
 */
export type WorkerStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type WorkerPlanStep = { text: string; status: "done" | "current" | "pending" | "blocked" };
export type WorkerView = {
  id: string;
  title: string;
  status: WorkerStatus;
  step: string | null;
  plan: WorkerPlanStep[];
  summary: string | null;
  error: string | null;
  resultMessageId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export const ACTIVE_WORKER: readonly WorkerStatus[] = ["queued", "running", "waiting"];
export const workerKeys = {
  thread: (threadId: string) => ["thread-workers", threadId] as const,
  activity: (agentId: string, workerId: string) => ["worker-live-activity", agentId, workerId] as const,
};

export function workersApi(threadId: string) {
  return `/api/copilotkit/threads/${encodeURIComponent(threadId)}/workers`;
}

export function useThreadWorkers(threadId: string | null | undefined) {
  const visible = useKeptVisible();
  const workers = useQuery({
    queryKey: workerKeys.thread(threadId ?? ""),
    enabled: Boolean(threadId),
    queryFn: async ({ signal }): Promise<WorkerView[]> => {
      const response = await tryClient(workersApi(threadId!), { signal, timeoutMs: 8_000 });
      if (!response.ok) throw new Error(`后台任务进度暂时无法刷新（${response.status}）`);
      const body = await response.json() as { workers?: WorkerView[] };
      if (!Array.isArray(body.workers)) throw new Error("暂时无法读取后台任务进度");
      return body.workers;
    },
    // An empty list must still discover a task started on another device.
    refetchInterval: (query) => (query.state.data ?? []).some((worker) => ACTIVE_WORKER.includes(worker.status))
      ? visible ? 1_500 : 10_000
      : visible ? 10_000 : false,
    refetchOnWindowFocus: visible,
    retry: 1,
    retryDelay: 1_500,
    staleTime: 1000,
  });
  const wasVisible = useRef(visible);
  const refetch = workers.refetch;
  useEffect(() => {
    const resumed = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (resumed && threadId) void refetch({ cancelRefetch: false });
  }, [visible, threadId, refetch]);
  return workers;
}

export type WorkerLiveActivity = { seq: string; running: boolean; detectedAt: number | null };

/** Observe the worker's small event cursor. First contact and successful polls are not new activity. */
export function useWorkerLiveActivity(worker: WorkerView, agentId: string | undefined) {
  const visible = useKeptVisible();
  const queryClient = useQueryClient();
  const active = ACTIVE_WORKER.includes(worker.status);
  const queryKey = workerKeys.activity(agentId ?? "", worker.id);
  const activity = useQuery({
    queryKey,
    enabled: active && Boolean(agentId),
    queryFn: async (): Promise<WorkerLiveActivity> => {
      const threadId = `worker-${worker.id}`;
      const reply = await readSync(agentId!, threadId, 5_000);
      if (!reply || reply === "unsupported" || reply.thread?.threadId !== threadId) throw new Error("暂时无法更新后台活动");
      const previous = queryClient.getQueryData<WorkerLiveActivity>(queryKey);
      return {
        seq: reply.thread.seq,
        running: reply.thread.running,
        detectedAt: previous && previous.seq !== reply.thread.seq ? Date.now() : previous?.detectedAt ?? null,
      };
    },
    refetchInterval: active ? visible ? 3_000 : 10_000 : false,
    refetchOnWindowFocus: visible,
    retry: 1,
    staleTime: 1_000,
  });
  const wasVisible = useRef(visible);
  const refetch = activity.refetch;
  useEffect(() => {
    const resumed = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (resumed && active && agentId) void refetch({ cancelRefetch: false });
  }, [visible, active, agentId, refetch]);
  return activity;
}

/** 停止 / 补充说明。完成后立刻刷新卡片。 */
export function useWorkerAction(threadId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(
    async (workerId: string, action: "cancel" | "steer", text?: string) => {
      if (!threadId) throw new Error("no thread");
      const response = await fetch(workersApi(threadId), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId, action, ...(text ? { text } : {}) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "操作失败");
      }
      await queryClient.invalidateQueries({ queryKey: workerKeys.thread(threadId) });
    },
    [threadId, queryClient],
  );
}

export const WORKER_RESULT_MARKER = "⟦chisabot:worker-result:";

/** 「⟦chisabot:worker-result:<id>:<status>⟧\n后台任务「标题」已完成。\n\n结果…」拆开。 */
export function parseWorkerResult(text: string): { workerId: string; status: string; headline: string; body: string } | null {
  if (!text.startsWith(WORKER_RESULT_MARKER)) return null;
  const end = text.indexOf("⟧");
  if (end < 0) return null;
  const [workerId = "", status = ""] = text.slice(WORKER_RESULT_MARKER.length, end).split(":");
  const rest = text.slice(end + 1).replace(/^\n/, "");
  const [headline = "", ...lines] = rest.split("\n");
  // 旧结果里工人自己写进去的标记（服务器现在会剥掉）也不显示。
  const body = lines.join("\n").replace(/⟦chisabot:[^⟧\n]{0,200}⟧[ \t]*/gu, "").trim();
  return { workerId, status, headline: headline.trim(), body };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export const WORKER_STATUS_ZH: Record<WorkerStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting: "等待你",
  done: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

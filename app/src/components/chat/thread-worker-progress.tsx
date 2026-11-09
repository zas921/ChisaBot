import { useId, useEffect, useState } from "react";
import { IconChevronDown, IconRefresh } from "@tabler/icons-react";
import { showsWorkerCard, WorkerCardBody } from "./worker-card";
import { useDismissedWorkers } from "@/lib/copilot/worker-dismissals";
import { ACTIVE_WORKER, formatElapsed, useThreadWorkers, useWorkerLiveActivity, type WorkerView } from "@/lib/copilot/workers";
import "./thread-worker-progress.css";

/** Always available above the composer, even when the original delegation message is folded away. */
export function ThreadWorkerProgress({ threadId, agentId }: { threadId: string; agentId?: string }) {
  const workers = useThreadWorkers(threadId);
  const { dismissed, dismiss } = useDismissedWorkers(threadId);
  const [open, setOpen] = useState(true);
  const regionId = useId();
  const rows = (workers.data ?? []).filter((worker) => showsWorkerCard(worker, dismissed));
  const active = rows.filter((worker) => ACTIVE_WORKER.includes(worker.status));
  const failures = rows.filter((worker) => worker.status === "failed")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const summary = [active.length ? `${active.length} 项进行中` : "", failures.length ? `${failures.length} 项失败` : ""]
    .filter(Boolean).join(" · ");
  if (!rows.length && !workers.isError) return null;
  return (
    <section aria-label="后台任务进度" className="thread-worker-progress" data-thread-id={threadId}>
      <header className="thread-worker-progress-head">
        <button aria-controls={regionId} aria-expanded={open} className="thread-worker-progress-toggle" onClick={() => setOpen((value) => !value)} type="button">
          <IconChevronDown aria-hidden className={open ? "size-4" : "size-4 -rotate-90"} />
          <strong>{"后台任务"}</strong>
          <span>{summary}</span>
          <span>{open ? "收起进度" : "展开进度"}</span>
        </button>
        <button aria-label="刷新后台任务进度" className="thread-worker-progress-refresh" disabled={workers.isFetching} onClick={() => void workers.refetch({ cancelRefetch: false })} title="刷新后台任务进度" type="button">
          <IconRefresh aria-hidden className="size-4" />
        </button>
      </header>
      {workers.isError ? <p className="thread-worker-progress-error" role="status">{"进度暂时无法刷新，正在重试；保留上次记录。"}</p> : null}
      <div hidden={!open} id={regionId}>
        <ol className="thread-worker-progress-list">
          {[...active, ...failures].map((worker) => (
            <li data-worker-id={worker.id} key={worker.id}>
              <WorkerCardBody compact={active.length > 1} onDismiss={dismiss} threadId={threadId} worker={worker} />
              {ACTIVE_WORKER.includes(worker.status) ? <WorkerActivity worker={worker} agentId={agentId} /> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function WorkerActivity({ worker, agentId }: { worker: WorkerView; agentId: string | undefined }) {
  const activity = useWorkerLiveActivity(worker, agentId);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const detectedAt = activity.data?.detectedAt;
  const elapsed = detectedAt == null ? null : Math.max(0, now - detectedAt);
  return (
    <p className="thread-worker-progress-activity" data-testid="worker-live-activity">
      {elapsed !== null
        ? `本页检测到进展：${elapsed < 1_000 ? "刚刚" : `${formatElapsed(elapsed)}前`}`
        : activity.data ? "已连接后台，正在追踪新的进展" : agentId ? "正在连接后台进展…" : "正在等待新的进度上报"}
      {activity.isError ? <span>{" · 连接暂时不可用，正在重试"}</span> : null}
    </p>
  );
}

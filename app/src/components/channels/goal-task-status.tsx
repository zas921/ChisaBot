import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { client } from "@/lib/client";

type GoalView = {
  id: string;
  objective: string;
  status: string;
  detail: string | null;
  criteria: { id: string; title: string; passed?: boolean; detail?: string }[];
  jobs: { jobId: string; status: string }[];
};
const labels: Record<string, string> = {
  active: "自动继续中",
  running: "正在执行",
  waiting_background: "等待后台作业完成",
  waiting_device: "等待设备重新上线",
  waiting_approval: "等待审批或输入",
  paused: "已暂停",
  completed: "全部验收通过",
  cancelled: "已放弃",
};
const liveStatuses = new Set([
  "active",
  "running",
  "waiting_background",
  "waiting_device",
  "waiting_approval",
  "paused",
]);

/** A fixed-size composer control: changing task phases never moves the transcript. */
export function GoalTaskStatus({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const key = ["goal-task", threadId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      client<GoalView[]>(
        `/api/goal-tasks?threadId=${encodeURIComponent(threadId)}`,
        "tasks",
        { signal, fallback: "无法读取持续任务状态" },
      ),
    refetchInterval: 3000,
    staleTime: 1000,
  });
  const task = data?.find((row) => liveStatuses.has(row.status));
  const change = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") =>
      client(`/api/goal-tasks/${task?.id}/${action}`, {
        method: "POST",
        fallback: "无法修改持续任务状态",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  if (!task) return null;
  const passed = task.criteria.filter((c) => c.passed).length;
  return (
    <>
      <Button
        aria-label={`持续任务：${labels[task.status] ?? task.status}，验收 ${passed}/${task.criteria.length}`}
        className="h-7 w-[88px] shrink-0 px-1 text-xs"
        data-testid="goal-task-status"
        onClick={() => setOpen(true)}
        size="sm"
        title={labels[task.status]}
        variant="ghost"
      >
        任务 {passed}/{task.criteria.length}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              持续任务 · {labels[task.status] ?? task.status}
            </DialogTitle>
            <DialogDescription>{task.objective}</DialogDescription>
          </DialogHeader>
          <p className="text-sm" role="status">
            {task.detail}
          </p>
          <ul className="space-y-3 text-sm">
            {task.criteria.map((criterion) => (
              <li key={criterion.id}>
                <strong>
                  {criterion.passed ? "✓" : "○"} {criterion.title}
                </strong>
                {criterion.detail ? (
                  <p className="mt-1 text-muted-foreground">
                    {criterion.detail}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {task.jobs.length ? (
            <p className="text-xs text-muted-foreground">
              后台作业：
              {task.jobs.map((j) => `${j.jobId}（${j.status}）`).join("、")}
            </p>
          ) : null}
          {change.error ? (
            <p className="text-sm text-destructive" role="alert">
              {change.error.message}
            </p>
          ) : null}
          {liveStatuses.has(task.status) ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                data-testid="goal-task-toggle"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate(
                    task.status === "paused" || task.status === "waiting_approval"
                      ? "resume"
                      : "pause",
                  )
                }
              >
                {task.status === "paused" || task.status === "waiting_approval"
                  ? "恢复持续任务"
                  : "停止持续任务"}
              </Button>
              <Button
                data-testid="goal-task-cancel"
                disabled={change.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "放弃后将释放本对话的任务槽位，可以重新登记新目标。已完成的步骤不会撤销。确定放弃？",
                    )
                  )
                    change.mutate("cancel");
                }}
                variant="outline"
              >
                {"放弃任务"}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

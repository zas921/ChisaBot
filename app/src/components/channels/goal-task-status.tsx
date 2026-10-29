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
};

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
  const task = data?.[0];
  const change = useMutation({
    mutationFn: (action: "pause" | "resume") =>
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
          {task.status !== "completed" ? (
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
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

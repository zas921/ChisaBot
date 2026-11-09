import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { type VideoJob, useVideoProjects, videoStateLabels } from "@/lib/video-production/queries";
import { delegatedVideoSteps, videoReviewStatus, videoReviewVerdicts } from "@/lib/video-production/presentation";
import { PanelCard } from "./panel-card";
import { VideoReviewDialog } from "@/components/channels/video-review-panel";
import { VideoProjectDeleteDialog } from "./video-project-delete-dialog";

const steps = ["素材", "写稿", "稿件确认", "配音合成", "成片确认", "发布"];
const currentStages: Record<string, { index: number; label: string }> = {
  preparing: { index: 0, label: "处理中" },
  awaiting_script: { index: 1, label: "待写稿" },
  awaiting_script_approval: { index: 2, label: "待你确认" },
  render_queued: { index: 3, label: "排队中" },
  rendering: { index: 3, label: "制作中" },
  awaiting_video_approval: { index: 4, label: "待你确认" },
  approved: { index: 5, label: "待安排" },
  publish_queued: { index: 5, label: "排队中" },
  publishing: { index: 5, label: "投稿中" },
  publish_uncertain: { index: 5, label: "待核对" },
};
const nextSteps: Record<string, string> = {
  preparing: "正在准备视频和字幕素材，完成后进入写稿。",
  awaiting_script: "素材已准备好，等待 Bot 保存解说稿和分镜。",
  awaiting_script_approval: "点击本面板的“查看与审核”，核对稿件后确认制作。",
  render_queued: "稿件已确认，等待后台开始配音和合成。",
  rendering: "后台正在配音和合成。成片完成后，需要你预览并确认。",
  awaiting_video_approval: "点击本面板的“查看与审核”，检查全部成片后再确认。",
  approved: "成片已确认，尚未发布。可下载，或在聊天中安排投稿。",
  publish_queued: "发布任务已排队，尚未投稿成功。",
  publishing: "正在提交平台，请等待平台明确返回投稿结果。",
  published: "平台已接受投稿；是否通过平台审核，请到平台查看。",
  publish_uncertain: "投稿结果不明确，请先到平台核对，避免重复提交。",
  needs_configuration: "任务需要补充配置。请查看下面的原因，在聊天中处理后再继续。",
  failed: "制作暂时停止。请查看下面的原因，在聊天中处理后再继续。",
  cancelled: "任务已取消。如需继续，请在聊天中说明。",
  deleting: "正在停止后台任务并清理本项目的文件，完成后会自动移除。",
};
const settledStates = new Set(["published", "cancelled"]);
const workingStates = new Set(["preparing", "rendering"]);
/** Longer than any single step normally takes; the worker reports before each step starts. */
const STALLED_SECONDS = 300;

function elapsed(seconds: number) {
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}

/** Real steps from the worker, so "still working" and "stuck" can be told apart. */
function WorkingStep({ progress }: { progress: NonNullable<VideoJob["progress"]> }) {
  const age = progress.ageSeconds ?? 0;
  const stalled = age >= STALLED_SECONDS;
  return <div className="space-y-1.5" data-testid="video-progress-step" data-stalled={stalled}>
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="min-w-0 break-words font-medium">{progress.label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{progress.percent}%</span>
    </div>
    <div aria-label="制作进度" aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.percent} role="progressbar"
      className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${stalled ? "bg-destructive" : "bg-primary"}`} style={{ width: `${progress.percent}%` }} />
    </div>
    <p className={`text-xs ${stalled ? "text-destructive" : "text-muted-foreground"}`} role={stalled ? "alert" : undefined}>
      {stalled ? `已经 ${Math.floor(age / 60)} 分钟没有新进展，可能卡住了。可以在聊天里让 Bot 查看或重试。` : `上次进展：${elapsed(age)}`}
    </p>
  </div>;
}

/** The worker persists Unix seconds, while older API adapters may return an ISO timestamp. */
function timestamp(value: string | number | undefined) {
  const number = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function completedStages(job: VideoJob) {
  const videos = job.artifacts?.filter((artifact) => /\.mp4$/i.test(artifact.name)) ?? [];
  return [
    Boolean(job.sources?.length), Boolean(job.script?.segments.length), Boolean(job.scriptApproved),
    Boolean(videos.length && job.artifactHash), Boolean(job.videoApproved), job.reviewPolicy?.mode === "delegate_export" ? videoReviewStatus(job).exportComplete : job.state === "published",
  ];
}

/** Progress and project actions share the right rail. Approval stays bound to the displayed version. */
export function VideoProgressPanel({ botId, empty = null }: { botId: string; empty?: ReactNode }) {
  const auth = useQuery(currentUserQueryOptions());
  if (auth.isError || !auth.data) return null;
  return <OwnedVideoProgressPanel key={`${auth.data.id}:${botId}`} botId={botId} ownerId={auth.data.id} empty={empty} />;
}

function OwnedVideoProgressPanel({ botId, ownerId, empty }: { botId: string; ownerId: string; empty: ReactNode }) {
  const jobs = useVideoProjects(ownerId, botId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoJob | null>(null);
  // Explicit ownership checks also reject mismatched cached or malformed responses.
  const visible = (jobs.isError ? [] : jobs.data?.jobs ?? [])
    .filter((job) => job.ownerId === ownerId && job.botId === botId)
    .sort((a, b) => Number(settledStates.has(a.state)) - Number(settledStates.has(b.state)) ||
      timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt));
  const job = visible.find((item) => item.id === selectedId) ?? visible[0];
  if (!job && !jobs.error) return jobs.isSuccess ? empty : null;
  const updated = job ? timestamp(job.updatedAt) : 0;
  const videos = job?.artifacts?.filter((artifact) => /\.mp4$/i.test(artifact.name)) ?? [];
  const ratios = job?.aspectRatios ?? [];
  const outputs = ratios.map((ratio) => ratio === "16:9" ? "横版 16:9" : ratio === "9:16" ? "竖版 9:16" : ratio).join("、");
  const review = job ? videoReviewStatus(job) : undefined;
  const current = review?.delegated ? review.current : job ? currentStages[job.state] : undefined;
  const stageLabels = review?.delegated ? delegatedVideoSteps : steps;
  const done = job ? completedStages(job) : [];
  if (review?.rework) done[1] = false;
  return <section className="glass-card live-panel" aria-label="视频制作进度" data-testid="video-progress-panel"
    data-job-id={job?.id} data-state={job?.state}>
    <PanelCard title="视频制作进度" preferenceKey={`video-progress:${ownerId}:${botId}`}
      menu={<Button variant="ghost" size="icon-sm" aria-label="刷新视频进度" disabled={jobs.isFetching}
        onClick={() => { void jobs.refetch(); }}><IconRefresh className={jobs.isFetching ? "size-4 animate-spin" : "size-4"} /></Button>}>
      <div className="space-y-4 px-3 pb-3 text-sm">
        {jobs.error ? <p className="break-words text-destructive" role="alert">视频进度暂不可用：{jobs.error.message}</p> : null}
        {job ? <>
          {visible.length > 1 ? <label className="block space-y-1 text-xs text-muted-foreground">
            <span>视频项目</span>
            <select aria-label="选择视频项目" className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              value={job.id} onChange={(event) => setSelectedId(event.target.value)}>
              {visible.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label> : null}
          <div className="space-y-1.5">
            <h3 className="break-words font-medium leading-6">{job.title}</h3>
            <p className="font-medium" data-testid="video-progress-status" role="status">{review?.stateLabel ?? videoStateLabels[job.state] ?? "状态待核对"} · 第 {job.revision} 版</p>
            <p className="text-xs text-muted-foreground">状态更新：{updated ? <time dateTime={new Date(updated).toISOString()}>
              {new Date(updated).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
            </time> : "暂无记录"}</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="视频项目操作">
            <Button size="sm" variant="outline" disabled={job.state === "deleting"} onClick={() => setReviewId(job.id)}>{review?.delegated ? "查看审核与成片" : "查看与审核"}</Button>
            <Button size="sm" variant="destructive" disabled={job.state === "publishing" || (job.state === "deleting" && !job.error)}
              onClick={() => setDeleteTarget(job)}>{job.state === "deleting" ? job.error ? "重试清理" : "删除中…" : "删除项目"}</Button>
          </div>
          <ol aria-label="制作阶段" className="space-y-2" data-testid="video-progress-stages">
            {stageLabels.map((label, index) => {
              const active = current?.index === index && !done[index];
              return <li key={label} className="flex items-center gap-2" data-step={index} data-complete={done[index]}
                aria-current={active ? "step" : undefined}>
                <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${done[index] ? "border-primary/25 bg-primary/10 text-primary" : active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}>
                  {done[index] ? <IconCheck className="size-3.5" /> : index + 1}
                </span>
                <span className={active ? "font-medium" : "text-muted-foreground"}>{label}</span>
                <span className={`ml-auto text-xs ${active ? "font-medium" : "text-muted-foreground"}`}>
                  {done[index] ? index === 5 ? review?.delegated ? "链接已交付" : "已投稿" : "已完成" : active ? current.label : "待处理"}
                </span>
              </li>;
            })}
          </ol>
          {review?.delegated ? <section className="space-y-2 rounded-lg border border-border p-3 text-xs" aria-label="主 bot 审核结果" data-testid="video-progress-review">
            <p className="break-all font-medium">主审核 bot：{review.reviewer}</p>
            <p className="text-muted-foreground">当前第 {review.attempt + 1} 轮审核{job.reviewRevisionRequests ? ` · 已退回 ${job.reviewRevisionRequests} 次内容修改` : ""}</p>
            <p className="leading-5 text-muted-foreground">此审核方式覆盖旧制作要求中的人工确认流程，其他质量要求仍有效。</p>
            {review.latest ? <>
              <p className="font-medium">{review.rereview ? "上轮结论" : "最新结论"}：{videoReviewVerdicts[review.latest.decision] ?? review.latest.decision} · {review.latest.stage === "script" ? "稿件" : "成片"} v{review.latest.revision}</p>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-5" data-testid="video-progress-review-notes">{review.latest.notes || review.latest.summary || "审核未附文字说明。"}</p>
            </> : <p className="text-muted-foreground">当前{review.stage === "script" ? "稿件" : "成片"}尚未形成审核结论。</p>}
            {review.history.length ? <details>
              <summary className="cursor-pointer font-medium">审核历史（{review.history.length}）</summary>
              <ol className="mt-2 max-h-64 space-y-3 overflow-y-auto">
                {review.history.map((entry, index) => <li key={`${entry.stage}:${entry.revision}:${entry.reviewAttempt ?? 0}:${index}`} className="space-y-1 border-t border-border pt-2">
                  <p>{entry.stage === "script" ? "稿件" : "成片"} v{entry.revision} · 第 {(entry.reviewAttempt ?? 0) + 1} 轮 · {videoReviewVerdicts[entry.decision] ?? entry.decision}</p>
                  <p className="whitespace-pre-wrap break-words leading-5 text-muted-foreground">{entry.notes || entry.summary || "未附文字说明"}</p>
                </li>)}
              </ol>
            </details> : null}
            {review.retrying ? <div role="status" className="space-y-1 border-t border-border pt-2">
              <p>系统将继续重试，已尝试 {job.autopilot?.attempts ?? 1} 次。</p>
              {job.autopilot?.nextAttemptAt ? <p>计划重试：{new Date(job.autopilot.nextAttemptAt * 1000).toLocaleString("zh-CN", { hour12: false })}</p> : null}
              {job.autopilot?.lastError ? <p className="break-words text-muted-foreground">{job.autopilot.lastError}</p> : null}
            </div> : null}
          </section> : null}
          {job.progress && workingStates.has(job.state) ? <WorkingStep progress={job.progress} /> : null}
          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center" data-testid="video-progress-counts">
            <div><dt className="text-xs text-muted-foreground">素材</dt><dd className="mt-1 font-medium" data-testid="video-progress-sources">{job.sources?.length ?? 0} 条</dd></div>
            <div><dt className="text-xs text-muted-foreground">稿件</dt><dd className="mt-1 font-medium" data-testid="video-progress-segments">{job.script?.segments.length ?? 0} 段</dd></div>
            <div><dt className="text-xs text-muted-foreground">成片</dt><dd className="mt-1 font-medium" data-testid="video-progress-artifacts">{videos.length} 个</dd></div>
          </dl>
          <p className="break-words text-xs text-muted-foreground" data-testid="video-progress-formats">输出：{outputs || "暂未指定"}</p>
          <div className="space-y-1 rounded-lg bg-muted p-3" data-testid="video-progress-next-step">
            <p className="font-medium">接下来</p>
            <p className="break-words text-xs leading-5">{review?.nextStep ?? nextSteps[job.state] ?? "暂时无法判断下一步，请在聊天中查看项目情况。"}</p>
          </div>
          {job.error ? <p className="break-words text-xs leading-5 text-destructive" role="alert">{job.error}</p> : null}
          <p className="text-xs text-muted-foreground">{review?.footer}</p>
        </> : null}
      </div>
    </PanelCard>
    {reviewId && visible.some((item) => item.id === reviewId) ? <VideoReviewDialog key={`${ownerId}:${botId}:${reviewId}`}
      jobId={reviewId} botId={botId} ownerId={ownerId} latest={visible.find((item) => item.id === reviewId)} onClose={() => setReviewId(null)} /> : null}
    {deleteTarget ? <VideoProjectDeleteDialog key={`${ownerId}:${botId}:${deleteTarget.id}`} job={deleteTarget}
      latest={visible.find((item) => item.id === deleteTarget.id)} ownerId={ownerId} botId={botId} onClose={() => setDeleteTarget(null)}
      onDeleted={(id) => { setDeleteTarget(null); if (reviewId === id) setReviewId(null); if (selectedId === id) setSelectedId(null); }} /> : null}
  </section>;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { downloadVideoAsset, type VideoDownloadProgress } from "../../../../shared/video-download";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { type VideoJob, useVideoRequest, videoStateLabels as stateLabels } from "@/lib/video-production/queries";
import { videoReviewStatus, videoReviewVerdicts } from "@/lib/video-production/presentation";

type ReviewContext = { job: VideoJob; csrf: string };
const jobPath = (id: string) => `/api/video-production/jobs/${encodeURIComponent(id)}`;
const assetPath = (id: string, name: string) => `${jobPath(id)}/assets/${encodeURIComponent(name)}`;

function sourceTime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const layoutLabels: Record<string, string> = { heading: "标题", stat: "数字", list: "要点列表", compare: "对比" };

function sameVersion(a: VideoJob, b: VideoJob) {
  return a.revision === b.revision && a.scriptHash === b.scriptHash &&
    a.artifactHash === b.artifactHash && a.state === b.state &&
    JSON.stringify([a.reviewPolicy, a.reviewAttempt, a.reviewPaused, a.reviews, a.exportReceipt, a.autopilot, a.scriptApproved, a.videoApproved]) ===
    JSON.stringify([b.reviewPolicy, b.reviewAttempt, b.reviewPaused, b.reviews, b.exportReceipt, b.autopilot, b.scriptApproved, b.videoApproved]);
}

/** The snapshot stays fixed while reading. Approval always submits the version on screen. */
export function VideoReviewDialog({ jobId, botId, ownerId, latest, onClose }: {
  jobId: string; botId: string; ownerId: string; latest?: VideoJob; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const videoRequest = useVideoRequest(ownerId);
  const [scriptRead, setScriptRead] = useState(false);
  const [videoWatched, setVideoWatched] = useState(false);
  const [notice, setNotice] = useState("");
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const downloadController = useRef<AbortController | null>(null);
  const [download, setDownload] = useState<(VideoDownloadProgress & { name: string; active: boolean; error?: string }) | null>(null);
  useEffect(() => () => downloadController.current?.abort(), [ownerId, jobId]);
  const review = useQuery({
    queryKey: ["video-review", ownerId, botId, jobId],
    queryFn: async ({ signal }) => {
      const value = await videoRequest<ReviewContext>(`${jobPath(jobId)}/review-context`, { signal });
      if (value.job?.id !== jobId || value.job.botId !== botId || value.job.ownerId !== ownerId || !value.csrf) {
        throw new Error("无法核对视频项目，请关闭后重试。");
      }
      return value;
    },
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => query.state.data?.job.reviewPolicy?.mode === "delegate_export" && !download?.active ? 8000 : false,
    retry: false,
  });
  const job = review.isError ? undefined : review.data?.job;
  const status = job ? videoReviewStatus(job) : undefined;
  const changed = !!job && !!latest && !sameVersion(job, latest);
  // Delegated review is read-only, so new verdicts/rework are visible without a manual reload.
  // Human review retains its fixed snapshot; a policy change still invalidates those controls.
  useEffect(() => {
    if (changed && (status?.delegated || latest?.reviewPolicy?.mode === "delegate_export") && !download?.active && !review.isFetching) {
      void review.refetch();
    }
  }, [changed, status?.delegated, latest, download?.active]);
  const approval = useMutation({
    mutationFn: ({ stage, revision, hash, csrf }: {
      stage: "script" | "video"; revision: number; hash: string; csrf: string;
    }) => videoRequest(`${jobPath(jobId)}/approve-${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Video-CSRF": csrf },
      body: JSON.stringify({ revision, hash }),
    }),
    onSuccess: async (_, submitted) => {
      setNotice(submitted.stage === "script"
        ? `第 ${submitted.revision} 版稿件已确认，正在安排制作。成片完成后仍需你确认。`
        : `第 ${submitted.revision} 版成片已确认，可以下载；发布可在聊天中继续安排。`);
      setScriptRead(false);
      setVideoWatched(false);
      await Promise.all([
        review.refetch(),
        queryClient.invalidateQueries({ queryKey: ["video-projects", ownerId, botId] }),
      ]);
    },
  });
  useEffect(() => {
    setScriptRead(false);
    setVideoWatched(false);
    setMediaErrors({});
  }, [review.dataUpdatedAt]);
  const busy = review.isFetching || approval.isPending;
  const blocked = busy || changed || review.isError || approval.isError || !review.data;
  const refresh = () => {
    setScriptRead(false);
    setVideoWatched(false);
    setNotice("");
    approval.reset();
    void review.refetch();
    void queryClient.invalidateQueries({ queryKey: ["video-projects", ownerId, botId] });
  };
  const approve = (stage: "script" | "video") => {
    const context = review.data;
    const hash = stage === "script" ? context?.job.scriptHash : context?.job.artifactHash;
    if (blocked || !context || context.job.reviewPolicy?.mode === "delegate_export" || latest?.reviewPolicy?.mode === "delegate_export" || !hash || !(stage === "script" ? scriptRead : videoWatched)) return;
    approval.mutate({ stage, revision: context.job.revision, hash, csrf: context.csrf });
  };
  const startDownload = async (artifact: NonNullable<VideoJob["artifacts"]>[number]) => {
    if (downloadController.current || !job || changed) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownload({ name: artifact.name, received: 0, total: artifact.bytes ?? 0, phase: "downloading", active: true });
    try {
      await downloadVideoAsset({
        url: `${assetPath(job.id, artifact.name)}?download=1&version=${encodeURIComponent(job.artifactHash ?? String(job.revision))}`,
        name: artifact.name, expectedBytes: artifact.bytes ?? NaN, sha256: artifact.sha256 ?? "", signal: controller.signal,
        onProgress: (progress) => setDownload({ ...progress, name: artifact.name, active: progress.phase !== "saved" }),
      });
    } catch (error) {
      setDownload((previous) => previous ? { ...previous, active: false, error: controller.signal.aborted ? "下载已取消，未保存文件。" : error instanceof Error ? error.message : "下载失败，未保存文件，请重试。" } : null);
    } finally { if (downloadController.current === controller) downloadController.current = null; }
  };
  const videos = job?.artifacts?.filter((artifact) => /\.mp4$/i.test(artifact.name)) ?? [];
  const qc = job?.artifacts?.find((artifact) => artifact.kind === "qc");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl" data-testid="video-review-dialog">
        <DialogHeader>
          <DialogTitle>{status?.delegated ? "主 bot 审核与成片" : "视频审核"}{job ? ` · 第 ${job.revision} 版` : ""}</DialogTitle>
          <DialogDescription>
            {job ? `${job.title} · ${status?.stateLabel ?? stateLabels[job.state] ?? job.state}` : "正在载入完整稿件与成片…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{status?.delegated ? "稿件与成片由主 bot 审核，返修后自动复核，通过后导出交付。" : "稿件和成片分别由你确认。"}</p>
            <Button size="sm" variant="outline" disabled={busy || !!download?.active} onClick={refresh}>重新载入最新版本</Button>
          </div>
          {review.isPending ? <p role="status">正在载入视频项目…</p> : null}
          {review.error || approval.error ? (
            <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
              {(review.error ?? approval.error)?.message}
            </p>
          ) : null}
          {changed ? (
            <p className="rounded-lg border border-border bg-muted p-3" role="alert">
              {status?.delegated ? "审核状态已更新，正在载入最新稿件与结果；下载期间将在下载结束后更新。" : "项目版本或状态已变化。请点击“重新载入最新版本”，重新核对内容后再确认。"}
            </p>
          ) : null}
          {notice ? <p className="rounded-lg bg-muted p-3" role="status">{notice}</p> : null}
          {job?.error ? <p className="text-destructive" role="alert">{job.error}</p> : null}
          {job ? <>
            {status?.delegated ? <section aria-label="主 bot 审核结果" data-testid="video-review-delegated" className="space-y-3 rounded-lg border border-border p-3 text-sm">
              <p className="break-all font-medium">主审核 bot：{status.reviewer} · 第 {status.attempt + 1} 轮审核</p>
              <p className="break-words leading-6" role="status">{status.nextStep}</p>
              {status.latest ? <>
                <p className="font-medium">{status.rereview ? "上轮结论" : "最新结论"}：{videoReviewVerdicts[status.latest.decision]} · {status.latest.stage === "script" ? "稿件" : "成片"} v{status.latest.revision}</p>
                <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words leading-6" data-testid="video-review-delegated-notes">{status.latest.notes || status.latest.summary || "审核未附文字说明。"}</p>
              </> : <p className="text-muted-foreground">当前{status.stage === "script" ? "稿件" : "成片"}尚未形成审核结论。</p>}
              {status.history.length ? <details>
                <summary className="cursor-pointer font-medium">审核历史（{status.history.length}）</summary>
                <ol className="mt-2 max-h-64 space-y-3 overflow-y-auto">
                  {status.history.map((entry, index) => <li key={`${entry.stage}:${entry.revision}:${entry.reviewAttempt ?? 0}:${index}`} className="space-y-1 border-t border-border pt-2">
                    <p>{entry.stage === "script" ? "稿件" : "成片"} v{entry.revision} · 第 {(entry.reviewAttempt ?? 0) + 1} 轮 · {videoReviewVerdicts[entry.decision]}</p>
                    <p className="whitespace-pre-wrap break-words leading-6 text-muted-foreground">{entry.notes || entry.summary || "未附文字说明"}</p>
                  </li>)}
                </ol>
              </details> : null}
              <p className="text-xs text-muted-foreground">审核意见、返修和导出状态每 8 秒自动更新。当前授权为审核与导出，不包含投稿。</p>
            </section> : null}
            <section aria-label="完整稿件" className="space-y-4" data-testid="video-review-script">
              <div>
                <h3 className="font-semibold">稿件与分镜 · 第 {job.revision} 版{job.scriptApproved ? status?.delegated ? " · 主 bot 已通过" : " · 已确认" : ""}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{status?.delegated ? "主 bot 按实际素材审核文案与分镜；退回意见由制作 bot 自动处理，再交主 bot 复核。" : "需要修改时，可回到聊天告诉 Bot；修改后的稿件需要重新确认。"}</p>
              </div>
              {job.script ? <>
                <h4 className="break-words font-medium">{job.script.title}</h4>
                {job.script.summary ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{job.script.summary}</p> : null}
                {job.script.tags?.length ? <p className="break-words text-xs text-muted-foreground">标签：{job.script.tags.join(" · ")}</p> : null}
                {job.scriptWarnings?.length ? <div data-testid="video-review-script-warnings" className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
                  <p className="font-medium">信息卡阅读提示</p>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {job.scriptWarnings.map((warning, index) => <li key={index} className="break-words">{warning.message}</li>)}
                  </ul>
                  <p className="text-xs text-muted-foreground">制作时会留足阅读时间。为避免长时间停顿，可让 Bot 精简卡片或补充逐条讲解。</p>
                </div> : null}
                <ol className="space-y-3">
                  {job.script.segments.map((segment, index) => <li key={index} data-testid="video-review-segment" className="space-y-2 rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">段落 {index + 1} · {segment.visual === "card" ? `信息卡画面${segment.layout && segment.layout !== "heading" ? `（${layoutLabels[segment.layout]}）` : ""}` : segment.visual === "quote" ? "原声片段（播放原作者声音，下方为中文字幕）" : "引用素材画面"}</p>
                    <p className="whitespace-pre-wrap break-words leading-7">{segment.visual === "quote" ? "字幕译文：" : ""}{segment.text}</p>
                    {segment.caption ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">画面文字：{segment.caption}</p> : null}
                    {segment.items?.length ? <ul data-testid="video-review-items" className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      {segment.items.map((item, itemIndex) => <li key={itemIndex} className="break-words">{item}</li>)}
                    </ul> : null}
                    {segment.visual !== "card" ? <ul data-testid="video-review-shots" className="space-y-1 text-xs text-muted-foreground">
                      {(segment.visual === "source" && segment.shots?.length ? segment.shots : [{ sourceId: segment.sourceId ?? "", start: segment.start ?? NaN, end: segment.end ?? NaN }]).map((shot, shotIndex, all) => <li key={shotIndex} className="break-words">
                        {all.length > 1 ? `镜头 ${shotIndex + 1} · ` : ""}素材：{job.sources?.find((source) => source.id === shot.sourceId)?.title ?? (shot.sourceId || "未标注")}
                        {" · 原片 "}{sourceTime(shot.start)}–{sourceTime(shot.end)}
                      </li>)}
                    </ul> : null}
                  </li>)}
                </ol>
                {!status?.delegated && job.state === "awaiting_script_approval" ? <div className="space-y-3 rounded-lg bg-muted p-3">
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={scriptRead} disabled={blocked}
                      onChange={(event) => setScriptRead(event.target.checked)} />
                    <span>我已阅读第 {job.revision} 版完整稿件和分镜，同意按此稿制作。</span>
                  </label>
                  <Button className="w-full sm:w-auto" disabled={blocked || !scriptRead || !job.scriptHash || !job.script.segments.length}
                    onClick={() => approve("script")}>确认第 {job.revision} 版稿件并开始制作</Button>
                  <p className="text-xs text-muted-foreground">此确认会开始配音和合成；发布前还需你审核成片。</p>
                </div> : null}
              </> : <p className="text-muted-foreground">稿件尚未完成。准备好后会在这里显示全文。</p>}
            </section>
            <section aria-label="成片审核" className="space-y-4 border-t border-border pt-4">
              <h3 className="font-semibold">{status?.delegated && !job.videoApproved ? "待审成片预览" : "成片预览"}{job.videoApproved ? status?.delegated ? " · 主 bot 已通过" : " · 已确认" : ""}</h3>
              {status?.delegated && videos.length ? <p className="text-xs text-muted-foreground">{status.exportComplete ? "当前版本已审核通过并交付导出链接，可下载成片。" : job.videoApproved ? "当前版本已审核通过，正在交付导出链接。" : "以下为当前制作版本，尚未通过主 bot 审核；预览和下载不代表审核通过或最终交付。"}</p> : null}
              {videos.length ? videos.map((artifact) => <figure key={artifact.name} className="space-y-2">
                <figcaption className="break-words text-xs text-muted-foreground">{artifact.aspectRatio ? `${artifact.aspectRatio} · ` : ""}{artifact.name}</figcaption>
                <video key={`${job.revision}:${job.artifactHash}:${artifact.name}`} controls playsInline preload="metadata"
                  aria-label={`${artifact.aspectRatio ?? "视频"}成片预览`}
                  className="max-h-[55svh] w-full rounded-lg bg-black"
                  src={`${assetPath(job.id, artifact.name)}?version=${encodeURIComponent(job.artifactHash ?? String(job.revision))}`}
                  onError={() => setMediaErrors((previous) => ({ ...previous, [artifact.name]: true }))} />
                {mediaErrors[artifact.name] ? <p role="alert" className="text-destructive">预览暂时无法播放，可以下载后检查画面、配音和字幕。</p> : null}
              </figure>) : <p className="text-muted-foreground">成片制作完成后，这里会显示横版和竖版预览。</p>}
              {qc ? <div data-testid="video-review-qc" className="space-y-1 rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">自动质检{qc.warnings?.length ? `：${qc.warnings.length} 条提示` : "：未发现问题"}</p>
                {qc.warnings?.length ? <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {qc.warnings.map((warning, warningIndex) => <li key={warningIndex} className="break-words">{warning}</li>)}
                </ul> : <p className="text-muted-foreground">未检测到黑屏、静止画面、静音或字幕过快。</p>}
                <p className="text-xs text-muted-foreground">{status?.delegated ? "自动检测结果供主 bot 审核参考；最终结论以本版本的主 bot 审核记录为准。" : "提示不会阻止确认，仍需你完整预览。"}</p>
              </div> : null}
              {job.artifacts?.length ? <div className="flex flex-wrap gap-x-4 gap-y-2">
                {job.artifacts.map((artifact) => <a key={artifact.name} className="break-all text-sm underline underline-offset-4"
                  href={`${assetPath(job.id, artifact.name)}?download=1`} download={artifact.name}
                  aria-disabled={!!download?.active || changed} onClick={(event) => { event.preventDefault(); void startDownload(artifact); }}>下载 {artifact.name}</a>)}
              </div> : null}
              {download ? <div className="space-y-2 rounded-lg border border-border p-3 text-sm" data-testid="video-download-progress">
                <p className="break-all">{download.name}</p>
                <p role={download.error ? "alert" : "status"} aria-live="polite">
                  {download.error ?? (download.phase === "saved" ? "文件已校验，已交给浏览器保存。" : download.phase === "verifying" ? "下载完成，正在校验文件…" : `${download.retrying ? "连接中断，正在重试… " : "正在下载… "}${(download.received / 1048576).toFixed(1)} / ${(download.total / 1048576).toFixed(1)} MB`)}
                </p>
                {download.active ? <>
                  <progress className="w-full" aria-label="视频下载进度" max={download.total || 1} value={download.received} />
                  <Button size="sm" variant="outline" onClick={() => downloadController.current?.abort()}>取消下载</Button>
                  <p className="text-xs text-muted-foreground">完整下载并校验通过后才会保存；关闭审核窗口会取消下载。</p>
                </> : null}
              </div> : null}
              {!status?.delegated && job.state === "awaiting_video_approval" && job.scriptApproved ? <div className="space-y-3 rounded-lg bg-muted p-3">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={videoWatched} disabled={blocked}
                    onChange={(event) => setVideoWatched(event.target.checked)} />
                  <span>我已检查第 {job.revision} 版全部成片的画面、配音和字幕。</span>
                </label>
                <Button className="w-full sm:w-auto" disabled={blocked || !videoWatched || !job.artifactHash || !videos.length}
                  onClick={() => approve("video")}>确认第 {job.revision} 版成片</Button>
                <p className="text-xs text-muted-foreground">确认后才可安排发布。此按钮只确认成片。</p>
              </div> : null}
            </section>
          </> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}


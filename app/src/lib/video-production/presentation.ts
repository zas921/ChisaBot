import type { VideoJob } from "./queries";

export const delegatedVideoSteps = ["素材", "写稿与返修", "主 bot 审稿", "配音合成", "主 bot 审片", "导出交付"];
export const videoReviewVerdicts = { approve: "审核通过", changes_requested: "退回修改", evidence_blocked: "证据待补充" };

/** Review history is immutable; only a decision for current content and attempt is current authority. */
export function videoReviewStatus(job: VideoJob) {
  const delegated = job.reviewPolicy?.mode === "delegate_export";
  const stage = job.scriptApproved ? "video" : "script";
  const hash = stage === "script" ? job.scriptHash : job.artifactHash;
  const attempt = job.reviewAttempt ?? 0;
  const latest = (job.reviews ?? []).filter((review) => review.stage === stage && review.revision === job.revision && review.hash === hash
    && (!delegated || review.reviewerBotId === job.reviewPolicy?.reviewerBotId) && (review.reviewAttempt ?? 0) <= attempt).at(-1);
  const rereview = !!latest && (latest.reviewAttempt ?? 0) < attempt;
  const currentDecision = latest && !rereview ? latest : undefined;
  const videos = job.artifacts?.filter((artifact) => artifact.kind === "video") ?? [];
  const receipt = job.exportReceipt;
  const exportComplete = job.state === "approved" && job.scriptApproved === true && job.videoApproved === true
    && !!job.artifactHash && receipt?.revision === job.revision && receipt.artifactHash === job.artifactHash
    && receipt.botId === job.botId && videos.length > 0 && videos.every((video) => receipt.artifactNames.includes(video.name));
  const waitingReview = job.state === "awaiting_script_approval" || job.state === "awaiting_video_approval";
  const rework = delegated && waitingReview && currentDecision?.decision === "changes_requested";
  const evidenceBlocked = delegated && waitingReview && currentDecision?.decision === "evidence_blocked";
  const held = job.reviewPaused || ["cancelled", "deleting"].includes(job.state);
  const retrying = delegated && !held && job.autopilot?.status === "retrying";
  let stateLabel: string | undefined, nextStep: string | undefined;
  let current: { index: number; label: string } | undefined;
  if (delegated) {
    switch (job.state) {
      case "preparing": current = { index: 0, label: "处理中" }; nextStep = "正在准备素材与字幕，完成后制作 bot 自动写稿。"; break;
      case "awaiting_script": current = { index: 1, label: "编写中" }; nextStep = "制作 bot 编写文案与分镜，保存后自动交主 bot 审核。"; break;
      case "awaiting_script_approval":
      case "awaiting_video_approval": {
        const item = stage === "script" ? "稿件" : "成片";
        current = { index: stage === "script" ? 2 : 4, label: "审核中" };
        stateLabel = `主 bot 正在审核${item}`;
        nextStep = stage === "script" ? "主 bot 核对事实、文案与原片画面，通过后自动制作。" : "主 bot 核对实际配音检测、字幕和各画幅成片，通过后自动导出。";
        if (rereview) {
          stateLabel = `等待主 bot 复核${item}`; current.label = "复核中";
          nextStep = "已开启同版本复核，主 bot 重新核对补充证据；历史结论保留。";
        } else if (rework) {
          stateLabel = "主 bot 已退回，制作 bot 返修中"; current = { index: 1, label: "返修中" };
          nextStep = "制作 bot 按下方意见检查实际素材并修改，随后自动交主 bot 复核，无需你代为审核。";
        } else if (evidenceBlocked) {
          stateLabel = "审核证据待补充"; current.label = "待补证";
          nextStep = "制作 bot 补查必要的媒体证据，随后申请复核；此时尚未批准，不需要重新授权审核。";
        }
        break;
      }
      case "render_queued": current = { index: 3, label: "排队中" }; nextStep = "稿件经主 bot 通过，等待配音与合成；完成后自动交主 bot 审片。"; break;
      case "rendering": current = { index: 3, label: "制作中" }; nextStep = "后台正在配音与合成，完成后主 bot 检查各画幅成片，需要时自动返修。"; break;
      case "approved":
        if (job.scriptApproved && job.videoApproved) {
          current = { index: 5, label: exportComplete ? "已交付" : "导出中" };
          stateLabel = exportComplete ? "审核通过，导出链接已交付" : "审核通过，正在导出";
          nextStep = exportComplete ? "当前版本已通过审核并取得导出链接，可查看和下载；未投稿。链接交付不代表文件已下载。" : "制作 bot 正在取得当前审核通过版本的导出链接，完成后交付；未投稿。";
        } else { stateLabel = "批准状态待核对"; nextStep = "当前版本的审核记录不完整，不能视为交付完成。"; }
        break;
      case "failed": nextStep = "本次处理失败，原因已保留在下方；尚未交付完成。"; break;
      case "needs_configuration": nextStep = "需要补充制作配置，原因见下方；已授权的主 bot 审核方式保持有效。"; break;
      case "cancelled": stateLabel = "制作任务已取消"; nextStep = "任务已停止，不会自动恢复。"; break;
      case "deleting": nextStep = "正在清理本项目资源，完成后会从列表移除。"; break;
      default: nextStep = "当前授权只包括主 bot 审核、制作返修与导出，不包含投稿。";
    }
    if (job.reviewPaused && !["cancelled", "deleting"].includes(job.state)) {
      stateLabel = "自动审核已暂停";
      nextStep = "自动流程已暂停；请查看审核意见。系统不会绕过暂停继续重试或批准。";
      if (current) current = { ...current, label: "已暂停" };
    } else if (retrying) nextStep = `${nextStep ?? "当前处理未完成。"} 系统正在等待第 ${job.autopilot?.attempts ?? 1} 次重试。`;
  }
  return { delegated, stage, latest, currentDecision, rereview, attempt, rework, evidenceBlocked, retrying,
    exportComplete, current, stateLabel, nextStep, history: [...(job.reviews ?? [])].reverse(),
    reviewer: job.reviewPolicy?.reviewerBotName || job.reviewPolicy?.reviewerBotId || "未指定", 
    footer: delegated ? "每 8 秒自动刷新 · 主 bot 审核与自动返修 · 不投稿" : "每 8 秒自动刷新 · 稿件与成片分别由你确认" };
}

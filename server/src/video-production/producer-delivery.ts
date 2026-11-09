import type { VideoEvent, VideoJob } from "./types";

export function videoProducerNeedsAction(event: VideoEvent, job: VideoJob): boolean {
  if (job.reviewPaused || job.reviewPolicy?.mode !== "delegate_export") return false;
  if (["cancelled", "deleting", "published", "rendering", "render_queued", "preparing"].includes(job.state)) return false;
  return event.kind === "materials_ready" || ["revisions_requested", "review_changes_requested", "review_evidence_blocked"].includes(event.kind)
    || event.kind === "review_approved" && job.state === "approved" && !(job.exportReceipt?.revision === job.revision && job.exportReceipt.artifactHash === job.artifactHash);
}

/** Reuse unfinished deliveries. Only completed, non-progressing work can get a new retry message. */
export function videoProducerMessageId(event: VideoEvent, job: VideoJob, latest?: { id: string; status: string }): string {
  const base = `video-event-${event.seq}`;
  const attempt = Number((event as VideoEvent & { deliveryAttempt?: number }).deliveryAttempt ?? 0);
  if (!latest) return attempt > 0 ? `${base}-attempt-${attempt}` : base;
  if (!["answered", "merged"].includes(latest.status) || !videoProducerNeedsAction(event, job)) return latest.id;
  // A process retry of the same worker delivery is idempotent. Only defer_event advances attempt.
  return attempt > 0 ? `${base}-attempt-${attempt}` : latest.id;
}

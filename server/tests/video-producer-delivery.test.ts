import { expect, test } from "bun:test";
import { videoProducerMessageId } from "../src/video-production/producer-delivery";
import type { VideoEvent, VideoJob } from "../src/video-production/types";
const event = { seq: 42, kind: "revisions_requested", deliveryAttempt: 2 } as VideoEvent & { deliveryAttempt: number };
const job = { state: "awaiting_script_approval", reviewPolicy: { mode: "delegate_export" } } as VideoJob;
test("a fluent finished producer turn that never fixed the draft receives a new durable retry", () => {
  expect(videoProducerMessageId(event, job, { id: "video-event-42", status: "answered" })).toBe("video-event-42-attempt-2");
  expect(videoProducerMessageId(event, job, { id: "video-event-42-attempt-2", status: "answered" })).toBe("video-event-42-attempt-2");
});
test("queued, executing, user-held and withdrawn work is never replayed by event retries", () => {
  for (const status of ["queued", "read", "owed", "paused", "stopped", "withdrawn"])
    expect(videoProducerMessageId(event, job, { id: "video-event-42", status })).toBe("video-event-42");
});
test("stopped jobs, human mode, and rendering do not get unsolicited retries", () => {
  for (const current of [{ ...job, reviewPaused: true }, { ...job, state: "cancelled" }, { ...job, state: "rendering" }, { ...job, reviewPolicy: { mode: "human" } }])
    expect(videoProducerMessageId(event, current as VideoJob, { id: "video-event-42", status: "answered" })).toBe("video-event-42");
});

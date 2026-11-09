import { describe, expect, test } from "bun:test";
import { isVideoAssetRequest, videoAssetFetchOptions } from "./video-assets";

describe("video asset transfer lifetime", () => {
  const path = "/api/video-production/jobs/video_1/assets/commentary-landscape.mp4";
  test("asset fetch disables Bun's fixed native timer and keeps caller cancellation", () => {
    const controller = new AbortController(), options = videoAssetFetchOptions(controller.signal);
    expect(options.timeout).toBe(false);
    expect(options.signal).toBe(controller.signal);
    controller.abort();
    expect(options.signal!.aborted).toBe(true);
  });
  test("only GET/HEAD asset transfers bypass the ordinary HTTP idle timeout", () => {
    expect(isVideoAssetRequest("GET", path)).toBe(true);
    expect(isVideoAssetRequest("HEAD", path)).toBe(true);
    for (const other of ["/api/video-production/settings", "/api/video-production/jobs/video_1", path + "/extra", "/api/video-production/jobs//assets/file.mp4"]) {
      expect(isVideoAssetRequest("GET", other)).toBe(false);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect(isVideoAssetRequest(method, path)).toBe(false);
  });

  test("a video larger than 20 MiB finishes after a pause exceeding the server idle timeout", async () => {
    const block = new Uint8Array(1024 * 1024).fill(17);
    const total = block.length * 24;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, fetch(request, server) {
      if (isVideoAssetRequest(request.method, new URL(request.url).pathname)) server.timeout(request, 0);
      return new Response((async function* () {
        for (let i = 0; i < 24; i++) {
          if (i === 21) await Bun.sleep(2_200);
          yield block;
        }
      })(), { headers: { "Content-Type": "video/mp4", "Content-Length": String(total) } });
    }});
    try {
      const response = await fetch(new URL(path, server.url));
      let received = 0;
      for await (const chunk of response.body!) received += chunk.length;
      expect(received).toBe(total);
    } finally { server.stop(true); }
  });

  test("ordinary requests retain the server idle limit", async () => {
    // A single byte can stay in the response buffer on Linux. Send a full MiB
    // before the gap to exercise an active stream with Bun's default 10s limit.
    const block = new Uint8Array(1024 * 1024).fill(23);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
      if (isVideoAssetRequest(request.method, new URL(request.url).pathname)) server.timeout(request, 0);
      return new Response((async function* () { yield block; await Bun.sleep(12_000); yield block; })(), { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(block.length * 2) } });
    }});
    try {
      await expect((async () => (await fetch(server.url)).text())()).rejects.toThrow();
    } finally { server.stop(true); }
  }, 20_000);
});

import type { VideoJob } from "./types";

export class VideoProductionError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
export function createVideoClient(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid video production service URL");
  const transport = options.fetch ?? fetch;
  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${options.token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const signal = init.signal ?? AbortSignal.timeout(30_000);
    let response: Response;
    try { response = await transport(new URL(path, base), { ...init, headers, signal, redirect: "error" }); }
    catch { throw new VideoProductionError("视频制作服务暂时无法连接，请稍后重试。", 503); }
    if (!response.ok && response.status !== 206) {
      let message = "视频制作服务暂时不可用。";
      try { const data = await response.json() as { error?: unknown; detail?: unknown }; if (typeof data.error === "string") message = data.error.slice(0, 700); else if (typeof data.detail === "string") message = data.detail.slice(0, 700); } catch { /* No upstream body is required. */ }
      throw new VideoProductionError(message, response.status);
    }
    return response;
  }
  async function json<T>(path: string, init?: RequestInit): Promise<T> { return (await request(path, init)).json() as Promise<T>; }
  async function job(ownerId: string, id: string): Promise<VideoJob> {
    const value = await json<VideoJob | { job: VideoJob }>(`/v1/jobs/${encodeURIComponent(id)}?ownerId=${encodeURIComponent(ownerId)}`);
    const found = "job" in value ? value.job as VideoJob : value as VideoJob;
    if (found.ownerId !== ownerId || found.id !== id) throw new VideoProductionError("找不到这个视频项目。", 404);
    return found;
  }
  return { request, json, job };
}

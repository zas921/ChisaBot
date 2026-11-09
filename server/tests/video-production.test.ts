import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { withConfirmTurn, withConfirmToolCall } from "../src/confirmations/context";
import { createVideoProduction } from "../src/video-production/service";
import type { VideoEvent, VideoJob } from "../src/video-production/types";
import { createSchema, scriptSchema } from "../src/video-production/schema";

const ORIGIN = "https://chisa.example";
const PREFIX = "/api/video-production";
function fixture(overrides: Partial<VideoJob> = {}): VideoJob {
  return { id: "video_1", ownerId: "alice", botId: "bot_a", threadId: "thread_a", title: "AI 工具对比", state: "awaiting_script_approval", revision: 2, scriptHash: "a".repeat(64), artifactHash: "b".repeat(64), script: { title: "标题", summary: "资料说明", tags: ["科技"], segments: [{ text: "第一段解说。", visual: "card" }] }, sources: [{ id: "source_1", url: "https://www.youtube.com/watch?v=abc", title: "来源", duration: 60, transcript: [{ start: 0, end: 3, text: "External material" }] }], artifacts: [], createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", scriptApproved: false, videoApproved: false, ...overrides };
}
function harness(initial = fixture(), opts: { notify?: (event: VideoEvent) => Promise<void>; localAsrAvailable?: boolean; listedJobs?: VideoJob[]; cleanupPending?: boolean; deleteStatus?: number } = {}) {
  let job = structuredClone(initial);
  const calls: { path: string; method: string; body: any; headers: Headers }[] = [];
  let events: VideoEvent[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined, headers = new Headers(init?.headers);
    calls.push({ path: url.pathname + url.search, method, body, headers });
    if (headers.get("Authorization") !== "Bearer test-video-service-secret") return Response.json({ error: "not authenticated" }, { status: 401 });
    if (url.pathname === "/v1/events") return Response.json({ events });
    if (/^\/v1\/events\/\d+\/ack$/.test(url.pathname)) { events = events.filter((event) => event.seq !== Number(url.pathname.split("/")[3])); return Response.json({ ok: true }); }
    if (url.pathname === "/v1/config") return Response.json({ tts: { provider: "edge", requiresApiKey: false }, youtubeCookiesConfigured: false, asrConfigured: false, localAsrAvailable: opts.localAsrAvailable, local_asr_model_path: "/private/model-location", asr_api_key: "must-never-leave-worker", youtube_cookies: "private-cookie-data", bilibili: { automaticPublishing: true, configured: true, tid: 201, account: { uname: "投稿账号", cookie: "private-account-cookie" }, cookies: "private-bilibili-cookie", aiStatement: true } });
    if (url.pathname === "/v1/jobs" && method === "POST") { job = { ...job, ownerId: body.ownerId, botId: body.botId, threadId: body.threadId }; return Response.json(job); }
    if (url.pathname === "/v1/jobs") return Response.json({ jobs: opts.listedJobs ?? [job] });
    if (url.pathname === "/v1/jobs/" + job.id && method === "DELETE") {
      if (opts.deleteStatus) return Response.json({ error: "项目资源尚未清理完成，请重试" }, { status: opts.deleteStatus });
      return Response.json({ id: job.id, deleted: !opts.cleanupPending, cleanupPending: !!opts.cleanupPending }, { status: opts.cleanupPending ? 202 : 200 });
    }
    if (url.pathname.endsWith("/material")) return Response.json(job);
    if (url.pathname.endsWith("/script") && method === "PUT") { job = { ...job, revision: job.revision + 1, scriptHash: "c".repeat(64), scriptApproved: false, videoApproved: false, state: "awaiting_script_approval", script: body }; return Response.json(job); }
    if (url.pathname.endsWith("/approve-script")) { job.scriptApproved = true; job.state = "render_queued"; return Response.json(job); }
    if (url.pathname.endsWith("/approve-video")) { job.videoApproved = true; job.state = "approved"; return Response.json(job); }
    if (url.pathname.endsWith("/publish")) return Response.json({ status: "needs_configuration", published: false, message: "请配置平台账号，当前可下载投稿包。", job });
    if (url.pathname.includes("/assets/")) return new Response("chunk", { status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-4/20", "Accept-Ranges": "bytes" } });
    return Response.json(job);
  }) as typeof fetch;
  const service = createVideoProduction({ baseUrl: "http://video-worker:8090", token: "test-video-service-secret", fetch: fakeFetch, allowedOrigins: [ORIGIN], notify: opts.notify });
  const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
    const owner = c.req.header("x-test-user");
    if (!owner) return c.json({ error: "not signed in" }, 401);
    c.set("actor", { id: owner, email: owner + "@example.test", role: "user" });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(PREFIX, service.routes(auth));
  async function request(path: string, init: RequestInit = {}, owner = "alice") { return app.request(ORIGIN + PREFIX + path, { ...init, headers: { "x-test-user": owner, ...Object.fromEntries(new Headers(init.headers)) } }); }
  async function csrf(owner = "alice") { const response = await request("/jobs/video_1/review", {}, owner); const html = await response.text(); return { token: /"csrf":"([^\"]+)"/.exec(html)?.[1] ?? "", html, response }; }
  async function mutate(action: string, body: unknown, token: string, owner = "alice", origin = ORIGIN, method = "POST") { return request("/jobs/video_1/" + action, { method, headers: { Origin: origin, "Content-Type": "application/json", "X-Video-CSRF": token }, body: JSON.stringify(body) }, owner); }
  return { service, app, calls, request, csrf, mutate, setJob: (next: VideoJob) => { job = next; }, setEvents: (next: VideoEvent[]) => { events = next; } };
}
const turn = <T>(work: () => T) => withConfirmTurn({ threadId: "trusted_thread", runId: "run_1", stopped: () => false }, work);

describe("video project deletion", () => {
  const remove = (h: ReturnType<typeof harness>, token: string, body: unknown = { botId: "bot_a", revision: 2 }, headers: Record<string, string> = {}) =>
    h.request("/jobs/video_1", { method: "DELETE", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Video-CSRF": token, ...headers }, body: JSON.stringify(body) });

  test("deleting the base job route requires login and a project-bound CSRF token", async () => {
    const h = harness();
    const { token } = await h.csrf();
    expect((await h.app.request(ORIGIN + PREFIX + "/jobs/video_1", { method: "DELETE" })).status).toBe(401);
    expect((await remove(h, "")).status).toBe(403);
    expect((await remove(h, "forged")).status).toBe(403);
    expect((await remove(h, token, undefined, { Origin: "https://other.example" })).status).toBe(403);
    expect((await remove(h, token, undefined, { "Content-Type": "text/plain" })).status).toBe(403);
    expect((await h.request("/jobs/video_2", { method: "DELETE", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Video-CSRF": token }, body: '{"botId":"bot_a","revision":2}' })).status).toBe(403);
    expect(h.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("valid deletion forwards only authenticated ownership and the confirmed revision", async () => {
    const h = harness();
    const { token } = await h.csrf();
    const response = await remove(h, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "video_1", deleted: true, cleanupPending: false });
    expect(h.calls.at(-1)).toMatchObject({ path: "/v1/jobs/video_1", method: "DELETE", body: { ownerId: "alice", revision: 2 } });
  });

  test("another BOT, stale revision, or altered fields never reach worker deletion", async () => {
    const h = harness();
    const { token } = await h.csrf();
    expect((await remove(h, token, { botId: "bot_b", revision: 2 })).status).toBe(404);
    expect((await remove(h, token, { botId: "bot_a", revision: 1 })).status).toBe(409);
    expect((await remove(h, token, { botId: "bot_a", revision: 2, ownerId: "bob" })).status).toBe(400);
    expect((await remove(h, token, { botId: "bot_a", revision: true })).status).toBe(400);
    h.setJob(fixture({ state: "publishing" }));
    expect((await remove(h, token)).status).toBe(409);
    expect(h.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("pending cleanup stays pending and failed cleanup never reports success", async () => {
    const pending = harness(fixture(), { cleanupPending: true });
    const response = await remove(pending, (await pending.csrf()).token);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "video_1", deleted: false, cleanupPending: true });
    const failed = harness(fixture(), { deleteStatus: 503 });
    const failure = await remove(failed, (await failed.csrf()).token);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('"deleted":true');
  });
});

describe("video production human review boundary", () => {
  test("inline review context requires login and ownership without changing review state", async () => {
    const h = harness();
    expect((await h.app.request(ORIGIN + PREFIX + "/jobs/video_1/review-context")).status).toBe(401);
    const denied = await h.request("/jobs/video_1/review-context", {}, "bob");
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("AI 工具对比");
    const response = await h.request("/jobs/video_1/review-context");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = await response.json();
    expect(data.job).toMatchObject({ id: "video_1", revision: 2, state: "awaiting_script_approval", scriptApproved: false, videoApproved: false });
    expect(data.job.reviewUrl).toBe(PREFIX + "/jobs/video_1/review");
    expect(data.csrf).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(data)).not.toContain("test-video-service-secret");
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  });
  test("inline confirmation token remains owner and project bound and cannot approve a replaced draft", async () => {
    const h = harness();
    const { csrf } = await (await h.request("/jobs/video_1/review-context")).json();
    const approval = { revision: 2, hash: "a".repeat(64) };
    expect((await h.mutate("approve-script", approval, csrf, "bob")).status).toBe(403);
    expect((await h.request("/jobs/video_2/approve-script", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Video-CSRF": csrf }, body: JSON.stringify(approval) })).status).toBe(403);
    h.setJob(fixture({ revision: 3, scriptHash: "c".repeat(64) }));
    expect((await h.mutate("approve-script", approval, csrf)).status).toBe(409);
    expect(h.calls.some((call) => call.method === "POST")).toBe(false);
    const current = await (await h.request("/jobs/video_1/review-context")).json();
    expect((await h.mutate("approve-script", { revision: current.job.revision, hash: current.job.scriptHash }, current.csrf)).status).toBe(200);
    expect(h.calls.at(-1)?.body).toEqual({ ownerId: "alice", revision: 3, hash: "c".repeat(64) });
  });
  test("inline project list filters both bot and thread within the authenticated owner", async () => {
    const h = harness(fixture(), { listedJobs: [
      fixture(), fixture({ id: "other_bot", botId: "bot_b" }),
      fixture({ id: "other_thread", threadId: "thread_b" }),
      fixture({ id: "other_owner", ownerId: "bob" }),
    ] });
    expect((await h.app.request(ORIGIN + PREFIX + "/jobs?botId=bot_a&threadId=thread_a")).status).toBe(401);
    const response = await h.request("/jobs?botId=bot_a&threadId=thread_a&ownerId=bob");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).jobs.map((job: VideoJob) => job.id)).toEqual(["video_1"]);
    expect(h.calls.at(-1)?.path).toBe("/v1/jobs?ownerId=alice");
    expect((await (await h.request("/jobs?threadId=thread_a")).json()).jobs.map((job: VideoJob) => job.id)).toEqual(["video_1", "other_bot"]);
    expect((await (await h.request("/jobs?botId=bot_a&threadId=unrelated")).json()).jobs).toEqual([]);
    const before = h.calls.length;
    expect((await h.request("/jobs?botId=")).status).toBe(400);
    expect((await h.request("/jobs?threadId=" + "a".repeat(257))).status).toBe(400);
    expect(h.calls).toHaveLength(before);
  });
  test("requires login and rejects another owner's worker response before displaying any data", async () => {
    const h = harness();
    expect((await h.app.request(ORIGIN + PREFIX + "/jobs/video_1/review")).status).toBe(401);
    const response = await h.request("/jobs/video_1/review", {}, "bob");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("AI 工具对比");
    expect(h.calls.at(-1)?.path).toContain("ownerId=bob");
  });
  test("approval requires same origin and an actor-bound CSRF token", async () => {
    const h = harness();
    const { token } = await h.csrf();
    const approval = { revision: 2, hash: "a".repeat(64) };
    expect((await h.mutate("approve-script", approval, "")).status).toBe(403);
    expect((await h.mutate("approve-script", approval, token, "alice", "https://evil.example")).status).toBe(403);
    expect((await h.mutate("approve-script", approval, token, "bob")).status).toBe(403);
    expect(h.calls.filter((call) => call.path.endsWith("approve-script"))).toHaveLength(0);
    expect((await h.mutate("approve-script", approval, token)).status).toBe(200);
    expect(h.calls.at(-1)?.body.ownerId).toBe("alice");
  });
  test("stale revision and stale content hash cannot approve; changed scripts revoke the old approval", async () => {
    const h = harness(fixture({ scriptApproved: true, videoApproved: true, state: "approved" }));
    const { token } = await h.csrf();
    const response = await h.mutate("script", { expectedRevision: 2, title: "改稿", summary: "", tags: [], segments: [{ text: "已修改的内容", visual: "card" }] }, token, "alice", ORIGIN, "PUT");
    expect(response.status).toBe(200);
    expect((await response.json()).videoApproved).toBe(false);
    expect((await h.mutate("approve-script", { revision: 2, hash: "a".repeat(64) }, token)).status).toBe(409);
    expect((await h.mutate("approve-script", { revision: 3, hash: "a".repeat(64) }, token)).status).toBe(409);
    expect((await h.mutate("approve-script", { revision: 3, hash: "c".repeat(64) }, token)).status).toBe(200);
  });
  test("video approval requires an approved script; publish requires the exact approved artifact", async () => {
    const h = harness(fixture({ state: "awaiting_video_approval" }));
    const { token } = await h.csrf();
    expect((await h.mutate("approve-video", { revision: 2, hash: "b".repeat(64) }, token)).status).toBe(409);
    h.setJob(fixture({ state: "awaiting_video_approval", scriptApproved: true }));
    expect((await h.mutate("publish", { revision: 2, hash: "b".repeat(64), platform: "bilibili" }, token)).status).toBe(409);
    expect((await h.mutate("approve-video", { revision: 2, hash: "b".repeat(64) }, token)).status).toBe(200);
    expect((await h.mutate("publish", { revision: 2, hash: "d".repeat(64), platform: "bilibili" }, token)).status).toBe(409);
    const publish = await h.mutate("publish", { revision: 2, hash: "b".repeat(64), platform: "douyin" }, token);
    expect(publish.status).toBe(200);
    expect((await publish.json()).published).toBe(false);
  });
  test("editing rejects unavailable source and out-of-bounds clips", async () => {
    const h = harness(), { token } = await h.csrf();
    const body = { expectedRevision: 2, title: "test", summary: "", tags: [], segments: [{ text: "旁白", visual: "source", sourceId: "source_1", start: 55, end: 65 }] };
    expect((await h.mutate("script", body, token, "alice", ORIGIN, "PUT")).status).toBe(400);
    expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
  test("storyboard shots and quotes are checked against the material before saving", async () => {
    const h = harness(), { token } = await h.csrf();
    const shots = { expectedRevision: 2, title: "test", summary: "", tags: [], segments: [{ text: "旁白", visual: "source", shots: [{ sourceId: "source_1", start: 1, end: 4 }, { sourceId: "source_1", start: 58, end: 62 }] }] };
    expect((await h.mutate("script", shots, token, "alice", ORIGIN, "PUT")).status).toBe(400);
    const quote = { ...shots, segments: [{ text: "原话译文", visual: "quote", sourceId: "missing", start: 1, end: 5 }] };
    expect((await h.mutate("script", quote, token, "alice", ORIGIN, "PUT")).status).toBe(400);
    expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    const valid = { ...shots, segments: [
      { text: "旁白", visual: "source", shots: [{ sourceId: "source_1", start: 1, end: 4 }, { sourceId: "source_1", start: 10, end: 14 }] },
      { text: "原话译文", visual: "quote", sourceId: "source_1", start: 20, end: 26, caption: "作者原话" },
      { text: "数字", visual: "card", layout: "stat", items: ["45 分钟", "作者自报"] }] };
    expect((await h.mutate("script", valid, token, "alice", ORIGIN, "PUT")).status).toBe(200);
    const sent = h.calls.find((call) => call.method === "PUT")!.body;
    expect(sent.segments[0].shots).toHaveLength(2);
    expect(sent.segments[2].items).toEqual(["45 分钟", "作者自报"]);
  });
  test("publication uncertainty and in-flight submissions cannot publish or retry again", async () => {
    for (const state of ["publish_uncertain", "publish_queued", "publishing", "published"]) {
      const h = harness(fixture({ state, scriptApproved: true, videoApproved: true }));
      const { token, html } = await h.csrf();
      expect((await h.mutate("publish", { revision: 2, hash: "b".repeat(64), platform: "bilibili" }, token)).status).toBe(409);
      expect((await h.mutate("retry", {}, token)).status).toBe(409);
      const tools = h.service.tools("alice", "bot_a");
      const retried = JSON.parse(await turn(() => tools.find((tool) => tool.name === "video_project_retry")!.execute({ id: "video_1" })));
      expect(retried.executed).toBe(false);
      expect(h.calls.some((call) => call.method === "POST")).toBe(false);
      expect(html).toContain("投稿结果未确认，请在平台核对，不要重复投稿。");
    }
  });
  test("local source thumbnails map to authenticated assets and retain their original source URL", async () => {
    const job = fixture(); job.sources![0]!.thumbnail = "source_1.jpg";
    const h = harness(job);
    const data = await (await h.request("/jobs/video_1")).json();
    expect(data.job.sources[0].thumbnail).toBe(PREFIX + "/jobs/video_1/assets/source_1.jpg");
    expect(data.job.sources[0].url).toBe("https://www.youtube.com/watch?v=abc");
  });
  test("review HTML escapes source text, uses CSP, and contains valid JavaScript", async () => {
    const h = harness(fixture({ title: '</script><script>alert("bad")</script>' }));
    const { html, response } = await h.csrf();
    expect(html).not.toContain('</script><script>alert("bad")');
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    const script = /<script nonce="[^\"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    // Bun defers vm.Script parsing until execution; Function parses immediately.
    expect(() => new Function(script)).not.toThrow();
    // The script lives in a template literal: a lone backslash is silently dropped.
    expect(script).toContain("/\\.mp4$/i.test(a.name)");
  });
  test("asset proxy enforces ownership and forwards Range for video playback", async () => {
    const h = harness();
    expect((await h.request("/jobs/video_1/assets/final.mp4", {}, "bob")).status).toBe(404);
    const response = await h.request("/jobs/video_1/assets/final.mp4", { headers: { Range: "bytes=0-4" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-4/20");
    expect(h.calls.at(-1)?.headers.get("Range")).toBe("bytes=0-4");
  });
  test("settings expose no secrets and require their own authenticated CSRF token", async () => {
    const h = harness();
    const response = await h.request("/settings"), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("must-never-leave-worker");
    expect(html).not.toContain("private-cookie-data");
    expect(html).not.toContain("private-account-cookie");
    expect(html).not.toContain("private-bilibili-cookie");
    const script = /<script nonce="[^\"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
    const token = /"csrf":"([^\"]+)"/.exec(html)![1]!;
    const request = (body: unknown, csrf = token) => h.request("/config", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Video-CSRF": csrf }, body: JSON.stringify(body) });
    expect((await request({ asr_api_key: "" }, "")).status).toBe(403);
    expect((await request({ ownerId: "bob", asr_api_key: "key" })).status).toBe(400);
    expect((await request({ asr_api_key: "" })).status).toBe(200);
    expect(h.calls.filter((call) => call.path === "/v1/config" && call.method === "POST").at(-1)?.body).toEqual({ ownerId: "alice" });
    expect((await request({ clearAsrKey: true })).status).toBe(200);
    expect(h.calls.filter((call) => call.path === "/v1/config" && call.method === "POST").at(-1)?.body).toEqual({ ownerId: "alice", asr_api_key: "" });
    expect((await h.mutate("approve-script", { revision: 2, hash: "a".repeat(64) }, token)).status).toBe(403);
  });
  test("settings explain free local transcription without exposing worker paths or keys", async () => {
    for (const localAsrAvailable of [true, false]) {
      const h = harness(fixture(), { localAsrAvailable });
      const config = await (await h.request("/config")).json();
      expect(config.localAsrAvailable).toBe(localAsrAvailable);
      expect(JSON.stringify(config)).not.toContain("/private/model-location");
      expect(JSON.stringify(config)).not.toContain("must-never-leave-worker");
      const html = await (await h.request("/settings")).text();
      expect(html).not.toContain("/private/model-location");
      expect(html).not.toContain("must-never-leave-worker");
      const script = /<script nonce="[^\"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
      const elements = new Map<string, { textContent?: string; value?: string; onclick?: unknown }>();
      const document = { getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, {});
        return elements.get(id)!;
      } };
      // Execute the real settings initializer as well as parsing its script.
      expect(() => new Function("document", script)(document)).not.toThrow();
      expect(elements.get("asrStatus")?.textContent).toBe(localAsrAvailable
        ? "免费本地转写已启用，无需 API Key。"
        : "尚未配置语音识别服务；有字幕的视频仍可制作。");
      expect(elements.get("asrHelp")?.textContent).toContain(localAsrAvailable
        ? "下方外部语音识别服务为可选配置"
        : "才需要兼容的语音识别服务");
    }
  });
  test("Bilibili credentials require an explicit partition and account checks never expose secrets", async () => {
    const h = harness(), html = await (await h.request("/settings")).text();
    const token = /"csrf":"([^\"]+)"/.exec(html)![1]!;
    const request = (body: unknown) => h.request("/config", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Video-CSRF": token }, body: JSON.stringify(body) });
    expect((await request({ bilibili_cookies: "[{cookie}]" })).status).toBe(400);
    expect((await request({ bilibili_cookies: "[{cookie}]", bilibili_tid: 0 })).status).toBe(400);
    expect(h.calls.some((call) => call.method === "POST")).toBe(false);
    const saved = await request({ bilibili_cookies: "[{cookie}]", bilibili_tid: 201 });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("[{cookie}]");
    expect(h.calls.filter((call) => call.method === "POST").at(-1)?.body).toEqual({ ownerId: "alice", bilibili_cookies: "[{cookie}]", bilibili_tid: 201 });
    expect((await request({ bilibili_cookies: "" })).status).toBe(200);
    const checked = await (await h.request("/config?checkBilibili=1")).json();
    expect(h.calls.at(-1)?.path).toBe("/v1/config?ownerId=alice&checkBilibili=1");
    expect(checked.bilibili).toMatchObject({ account: "投稿账号", configured: true, automaticPublishing: true, tid: 201 });
    expect(JSON.stringify(checked)).not.toContain("private-");
  });
  test("submission limits match the worker before work is queued", () => {
    const create = { title: "解说", urls: Array(4).fill("https://youtu.be/abc"), brief: "比较功能" };
    expect(createSchema.safeParse(create).success).toBe(false);
    expect(createSchema.safeParse({ ...create, urls: [create.urls[0]], title: "字".repeat(81) }).success).toBe(false);
    const script = { expectedRevision: 1, title: "解说", summary: "", tags: [], segments: [{ text: "旁白", visual: "card" }] };
    expect(scriptSchema.safeParse({ ...script, segments: Array(41).fill(script.segments[0]) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, summary: "字".repeat(1501) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, title: "字".repeat(81) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, tags: ["字".repeat(31)] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, tags: Array(11).fill("标签") }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, tags: ["AI,工具"] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, tags: Array(7).fill("字".repeat(30)) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, tags: Array(6).fill("字".repeat(30)) }).success).toBe(true);
    expect(scriptSchema.safeParse({ ...script, segments: [{ text: "字".repeat(1201), visual: "card" }] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, segments: Array(4).fill({ text: "字".repeat(1200), visual: "card" }) }).success).toBe(false);
    const quote = { text: "译文", visual: "quote", sourceId: "source_1", start: 0, end: 19 };
    expect(scriptSchema.safeParse({ ...script, segments: [quote] }).success).toBe(true);
    expect(scriptSchema.safeParse({ ...script, segments: Array(7).fill(quote) }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, segments: [{ ...quote, end: 25 }] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, segments: [{ text: "x", visual: "source", shots: [{ sourceId: "s", start: 0, end: 31 }] }] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, segments: [{ text: "x", visual: "card", layout: "compare", items: ["a", "b", "c"] }] }).success).toBe(false);
    expect(scriptSchema.safeParse({ ...script, segments: [{ text: "x", visual: "card", sourceId: "source_1", start: 0, end: 3 }] }).success).toBe(false);
  });
});

describe("video production tools and durable notifications", () => {
  test("models have no approval tool and cannot invent thread or owner IDs", async () => {
    const h = harness(), tools = h.service.tools("alice", "bot_a");
    expect(tools.some((tool) => /approve/.test(tool.name))).toBe(false);
    const create = tools.find((tool) => tool.name === "video_project_create")!;
    const args = { title: "解说", urls: ["https://youtu.be/abc"], brief: "比较功能" };
    expect(JSON.parse(await create.execute(args)).executed).toBe(false);
    expect(JSON.parse(await turn(() => create.execute({ ...args, ownerId: "bob", threadId: "invented" })))).toHaveProperty("error");
    await turn(() => withConfirmToolCall("trusted_call_1", create.name, () => create.execute(args)));
    const submitted = h.calls.find((call) => call.path === "/v1/jobs" && call.method === "POST")!;
    expect(submitted.body).toMatchObject({ ownerId: "alice", botId: "bot_a", threadId: "trusted_thread", requestId: "trusted_call_1" });
  });
  test("material is marked as untrusted and another bot's project is refused", async () => {
    const h = harness(), material = h.service.tools("alice", "bot_a").find((tool) => tool.name === "video_project_material")!;
    expect(await turn(() => material.execute({ id: "video_1" }))).toContain("<untrusted_data");
    h.setJob(fixture({ botId: "different_bot" }));
    expect(JSON.parse(await turn(() => material.execute({ id: "video_1" })))).toHaveProperty("error");
  });
  test("failed delivery is not acknowledged, and retry preserves event order", async () => {
    const seen: number[] = []; let fail = true;
    const h = harness(fixture(), { notify: async (event) => { if (fail) throw new Error("temporarily offline"); seen.push(event.seq); } });
    h.setEvents([1, 2].map((seq) => ({ seq, jobId: "video_1", ownerId: "alice", botId: "bot_a", threadId: "thread_a", kind: "ready", message: "ready" })));
    await expect(h.service.pollEvents()).rejects.toThrow();
    expect(h.calls.some((call) => call.path.endsWith("/ack"))).toBe(false);
    fail = false;
    await h.service.pollEvents();
    expect(seen).toEqual([1, 2]);
    expect(h.calls.filter((call) => call.path.endsWith("/ack"))).toHaveLength(2);
    await h.service.pollEvents();
    expect(seen).toEqual([1, 2]);
  });
});

import { expect, test } from "bun:test";
import { videoAssetFetchOptions } from "../../shared/video-assets";
import { createVideoClient } from "../src/video-production/client";

test("video worker transport forwards native-timeout opt-out and caller cancellation", async () => {
  const controller = new AbortController();
  let received: RequestInit & { timeout?: false } = {};
  const client = createVideoClient({ baseUrl: "http://worker", token: "test-token", fetch: (async (_url, init) => { received = init ?? {}; return new Response("video"); }) as typeof fetch });
  await client.request("/v1/jobs/video_1/assets/movie.mp4", videoAssetFetchOptions(controller.signal));
  expect(received.timeout).toBe(false);
  expect(received.signal).toBe(controller.signal);
  controller.abort();
  expect(received.signal!.aborted).toBe(true);
});

test("worker asset fetch survives native timer while regular calls and user cancellation still stop", async () => {
  const script = `
    import { createVideoClient } from ${JSON.stringify(new URL("../src/video-production/client.ts", import.meta.url).href)};
    import { videoAssetFetchOptions } from ${JSON.stringify(new URL("../../shared/video-assets.ts", import.meta.url).href)};
    const block=new Uint8Array(1024*1024).fill(19),total=block.length*24;
    const upstream=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch(){
      return new Response((async function*(){for(let i=0;i<24;i++){yield block;await Bun.sleep(500);}})());
    }});
    const client=createVideoClient({baseUrl:upstream.url.href,token:'test-token'});
    async function consume(fixed){let bytes=0,failed=false;try{
      const signal=new AbortController().signal;
      const response=await client.request('/v1/jobs/video_1/assets/movie.mp4',fixed?videoAssetFetchOptions(signal):{signal});
      for await(const chunk of response.body)bytes+=chunk.length;
    }catch{failed=true;}return {bytes,failed};}
    const [ordinary,asset]=await Promise.all([consume(false),consume(true)]);
    const controller=new AbortController();
    const cancelled=await client.request('/v1/jobs/video_1/assets/movie.mp4',videoAssetFetchOptions(controller.signal));
    controller.abort();let cancellation=false;try{await cancelled.arrayBuffer();}catch{cancellation=true;}
    console.log(JSON.stringify({ordinary,asset,cancellation,total}));upstream.stop(true);
  `;
  const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", "-e", script], env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "4" }, stdout: "pipe", stderr: "pipe" });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.ordinary.failed).toBe(true);
    expect(result.ordinary.bytes).toBeLessThan(result.total);
    expect(result.asset).toEqual({ bytes: result.total, failed: false });
    expect(result.cancellation).toBe(true);
  } finally { child.kill(); }
}, 25_000);

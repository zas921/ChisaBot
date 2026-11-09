export type VideoDownloadProgress = {
  received: number; total: number; retrying?: number;
  phase: "downloading" | "verifying" | "saved";
};
export type VideoDownloadOptions = {
  url: string; name: string; expectedBytes: number; sha256: string;
  signal?: AbortSignal; onProgress?: (progress: VideoDownloadProgress) => void;
  fetch?: typeof fetch; saveBlob?: (blob: Blob, name: string) => Promise<void> | void;
  chunkSize?: number; chunkTimeoutMs?: number; retryDelayMs?: number; retries?: number;
};

/** Self-contained so the nonce-protected legacy review page can embed this same implementation. */
export async function downloadVideoAsset(options: VideoDownloadOptions): Promise<{ bytes: number; method: "blob" }> {
  const total = options.expectedBytes;
  if (!Number.isSafeInteger(total) || total < 0 || !/^[a-f0-9]{64}$/i.test(options.sha256 ?? "")) {
    throw new Error("缺少文件校验信息，请重新载入视频项目后下载。");
  }
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
  const chunkTimeout = options.chunkTimeoutMs ?? 120_000;
  const retries = options.retries ?? 3;
  const retryDelay = options.retryDelayMs ?? 1_000;
  const transport = options.fetch ?? globalThis.fetch;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  const cancelled = () => new DOMException("下载已取消。", "AbortError");
  const checkCancelled = () => { if (options.signal?.aborted) throw cancelled(); };
  const fatal = (message: string) => Object.assign(new Error(message), { fatal: true });
  const progress = (phase: VideoDownloadProgress["phase"], retrying?: number) =>
    options.onProgress?.({ received, total, phase, ...(retrying ? { retrying } : {}) });
  async function pause(milliseconds: number) {
    checkCancelled();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      const abort = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); reject(cancelled()); };
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async function block(start: number, end: number) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAborted: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const stop = (reason: Error) => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      rejectAborted(reason);
    };
    const cancel = () => stop(cancelled());
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop(new Error("当前下载片段超时。")), chunkTimeout);
    try {
      checkCancelled();
      return await Promise.race([aborted, (async () => {
        const response = await transport(options.url, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { Range: `bytes=${start}-${end}` },
        });
        const rejectResponse = async (error: Error): Promise<never> => {
          await response.body?.cancel().catch(() => {});
          throw error;
        };
        if ([401, 403].includes(response.status)) return rejectResponse(fatal("登录已失效或没有下载权限，请重新登录后重试。"));
        if (response.status === 404) return rejectResponse(fatal("文件已变化或不存在，请重新载入视频项目。"));
        if (response.status === 408 || response.status === 429 || response.status >= 500) return rejectResponse(new Error("连接暂时不可用。"));
        if (response.status !== 206) return rejectResponse(fatal("服务器未返回所需文件片段，未保存文件。请稍后重试。"));
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
        if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== total) {
          return rejectResponse(fatal("文件版本或大小已变化，未保存文件。请重新载入后下载。"));
        }
        if (!response.body) throw new Error("未收到文件内容。");
        reader = response.body.getReader();
        const expected = end - start + 1, data = new Uint8Array(expected);
        let offset = 0;
        while (true) {
          checkCancelled();
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.byteLength > expected) {
            await reader.cancel();
            throw fatal("文件片段大小不符，未保存文件。");
          }
          data.set(next.value, offset); offset += next.value.byteLength;
        }
        if (offset !== expected) throw new Error("文件片段传输不完整。");
        return data;
      })()]);
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
    }
  }
  try {
    checkCancelled(); progress("downloading");
    while (received < total) {
      checkCancelled();
      const end = Math.min(received + chunkSize, total) - 1;
      let data: Uint8Array<ArrayBuffer> | undefined;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try { data = await block(received, end); break; }
        catch (error) {
          checkCancelled();
          if ((error as { fatal?: boolean }).fatal || attempt === retries) throw error;
          progress("downloading", attempt + 1);
          await pause(retryDelay * (attempt + 1));
        }
      }
      if (!data) throw new Error("下载未完成，请重试。");
      parts.push(data); received += data.byteLength; progress("downloading");
    }
    checkCancelled(); progress("verifying");
    const blob = new Blob(parts, { type: "application/octet-stream" });
    parts.length = 0;
    if (blob.size !== total) throw new Error("文件大小校验失败，未保存文件。");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    checkCancelled();
    if (hash !== options.sha256.toLowerCase()) throw new Error("文件校验失败，未保存文件。请重新载入视频项目后重试。");
    if (options.saveBlob) await options.saveBlob(blob, options.name);
    else {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = options.name; link.style.display = "none";
      document.body.append(link);
      try { link.click(); } catch (error) { URL.revokeObjectURL(url); throw error; }
      finally { link.remove(); }
      // Chromium/Electron must retain the blob until the native download has acquired it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    progress("saved");
    return { bytes: total, method: "blob" };
  } finally { parts.length = 0; }
}

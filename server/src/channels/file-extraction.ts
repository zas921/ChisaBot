import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredAttachment } from "./attachment-parts";
import { FILE_MIME_BY_EXTENSION, mimeForFilename } from "../../../shared/attachments";

const script = fileURLToPath(
  new URL("../../scripts/extract-attachment.py", import.meta.url),
);
const cache = new Map<string, string>();
let active = 0;
const waiters: Array<() => void> = [];

/** Two bounded readers at a time; never run document macros, archive entries or a shell. */
export async function extractFileText(file: StoredAttachment): Promise<string> {
  const key = createHash("sha256")
    .update(file.mimeType)
    .update("\0")
    .update(file.name)
    .update("\0")
    .update(file.bytes)
    .digest("hex");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (active >= 2) {
    if (waiters.length >= 16) throw new Error("附件读取任务较多，请稍后重试。");
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else active++;
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const extension = mimeForFilename(file.name) ? extname(file.name).toLowerCase() : `.${Object.entries(FILE_MIME_BY_EXTENSION).find(([, mime]) => mime === file.mimeType)?.[0] ?? "bin"}`;
      const child = spawn(
        process.env.CHISABOT_FILE_PYTHON || "python3",
        [script, extension, file.mimeType],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        child.kill("SIGKILL");
        reject(new Error("附件读取超时，请拆分文件后重试。"));
      }, 20_000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("服务器的附件读取组件不可用，请联系管理员。"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          stopped = true;
          child.kill("SIGKILL");
          reject(new Error("附件提取结果过大，请拆分文件。"));
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stopped) return;
        if (code !== 0) {
          reject(new Error("附件读取失败，文件可能过大或损坏。"));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            text?: unknown;
            error?: unknown;
          };
          if (typeof result.error === "string") throw new Error(result.error);
          if (typeof result.text !== "string" || result.text.length > 241_000)
            throw new Error("附件读取结果无效。");
          resolve(result.text);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("附件读取失败。"));
        }
      });
      child.stdin.end(file.bytes);
    });
    cache.set(key, text);
    if (cache.size > 16) cache.delete(cache.keys().next().value as string);
    return text;
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}

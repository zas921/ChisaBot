/**
 * 模型额度用完 / 暂时不可用时自动换一个能用的模型（DESIGN.md §60 成熟度 1，§61 备用模型）。
 *
 * 2026-10-15 生产实测：默认模型 clinepass/cline-free/mimo-v2.6-flash 的每日免费额度一用完，
 * 每个机器人的每次回答都要等 AI SDK 重试三次（十几秒到两分多钟），然后弹一条英文报错
 * 「Failed after 3 attempts… Daily free limit reached… Try again in 19h 51m」，整整一天没法用。
 *
 * 这里包在模型外面：调用（doStream / doGenerate）在还没吐出任何内容之前就被拒（429、402，或
 * 403/400 且错误里写着额度 / quota / limit），就记下这个模型「冷却到什么时候」（错误里写了
 * 「Try again in 19h 51m」就按它，否则 10 分钟），然后立刻用候选模型重发同一个请求；冷却期内的
 * 后续回合直接跳过它，不再白等。候选模型：环境变量 CHISABOT_MODEL_FALLBACKS（逗号分隔，
 * 设为 off 关闭）；没设就从模型目录里取与当前模型同一个平台前缀（clinepass/…）的其它模型，按目录顺序。
 * 全部候选都失败时抛出原来的错误（界面照旧显示，见 app 的错误翻译）。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

type Model = Record<string, unknown> & { modelId?: string };

/** 为什么换了模型：额度 / 限流（quota），或者模型服务 5xx / 过载（unavailable）。 */
export type FallbackReason = "quota" | "unavailable";
export type FallbackUse = { from: string; to: string; reason: FallbackReason };
type FallbackListener = (use: FallbackUse) => void;

/*
 * 谁想知道「这一轮换了模型」：聊天运行（context-usage.ts meterRun → RUN_FINISHED 的
 * metadata.modelFallback → 对话里的淡色小字）和管理员自检（admin-smoke.ts）。AsyncLocalStorage，
 * 运行之间互不串。
 */
const listeners = new AsyncLocalStorage<FallbackListener>();
export function withFallbackListener<T>(listener: FallbackListener, run: () => T): T {
  return listeners.run(listener, run);
}
function announce(use: FallbackUse) {
  try {
    listeners.getStore()?.(use);
  } catch {
    // 记录失败不影响回答。
  }
}
type Call = (options: unknown) => Promise<unknown>;

export type FallbackDeps = {
  /** 候选模型 id（不含当前模型），按优先级。 */
  candidates: (primary: string) => Promise<string[]>;
  /** 用同一个连接建一个别的模型。 */
  build: (modelId: string) => unknown;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
  /**
   * 主模型多久没有任何输出就当它卡住了、换备用模型（毫秒；0 = 不限）。doStream 算到第一段真正的内容
   * （元数据与空开头事件不算），doGenerate 算到整个结果。只在有备用模型可换时生效。默认 {@link FIRST_OUTPUT_MS}。
   */
  firstOutputMs?: number;
  /** A non-secret connection fingerprint. Omit to isolate this model instance's cooldowns. */
  cooldownScope?: string;
};

/** Never use the credential itself as a cache key or expose it in logs. */
export function modelCooldownScope(connection: {
  provider: string; baseUrl?: string; useApiKey?: boolean;
}, apiKey: string | null): string {
  return createHash("sha256").update(JSON.stringify([
    connection.provider, connection.baseUrl ?? "", connection.useApiKey !== false,
    connection.useApiKey === false ? "" : apiKey ?? "",
  ])).digest("hex");
}

/**
 * 静默可能是上游隐藏了思考过程，不能默认 30 秒就中止主模型并切换。
 * 默认关闭首输出期限；显式 CHISABOT_MODEL_FIRST_OUTPUT_MS 仍可启用。
 * 明确的额度 / 服务错误照常切换；用户停止仍可中止请求。
 */
export const FIRST_OUTPUT_MS = (() => {
  const raw = process.env.CHISABOT_MODEL_FIRST_OUTPUT_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

class FirstOutputTimeout extends Error {
  constructor(readonly ms: number) {
    super(`model gave no output in ${Math.round(ms / 1000)}s`);
    this.name = "FirstOutputTimeout";
  }
}

type StreamPart = { type?: string; error?: unknown; delta?: unknown } & Record<string, unknown>;
type StreamResult = { stream: ReadableStream<StreamPart> } & Record<string, unknown>;

/** SSE errors arrive as JSON, not rejected fetches (the HTTP response was already 200). */
function streamError(value: unknown): Error {
  if (value instanceof Error) return value;
  const body = typeof value === "string" ? value : JSON.stringify(value ?? "Model stream failed") ?? String(value);
  let detail = value;
  let statusCode: number | undefined;
  let code = "";
  for (let depth = 0; detail && typeof detail === "object" && depth < 5; depth++) {
    const item = detail as Record<string, unknown>;
    const status = item.statusCode ?? item.status ?? item.status_code;
    if (typeof status === "number") statusCode ??= status;
    if (typeof item.code === "string") code = item.code;
    else if (typeof item.type === "string") code = item.type;
    const response = item.response as Record<string, unknown> | undefined;
    const next = item.error ?? response?.error;
    if (!next) break;
    detail = next;
  }
  const message = typeof detail === "object" && detail && typeof (detail as Record<string, unknown>).message === "string"
    ? (detail as { message: string }).message
    : providerReason(body);
  return Object.assign(new Error(message || "Model stream failed"), { statusCode, code, responseBody: body });
}

/** Metadata and empty opening markers cannot prove that the model has started answering. */
function hasOutput(part: StreamPart): boolean {
  if (["stream-start", "response-metadata", "text-start", "reasoning-start", "text-end", "reasoning-end", "finish"].includes(part.type ?? "")) return false;
  if (part.type === "text-delta" || part.type === "reasoning-delta") return typeof part.delta === "string" && part.delta.length > 0;
  // Tool input, tool results, sources and any unfamiliar event are conservatively committed.
  return true;
}

/**
 * 在内容出现前检查 SSE 错误；可选的首输出期限为 0 时无限等待，保留长思考。
 * 一旦有文本、推理或工具内容就交还原流，后续错误只透传，绝不重放已有输出/工具。
 */
async function withStreamPreflight(
  call: (options: unknown) => Promise<unknown>,
  options: unknown,
  property: "doStream" | "doGenerate",
  ms: number,
  modelId: string,
): Promise<unknown> {
  if (property === "doGenerate" && ms <= 0) return call(options);
  const parent = (options as { abortSignal?: AbortSignal } | null)?.abortSignal;
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const forward = () => {
    controller.abort(parent?.reason);
    rejectAbort(parent?.reason ?? new DOMException("Stopped by user", "AbortError"));
  };
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    if (ms <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new FirstOutputTimeout(ms));
      reject(new FirstOutputTimeout(ms));
    }, ms);
  });
  deadline.catch(() => {});
  let streaming = false;
  let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
  const cleanupParent = () => parent?.removeEventListener("abort", forward);
  const callOptions =
    options && typeof options === "object" && "abortSignal" in options
      ? { ...(options as object), abortSignal: controller.signal }
      : Object.defineProperty({ ...(options as object) }, "abortSignal", {
          value: controller.signal,
          enumerable: false,
          configurable: true,
          writable: true,
        });
  try {
    if (parent?.aborted) throw parent.reason;
    const result = await Promise.race([call(callOptions), deadline, aborted]);
    if (
      property !== "doStream" ||
      !result ||
      typeof result !== "object" ||
      typeof (result as StreamResult).stream?.getReader !== "function"
    )
      return result;
    const streamed = result as StreamResult;
    reader = streamed.stream.getReader();
    const streamReader = reader;
    const head: StreamPart[] = [];
    let done = false;
    for (;;) {
      const next = await Promise.race([streamReader.read(), deadline, aborted]);
      if (next.done) {
        done = true;
        break;
      }
      if (next.value?.type === "error") throw streamError(next.value.error);
      head.push(next.value);
      if (hasOutput(next.value) || next.value.type === "finish") break;
    }
    if (!done) streaming = true;
    const stream = new ReadableStream<StreamPart>({
      start(out) {
        for (const part of head) out.enqueue(part);
        if (done) {
          cleanupParent();
          out.close();
        }
      },
      async pull(out) {
        try {
          const next = await Promise.race([streamReader.read(), aborted]);
          if (next.done) {
            cleanupParent();
            out.close();
          } else {
            if (next.value?.type === "error") {
              const error = streamError(next.value.error);
              explainModelError(error, modelId);
              out.enqueue({ ...next.value, error });
            } else out.enqueue(next.value);
          }
        } catch (err) {
          cleanupParent();
          if (!parent?.aborted) explainModelError(err, modelId);
          throw err;
        }
      },
      cancel(reason) {
        cleanupParent();
        controller.abort(reason);
        return streamReader.cancel(reason);
      },
    });
    return { ...streamed, stream };
  } catch (error) {
    controller.abort(error);
    void reader?.cancel(error).catch(() => {});
    if (timedOut && !parent?.aborted) throw new FirstOutputTimeout(ms);
    throw error;
  } finally {
    clearTimeout(timer);
    if (!streaming) cleanupParent();
  }
}

type Cooldown = { modelId: string; until: number; reason: FallbackReason; statusCode?: number };
const cooldown = new Map<string, Cooldown>();
const modelScopes = new WeakMap<object, string>();
let nextModelScope = 0;
const cooldownKey = (scope: string, modelId: string) => JSON.stringify([scope, modelId]);
export function resetModelCooldowns() {
  cooldown.clear();
}
/** Without a scope this is a diagnostic query only; calls always use their own connection scope. */
export function coolingDown(modelId: string, now = Date.now(), scope?: string): boolean {
  if (scope !== undefined) {
    const key = cooldownKey(scope, modelId);
    const entry = cooldown.get(key);
    if (entry && entry.until <= now) cooldown.delete(key);
    return Boolean(entry && entry.until > now);
  }
  let active = false;
  for (const [key, entry] of cooldown) {
    if (entry.until <= now) cooldown.delete(key);
    else if (entry.modelId === modelId) active = true;
  }
  return active;
}

function errorParts(error: unknown): { status?: number; text: string } {
  const seen = new Set<unknown>();
  let status: number | undefined;
  const texts: string[] = [];
  let current: unknown = error;
  // RetryError → lastError / errors；APICallError → statusCode / responseBody
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (typeof e.statusCode === "number" && status === undefined) status = e.statusCode;
    for (const key of ["message", "responseBody", "code"]) if (typeof e[key] === "string") texts.push(e[key] as string);
    current = e.lastError ?? e.cause;
  }
  return { status, text: texts.join(" ") };
}

/** 疑似密钥 / 令牌打码后再给人看（供应商有时会把请求里的 key 回显在报错里）。 */
function maskSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk|pk|rk|ak|key|tok)[-_][A-Za-z0-9._-]{8,}/gi, (m) => `${m.slice(0, 6)}***`)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => `${m.slice(0, 4)}***`);
}

/** 供应商响应体里给人看的那句话：JSON 的 error.message / message / detail / msg，读不出来就用原文。 */
export function providerReason(body: string): string {
  const raw = body.trim();
  if (!raw) return "";
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const error = json.error;
    const candidates = [
      typeof error === "object" && error ? (error as Record<string, unknown>).message : error,
      json.message,
      json.detail,
      json.msg,
      json.error_msg,
    ];
    for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  } catch {
    // 不是 JSON：HTML 错误页之类，去掉标签留文字。
  }
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const EXPLAINED = Symbol.for("chisabot.modelErrorExplained");

/**
 * 把「为什么调用失败」写进错误本身（2026-10-21，用户：模型出错时要能看到原因）。
 *
 * AI SDK 的 APICallError 只把状态行（「Bad Request」「Unauthorized」）放在 message 里，供应商真正说的原因
 * 在 responseBody，状态码在 statusCode；CopilotKit 发 RUN_ERROR 时只取 message，于是对话里的错误卡只能说
 * 「这一轮没有收到回答」，查看详情也只有一个英文状态行。这里原地补上「模型 id · HTTP 状态码：供应商原因」，
 * 不换错误对象（AI SDK 的重试判断看 isRetryable / 类型标记），也不重复补。用户自己点的停止不动。
 */
export function explainModelError(error: unknown, modelId: string): void {
  if (!(error instanceof Error) || (error as unknown as Record<symbol, unknown>)[EXPLAINED]) return;
  if (error.name === "AbortError" || /\baborted\b/i.test(error.message)) return;
  const e = error as Error & { statusCode?: unknown; responseBody?: unknown; cause?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  let reason = typeof e.responseBody === "string" ? providerReason(e.responseBody) : "";
  if (!reason && e.cause instanceof Error && e.cause.message && !error.message.includes(e.cause.message)) {
    // fetch failed → cause 才是「connect ECONNREFUSED 172.18.0.3:3425」这种真正的原因。
    const code = (e.cause as Error & { code?: unknown }).code;
    reason = `${typeof code === "string" && !e.cause.message.includes(code) ? `${code} ` : ""}${e.cause.message}`;
  }
  if (reason && error.message.includes(reason)) reason = "";
  reason = maskSecrets(reason).slice(0, 300);
  const where = [`模型 ${modelId}`, status !== undefined ? `HTTP ${status}` : ""].filter(Boolean).join(" · ");
  try {
    error.message = maskSecrets(`${error.message.trim() || "模型调用失败"}（${where}${reason ? `：${reason}` : ""}）`);
    Object.defineProperty(error, EXPLAINED, { value: true });
  } catch {
    // 只读 / 冻结的错误对象：保持原样。
  }
}

/** 日志里留一小段原始错误，事后能看出主模型到底为什么被拒。 */
function errorSnippet(error: unknown): string {
  const { status, text } = errorParts(error);
  return maskSecrets(`${status ?? ""} ${text}`).replace(/\s+/g, " ").trim().slice(0, 240);
}

const QUOTA_TEXT = /quota|rate.?limit|daily.*limit|free (tier|limit)|limit reached|insufficient.*(credit|balance)|exceeded|额度|限额|余额/i;

/** 这个错误是不是「这个模型暂时用不了（额度 / 限流）」，换一个模型有意义。 */
export function isQuotaError(error: unknown): boolean {
  const { status, text } = errorParts(error);
  if (status === 429 || status === 402) return true;
  if ((status === 403 || status === 400 || status === undefined) && QUOTA_TEXT.test(text) && /429|limit|quota|额度|限额/i.test(text)) return true;
  return false;
}

const UNAVAILABLE_TEXT = /overloaded|service unavailable|bad gateway|upstream (error|request failed)|temporarily unavailable/i;

/**
 * 这个错误值不值得换模型：额度 / 限流 → quota；模型服务 5xx / 529 过载 → unavailable；
 * 其它（400 参数错、401 密钥错、网络断）→ null，照常报错（换模型也救不了，或者会掩盖配置问题）。
 */
export function fallbackReason(error: unknown): FallbackReason | null {
  if (isQuotaError(error)) return "quota";
  const { status, text } = errorParts(error);
  if (status !== undefined && (status === 529 || (status >= 500 && status <= 504))) return "unavailable";
  // A successful HTTP response can carry a provider-side SSE failure without an HTTP error status.
  if (status === undefined && /\b(server_error|internal_server_error|overloaded_error)\b/i.test(text)) return "unavailable";
  if (status === undefined && /\b(50[0234]|529)\b/.test(text) && UNAVAILABLE_TEXT.test(text)) return "unavailable";
  return null;
}

/** 一天 / 免费额度这类「短时间不会恢复」的字样；没有它的 429 多半只是一时限流。 */
const LONG_QUOTA_TEXT = /quota|daily|free (tier|limit)|limit reached|insufficient|exceeded|额度|限额|余额/i;

/**
 * 「Try again in 19h 51m」/「retry after 30s」→ 毫秒；读不出来时：写着额度 / 每日限额的 10 分钟，
 * 只是一时限流（429 没说原因，DESIGN.md §101）的 1 分钟——以前一律 10 分钟，主模型偶尔一次 429，
 * 后面 10 分钟的每一轮都只能用备用模型，备用模型又下线了，整整 10 分钟什么都做不了（2026-10-18 生产）。
 * 最多 24 小时。
 */
export function cooldownMs(error: unknown): number {
  const { text } = errorParts(error);
  const m = /(?:try again|retry)[^0-9]{0,20}(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?/i.exec(text);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
    if (ms > 0) return Math.min(ms, 24 * 3600_000);
  }
  return LONG_QUOTA_TEXT.test(text) ? 10 * 60_000 : 60_000;
}

/** 备用模型自己坏了（不存在 / 参数不收 / 密钥不对）：这么久之内不再试它。 */
const BROKEN_CANDIDATE_MS = 30 * 60_000;

/** 冷却多久：额度按错误里写的恢复时间；服务不可用 2 分钟（多半是一时的）。 */
function cooldownFor(error: unknown, reason: FallbackReason): number {
  return reason === "quota" ? cooldownMs(error) : 2 * 60_000;
}

export function fallbackLanguageModel<T>(model: T, primaryId: string, deps: FallbackDeps): T {
  if (!model || typeof model !== "object") return model;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const target = model as unknown as Model;
  let scope = deps.cooldownScope;
  if (scope === undefined) {
    scope = modelScopes.get(model);
    if (scope === undefined) {
      scope = `instance:${++nextModelScope}`;
      modelScopes.set(model, scope);
    }
  }
  const connectionScope = scope;
  const remember = (id: string, ms: number, reason: FallbackReason, error: unknown) => {
    const time = now();
    // Discard expired connections too, so repeatedly rotating credentials does not grow the cache.
    for (const [key, entry] of cooldown) if (entry.until <= time) cooldown.delete(key);
    const { status } = errorParts(error);
    // Connections can be shared by several conversations. Never retain one request's error text.
    cooldown.set(cooldownKey(connectionScope, id), { modelId: id, until: time + ms, reason, statusCode: status });
  };
  const wrap = (property: "doStream" | "doGenerate") => async (options: unknown) => {
    try {
      return await attempt(property, options);
    } catch (error) {
      // 最后抛出去的是主模型的错误（候选都失败时也是它）：补上模型、状态码和供应商原因再交给对话。
      if (!(options as { abortSignal?: AbortSignal } | null)?.abortSignal?.aborted) explainModelError(error, primaryId);
      throw error;
    }
  };
  const attempt = async (property: "doStream" | "doGenerate", options: unknown) => {
    const primaryCall = (target[property] as Call).bind(model);
    let firstError: unknown = null;
    let reason: FallbackReason = "quota";
    const list = await deps.candidates(primaryId).catch(() => [] as string[]);
    const deadlineMs = deps.firstOutputMs ?? FIRST_OUTPUT_MS;
    if (!coolingDown(primaryId, now(), connectionScope)) {
      try {
        // 有备用模型可换时才给主模型设「第一段输出」期限（§101.10）；没得换就照旧等它。
        return await withStreamPreflight(primaryCall, options, property,
          list.some((id) => id !== primaryId) ? deadlineMs : 0, primaryId);
      } catch (error) {
        if ((options as { abortSignal?: AbortSignal } | null)?.abortSignal?.aborted) throw error;
        if (error instanceof FirstOutputTimeout) {
          const ms = 60_000;
          remember(primaryId, ms, "unavailable", error);
          firstError = error;
          reason = "unavailable";
          log({ type: "model-fallback", event: "primary-timeout", model: primaryId, cooldownSeconds: Math.round(ms / 1000), error: error.message });
        }
        const why = firstError ? "unavailable" : fallbackReason(error);
        if (!why) throw error;
        if (!firstError) {
          const ms = cooldownFor(error, why);
          remember(primaryId, ms, why, error);
          firstError = error;
          reason = why;
          log({ type: "model-fallback", event: why === "quota" ? "primary-quota" : "primary-unavailable", model: primaryId, cooldownSeconds: Math.round(ms / 1000), error: errorSnippet(error) });
        }
      }
    } else {
      const prior = cooldown.get(cooldownKey(connectionScope, primaryId));
      reason = prior?.reason ?? "quota";
      const seconds = Math.max(1, Math.ceil(((prior?.until ?? now()) - now()) / 1000));
      firstError = Object.assign(new Error(
        `${reason === "quota" ? "上游额度不足或限流" : "上游暂时不可用"}，当前模型冷却中，请约 ${seconds} 秒后重试`,
      ), { statusCode: prior?.statusCode });
    }
    for (const id of new Set(list)) {
      if (id === primaryId || coolingDown(id, now(), connectionScope)) continue;
      const other = deps.build(id) as Model | null;
      const call = other && typeof other[property] === "function" ? (other[property] as Call).bind(other) : null;
      if (!call) continue;
      try {
        const result = await withStreamPreflight(call, options, property, deadlineMs, id);
        log({ type: "model-fallback", event: "used", model: primaryId, fallback: id });
        announce({ from: primaryId, to: id, reason });
        return result;
      } catch (error) {
        const parentSignal = (options as { abortSignal?: AbortSignal } | null)?.abortSignal;
        if (parentSignal?.aborted) throw error;
        // 备用模型的任何错误都不该挡住下一个候选（以前 404「model not found」直接抛出，后面的候选和主模型都没机会，§101）。
        const why = error instanceof FirstOutputTimeout ? "unavailable" : fallbackReason(error);
        remember(id, why ? cooldownFor(error, why) : BROKEN_CANDIDATE_MS, why ?? "unavailable", error);
        log({ type: "model-fallback", event: "candidate-failed", model: primaryId, fallback: id, reason: why ?? "broken", error: errorSnippet(error) });
      }
    }
    // 没有可用候选也遵守冷却；否则连续点击或 SDK 重试又会在同一故障上等一分钟。
    throw firstError;
  };
  return new Proxy(model as unknown as object, {
    get(object, property) {
      if ((property === "doStream" || property === "doGenerate") && typeof target[property] === "function") return wrap(property);
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as unknown as T;
}

/**
 * 候选模型，按优先级：
 * 1. 管理员在 设置 → 模型 →「备用模型」里排好的列表（configured，DESIGN.md §61）；
 * 2. 环境变量 CHISABOT_MODEL_FALLBACKS（逗号分隔；off / 0 关闭自动挑选）；
 * 3. 目录里与当前模型同平台前缀的其它模型（最多 3 个）。
 * 只返回目录里存在的模型的规则只用于第 3 条；管理员列表照填写的顺序，目录暂时读不到也照用。
 */
export function fallbackCandidates(
  catalog: () => Promise<string[]>,
  env: Record<string, string | undefined> = process.env,
  configured: () => Promise<string[]> = async () => [],
): (primary: string) => Promise<string[]> {
  return async (primary) => {
    const admin = (await configured().catch(() => [] as string[])).filter((id) => id && id !== primary);
    if (admin.length) return admin;
    const fromEnv = env.CHISABOT_MODEL_FALLBACKS?.trim();
    if (fromEnv === "off" || fromEnv === "0") return [];
    if (fromEnv) return fromEnv.split(",").map((s) => s.trim()).filter((s) => s && s !== primary);
    const slash = primary.indexOf("/");
    if (slash <= 0) return [];
    const prefix = primary.slice(0, slash + 1);
    return (await catalog()).filter((id) => id !== primary && id.startsWith(prefix)).slice(0, 3);
  };
}

/** 对话里那行淡色小字（DESIGN.md §61）：模型 id 只留最后一段（clinepass/cline-free/step-5 → step-5）。 */
export function fallbackNotice(use: Pick<FallbackUse, "to" | "reason">): string {
  const short = use.to.split("/").filter(Boolean).pop() || use.to;
  return use.reason === "unavailable" ? `主模型暂时不可用，已改用 ${short}` : `主模型额度用完，已改用 ${short}`;
}

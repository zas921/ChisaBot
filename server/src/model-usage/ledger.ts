import { z } from "zod";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import type { ModelUsageEntry } from "./sink";

/**
 * 模型用量账本（2026-10-21，用户：「每日 token 用来的面板」做不出来）。
 *
 * 机器人以前没有任何地方能查到自己用了多少 token：Magpie 的 /api/usage 要管理密钥（机器人的 shell 既到不了
 * 内网，也读不到密钥），数据库连接串只在 API 进程里，而且不是每个部署都用 Magpie。所以由 ChisaBot 自己记：
 *
 * - 机器人回合里的每一次模型调用（context-usage.ts `meterLanguageModel` 在流结束时读到的用量）写一行
 *   chisabot_model_usage：哪个机器人、哪段对话、哪个模型、输入 / 输出 / 缓存命中的 token。主人按对话
 *   当时的主人记（插入时从 openbot_local_threads 查），后台刷新面板的临时对话删了也不丢。
 * - 机器人拿到一个只读工具 `model_usage`：按天、按模型汇总「这个人」的用量，做面板、回答「今天用了多少」都用它。
 *
 * 只记 ChisaBot 机器人回合里的调用：起标题、路由、图片 / 语音这些辅助调用不在里面，工具结果里写明了。
 * 开机 `ensure()` 建表；回滚到旧镜像不受影响（旧镜像只是看不到这张表）。
 */

const DEFAULT_TZ = "Asia/Shanghai";
/** 保留多久（天）。一行几十字节，一天几百行，一年也就几 MB。 */
const RETENTION_DAYS = 400;

export function validTimeZone(value: string | undefined): string {
  const zone = value?.trim();
  if (!zone) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TZ;
  }
}

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  calls: number;
};
export type UsageDay = UsageTotals & { date: string; models: (UsageTotals & { model: string })[] };

type Row = { day: string; model: string | null; input: string | number; output: string | number; cached: string | number; calls: string | number };

const num = (value: string | number | null | undefined) => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const empty = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, calls: 0 });
const add = (into: UsageTotals, row: Row) => {
  into.inputTokens += num(row.input);
  into.outputTokens += num(row.output);
  into.cachedInputTokens += num(row.cached);
  into.totalTokens = into.inputTokens + into.outputTokens;
  into.calls += num(row.calls);
};

/** SQL 结果（每天 × 每个模型一行）→ 按天汇总，最新的一天在前；没有用量的日子也列出来（全 0），画图不断档。 */
export function summarizeUsageRows(rows: Row[], days: number, today: string): UsageDay[] {
  const byDay = new Map<string, UsageDay>();
  const [y, m, d] = today.split("-").map(Number);
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - i)).toISOString().slice(0, 10);
    byDay.set(date, { date, ...empty(), models: [] });
  }
  for (const row of rows) {
    const day = byDay.get(row.day);
    if (!day) continue;
    add(day, row);
    const model = { model: row.model || "（未知模型）", ...empty() };
    add(model, row);
    day.models.push(model);
  }
  for (const day of byDay.values()) day.models.sort((a, b) => b.totalTokens - a.totalTokens);
  return [...byDay.values()];
}

/** 某个时区里的「今天」，YYYY-MM-DD。 */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts.slice(0, 10);
}

const usageParameters = z
  .object({
    days: z.number().int().min(1).max(90).optional().describe("看最近几天（含今天），默认 7，最多 90"),
    timeZone: z.string().max(60).optional().describe("按哪个时区切分「一天」（IANA，如 Asia/Shanghai）。用户没说就不填，默认北京时间"),
  })
  .strict();

export function createModelUsageLedger(database: Database, options: { log?: (event: Record<string, unknown>) => void } = {}) {
  const sql = database.$client;
  const log = options.log ?? ((event) => console.warn(JSON.stringify(event)));

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_model_usage (
        id bigserial PRIMARY KEY,
        owner_user_id text,
        bot_id text,
        thread_id text,
        model text,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        cached_input_tokens integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_model_usage_owner_time ON chisabot_model_usage (owner_user_id, created_at DESC);
    `);
    await sql.unsafe(`DELETE FROM chisabot_model_usage WHERE created_at < now() - interval '${RETENTION_DAYS} days'`).catch(() => {});
  }

  function record(entry: ModelUsageEntry) {
    const clamp = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 2_000_000_000) : 0);
    void sql
      .unsafe(
        `INSERT INTO chisabot_model_usage (owner_user_id, bot_id, thread_id, model, input_tokens, output_tokens, cached_input_tokens)
         VALUES ((SELECT owner_user_id FROM openbot_local_threads WHERE id = $1), $2, $1, $3, $4, $5, $6)`,
        [
          entry.threadId ?? null,
          entry.botId?.slice(0, 200) ?? null,
          entry.model?.slice(0, 200) ?? null,
          clamp(entry.inputTokens),
          clamp(entry.outputTokens),
          clamp(entry.cachedInputTokens),
        ],
      )
      .catch((error: unknown) => log({ type: "model-usage-record-failed", reason: reasonWithoutStatement(error).slice(0, 200) }));
  }

  async function summary(ownerUserId: string, input: { days?: number; timeZone?: string } = {}) {
    const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), 90);
    const timeZone = validTimeZone(input.timeZone);
    const today = todayIn(timeZone);
    const rows = (await sql.unsafe(
      `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, model,
              sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cached_input_tokens) AS cached, count(*) AS calls
         FROM chisabot_model_usage
        WHERE owner_user_id = $1 AND created_at >= (($3::date - ($4::int - 1))::timestamp AT TIME ZONE $2)
        GROUP BY 1, 2`,
      [ownerUserId, timeZone, today, days],
    )) as unknown as Row[];
    const byDay = summarizeUsageRows(rows, days, today);
    const total = empty();
    for (const day of byDay) {
      total.inputTokens += day.inputTokens;
      total.outputTokens += day.outputTokens;
      total.cachedInputTokens += day.cachedInputTokens;
      total.calls += day.calls;
    }
    total.totalTokens = total.inputTokens + total.outputTokens;
    return { timeZone, today, days: byDay, total };
  }

  function tools(ownerUserId: string): GrantedTool[] {
    return [
      {
        name: "model_usage",
        ref: "model-usage/model_usage",
        description:
          "查询这个用户在 ChisaBot 里的模型 token 用量（ChisaBot 自己记的账，不依赖 Magpie 或模型平台）：按天、按模型汇总输入 / 输出 / 缓存命中 token 和调用次数，今天在最前面。做「每日 token 用量」面板、回答「今天 / 这周用了多少 token」时用它取数；面板来源写「ChisaBot 用量记录」，不带网址。只统计机器人回合里的模型调用，起标题等辅助调用不计。",
        parameters: usageParameters,
        async execute(args) {
          const parsed = usageParameters.safeParse(args ?? {});
          if (!parsed.success) return `${REFUSAL_MARKER} model_usage 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
          try {
            const result = await summary(ownerUserId, parsed.data);
            return JSON.stringify({
              ...result,
              note: "ChisaBot 自己记录的机器人回合模型调用；起标题、路由、图片 / 语音等辅助调用不在内。这张表是新加的：之前的日子没有记录，显示为 0。",
            });
          } catch (error) {
            return `${REFUSAL_MARKER} 读取用量失败：${reasonWithoutStatement(error).slice(0, 200)}`;
          }
        },
      },
    ];
  }

  return { ensure, record, summary, tools };
}

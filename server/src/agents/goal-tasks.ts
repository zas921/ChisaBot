import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { currentConfirmTurn } from "../confirmations/context";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { Database } from "../db/client";
import type { GrantedTool } from "../plugins/tools";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { TurnRunner } from "../turns/types";

const automatic = [
  "active",
  "running",
  "waiting_background",
  "waiting_device",
  "waiting_approval",
];
const automaticParam = `{${automatic.join(",")}}`;
export type GoalScope = {
  ownerUserId: string;
  agentId: string;
  threadId: string;
};
export type GoalJob = {
  deviceId: string;
  jobId: string;
  status: string;
  exitCode?: unknown;
  detail?: string;
  launchMarker?: string;
};
const checkSchema = z
  .object({
    tool: z.literal("device_run_shell"),
    args: z
      .object({
        deviceId: z.string().min(1),
        command: z.string().min(1).max(32000),
        cwd: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(600).optional(),
      })
      .strict(),
    stdoutIncludes: z.array(z.string().min(1).max(1000)).min(1).max(20),
  })
  .strict();
export const goalInputSchema = z
  .object({
    agentId: z.string().min(1),
    threadId: z.string().min(1),
    objective: z.string().min(1).max(12000),
    criteria: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            title: z.string().min(1).max(1000),
            check: checkSchema,
          })
          .strict(),
      )
      .min(1)
      .max(30),
    adoptJobs: z
      .array(
        z
          .object({ deviceId: z.string().min(1), jobId: z.string().min(1) })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
type Criterion = z.infer<typeof goalInputSchema>["criteria"][number] & {
  passed?: boolean;
  checkedAt?: string;
  detail?: string;
};
export type GoalTask = GoalScope & {
  id: string;
  objective: string;
  criteria: Criterion[];
  jobs: GoalJob[];
  status: string;
  detail: string | null;
  generation: number;
  rounds: number;
  cursor: number;
  lastRunId: string | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
};
type Row = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string;
  objective: string;
  criteria: Criterion[];
  jobs: GoalJob[];
  status: string;
  detail: string | null;
  generation: number;
  rounds: number;
  idle_rounds: number;
  message_cursor: number;
  last_run_id: string | null;
  next_check_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  waiting_since: Date | string | null;
  lease_token: string | null;
  active_calls: string[];
};
const view = (r: Row): GoalTask => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  agentId: r.agent_id,
  threadId: r.thread_id,
  objective: r.objective,
  criteria: r.criteria,
  jobs: r.jobs,
  status: r.status,
  detail: r.detail,
  generation: r.generation,
  rounds: r.rounds,
  cursor: r.message_cursor,
  lastRunId: r.last_run_id,
  nextCheckAt: new Date(r.next_check_at).toISOString(),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** Device tools and AG-UI may each JSON-encode a string. Decode a bounded number of layers. */
export function decodeGoalResult(value: unknown): unknown {
  for (let i = 0; i < 8 && typeof value === "string"; i++) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === value) break;
      value = parsed;
    } catch {
      break;
    }
  }
  return value;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export function acceptanceResult(
  raw: unknown,
  required: readonly string[],
): { passed: boolean; detail: string } {
  const value = decodeGoalResult(raw);
  const result = object(value);
  if (!result) return { passed: false, detail: String(value).slice(0, 1500) };
  if (
    result.waiting ||
    result.cancelled ||
    result.timedOut ||
    result.status === "running"
  )
    return {
      passed: false,
      detail: "验收尚未完成、已取消或仍在等待，不能算通过。",
    };
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const passed =
    result.exitCode === 0 && required.every((text) => stdout.includes(text));
  return {
    passed,
    detail: passed
      ? "实际验收命令退出码为 0，且全部预定断言存在。"
      : `验收未通过：exitCode=${String(result.exitCode)}；${String(result.stderr || stdout || result.error || "缺少预定验收断言").slice(-1500)}`,
  };
}
export function jobsFromMessages(
  messages: readonly Message[],
  existing: readonly GoalJob[] = [],
): GoalJob[] {
  const jobs = new Map(
    existing.map((j) => [`${j.deviceId}:${j.jobId}`, { ...j }]),
  );
  const calls = new Map(
    messages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .map((c) => [c.id, c]),
  );
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const call = calls.get(message.toolCallId);
    if (
      !call ||
      !["device_run_shell", "device_shell_output"].includes(call.function.name)
    )
      continue;
    const args = object(decodeGoalResult(call.function.arguments));
    const result = object(decodeGoalResult(message.content));
    if (
      !args ||
      !result ||
      typeof args.deviceId !== "string" ||
      typeof result.jobId !== "string" ||
      typeof result.status !== "string"
    )
      continue;
    const job: GoalJob = {
      deviceId: args.deviceId,
      jobId: result.jobId,
      status: result.status,
      exitCode: result.exitCode,
    };
    const key = `${job.deviceId}:${job.jobId}`;
    jobs.set(key, { ...jobs.get(key), ...job });
  }
  return [...jobs.values()];
}

export function goalInstruction(task: GoalTask): string {
  return [
    "这是用户明确授权的持续任务恢复，不是新用户消息，也不是定时提醒。沿用当前对话的已完成结果，不重放已完成操作。",
    `任务 ID：${task.id}\n目标：${task.objective}`,
    "全部验收项：",
    ...task.criteria.map(
      (c) =>
        `- ${c.id} [${c.passed ? "最近验证通过，最终仍需复验" : "未通过"}] ${c.title}${c.detail ? `；${c.detail}` : ""}`,
    ),
    `后台作业：${JSON.stringify(task.jobs)}`,
    task.detail ? `调度说明：${task.detail}` : "",
    "现在执行下一个未完成步骤。遇到可修复错误就修复并重试；不要只汇报‘下轮继续’或‘完成后接着做’。启动后台命令后系统会跟踪完成状态，作业未完成时可以结束这一小段，系统自动等待并恢复。",
    "每个阶段使用 goal_verify 检查固定验收合同；所有条件满足后调用 goal_finish 重新执行全部验收。自然语言声称完成不能结束持续任务。不可把编译前的 error CS=0 当成编译成功，不可把编译通过当成玩法验收通过。",
    "需要登录、审批或必须由用户决定时调用已有的确认/询问工具，诚实等待；用户停止时立即停止。不要为持续任务另排 schedule_follow_up，也不要通过更改验收脚本或伪造报告绕过目标。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createGoalTasks(options: {
  database: Database;
  runTurn: TurnRunner;
  executeCheck: (
    scope: GoalScope,
    check: z.infer<typeof checkSchema>,
  ) => Promise<unknown>;
  pollJob: (scope: GoalScope, job: GoalJob) => Promise<unknown>;
  isPaused: (threadId: string) => Promise<boolean>;
  clearPause: (threadId: string) => Promise<void>;
  stopRun: (threadId: string) => Promise<unknown>;
  botPaused: (scope: GoalScope) => Promise<boolean>;
  canUse: (ownerUserId: string, agentId: string) => Promise<boolean>;
  devicesReady?: (scope: GoalScope, deviceIds: string[]) => Promise<boolean>;
  pollMs?: number;
}) {
  const sql = options.database.$client;
  const pollMs = options.pollMs ?? 10_000;
  const running = new Set<Promise<void>>();
  const rows = (query: string, args: unknown[] = []) =>
    sql.unsafe<Row[]>(query, args);
  async function ensure() {
    await sql.unsafe(`/* goal-01 */ CREATE TABLE IF NOT EXISTS chisabot_goal_tasks (
      id text PRIMARY KEY, owner_user_id text NOT NULL, agent_id text NOT NULL,
      thread_id text NOT NULL REFERENCES openbot_local_threads(id) ON DELETE CASCADE,
      objective text NOT NULL, criteria jsonb NOT NULL, jobs jsonb NOT NULL DEFAULT '[]',
      status text NOT NULL DEFAULT 'active', detail text, generation integer NOT NULL DEFAULT 1,
      rounds integer NOT NULL DEFAULT 0, idle_rounds integer NOT NULL DEFAULT 0, message_cursor integer NOT NULL DEFAULT 0, last_run_id text, waiting_since timestamptz,
      active_calls jsonb NOT NULL DEFAULT '[]', lease_token text, lease_until timestamptz,
      next_check_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.unsafe(
      "/* goal-02 */ CREATE UNIQUE INDEX IF NOT EXISTS chisabot_goal_one_live_thread ON chisabot_goal_tasks(thread_id) WHERE status <> 'completed'",
    );
    await sql.unsafe(
      "/* goal-03 */ CREATE INDEX IF NOT EXISTS chisabot_goal_due ON chisabot_goal_tasks(next_check_at) WHERE status <> 'completed'",
    );
  }
  async function owned(scope: GoalScope): Promise<Row | null> {
    const [row] = await rows(
      "/* goal-04 */ SELECT * FROM chisabot_goal_tasks WHERE owner_user_id=$1 AND agent_id=$2 AND thread_id=$3 AND status <> 'completed' ORDER BY created_at DESC LIMIT 1",
      [scope.ownerUserId, scope.agentId, scope.threadId],
    );
    return row ?? null;
  }
  async function byId(id: string, ownerUserId: string): Promise<Row | null> {
    const [row] = await rows(
      "/* goal-05 */ SELECT * FROM chisabot_goal_tasks WHERE id=$1 AND owner_user_id=$2",
      [id, ownerUserId],
    );
    return row ?? null;
  }
  async function create(
    ownerUserId: string,
    input: z.infer<typeof goalInputSchema>,
  ) {
    if (!(await options.canUse(ownerUserId, input.agentId)))
      throw new Error("这个机器人不可用于持续任务。");
    const [thread] = await sql.unsafe<{ messages: Message[] }[]>(
      "/* goal-06 */ SELECT messages FROM openbot_local_threads WHERE id=$1 AND owner_user_id=$2 AND agent_id=$3",
      [input.threadId, ownerUserId, input.agentId],
    );
    if (!thread) throw new Error("对话不属于这个用户和机器人。");
    if (new Set(input.criteria.map((c) => c.id)).size !== input.criteria.length)
      throw new Error("验收项 ID 不能重复。");
    const existing = await owned({
      ownerUserId,
      agentId: input.agentId,
      threadId: input.threadId,
    });
    if (existing) throw new Error("此对话已有持续任务，请读取或恢复该任务。");
    const [row] = await rows(
      `/* goal-07 */ INSERT INTO chisabot_goal_tasks(id,owner_user_id,agent_id,thread_id,objective,criteria,jobs,message_cursor)
      VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7::text::jsonb,$8) RETURNING *`,
      [
        randomUUID(),
        ownerUserId,
        input.agentId,
        input.threadId,
        input.objective,
        JSON.stringify(input.criteria),
        JSON.stringify(
          (input.adoptJobs ?? []).map((j) => ({ ...j, status: "running" })),
        ),
        thread.messages.length,
      ],
    );
    if (!row) throw new Error("持续任务未保存。");
    await options.clearPause(input.threadId);
    return view(row);
  }
  async function pause(id: string, ownerUserId: string) {
    const [row] = await rows(
      "/* goal-08 */ UPDATE chisabot_goal_tasks SET status='paused', detail='用户已暂停持续任务。', generation=generation+1, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND status <> 'completed' RETURNING *",
      [id, ownerUserId],
    );
    if (!row) throw new Error("持续任务不存在或已完成。");
    await options.stopRun(row.thread_id);
    return view(row);
  }
  async function resume(id: string, ownerUserId: string) {
    const row = await byId(id, ownerUserId);
    if (!row || row.status === "completed")
      throw new Error("持续任务不存在或已完成。");
    await options.clearPause(row.thread_id);
    const [fresh] = await rows(
      "/* goal-09 */ UPDATE chisabot_goal_tasks SET status='active',waiting_since=NULL, detail='用户恢复了持续任务。',generation=generation+1,active_calls='[]',lease_token=NULL,lease_until=NULL,next_check_at=now(),updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *",
      [id, ownerUserId],
    );
    if (!fresh) throw new Error("持续任务未恢复。");
    return view(fresh);
  }
  async function observe(
    scope: GoalScope,
    name: string,
    args: unknown,
    raw: unknown,
  ) {
    const task = await owned(scope);
    if (!task || !automatic.includes(task.status)) return;
    const decoded = decodeGoalResult(raw);
    if (
      typeof decoded === "string" &&
      decoded.startsWith(REFUSAL_MARKER) &&
      !/离线|offline/i.test(decoded) &&
      /审批|批准|权限|登录|拒绝|permission|approval/i.test(decoded)
    ) {
      await sql.unsafe(
        "/* goal-10 */ UPDATE chisabot_goal_tasks SET status='waiting_approval',waiting_since=now(),detail=$3,updated_at=now() WHERE id=$1 AND generation=$2 AND status=ANY($4::text[])",
        [task.id, task.generation, decoded.slice(0, 1500), automaticParam],
      );
      return;
    }
    const value = object(decodeGoalResult(raw));
    const input = object(args);
    if (
      !value ||
      !input ||
      typeof input.deviceId !== "string" ||
      typeof value.jobId !== "string" ||
      typeof value.status !== "string" ||
      !["device_run_shell", "device_shell_output"].includes(name)
    )
      return;
    await sql.begin(async (tx) => {
      const [fresh] = await tx.unsafe<Row[]>(
        "/* goal-11 */ SELECT * FROM chisabot_goal_tasks WHERE id=$1 FOR UPDATE",
        [task.id],
      );
      if (
        !fresh ||
        fresh.generation !== task.generation ||
        !automatic.includes(fresh.status)
      )
        return;
      const marker =
        typeof input.command === "string"
          ? /^# chisabot-goal-operation:([a-f0-9-]+)/.exec(input.command)?.[1]
          : undefined;
      const jobs = fresh.jobs.filter(
        (j) =>
          !(j.jobId === value.jobId && j.deviceId === input.deviceId) &&
          !(marker && j.launchMarker === marker),
      );
      jobs.push({
        deviceId: input.deviceId as string,
        jobId: value.jobId as string,
        status: value.status as string,
        exitCode: value.exitCode,
        ...(marker ? { launchMarker: marker } : {}),
      });
      await tx.unsafe(
        "/* goal-12 */ UPDATE chisabot_goal_tasks SET jobs=$2::text::jsonb,updated_at=now() WHERE id=$1",
        [task.id, JSON.stringify(jobs)],
      );
    });
  }
  /** Save intent before the RPC. A restart reconciles the marked process via exec_list. */
  async function prepareDeviceCall(
    scope: GoalScope,
    name: string,
    input: unknown,
  ) {
    const args = object(input);
    if (
      name !== "device_run_shell" ||
      !args?.background ||
      typeof args.command !== "string" ||
      typeof args.deviceId !== "string"
    )
      return input;
    const task = await owned(scope);
    if (!task || !automatic.includes(task.status)) return input;
    const marker = randomUUID();
    await sql.begin(async (tx) => {
      const [fresh] = await tx.unsafe<Row[]>(
        "/* goal-13 */ SELECT * FROM chisabot_goal_tasks WHERE id=$1 FOR UPDATE",
        [task.id],
      );
      if (
        !fresh ||
        fresh.generation !== task.generation ||
        !automatic.includes(fresh.status)
      )
        throw new Error("持续任务已停止，后台命令没有启动。");
      const jobs: GoalJob[] = [
        ...fresh.jobs,
        {
          deviceId: args.deviceId as string,
          jobId: `launch:${marker}`,
          status: "launching",
          launchMarker: marker,
        },
      ];
      await tx.unsafe(
        "/* goal-14 */ UPDATE chisabot_goal_tasks SET jobs=$2::text::jsonb,updated_at=now() WHERE id=$1",
        [task.id, JSON.stringify(jobs)],
      );
    });
    return {
      ...args,
      command: `# chisabot-goal-operation:${marker}\n${args.command}`,
    };
  }
  async function operation(
    scope: GoalScope,
  ): Promise<(() => Promise<void>) | null> {
    const task = await owned(scope);
    if (!task) return null;
    if (!automatic.includes(task.status)) {
      if (currentConfirmTurn()?.runId === task.last_run_id)
        throw new Error("持续任务已停止，当前回合不能继续操作设备。");
      return null;
    }
    const id = randomUUID();
    const changed = await sql.unsafe(
      "/* goal-15 */ UPDATE chisabot_goal_tasks SET active_calls=active_calls || $2::text::jsonb WHERE id=$1 AND generation=$3 AND status=ANY($4::text[]) RETURNING id",
      [task.id, JSON.stringify([id]), task.generation, automaticParam],
    );
    if (!changed.length) throw new Error("持续任务已停止，设备操作没有启动。");
    return async () => {
      await sql.unsafe(
        "/* goal-16 */ UPDATE chisabot_goal_tasks SET active_calls=active_calls - $2 WHERE id=$1",
        [task.id, id],
      );
    };
  }
  async function verify(
    scope: GoalScope,
    criterionId?: string,
    finish = false,
  ) {
    const task = await owned(scope);
    if (!task || !automatic.includes(task.status))
      throw new Error("当前对话没有正在执行的持续任务。");
    const selected =
      finish || !criterionId
        ? task.criteria
        : task.criteria.filter((c) => c.id === criterionId);
    if (!selected.length) throw new Error("验收项不存在。");
    const results: Criterion[] = [];
    for (const criterion of selected) {
      const fresh = await byId(task.id, task.owner_user_id);
      if (
        !fresh ||
        fresh.generation !== task.generation ||
        !automatic.includes(fresh.status) ||
        (await options.isPaused(task.thread_id))
      )
        throw new Error("任务已停止，验收没有继续。");
      const raw = await options.executeCheck(scope, criterion.check);
      const decoded = decodeGoalResult(raw);
      const blocked = object(decoded);
      if (
        (typeof decoded === "string" &&
          decoded.startsWith(REFUSAL_MARKER) &&
          /审批|批准|权限|登录|拒绝|permission|approval/i.test(decoded)) ||
        blocked?.waiting === true ||
        blocked?.humanHasControl === true
      ) {
        await sql.unsafe(
          "/* goal-17 */ UPDATE chisabot_goal_tasks SET status='waiting_approval',waiting_since=now(),detail=$3,updated_at=now() WHERE id=$1 AND generation=$2 AND status=ANY($4::text[])",
          [
            task.id,
            task.generation,
            String(decoded).slice(0, 1500),
            automaticParam,
          ],
        );
        return view((await byId(task.id, task.owner_user_id)) ?? task);
      }
      results.push({
        ...criterion,
        ...acceptanceResult(raw, criterion.check.stdoutIncludes),
        checkedAt: new Date().toISOString(),
      });
    }
    if (await options.isPaused(task.thread_id))
      throw new Error("任务已停止，不能标记完成。");
    return sql.begin(async (tx) => {
      const [fresh] = await tx.unsafe<Row[]>(
        "/* goal-18 */ SELECT * FROM chisabot_goal_tasks WHERE id=$1 FOR UPDATE",
        [task.id],
      );
      if (
        !fresh ||
        fresh.generation !== task.generation ||
        !automatic.includes(fresh.status)
      )
        throw new Error("任务已停止，不能标记完成。");
      const criteria = fresh.criteria.map(
        (c) => results.find((r) => r.id === c.id) ?? c,
      );
      const complete =
        finish &&
        criteria.every((c) => c.passed === true) &&
        fresh.active_calls.length === 0 &&
        !fresh.jobs.some(
          (j) => j.status === "running" || j.status === "launching",
        );
      const detail = complete
        ? "全部固定验收已实际重跑并通过。"
        : "尚未全部验收通过；继续修复未通过项。";
      const [updated] = await tx.unsafe<Row[]>(
        "/* goal-19 */ UPDATE chisabot_goal_tasks SET criteria=$2::text::jsonb,status=CASE WHEN $3 THEN 'completed' ELSE status END,detail=$4,updated_at=now() WHERE id=$1 RETURNING *",
        [task.id, JSON.stringify(criteria), complete, detail],
      );
      if (!updated) throw new Error("验收结果未保存。");
      return view(updated);
    });
  }
  function tools(ownerUserId: string, agentId: string): GrantedTool[] {
    const scope = (): GoalScope => {
      const turn = currentConfirmTurn();
      if (!turn || turn.stopped())
        throw new Error("当前回合已停止或不属于对话。");
      return { ownerUserId, agentId, threadId: turn.threadId };
    };
    const make = (
      name: string,
      description: string,
      parameters: z.ZodType,
      fn: (args: unknown) => Promise<unknown>,
    ): GrantedTool => ({
      name,
      ref: `goals/${name}`,
      description,
      parameters,
      guidance:
        "用户要求持续到全部目标验收时，使用已登记的持续任务（goal_status）。阶段汇报不会结束目标，后台作业由系统自动跟踪恢复。goal_verify / goal_finish 运行固定的实际验收命令，口头声称完成无效。没有持续任务的普通聊天照常回答。",
      async execute(args) {
        try {
          const value = await fn(parameters.parse(args ?? {}));
          return JSON.stringify(
            object(value)?.status === "waiting_approval"
              ? { ...object(value), waiting: true }
              : value,
          );
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) throw error;
          return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
    return [
      make(
        "goal_start",
        "用户明确要求长任务持续执行到全部验收通过时，登记持久化任务。先将目标转为实际可执行的验收命令；后台作业完成和模型提前收尾后系统都会恢复原对话。普通问答不要登记。验收命令必须检查实际产物，不能只打印成功。",
        goalInputSchema.omit({ agentId: true, threadId: true }),
        async (args) => {
          const current = scope();
          return create(current.ownerUserId, {
            ...(args as Omit<
              z.infer<typeof goalInputSchema>,
              "agentId" | "threadId"
            >),
            agentId: current.agentId,
            threadId: current.threadId,
          });
        },
      ),
      make(
        "goal_status",
        "读取本对话持续任务的目标、固定验收条件、后台作业和当前状态。",
        z.object({}).strict(),
        async () => {
          const task = await owned(scope());
          return task ? view(task) : { task: null };
        },
      ),
      make(
        "goal_verify",
        "实际执行持续任务的固定验收命令；失败就修复后再验证，不能自行更改验收合同或直接声明 passed。",
        z.object({ criterionId: z.string().optional() }).strict(),
        async (args) =>
          verify(scope(), (args as { criterionId?: string }).criterionId),
      ),
      make(
        "goal_finish",
        "结束持续任务前重新实际执行全部固定验收。只有全部通过且没有待完成后台作业才能结束。",
        z.object({}).strict(),
        async () => verify(scope(), undefined, true),
      ),
    ];
  }
  async function release(
    row: Row,
    token: string,
    status: string,
    detail: string,
    delay = pollMs,
  ) {
    await sql.unsafe(
      `/* goal-20 */ UPDATE chisabot_goal_tasks SET waiting_since=CASE WHEN $3='waiting_approval' THEN coalesce(waiting_since,now()) ELSE NULL END,status=$3,detail=$4,next_check_at=now()+($5::int*interval '1 millisecond'),lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND status=ANY($6::text[])`,
      [row.id, token, status, detail.slice(0, 2000), delay, automaticParam],
    );
  }
  async function process(row: Row, token: string) {
    const scope: GoalScope = {
      ownerUserId: row.owner_user_id,
      agentId: row.agent_id,
      threadId: row.thread_id,
    };
    const heartbeat = setInterval(() => {
      void sql
        .unsafe(
          "/* goal-21 */ UPDATE chisabot_goal_tasks SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2",
          [row.id, token],
        )
        .catch(() => {});
    }, 15000);
    heartbeat.unref?.();
    try {
      if (
        (await options.isPaused(scope.threadId)) ||
        (await options.botPaused(scope))
      ) {
        await release(
          row,
          token,
          "paused",
          "用户停止或暂停了任务，等待明确恢复。",
        );
        return;
      }
      if (!(await options.canUse(scope.ownerUserId, scope.agentId))) {
        await release(row, token, "paused", "机器人已删除或访问权限被撤销。");
        return;
      }
      const [thread] = await sql.unsafe<
        { messages: Message[]; busy: boolean; archived: boolean }[]
      >(
        "/* goal-22 */ SELECT messages,archived,(run_id IS NOT NULL AND lock_expires_at>now()) AS busy FROM openbot_local_threads WHERE id=$1 AND owner_user_id=$2 AND agent_id=$3",
        [scope.threadId, scope.ownerUserId, scope.agentId],
      );
      if (!thread || thread.archived) {
        await release(row, token, "paused", "原对话已不存在或已归档。");
        return;
      }
      if (thread.busy) {
        await release(
          row,
          token,
          row.status === "waiting_approval" ? "waiting_approval" : "active",
          "原对话仍在执行，等当前回合结束后检查。",
        );
        return;
      }
      const messages = thread.messages;
      if (row.status === "waiting_approval" && row.waiting_since) {
        const [later] = await sql.unsafe(
          "/* goal-23 */ SELECT run_id FROM openbot_local_runs WHERE thread_id=$1 AND created_at>$2 AND status='finished' LIMIT 1",
          [scope.threadId, row.waiting_since],
        );
        if (!later) {
          await release(
            row,
            token,
            "waiting_approval",
            row.detail ?? "等待审批或用户输入。",
            30000,
          );
          return;
        }
      }
      const recent = messages.slice(
        Math.min(row.message_cursor, messages.length),
      );
      const jobs = jobsFromMessages(recent, row.jobs);
      const answered = new Set(
        messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
      );
      const pending = recent.some(
        (m) =>
          m.role === "assistant" &&
          m.toolCalls?.some((c) => !answered.has(c.id)),
      );
      const [terminal] = await sql.unsafe<
        {
          event: {
            metadata?: Record<string, unknown>;
            outcome?: { type?: string; interrupts?: unknown[] };
          };
        }[]
      >(
        "/* goal-24 */ SELECT event FROM openbot_local_events WHERE thread_id=$1 AND event->>'type'='RUN_FINISHED' ORDER BY sequence DESC LIMIT 1",
        [scope.threadId],
      );
      if (
        pending ||
        terminal?.event.outcome?.type === "interrupt" ||
        terminal?.event.metadata?.openbotWaiting
      ) {
        await release(
          row,
          token,
          "waiting_approval",
          "正在等待工具结果、审批或用户输入，不绕过等待。",
        );
        return;
      }
      let waiting = false,
        offline = false;
      for (const job of jobs) {
        if (job.status !== "running" && job.status !== "launching") continue;
        const raw = decodeGoalResult(await options.pollJob(scope, job));
        const result = object(raw);
        if (result && typeof result.status === "string") {
          if (typeof result.jobId === "string") job.jobId = result.jobId;
          job.status = result.status;
          job.exitCode = result.exitCode;
          job.detail = String(result.error ?? "").slice(0, 500);
        } else {
          const text = String(raw);
          job.detail = text.slice(0, 700);
          if (/离线|offline|not connected/i.test(text)) offline = true;
          else if (/没有.*(?:任务|命令)|not found|unknown job/i.test(text)) {
            job.status = "unknown";
            job.detail =
              "作业记录已失效，恢复后检查实际进程/输出文件，不能重新执行已完成操作。";
          } else if (text.startsWith(REFUSAL_MARKER)) {
            await release(row, token, "waiting_approval", text, 30000);
            return;
          }
        }
        waiting ||= job.status === "running" || job.status === "launching";
      }
      const updated = await sql.unsafe(
        "/* goal-25 */ UPDATE chisabot_goal_tasks SET jobs=$3::text::jsonb,message_cursor=$4,active_calls='[]',updated_at=now() WHERE id=$1 AND lease_token=$2 AND status=ANY($5::text[]) AND EXISTS(SELECT 1 FROM openbot_local_threads WHERE id=$6 AND jsonb_array_length(messages)=$4 AND (run_id IS NULL OR lock_expires_at<=now())) RETURNING id",
        [
          row.id,
          token,
          JSON.stringify(jobs),
          messages.length,
          automaticParam,
          scope.threadId,
        ],
      );
      if (!updated.length) return;
      if (waiting) {
        await release(
          row,
          token,
          offline ? "waiting_device" : "waiting_background",
          offline
            ? "设备离线，保留作业并等待重连。"
            : "后台作业仍在运行，完成后自动恢复原对话。",
          offline ? 30000 : pollMs,
        );
        return;
      }
      const fresh = await byId(row.id, scope.ownerUserId);
      if (
        !fresh ||
        fresh.lease_token !== token ||
        !automatic.includes(fresh.status) ||
        (await options.isPaused(scope.threadId))
      )
        return;
      if (
        options.devicesReady &&
        !(await options.devicesReady(
          scope,
          fresh.criteria.map((c) => c.check.args.deviceId),
        ))
      ) {
        await release(
          row,
          token,
          "waiting_device",
          "目标设备离线，保留全部进度并等待重连。",
          30000,
        );
        return;
      }
      const runId = randomUUID();
      await sql.unsafe(
        "/* goal-26 */ UPDATE chisabot_goal_tasks SET status='running',rounds=rounds+1,last_run_id=$3,detail='正在自动执行下一阶段。',updated_at=now() WHERE id=$1 AND lease_token=$2",
        [row.id, token, runId],
      );
      await options.runTurn({
        ...scope,
        routineId: `goal:${row.id}`,
        runId,
        instruction: goalInstruction(view(fresh)),
        automationContext: goalInstruction(view(fresh)),
        forwardedProps: {
          goalTaskContinuation: { id: row.id, generation: row.generation },
        },
        initiator: { kind: "routine", id: `goal:${row.id}` },
      });
      const after = await byId(row.id, scope.ownerUserId);
      if (
        !after ||
        after.status === "completed" ||
        !automatic.includes(after.status)
      )
        return;
      if (await options.isPaused(scope.threadId)) {
        await release(row, token, "paused", "用户已停止持续任务。");
        return;
      }
      if (after.status === "waiting_approval") {
        await release(
          row,
          token,
          "waiting_approval",
          after.detail ?? "等待审批或用户输入。",
          30000,
        );
        return;
      }
      const [newHistory] = await sql.unsafe<{ messages: Message[] }[]>(
        "/* goal-27 */ SELECT messages FROM openbot_local_threads WHERE id=$1",
        [scope.threadId],
      );
      const oldIds = new Set(messages.map((m) => m.id));
      const progressed = newHistory?.messages.some(
        (m) => m.role === "tool" && !oldIds.has(m.id),
      );
      const idleRounds = progressed ? 0 : row.idle_rounds + 1;
      await sql.unsafe(
        "/* goal-28 */ UPDATE chisabot_goal_tasks SET idle_rounds=$3 WHERE id=$1 AND lease_token=$2",
        [row.id, token, idleRounds],
      );
      await release(
        row,
        token,
        "active",
        progressed
          ? "本轮已结束，持续目标尚未全部验收；系统将自动检查作业并继续。"
          : "模型提前收尾且没有执行动作，持续任务仍未完成；退避后自动要求执行下一步。",
        Math.min(300000, pollMs * 2 ** Math.min(idleRounds, 6)),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        "goal-task-turn-failed",
        JSON.stringify({
          taskId: row.id,
          error: error instanceof Error ? error.name : "UnknownError",
          detail: detail.slice(0, 500),
        }),
      );
      await release(
        row,
        token,
        error instanceof HeadlessToolSuspension ? "waiting_approval" : "active",
        detail,
        error instanceof HeadlessToolSuspension ? 30000 : 60000,
      );
    } finally {
      clearInterval(heartbeat);
      await sql
        .unsafe(
          "/* goal-29 */ UPDATE chisabot_goal_tasks SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [row.id, token],
        )
        .catch(() => {});
    }
  }
  async function sweep() {
    if (running.size >= 2) return 0;
    const claimed = await sql.begin(async (tx) => {
      const due = await tx.unsafe<Row[]>(
        "/* goal-30 */ SELECT * FROM chisabot_goal_tasks WHERE status=ANY($1::text[]) AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT $2",
        [automaticParam, 2 - running.size],
      );
      for (const row of due) {
        row.lease_token = randomUUID();
        await tx.unsafe(
          "/* goal-31 */ UPDATE chisabot_goal_tasks SET lease_token=$2,lease_until=now()+interval '90 seconds' WHERE id=$1",
          [row.id, row.lease_token],
        );
      }
      return due;
    });
    for (const row of claimed) {
      const token = row.lease_token;
      if (!token) continue;
      const work = process(row, token)
        .catch((e: unknown) =>
          console.error(
            "goal-task-sweep",
            e instanceof Error ? e.message : String(e),
          ),
        )
        .finally(() => running.delete(work));
      running.add(work);
    }
    return claimed.length;
  }
  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.get("/", async (c) => {
      const threadId = c.req.query("threadId");
      const result = await rows(
        "/* goal-32 */ SELECT * FROM chisabot_goal_tasks WHERE owner_user_id=$1 AND ($2::text IS NULL OR thread_id=$2) ORDER BY created_at DESC LIMIT 40",
        [c.var.actor.id, threadId ?? null],
      );
      return c.json({ tasks: result.map(view) });
    });
    app.post("/", async (c) => {
      const input = goalInputSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!input.success)
        return c.json({ error: input.error.issues[0]?.message }, 400);
      try {
        return c.json({ task: await create(c.var.actor.id, input.data) }, 201);
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          409,
        );
      }
    });
    app.post("/:id/:action", async (c) => {
      try {
        const action = c.req.param("action");
        const id = c.req.param("id");
        if (!(await byId(id, c.var.actor.id)))
          return c.json({ error: "Task not found" }, 404);
        if (action !== "pause" && action !== "resume")
          return c.json({ error: "Unknown task action" }, 400);
        return c.json({
          task:
            action === "pause"
              ? await pause(id, c.var.actor.id)
              : await resume(id, c.var.actor.id),
        });
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          409,
        );
      }
    });
    return app;
  }
  return {
    ensure,
    create,
    pause,
    resume,
    tools,
    sweep,
    routes,
    observe,
    operation,
    prepareDeviceCall,
    verify,
    get: async (id: string, owner: string) => {
      const r = await byId(id, owner);
      return r ? view(r) : null;
    },
  };
}

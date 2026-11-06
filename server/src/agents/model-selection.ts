import { and, eq, isNull } from "drizzle-orm";
import {
  isReasoningEffort,
  type AgentModelState,
  type AgentRunOptions,
} from "../../../shared/model-selection";
import type { Database } from "../db/client";
import { agentProfiles, agents } from "../db/schema";
import type { ModelCatalogService } from "../model-catalog";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

export class ModelSelectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export type AgentModelService = {
  get(actor: AgentActor, id: string): Promise<AgentModelState>;
  set(
    actor: AgentActor,
    id: string,
    model: string | null | undefined,
    options?: AgentRunOptions,
  ): Promise<AgentModelState>;
  /** Internal runtime read. Visibility is checked by the actor's runtime roster first. */
  resolveModel(id: string): Promise<string | null>;
  resolveSettings(
    id: string,
  ): Promise<AgentRunOptions & { model: string | null }>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validModelId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /\s/u.test(value)
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** Package synchronization owns configuration; the independent override survives every boot. */
export function modelOverrideFromValue(value: unknown): string | null {
  const model = record(value).model;
  return validModelId(model) ? model : null;
}

export function runOptionsFromValue(value: unknown): AgentRunOptions {
  const row = record(value);
  return {
    ...(isReasoningEffort(row.reasoningEffort)
      ? { reasoningEffort: row.reasoningEffort }
      : {}),
    ...(typeof row.fastMode === "boolean" ? { fastMode: row.fastMode } : {}),
  };
}

function canSelect(actor: AgentActor, profile: AgentProfile): boolean {
  return (
    profile.deletedAt === null &&
    (actor.role === "admin" ||
      (!profile.systemOwned && profile.ownerUserId === actor.id))
  );
}

function local(type: string | undefined) {
  if (type !== "built_in")
    throw new ModelSelectionError(
      "此 BOT 在外部服务运行，模型请在其服务中配置。",
      409,
    );
}

function found(profile: AgentProfile | null): asserts profile is AgentProfile {
  if (!profile) throw new ModelSelectionError("找不到此 BOT。", 404);
}

function state(
  id: string,
  override: unknown,
  defaultModel: string,
  actor: AgentActor,
  profile: AgentProfile,
  available = true,
  supportsRunOptions = true,
): AgentModelState {
  const overrideModel = available ? modelOverrideFromValue(override) : null;
  const model = overrideModel ?? defaultModel;
  return {
    agentId: id,
    model,
    overrideModel,
    defaultModel,
    canManage: available && canSelect(actor, profile),
    available,
    reasoningEffort: available
      ? (runOptionsFromValue(override).reasoningEffort ?? null)
      : null,
    fastMode: available && runOptionsFromValue(override).fastMode === true,
    supportsRunOptions: available && supportsRunOptions,
  };
}

export function createAgentModelService(options: {
  database: Database;
  profiles: AgentProfileStore;
  resolveDefaultModel: () => Promise<string>;
  resolveProtocol?: () => Promise<"openai" | "anthropic">;
  catalog: ModelCatalogService;
}): AgentModelService {
  const { database, profiles } = options;
  const catalog = async () => {
    try {
      return await options.catalog.list();
    } catch {
      // Upstream response bodies and connection errors can contain credentials.
      throw new ModelSelectionError("模型列表暂时无法加载，请稍后重试。", 409);
    }
  };

  return {
    async get(actor, id) {
      const profile = await profiles.get(actor, id);
      found(profile);
      const [row] = await database
        .select({ type: agents.type, override: agents.override })
        .from(agents)
        .where(eq(agents.id, id));
      if (!row) throw new ModelSelectionError("找不到此 BOT。", 404);
      const defaultModel = await options.resolveDefaultModel();
      // Capability is separate from catalog membership, so stale/removed IDs remain readable.
      return state(
        id,
        row.override,
        defaultModel,
        actor,
        profile,
        row.type === "built_in",
        !options.resolveProtocol ||
          (await options.resolveProtocol()) === "openai",
      );
    },

    async set(actor, id, selected, runOptions = {}) {
      if (
        (runOptions.reasoningEffort !== undefined &&
          runOptions.reasoningEffort !== null &&
          !isReasoningEffort(runOptions.reasoningEffort)) ||
        (runOptions.fastMode !== undefined &&
          typeof runOptions.fastMode !== "boolean")
      )
        throw new ModelSelectionError(
          "请选择有效的思考深度和 Fast 模式。",
          400,
        );
      const supportsRunOptions =
        !options.resolveProtocol ||
        (await options.resolveProtocol()) === "openai";
      if (
        !supportsRunOptions &&
        (runOptions.reasoningEffort != null || runOptions.fastMode === true)
      )
        throw new ModelSelectionError(
          "当前连接协议不支持思考深度和 Fast 模式。",
          400,
        );
      if (
        selected !== undefined &&
        selected !== null &&
        !validModelId(selected)
      ) {
        throw new ModelSelectionError(
          "请选择模型列表中的模型，或使用默认模型。",
          400,
        );
      }
      const model = selected;
      const initial = await profiles.get(actor, id);
      found(initial);
      if (!canSelect(actor, initial))
        throw new ModelSelectionError("您无权修改此 BOT 的模型。", 403);
      const [initialRow] = await database
        .select({ type: agents.type })
        .from(agents)
        .where(eq(agents.id, id));
      local(initialRow?.type);
      // No network requests or second pooled reads while holding mutation locks.
      const [defaultModel, available] = await Promise.all([
        options.resolveDefaultModel(),
        model == null ? undefined : catalog(),
      ]);
      if (
        model != null &&
        !available?.models.some((entry) => entry.id === model)
      ) {
        throw new ModelSelectionError(
          "此模型不在当前列表中，请刷新模型列表后重新选择。",
          400,
        );
      }

      return database.transaction(async (transaction) => {
        // The same order used by profile mutation, so deletion/ownership changes serialize safely.
        await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, id))
          .for("update");
        await transaction
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .where(eq(agentProfiles.agentId, id))
          .for("update");
        const profile = await profiles.getWithin(transaction, actor, id);
        found(profile);
        if (!canSelect(actor, profile))
          throw new ModelSelectionError("您无权修改此 BOT 的模型。", 403);
        const [row] = await transaction
          .select({ type: agents.type, override: agents.override })
          .from(agents)
          .where(eq(agents.id, id));
        local(row?.type);
        const override = { ...record(row?.override) };
        if (model === null) delete override.model;
        else if (model !== undefined) override.model = model;
        if (runOptions.reasoningEffort === null)
          delete override.reasoningEffort;
        else if (runOptions.reasoningEffort !== undefined)
          override.reasoningEffort = runOptions.reasoningEffort;
        if (runOptions.fastMode !== undefined)
          override.fastMode = runOptions.fastMode;
        await transaction
          .update(agents)
          .set({ override, updatedAt: new Date() })
          .where(eq(agents.id, id));
        return state(
          id,
          override,
          defaultModel,
          actor,
          profile,
          true,
          supportsRunOptions,
        );
      });
    },

    async resolveModel(id) {
      return (await this.resolveSettings(id)).model;
    },

    async resolveSettings(id) {
      const [row] = await database
        .select({ override: agents.override })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            eq(agents.id, id),
            eq(agents.type, "built_in"),
            isNull(agentProfiles.deletedAt),
          ),
        );
      return {
        model: modelOverrideFromValue(row?.override),
        ...runOptionsFromValue(row?.override),
      };
    },
  };
}

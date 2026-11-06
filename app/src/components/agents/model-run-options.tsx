import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import {
  REASONING_EFFORTS,
  type AgentModelUpdate,
  type ReasoningEffort,
} from "../../../../shared/model-selection";
import { Switch } from "@/components/ui/switch";
import { useModelSelectionSaving } from "@/lib/model-selection/hooks";
import { saveAgentModelMutationOptions } from "@/lib/model-selection/mutations";
import {
  agentModelQueryOptions,
  modelSelectionKeys,
} from "@/lib/model-selection/queries";

const LABELS: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};

/** Both surfaces share the BOT's saved state and the existing send/save lock. */
export function ModelRunOptions({
  agentId,
  disabled = false,
}: {
  agentId: string;
  disabled?: boolean;
}) {
  const fastLabelId = useId();
  const queryClient = useQueryClient();
  const { data } = useQuery(agentModelQueryOptions(agentId));
  const save = useMutation(saveAgentModelMutationOptions(queryClient, agentId));
  const saving = useModelSelectionSaving(agentId);
  if (!data?.available) return null;
  const unsupported = data.supportsRunOptions === false;
  const locked = disabled || saving || !data.canManage || unsupported;
  const update = (value: AgentModelUpdate) => {
    if (
      !queryClient.isMutating({ mutationKey: modelSelectionKeys.save(agentId) })
    )
      save.mutate(value);
  };
  return (
    <div className="model-run-options">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs">
          <span>思考深度</span>
          <select
            aria-label="思考深度"
            className="model-effort-select"
            disabled={locked}
            value={data.reasoningEffort ?? ""}
            onChange={(event) =>
              update({
                reasoningEffort: (event.target.value ||
                  null) as ReasoningEffort | null,
              })
            }
          >
            <option value="">模型默认</option>
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {LABELS[effort]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 text-xs">
          <span id={fastLabelId}>Fast 模式</span>
          <Switch
            aria-labelledby={fastLabelId}
            nativeButton
            render={<button type="button" />}
            size="sm"
            checked={data.fastMode ?? false}
            disabled={locked}
            onCheckedChange={(checked) => update({ fastMode: checked })}
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {unsupported
          ? "当前连接协议不支持这些选项。"
          : "下一轮生效；需模型与网关支持，Fast 可能增加费用。"}
      </p>
      {saving ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          正在保存模型设置…
        </p>
      ) : null}
      {save.error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </div>
  );
}

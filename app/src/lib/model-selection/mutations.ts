import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { AgentModelState, AgentModelUpdate } from "../../../../shared/model-selection";
import { agentApiPath } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { loadModelCatalog, modelSelectionKeys } from "./queries";
import { notifyModelSelectionChanged } from "./sync";

export function saveAgentModelMutationOptions(queryClient: QueryClient, agentId: string) {
  return mutationOptions({
    mutationKey: modelSelectionKeys.save(agentId),
    onMutate: () => queryClient.cancelQueries({ queryKey: modelSelectionKeys.agent(agentId) }),
    mutationFn: async (model: string | null | AgentModelUpdate): Promise<AgentModelState> => {
      const response = await client(`${agentApiPath(agentId)}/model`, {
        method: "PUT", body: typeof model === "object" && model !== null ? model : { model }, fallback: "无法保存模型设置，请重试。",
      });
      return response.json();
    },
    onSuccess: async (state) => {
      await queryClient.cancelQueries({ queryKey: modelSelectionKeys.agent(agentId) });
      queryClient.setQueryData(modelSelectionKeys.agent(agentId), state);
      notifyModelSelectionChanged(agentId);
    },
  });
}

export function refreshModelsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: modelSelectionKeys.refresh,
    mutationFn: () => loadModelCatalog(true),
    onSuccess: (catalog) => {
      queryClient.setQueryData(modelSelectionKeys.catalog, catalog);
      void queryClient.invalidateQueries({ queryKey: modelSelectionKeys.agents });
      notifyModelSelectionChanged();
    },
  });
}

/** The send path checks the cache synchronously as well as the rendered button's pending state. */
export function assertModelSelectionNotSaving(queryClient: QueryClient, agentId: string) {
  if (queryClient.isMutating({ mutationKey: modelSelectionKeys.save(agentId) }) > 0) {
    throw new Error("模型正在保存，请稍后发送。");
  }
}

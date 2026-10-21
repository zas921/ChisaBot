/**
 * 模型用量的上报口（ledger.ts 的账本接在这里）。单独一个没有依赖的文件：context-usage.ts 在每次模型调用
 * 结束时调用它，不该为此把数据库和工具层带进模型包装里。
 */
export type ModelUsageEntry = {
  botId?: string;
  threadId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

let sink: ((entry: ModelUsageEntry) => void) | undefined;

/** index.ts 接上账本；没接（测试、脚本）时什么都不记。 */
export function setModelUsageSink(next: ((entry: ModelUsageEntry) => void) | undefined): void {
  sink = next;
}

/** 记一次模型调用。绝不影响回答：任何错误都吞掉。 */
export function reportModelUsage(entry: ModelUsageEntry): void {
  try {
    sink?.(entry);
  } catch {
    // 记账失败不影响回答。
  }
}

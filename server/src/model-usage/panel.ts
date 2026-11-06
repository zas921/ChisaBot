import type { UsageDay } from "./ledger";
import type { LivePanelRow } from "../live-panels/store";

/** Explicit opt-in: ordinary model-authored panels continue to use their own refresh flow. */
export const USAGE_PANEL_SOURCE = "chisabot-model-usage-v1";

export function tokenScale(tokens: number): { unit: string; divisor: number } {
  if (tokens >= 1_000_000_000) return { unit: "B", divisor: 1_000_000_000 };
  if (tokens >= 1_000_000) return { unit: "M", divisor: 1_000_000 };
  if (tokens >= 1_000) return { unit: "K", divisor: 1_000 };
  return { unit: "", divisor: 1 };
}

export function formatTokens(tokens: number): string {
  const { unit, divisor } = tokenScale(tokens);
  return `${Number((tokens / divisor).toFixed(2))}${unit}`;
}

export function usagePanelConfig(spec: string | null): { days: number; timeZone: string } | null {
  if (!spec) return null;
  try {
    const config = JSON.parse(spec).state?.usageSource;
    if (config?.type !== USAGE_PANEL_SOURCE) return null;
    if (!Number.isInteger(config.days) || config.days < 1 || config.days > 90 || typeof config.timeZone !== "string")
      throw new Error("用量面板的数据源设置无效");
    new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone });
    return { days: config.days, timeZone: config.timeZone };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function usagePanelSpec(spec: string, summary: { today: string; days: UsageDay[] }): string {
  const parsed = JSON.parse(spec);
  const today = summary.days.find(day => day.date === summary.today);
  const ordered = [...summary.days].sort((a, b) => a.date.localeCompare(b.date));
  const chartScale = tokenScale(Math.max(0, ...ordered.map(day => day.totalTokens)));
  parsed.state = { ...parsed.state,
    today: formatTokens(today?.totalTokens ?? 0),
    calls: today?.calls ?? 0,
    labels: ordered.map(day => day.date.slice(5).replace("-", "/")),
    series: ordered.map(day => Number((day.totalTokens / chartScale.divisor).toFixed(2))),
  };
  // Keep layout and state bindings; update date captions even across midnight.
  for (const element of Object.values(parsed.elements) as { type?: string; props?: Record<string, unknown> }[]) {
    if (element.type === "Metric" && (element.props?.value as { $state?: string })?.$state === "/today")
      element.props!.caption = summary.today.slice(5).replace("-", "/");
    if (element.type === "Chart" && (element.props?.data as { $state?: string })?.$state === "/series")
      element.props!.unit = chartScale.unit;
  }
  return JSON.stringify(parsed);
}

export function createUsagePanelRefresh(deps: {
  summary(owner: string, input: { days: number; timeZone: string }): Promise<{ today: string; days: UsageDay[] }>;
  update(owner: string, id: string, input: { spec: string; sources: { name: string }[] }): Promise<unknown>;
}) {
  return async (row: LivePanelRow, signal: AbortSignal): Promise<boolean> => {
    const config = usagePanelConfig(row.spec);
    if (!config) return false;
    signal.throwIfAborted();
    const summary = await deps.summary(row.ownerUserId, config);
    signal.throwIfAborted();
    await deps.update(row.ownerUserId, row.id, {
      spec: usagePanelSpec(row.spec!, summary), sources: [{ name: "ChisaBot 用量记录" }],
    });
    return true;
  };
}

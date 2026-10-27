import { useEffect, useState } from "react";

/**
 * ChisaBot PC 客户端的本机桥（docs/pc-node.md §8.2）。
 *
 * PC 客户端的主窗口就是这个网页本身，所以「设备」页面同时是 PC 的本机设置页。只有网页做不到的本机事情
 * 才走这座桥：本机紧急停止、高风险操作的本机确认、开机自启、文件夹选择器、退出登录。桥由 Electron 的
 * preload 只在「已登录的那台服务器」的页面里注入；主进程对每次调用再核对来源，并且任何「放松安全」的改动
 * （解除紧急停止、关闭本机确认、退出登录）都会在 PC 上弹出本机确认窗，网页无法替用户点。
 * 在普通浏览器里 `window.chisabotPC` 不存在，所有本机界面都不渲染。
 */

export type PcLocalState = {
  version: string;
  platform: string;
  hostname: string;
  serverUrl: string;
  deviceId: string;
  agentState: "online" | "connecting" | "offline" | "revoked" | "stopped";
  statusText: string;
  /** 本机有没有设备令牌（0.1.1 起）。false = 已登录但这台电脑还没登记成设备。旧客户端没有这个字段。 */
  enrolled?: boolean;
  /** 需要「登记这台电脑」：没登记 / 令牌无效 / 被撤销（0.1.1 起）。 */
  needsEnroll?: boolean;
  /** 节点这次连接走的路线：「直连」或「HTTP 代理 127.0.0.1:7890」（0.1.6 起，系统代理）。 */
  networkRoute?: string;
  tokenProtected: boolean;
  localPaused: boolean;
  forceLocalApproval: boolean;
  autoStart: boolean;
  startHidden: boolean;
  /** 自动更新（docs/online-update.md §PC）。旧客户端没有这个字段，网页就不显示更新设置。 */
  autoUpdate?: boolean;
  update?: PcUpdateState;
};

export type PcUpdateState = {
  /** 打包后的安装版才能自动更新；开发运行 / 免安装版为 false。 */
  supported: boolean;
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "none" | "error";
  /** 发现 / 下载好的新版本号。 */
  version?: string;
  /** 下载进度 0–100。 */
  percent?: number;
  checkedAt?: string;
  error?: string;
  /**
   * 个人定制版客户端（upstream-notice.js，2026-10-22）：不自动更新，只提示原版（repo）发布了比定制版所基于的原版
   * （base）更新的版本。这时 version 是原版的版本号，status available = 原版有新版本，releaseUrl 是发布页。
   */
  upstream?: boolean;
  repo?: string;
  base?: string;
  releaseUrl?: string;
};

export type PcLocalPatch = Partial<
  Pick<PcLocalState, "localPaused" | "forceLocalApproval" | "autoStart" | "startHidden" | "autoUpdate">
>;

export type PcBridge = {
  media?: import("../../../shared/media").PanelWebBridge;
  state(): Promise<PcLocalState>;
  /** 收紧（开启紧急停止 / 开启本机确认）立即生效；放松要在 PC 上本机确认，用户取消时返回的状态不变。 */
  setLocal(patch: PcLocalPatch): Promise<PcLocalState>;
  /** 系统文件夹选择器；返回选中的绝对路径（取消 = 空数组）。 */
  pickFolders(): Promise<string[]>;
  /** 退出登录并作废这台电脑的设备令牌（本机确认后），回到设置向导。 */
  logout(): Promise<boolean>;
  /**
   * 用当前登录会话把这台电脑（重新）登记成设备（0.1.1 起，旧客户端没有）。被撤销过的设备会先在 PC 上弹本机确认。
   * status：enrolled / already（令牌仍有效，重新连接）/ login（会话过期）/ offline / failed / cancelled。
   */
  enroll?(): Promise<{ status: string; message: string; state: PcLocalState }>;
  /** 跳过重连等待，立刻重新连接服务器（没登记时先补登记；0.1.6 起）。 */
  reconnect?(): Promise<{ status: string; message: string; state: PcLocalState }>;
  /** 立即检查更新（返回最新的更新状态）。 */
  checkUpdate?(): Promise<PcUpdateState>;
  /** 新版本已下载时，退出并安装（会先在本机弹确认窗）。 */
  installUpdate?(): Promise<boolean>;
  onChange(callback: () => void): () => void;
  /** 电脑文件夹同步（0.1.11 起，Windows；DESIGN.md §73.9）。旧客户端没有。 */
  sync?: PcSyncBridge;
};

export type PcSyncState = "cloud_only" | "syncing" | "pc_active" | "paused" | "conflict";
export type PcSyncBinding = {
  workspaceId: string;
  name: string;
  path: string;
  enabled: boolean;
  state: PcSyncState;
  detail: string | null;
  busy: string | null;
  progress: { done: number; total: number } | null;
  lastSyncedAt: string | null;
  files: number | null;
  bytes: number | null;
  conflicts: { path: string; kind: string }[];
  git: { branch?: string; head?: string; cloudHead?: string | null; result?: string; note?: string; at?: string } | null;
  gitConflict: string | null;
  unconfirmed: boolean;
  handoff: string | null;
  ignores: string[];
};
export type PcSyncStatus = { available: boolean; reason: string | null; platform?: string; ignores?: string[]; bindings: PcSyncBinding[] };
export type PcFolderInfo = {
  path: string;
  name: string;
  empty: boolean;
  files: number;
  bytes: number;
  truncated: boolean;
  big: boolean;
  git: { repo: boolean; branch?: string | null; head?: string | null; remote?: string | null; noGit?: boolean };
  skipped: { name: string; count: number }[];
  ignores: string[];
  bound: string | null;
  /** 0.1.15 起：bound 指的工作区已经在云端删掉了（本机留下的旧记录），可以「解除旧的同步并重新导入」。 */
  boundStale?: boolean;
  boundName?: string | null;
  staleIds?: string[];
};
export type PcSyncChoice = "cloud" | "pc" | "both" | "git_cloud" | "git_retry" | "handoff_retry";
export type PcSyncBridge = {
  version: number;
  status(): Promise<PcSyncStatus>;
  /** 系统的选择文件夹对话框 + 检查结果；取消 = null。 */
  pick(opts?: { forEnable?: boolean }): Promise<PcFolderInfo | null>;
  create(input: { path: string; name: string; enableSync: boolean }): Promise<{ workspace: { id: string; name: string }; state: PcSyncState; files: number; bytes: number }>;
  enable(input: { workspaceId: string; path?: string | null; name?: string; source?: string }): Promise<{ state: PcSyncState }>;
  release(workspaceId: string): Promise<{ state: PcSyncState }>;
  /** version 2（0.1.15）起：放下已在云端删掉的工作区留下的本机同步记录（服务器确认删掉了才放）。 */
  forget?(workspaceId: string): Promise<{ forgotten: boolean }>;
  syncNow(workspaceId: string): Promise<{ state: PcSyncState }>;
  resolve(input: { workspaceId: string; path: string; choice: PcSyncChoice }): Promise<unknown>;
  openFolder(workspaceId: string): Promise<string>;
  onChange(callback: () => void): () => void;
};

/** 本机桥的报错去掉 Electron 加的「Error invoking remote method 'pc:…': Error: 」前缀。 */
export function pcErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(Error:\s*)+/, "").trim() || "出错了";
}

/** 同一个文件夹（Windows 路径不分大小写，斜杠方向不论）。 */
export function samePcPath(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const n = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** PC 客户端的电脑同步桥（浏览器 / 手机 / 旧客户端是 null）。 */
export function pcSyncBridge(): PcSyncBridge | null {
  const b = pcBridge();
  return b?.sync ?? null;
}

/** PC 上的同步状态（主进程有变化就刷新，另外每 5 秒一次兜底）。 */
export function usePcSync(): PcSyncStatus | null {
  const [state, setState] = useState<PcSyncStatus | null>(null);
  useEffect(() => {
    const bridge = pcSyncBridge();
    if (!bridge) return;
    let alive = true;
    const load = () =>
      bridge
        .status()
        .then((next) => alive && setState(next))
        .catch(() => {});
    void load();
    const off = bridge.onChange(() => void load());
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      off();
      clearInterval(t);
    };
  }, []);
  return state;
}

declare global {
  interface Window {
    chisabotPC?: PcBridge;
  }
}

export function pcBridge(): PcBridge | null {
  return typeof window !== "undefined" && window.chisabotPC ? window.chisabotPC : null;
}

/** 在 PC 客户端里返回本机状态（随托盘 / 节点状态变化刷新）；在浏览器里始终是 null。 */
export function usePcLocal(): [PcLocalState | null, (next: PcLocalState) => void] {
  const [state, setState] = useState<PcLocalState | null>(null);
  useEffect(() => {
    const bridge = pcBridge();
    if (!bridge) return;
    let alive = true;
    const load = () =>
      bridge
        .state()
        .then((next) => alive && setState(next))
        .catch(() => {});
    void load();
    const off = bridge.onChange(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return [state, setState];
}

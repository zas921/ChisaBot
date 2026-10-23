export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
/** Constructed only by the authenticated server boundary. */
export type ActorContext = {
  actorId: string;
  botId: string;
  isAdmin?: boolean;
};
export type PanelCapability = {
  id: string;
  adapter: string;
  action: string;
  inputSchema: Record<string, Json>;
  outputSchema: Record<string, Json>;
  scope: Json;
  effect: "read" | "write";
};
export type PanelDefinition = {
  name: string;
  html: string;
  css: string;
  script: string;
  manifest: {
    data: readonly PanelCapability[];
    tasks: readonly PanelCapability[];
  };
  stateSchema: Record<string, Json>;
  schemaVersion: number;
  initialState: Json;
  size: { width: number; height: number | "auto" };
};
export type PanelDraft = {
  id: string;
  sessionId: string;
  actorId: string;
  botId: string;
  targetInstanceId: string | null;
  draftRevision: number;
  baseInstanceVersion: number | null;
  baseLibraryVersion: number | null;
  definition: PanelDefinition;
  status: "ready" | "saved" | "cancelled";
};
export type PanelInstance = {
  id: string;
  botId: string;
  instanceVersion: number;
  definition: PanelDefinition;
  sourceLibraryId: string | null;
  sourceVersion: number | null;
  position: number;
  collapsed: boolean;
  title: string;
  size: PanelDefinition["size"];
};
export type PanelSession = {
  sessionId: string;
  targetInstanceId: string | null;
  baseInstanceVersion: number | null;
  baseLibraryVersion: number | null;
  draft: PanelDraft | null;
};
export type PanelLibraryEntry = {
  id: string;
  version: number;
  definition: PanelDefinition;
  canManage: boolean;
};
export type PanelTask = {
  id: string;
  instanceId: string;
  botId: string;
  instanceVersion: number;
  capabilityId: string;
  args: { value: Json };
  status:
    | "pending"
    | "confirmed"
    | "running"
    | "waiting"
    | "unknown"
    | "succeeded"
    | "failed"
    | "cancelled";
  runId: string | null;
  channelId: string | null;
  replyText?: string;
};
export type PanelListPage = {
  items: PanelInstance[];
  nextOffset: number | null;
  canManage: boolean;
  canInteract: boolean;
};
export type DraftWrite = {
  sessionId: string;
  expectedDraftRevision: number;
  definition: PanelDefinition;
};
export type CommitInput = {
  draftId: string;
  expectedDraftRevision: number;
  baseInstanceVersion?: number;
  baseLibraryVersion?: number;
  libraryId?: string;
  mode: "first" | "instance" | "new-library" | "update-library";
  idempotencyKey: string;
  resetState: boolean;
};
export type CommitResult = {
  libraryId?: string;
  instanceId?: string;
  libraryVersion?: number;
  instanceVersion?: number;
};
export type StateWrite = {
  instanceId: string;
  instanceVersion: number;
  stateRevision: number;
  value: Json;
  resetIncompatible?: boolean;
};
export type PanelBinding = {
  instanceId: string;
  instanceVersion: number;
  botId: string;
};
export type PanelGrant = {
  instanceId: string;
  actorId: string;
  capabilityId: string;
  capabilityHash: string;
  adapter: string;
  action: string;
  inputSchema: Record<string, Json>;
  outputSchema: Record<string, Json>;
  scope: Json;
  effect: "read" | "write";
};
export type PanelBridge = {
  ui: { patch(value: Json): void };
  state: {
    read(signal?: AbortSignal): Promise<Json>;
    write(value: Json, signal?: AbortSignal): Promise<void>;
  };
  data: {
    read(capabilityId: string, args: Json, signal?: AbortSignal): Promise<Json>;
  };
  tasks: {
    request(
      actionId: string,
      args: Json,
      signal?: AbortSignal,
    ): Promise<{ requestId: string }>;
  };
};
export type PanelRuntimeOptions = {
  binding: PanelBinding | null;
  definition: PanelDefinition;
  mode: "preview" | "saved";
  bridge: PanelBridge;
};
export type PanelRuntime = {
  mount(container: HTMLElement): void;
  pause(): void;
  destroy(): void;
};
export class PanelError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
    /** 给模型 / 日志看的具体原因；只进 message，`code` 不变（接口和界面都按 code 认）。 */
    detail?: string,
  ) {
    super(detail ? `${code}（${detail}）` : code);
    this.name = "PanelError";
  }
}

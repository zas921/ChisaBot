export function mediaHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export type PanelWebState = {
  id: string;
  status: "loading" | "ready" | "error";
  detached: boolean;
  muted: boolean;
  pinned: boolean;
  error?: string;
};

export type PanelWebBridge = {
  version: 1;
  open(input: { id: string; url: string }): Promise<PanelWebState>;
  layout(input: { id: string; x: number; y: number; width: number; height: number; visible: boolean }): Promise<void>;
  control(input: { id: string; action: "reload" | "mute" | "detach" | "dock" }): Promise<PanelWebState>;
  release(id: string): Promise<void>;
  onState(callback: (state: PanelWebState) => void): () => void;
};

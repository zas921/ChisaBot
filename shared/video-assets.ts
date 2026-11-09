/** Only authenticated video asset transfers need an unlimited streaming lifetime. */
export function isVideoAssetRequest(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") &&
    /^\/api\/video-production\/jobs\/[^/]+\/assets\/[^/]+$/.test(pathname);
}

/** Bun 1.3.x's native fetch timer can cut an active download off at 300s. */
export function videoAssetFetchOptions(signal: AbortSignal): RequestInit & { timeout: false } {
  return { signal, timeout: false };
}

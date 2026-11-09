/**
 * Live screen relay toward the viewer, with real backpressure (2026-10-21, 内置浏览器卡顿;
 * 2026-11-02: binary JPEG frames).
 *
 * The proxy in index.ts used to read `ws.bufferedAmount` and drop above 2 MB. Bun's server socket
 * has no such property (it is `getBufferedAmount()`), and its `send` queues rather than throws when the
 * peer is slow, so nothing was ever dropped: on a slow link frames queued without bound and the
 * picture fell further and further behind what the Bot's browser was showing.
 *
 * Now: above a small budget only FRAMES are held back, and only the newest one is kept; it goes out
 * when the socket drains. Everything else (tabs, navigation results, errors, pings) is never dropped,
 * because losing one of those is a wrong screen, not a late one. Flow control end to end lives in
 * agent-computer/src/screencast.ts; this is the guard for viewers that do not take part in it.
 *
 * Frames are binary WebSocket messages (shared/screencast-frame.ts). Control messages stay JSON text.
 * Both shapes are recognised so a mixed hop during rollout does not park the wrong thing.
 */

import { isScreencastFrameMessage } from "../../../shared/screencast-frame";

/** About two screencast frames. Above this a frame waits for the socket to drain. */
export const VIEWER_BUFFER_BUDGET = 256 * 1024;

export type WirePayload = string | Uint8Array | ArrayBuffer | ArrayBufferView;

export type ViewerSocket = {
  send: (data: WirePayload) => unknown;
  getBufferedAmount?: () => number;
  bufferedAmount?: number;
};

export type RelayState = { parkedFrame?: WirePayload };

export function viewerBuffered(ws: ViewerSocket): number {
  try {
    if (typeof ws.getBufferedAmount === "function") return ws.getBufferedAmount();
  } catch {
    return 0;
  }
  return typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
}

/** Screencast picture (binary v1, or legacy JSON `{"type":"frame"…}`). */
export function isFrameMessage(data: WirePayload): boolean {
  return isScreencastFrameMessage(data);
}

/** Coerce Bun / browser binary payloads into something `ws.send` accepts. */
export function wireBytes(data: WirePayload): WirePayload {
  if (typeof data === "string" || data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** One message from the computer, on its way to the viewer. */
export function relayToViewer(
  ws: ViewerSocket,
  data: WirePayload,
  state: RelayState,
): void {
  const payload = wireBytes(data);
  if (isFrameMessage(payload)) {
    if (viewerBuffered(ws) > VIEWER_BUFFER_BUDGET) {
      // Newest wins: a parked frame is replaced, never queued behind.
      state.parkedFrame = payload;
      return;
    }
    // This frame is newer than anything parked, so the parked one is no longer worth sending.
    state.parkedFrame = undefined;
  }
  ws.send(payload);
}

/** The viewer's socket drained: send the newest held-back frame, if the budget allows it now. */
export function viewerDrained(ws: ViewerSocket, state: RelayState): void {
  const frame = state.parkedFrame;
  if (frame === undefined || viewerBuffered(ws) > VIEWER_BUFFER_BUDGET) return;
  state.parkedFrame = undefined;
  ws.send(frame);
}

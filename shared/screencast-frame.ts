/**
 * Live-screen frame wire format: one binary WebSocket message per JPEG.
 *
 * Why binary: the old path Base64-encoded the JPEG inside JSON, which grew every frame by ~33%,
 * forced a string parse on every hop, and made the ocean link and the Bun proxy copy more than they
 * needed to. Control messages (tabs, navigation, ping, errors, input) stay JSON text; only the
 * picture is binary.
 *
 * Layout (big-endian):
 *   magic u8 = 0x01
 *   flags u8 (bit0 = url present)
 *   width u16
 *   height u16
 *   urlLen u16
 *   url utf8 (urlLen bytes)
 *   jpeg bytes (remainder)
 */

export const SCREENCAST_FRAME_MAGIC = 0x01;

const FLAG_HAS_URL = 0x01;
const HEADER_SIZE = 8;
const MAX_DIMENSION = 8192;
const MAX_URL_BYTES = 4096;
/** ~20 MB JPEG ceiling; matches the old JSON path's data-length guard. */
const MAX_JPEG_BYTES = 20_000_000;

export type ScreencastFramePayload = {
  width: number;
  height: number;
  jpeg: Uint8Array;
  url?: string;
};

function assertDimension(n: number, label: string): void {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DIMENSION) {
    throw new RangeError(`${label} must be an integer 1…${MAX_DIMENSION}.`);
  }
}

/** Pack one frame for the wire. */
export function encodeScreencastFrame(frame: ScreencastFramePayload): Uint8Array {
  assertDimension(frame.width, "width");
  assertDimension(frame.height, "height");
  if (!(frame.jpeg instanceof Uint8Array) || frame.jpeg.byteLength === 0) {
    throw new TypeError("jpeg must be a non-empty Uint8Array.");
  }
  if (frame.jpeg.byteLength > MAX_JPEG_BYTES) {
    throw new RangeError("jpeg is too large.");
  }
  const urlBytes =
    frame.url && frame.url.length > 0
      ? new TextEncoder().encode(frame.url)
      : null;
  if (urlBytes && urlBytes.byteLength > MAX_URL_BYTES) {
    throw new RangeError("url is too long.");
  }
  const urlLen = urlBytes?.byteLength ?? 0;
  const out = new Uint8Array(HEADER_SIZE + urlLen + frame.jpeg.byteLength);
  out[0] = SCREENCAST_FRAME_MAGIC;
  out[1] = urlLen > 0 ? FLAG_HAS_URL : 0;
  out[2] = (frame.width >> 8) & 0xff;
  out[3] = frame.width & 0xff;
  out[4] = (frame.height >> 8) & 0xff;
  out[5] = frame.height & 0xff;
  out[6] = (urlLen >> 8) & 0xff;
  out[7] = urlLen & 0xff;
  if (urlBytes && urlLen > 0) out.set(urlBytes, HEADER_SIZE);
  out.set(frame.jpeg, HEADER_SIZE + urlLen);
  return out;
}

/** Turn any WS binary payload into bytes without copying when possible. */
export function asUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** True when this WebSocket data looks like a v1 screencast frame (binary or legacy JSON). */
export function isScreencastFrameMessage(
  data: string | ArrayBuffer | ArrayBufferView,
): boolean {
  if (typeof data === "string") return data.startsWith('{"type":"frame"');
  const bytes = asUint8Array(data);
  return bytes.byteLength >= HEADER_SIZE && bytes[0] === SCREENCAST_FRAME_MAGIC;
}

/** Decode a v1 binary frame, or null if it is not one / is corrupt. */
export function decodeScreencastFrame(
  data: ArrayBuffer | ArrayBufferView,
): ScreencastFramePayload | null {
  const bytes = asUint8Array(data);
  if (bytes.byteLength < HEADER_SIZE) return null;
  if (bytes[0] !== SCREENCAST_FRAME_MAGIC) return null;
  const flags = bytes[1] ?? 0;
  const width = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const height = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
  const urlLen = ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0);
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION)
    return null;
  if (urlLen > MAX_URL_BYTES) return null;
  if (bytes.byteLength < HEADER_SIZE + urlLen) return null;
  const jpegStart = HEADER_SIZE + urlLen;
  const jpegLen = bytes.byteLength - jpegStart;
  if (jpegLen <= 0 || jpegLen > MAX_JPEG_BYTES) return null;
  if ((flags & FLAG_HAS_URL) === 0 && urlLen !== 0) return null;
  let url: string | undefined;
  if (urlLen > 0) {
    try {
      url = new TextDecoder().decode(bytes.subarray(HEADER_SIZE, jpegStart));
    } catch {
      return null;
    }
  }
  // Copy jpeg so callers can retain the payload after the WS buffer is reused.
  const jpeg = bytes.slice(jpegStart);
  return { width, height, jpeg, ...(url ? { url } : {}) };
}

/** Chrome CDP hands JPEG as Base64; decode once at the source. */
export function jpegFromBase64(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(data, "base64"));
  }
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

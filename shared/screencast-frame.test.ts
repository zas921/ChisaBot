import { describe, expect, test } from "bun:test";
import {
  decodeScreencastFrame,
  encodeScreencastFrame,
  isScreencastFrameMessage,
  jpegFromBase64,
  SCREENCAST_FRAME_MAGIC,
} from "./screencast-frame";

describe("screencast binary frames", () => {
  test("round-trips jpeg + url", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const wire = encodeScreencastFrame({
      width: 1024,
      height: 640,
      jpeg,
      url: "https://example.com/path?x=1",
    });
    expect(wire[0]).toBe(SCREENCAST_FRAME_MAGIC);
    expect(isScreencastFrameMessage(wire)).toBe(true);
    const decoded = decodeScreencastFrame(wire);
    expect(decoded).toEqual({
      width: 1024,
      height: 640,
      jpeg,
      url: "https://example.com/path?x=1",
    });
  });

  test("round-trips without a url", () => {
    const jpeg = new Uint8Array([9, 8, 7]);
    const wire = encodeScreencastFrame({ width: 800, height: 600, jpeg });
    expect(decodeScreencastFrame(wire)).toEqual({
      width: 800,
      height: 600,
      jpeg,
    });
  });

  test("rejects corrupt or non-frame payloads", () => {
    expect(decodeScreencastFrame(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(isScreencastFrameMessage('{"type":"frame"')).toBe(true);
    expect(isScreencastFrameMessage('{"type":"tabs"}')).toBe(false);
    expect(isScreencastFrameMessage(new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      false,
    );
  });

  test("jpegFromBase64 matches Buffer", () => {
    const raw = new Uint8Array([1, 2, 3, 4, 255]);
    const b64 = Buffer.from(raw).toString("base64");
    expect([...jpegFromBase64(b64)]).toEqual([...raw]);
  });

  test("encode refuses absurd dimensions", () => {
    const jpeg = new Uint8Array([1]);
    expect(() =>
      encodeScreencastFrame({ width: 0, height: 10, jpeg }),
    ).toThrow();
    expect(() =>
      encodeScreencastFrame({ width: 10, height: 9000, jpeg }),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { FRAME_ACK_STALL_MS, type InputMessage, MIN_FRAME_INTERVAL_MS, startScreencast } from "../src/screencast";

/**
 * What a person's keystroke turns into on the wire.
 *
 * `screencast.ts` imports Playwright for its types only, and a type import is gone at run time, so
 * this reaches the translation without a browser. What it cannot reach is what Chrome then does with
 * it, which is the half that was wrong: `rawKeyDown` and `keyDown` are both delivered to the page,
 * and only one of them makes Chrome carry out what the key means. That difference was measured
 * against Chromium 151 rather than guessed, and this file pins the parameters that measurement
 * settled on.
 */

/** A CDP session that records what was asked of it, and answers everything. */
function recording() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    on() {},
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
  } as unknown as Page;
  return { page, sent };
}

/** The parameters of the one key event a message produced. */
async function dispatched(message: InputMessage) {
  const { page, sent } = recording();
  const cast = await startScreencast(page, () => {});
  sent.length = 0;
  await cast.send(message);
  const keyEvents = sent.filter(
    (call) => call.method === "Input.dispatchKeyEvent",
  );
  expect(keyEvents).toHaveLength(1);
  return keyEvents[0]?.params as Record<string, unknown>;
}

/** A keystroke exactly as the live screen sends one: text only for a printable character. */
function typed(
  event: "down" | "up",
  key: string,
  code: string,
  keyCode: number,
): InputMessage {
  return {
    type: "key",
    event,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(key.length === 1 ? { text: key } : {}),
    modifiers: 0,
  };
}

describe("a key a person presses while they hold the wheel", () => {
  test("Enter is a press the page acts on, not one it merely hears", async () => {
    // Measured through this file against Chromium 151: as a `rawKeyDown` the page's own `keydown`
    // listener saw Enter and nothing else happened -- the sign-in form did not submit, a textarea
    // did not take a new line, and a focused button was not pressed.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("\r");
  });

  test("a printable character keeps the text the person typed", async () => {
    const params = await dispatched(typed("down", "a", "KeyA", 65));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("a");
  });

  test("a key that produces no character is still a rawKeyDown", async () => {
    // Backspace, Delete, Tab, Home, End and the arrows were all measured to do what they mean
    // without text, so filling one in for them would be inventing an insertion.
    for (const [key, code, keyCode] of [
      ["Backspace", "Backspace", 8],
      ["Delete", "Delete", 46],
      ["Tab", "Tab", 9],
      ["ArrowLeft", "ArrowLeft", 37],
      ["Home", "Home", 36],
    ] as const) {
      const params = await dispatched(typed("down", key, code, keyCode));
      expect(params.type).toBe("rawKeyDown");
      expect(params).not.toHaveProperty("text");
    }
  });

  test("Enter going up is a key up carrying nothing it was not given", async () => {
    // The fill-in belongs to the way down, where a default action happens. A key up that carried a
    // carriage return would be a second one.
    const params = await dispatched(typed("up", "Enter", "Enter", 13));
    expect(params.type).toBe("keyUp");
    expect(params).not.toHaveProperty("text");
  });

  test("the virtual key code the surface offered is the one that is sent", async () => {
    // A form field ignores a bare Enter or Backspace without this, which is why it is sent at all.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.windowsVirtualKeyCode).toBe(13);
    expect(params.nativeVirtualKeyCode).toBe(13);
  });
});

describe("开场帧与地址栏", () => {
  /** A CDP session that answers a screenshot, and a page that can navigate. */
  function castable(options: { screenshot?: string; gotoFails?: string } = {}) {
    const sent: string[] = [];
    let handler: ((event: unknown) => void) | undefined;
    const client = {
      on(_event: string, listener: (event: unknown) => void) {
        handler = listener;
      },
      async send(method: string) {
        sent.push(method);
        if (method === "Page.captureScreenshot")
          return options.screenshot ? { data: options.screenshot } : {};
        return {};
      },
      async detach() {},
    };
    let url = "about:blank";
    const page = {
      context: () => ({ newCDPSession: async () => client }),
      url: () => url,
      viewportSize: () => ({ width: 1280, height: 800 }),
      goto: async (target: string) => {
        if (options.gotoFails) throw new Error(options.gotoFails);
        url = target;
      },
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {},
    } as unknown as Page;
    return { page, sent, emit: (event: unknown) => handler?.(event) };
  }

  test("开播后先发一张截图，静止的页面也有画面", async () => {
    const { page } = castable({ screenshot: "SHOT" });
    const frames: unknown[] = [];
    await startScreencast(page, (frame) => frames.push(frame));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toEqual([
      { type: "frame", data: "SHOT", width: 1280, height: 800, url: "about:blank" },
    ]);
  });

  test("Chrome 自己的帧先到时，不再补开场帧", async () => {
    const { page, emit } = castable({ screenshot: "SHOT" });
    const frames: { data?: string }[] = [];
    const cast = startScreencast(page, (frame) => frames.push(frame as { data?: string }));
    await cast;
    emit({ data: "CAST", sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames.map((f) => f.data)).toContain("CAST");
  });

  test("地址栏打开网址，结果发回去", async () => {
    const { page } = castable();
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "https://example.com/" });
    expect(messages).toContainEqual({ type: "navigation", ok: true, url: "https://example.com/" });
  });

  test("打不开时是一句中文说明，不是断线", async () => {
    const { page } = castable({ gotoFails: "net::ERR_TUNNEL_CONNECTION_FAILED at https://x.test/" });
    const messages: unknown[] = [];
    const cast = await startScreencast(page, (m) => messages.push(m));
    await cast.send({ type: "navigate", url: "https://x.test/" });
    expect(messages).toContainEqual({
      type: "navigation",
      ok: false,
      url: "about:blank",
      error: "网络策略不允许访问这个网址。",
    });
  });
});

/*
 * 2026-10-21 流量控制（内置浏览器卡顿）：Chrome 的帧不再立刻 ack。帧率上限 20 fps；查看端回 frame-ack
 * 之后，在途帧满 MAX_FRAMES_IN_FLIGHT 就先压住 Chrome，等查看端追上，下一帧总是最新画面。
 */
describe("直播画面的流量控制", () => {
  function chrome() {
    const acks: number[] = [];
    let handler: ((event: unknown) => void) | undefined;
    const client = {
      on(_event: string, listener: (event: unknown) => void) {
        handler = listener;
      },
      async send(method: string, params: { sessionId?: number } = {}) {
        if (method === "Page.screencastFrameAck" && typeof params.sessionId === "number") acks.push(params.sessionId);
        return {};
      },
      async detach() {},
    };
    const page = {
      context: () => ({ newCDPSession: async () => client }),
      url: () => "https://example.com/",
      viewportSize: () => ({ width: 1280, height: 800 }),
    } as unknown as Page;
    const frame = (sessionId: number) => handler?.({ data: `F${sessionId}`, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
    return { page, acks, frame };
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("ack 不早于帧间隔：最多每秒 20 帧", async () => {
    const { page, acks, frame } = chrome();
    await startScreencast(page, () => {});
    frame(1);
    expect(acks).toEqual([]);
    await sleep(MIN_FRAME_INTERVAL_MS + 20);
    expect(acks).toEqual([1]);
  });

  test("旧查看端不回 frame-ack：照常 ack，不会卡住", async () => {
    const { page, acks, frame } = chrome();
    await startScreencast(page, () => {});
    for (let id = 1; id <= 4; id++) {
      frame(id);
      await sleep(MIN_FRAME_INTERVAL_MS + 15);
    }
    expect(acks).toEqual([1, 2, 3, 4]);
  });

  test("查看端没追上时压住 Chrome，确认一到就放行", async () => {
    const { page, acks, frame } = chrome();
    const cast = await startScreencast(page, () => {});
    cast.frameDelivered?.(); // 这个查看端会回确认
    frame(1);
    await sleep(MIN_FRAME_INTERVAL_MS + 15);
    frame(2);
    await sleep(MIN_FRAME_INTERVAL_MS + 15);
    expect(acks).toEqual([1]); // 在途 2 帧，第 2 帧先不 ack
    cast.frameDelivered?.();
    await sleep(5);
    expect(acks).toEqual([1, 2]);
  });

  test("确认丢了也不会永远卡住", async () => {
    const { page, acks, frame } = chrome();
    const cast = await startScreencast(page, () => {});
    cast.frameDelivered?.();
    frame(1);
    await sleep(MIN_FRAME_INTERVAL_MS + 15);
    frame(2);
    await sleep(FRAME_ACK_STALL_MS + MIN_FRAME_INTERVAL_MS + 50);
    expect(acks).toEqual([1, 2]);
    await cast.stop();
  });
});

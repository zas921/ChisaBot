import { describe, expect, test } from "bun:test";
import { relayToViewer, VIEWER_BUFFER_BUDGET, viewerBuffered, viewerDrained } from "../src/computer/stream-relay";

/*
 * 2026-10-21 内置浏览器卡顿：Bun 的服务端 socket 没有 bufferedAmount，send 拥塞时排队而不是抛错，
 * 以前的「超过 2 MB 就丢帧」从来没生效。现在超过预算只压住画面帧（只留最新一帧），drain 时补发；
 * 标签、导航、错误、心跳从不丢。
 */
function viewer(buffered: number) {
  const sent: string[] = [];
  const ws = { buffered, send: (data: string) => sent.push(data), getBufferedAmount: () => ws.buffered };
  return { ws, sent };
}
const frame = (n: number) => JSON.stringify({ type: "frame", data: `F${n}`, width: 1280, height: 800 });

describe("live screen relay", () => {
  test("reads Bun's getBufferedAmount, not the missing property", () => {
    expect(viewerBuffered(viewer(123).ws)).toBe(123);
    expect(viewerBuffered({ send() {}, bufferedAmount: 7 })).toBe(7);
  });

  test("an uncongested viewer gets every frame at once", () => {
    const { ws, sent } = viewer(0);
    const state = {};
    relayToViewer(ws, frame(1), state);
    relayToViewer(ws, frame(2), state);
    expect(sent).toEqual([frame(1), frame(2)]);
  });

  test("congested: frames are held back, newest wins, sent on drain", () => {
    const { ws, sent } = viewer(VIEWER_BUFFER_BUDGET + 1);
    const state: { parkedFrame?: string } = {};
    relayToViewer(ws, frame(1), state);
    relayToViewer(ws, frame(2), state);
    expect(sent).toEqual([]);
    viewerDrained(ws, state); // still congested
    expect(sent).toEqual([]);
    ws.buffered = 0;
    viewerDrained(ws, state);
    expect(sent).toEqual([frame(2)]);
    expect(state.parkedFrame).toBeUndefined();
  });

  test("control messages are never dropped, even when congested", () => {
    const { ws, sent } = viewer(VIEWER_BUFFER_BUDGET * 10);
    const state = {};
    const tabs = JSON.stringify({ type: "tabs", tabs: [] });
    const nav = JSON.stringify({ type: "navigation", ok: true, url: "https://a.test/" });
    const ping = JSON.stringify({ type: "ping", t: 1 });
    for (const message of [tabs, nav, ping]) relayToViewer(ws, message, state);
    expect(sent).toEqual([tabs, nav, ping]);
  });

  test("a newer frame that can go out supersedes the parked one", () => {
    const { ws, sent } = viewer(VIEWER_BUFFER_BUDGET + 1);
    const state: { parkedFrame?: string } = {};
    relayToViewer(ws, frame(1), state);
    ws.buffered = 0;
    relayToViewer(ws, frame(2), state);
    expect(sent).toEqual([frame(2)]);
    viewerDrained(ws, state);
    expect(sent).toEqual([frame(2)]);
  });
});

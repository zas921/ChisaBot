import { afterEach, expect, test } from "bun:test";
import {
  readSendReceipt,
  SEND_RECEIPT_UNKNOWN_NOTICE,
  type SendReceipt,
  waitForSendReceipt,
} from "../src/lib/copilot/connection-drop";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("send confirmation reads a small identity endpoint instead of the transcript", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({ threadId: "thread/one", messageId: "message?one", received: true, running: true, persisted: false, runId: "run" });
  }) as typeof fetch;
  expect(await readSendReceipt("thread/one", "bot/one", "message?one")).toEqual({ received: true, running: true, persisted: false, runId: "run" });
  expect(calls).toEqual(["/api/copilotkit/threads/thread%2Fone/send-status?agentId=bot%2Fone&messageId=message%3Fone"]);
});

test.each([404, 503])("HTTP %s is unknown, never proof of a failed send", async (status) => {
  globalThis.fetch = (async () => new Response("unavailable", { status })) as unknown as typeof fetch;
  expect(await readSendReceipt("thread", "bot", "message")).toBeNull();
});

test("a receipt for another message cannot acknowledge this one", async () => {
  globalThis.fetch = (async () => Response.json({ threadId: "thread", messageId: "other", received: true, running: true })) as unknown as typeof fetch;
  expect(await readSendReceipt("thread", "bot", "message")).toBeNull();
});

test("an idle snapshot without the message still leaves an in-flight request unconfirmed", async () => {
  globalThis.fetch = (async () => Response.json({ threadId: "thread", messageId: "message", received: false, running: false, persisted: false })) as unknown as typeof fetch;
  expect(await readSendReceipt("thread", "bot", "message")).toEqual({ received: null, running: false, persisted: false, runId: null });
});

function scenario() {
  let time = 0;
  let stopped = false;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  let tick: () => void = () => {};
  const notices: Array<string | null> = [];
  const run = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  return {
    run, finish, fail, notices,
    now: () => time,
    stop: () => { stopped = true; },
    onTick: (fn: () => void) => { tick = fn; },
    deps: {
      now: () => time,
      stopped: () => stopped,
      onPending: (notice: string | null) => { notices.push(notice); },
      afterMs: async (ms: number) => {
        time += ms;
        tick();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      },
    },
  };
}

const accepted: SendReceipt = { received: true, running: true, persisted: false, runId: "run" };

test("server acceptance is enough before history persistence finishes", async () => {
  const s = scenario();
  expect(await waitForSendReceipt(s.run, { ...s.deps, probe: async () => accepted })).toEqual({ kind: "received", receipt: accepted });
  expect(s.notices.at(-1)).toBeNull();
});

test("unknown and temporarily unavailable receipts never stop or resubmit a task", async () => {
  const s = scenario();
  let probes = 0;
  const result = await waitForSendReceipt(s.run, {
    ...s.deps,
    probe: async () => {
      probes++;
      if (s.now() >= 45_000) return accepted;
      return probes % 2 ? null : { ...accepted, received: null, running: false, runId: null };
    },
  });
  expect(result).toEqual({ kind: "received", receipt: accepted });
  expect(s.now()).toBeGreaterThanOrEqual(45_000);
  expect(probes).toBeGreaterThan(4);
  expect(s.notices).toContain(SEND_RECEIPT_UNKNOWN_NOTICE);
  expect(s.notices.at(-1)).toBeNull();
});

test("an unconfirmed send survives two hours without automatic failure", async () => {
  const s = scenario();
  s.onTick(() => { if (s.now() >= 2 * 60 * 60_000) s.finish(); });
  expect(await waitForSendReceipt(s.run, { ...s.deps, probe: async () => ({ ...accepted, received: null, running: false }) })).toEqual({ kind: "done" });
  expect(s.now()).toBe(2 * 60 * 60_000);
});

test("manual stop remains responsive even when the acknowledgement request never settles", async () => {
  const s = scenario();
  s.onTick(() => { if (s.now() >= 13_000) s.stop(); });
  expect(await waitForSendReceipt(s.run, { ...s.deps, probe: () => new Promise(() => {}) })).toEqual({ kind: "stopped" });
  expect(s.now()).toBe(13_000);
});

test("a real request failure leaves confirmation so the existing failure path can report it", async () => {
  const s = scenario();
  s.onTick(() => { if (s.now() >= 2_000) s.fail(new Error("HTTP 401")); });
  expect(await waitForSendReceipt(s.run, { ...s.deps, probe: async () => null })).toEqual({ kind: "done" });
  await expect(s.run).rejects.toThrow("HTTP 401");
});

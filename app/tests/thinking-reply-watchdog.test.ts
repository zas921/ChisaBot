import { expect, test } from "bun:test";
import {
  SEND_REPLY_MAX_MS,
  waitForPersistedReply,
} from "../src/lib/copilot/connection-drop";

function scenario() {
  let time = 0;
  let progress = 0;
  let stopped = false;
  let finish!: () => void;
  const run = new Promise<void>((resolve) => { finish = resolve; });
  const notices: boolean[] = [];
  let tick: () => void = () => {};
  return {
    run, finish, notices,
    time: () => time,
    stop: () => { stopped = true; },
    progress: () => { progress = time; },
    onTick: (fn: () => void) => { tick = fn; },
    deps: {
      startedAt: 0,
      now: () => time,
      lastProgressAt: () => progress,
      stopped: () => stopped,
      silenceMs: 180_000,
      maxMs: SEND_REPLY_MAX_MS,
      probeMs: 5_000,
      onWaiting: (value: boolean) => { notices.push(value); },
      afterMs: async (ms: number) => {
        time += ms;
        tick();
        // Let state probes and run completion settle before the next clock tick.
        for (let i = 0; i < 8; i++) await Promise.resolve();
      },
    },
  };
}

test("a silent model stays alive beyond three minutes when the server is running", async () => {
  const s = scenario();
  let probes = 0;
  s.onTick(() => { if (s.time() >= 600_000) s.finish(); });
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => { probes++; return true; },
  })).toBe("done");
  expect(s.time()).toBeGreaterThanOrEqual(600_000);
  expect(probes).toBeGreaterThan(10);
  expect(s.notices).toEqual([true, false]);
});

test("server keepalives cannot extend the final 25 minute wall clock", async () => {
  const s = scenario();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => true,
  })).toBe("timeout");
  expect(s.time()).toBe(SEND_REPLY_MAX_MS);
  expect(s.notices).toEqual([true, false]);
});

test("continuous model progress cannot extend the final wall clock either", async () => {
  const s = scenario();
  let probes = 0;
  s.onTick(s.progress);
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => { probes++; return true; },
  })).toBe("timeout");
  expect(probes).toBe(0);
  expect(s.time()).toBe(SEND_REPLY_MAX_MS);
});

test("manual stop releases a silent turn even when the run and status request hang", async () => {
  const s = scenario();
  s.onTick(() => { if (s.time() >= 190_000) s.stop(); });
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: () => new Promise(() => {}),
  })).toBe("stopped");
  expect(s.time()).toBe(190_000);
});

test("server idle returns for history recovery instead of waiting on a lost finish event", async () => {
  const s = scenario();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => false,
  })).toBe("server_idle");
  expect(s.time()).toBeLessThan(185_000);
});

test.each([null, "unsupported"] as const)("unavailable status %s releases local waiting", async (status) => {
  const s = scenario();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => status,
  })).toBe("unreachable");
  expect(s.time()).toBeLessThanOrEqual(196_000);
});

test("a wedged status request is bounded independently of its own timeout", async () => {
  const s = scenario();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: () => new Promise(() => {}),
  })).toBe("unreachable");
  expect(s.time()).toBe(195_000);
});

test("the wall clock wins even if a status request never returns", async () => {
  const s = scenario();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, maxMs: 185_000, running: () => new Promise(() => {}),
  })).toBe("timeout");
  expect(s.time()).toBe(185_000);
});

test("new stream output clears the waiting notice and invalidates an old idle probe", async () => {
  const s = scenario();
  let probes = 0;
  let late!: (running: boolean) => void;
  s.onTick(() => {
    if (s.time() === 190_000) { s.progress(); late(false); }
    if (s.time() >= 200_000) s.finish();
  });
  expect(await waitForPersistedReply(s.run, {
    ...s.deps,
    running: async () => {
      if (++probes === 1) return true;
      return await new Promise<boolean>((resolve) => { late = resolve; });
    },
  })).toBe("done");
  expect(s.notices).toEqual([true, false]);
});

test("an already settled run needs no state probe or failure", async () => {
  const s = scenario();
  let probes = 0;
  s.finish();
  expect(await waitForPersistedReply(s.run, {
    ...s.deps, running: async () => { probes++; return false; },
  })).toBe("done");
  expect(probes).toBe(0);
});

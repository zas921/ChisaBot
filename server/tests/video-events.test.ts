import { describe, expect, test } from "bun:test";
import { createVideoProduction } from "../src/video-production/service";
import type { VideoEvent } from "../src/video-production/types";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(5); }
  throw new Error("Expected background condition was not reached.");
}
function event(seq: number, jobId = "project_a"): VideoEvent {
  return { seq, jobId, ownerId: "alice", botId: "producer", threadId: "thread_a", kind: "material_ready", message: `event ${seq}` };
}
function harness(initial: VideoEvent[], notify: (event: VideoEvent) => Promise<void>, pollMs = 10) {
  let events = initial;
  const acked: number[] = [], reads: number[] = [], failures: string[] = [];
  const fetcher: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (new Headers(init?.headers).get("Authorization") !== "Bearer worker-secret-token-for-tests") return Response.json({}, { status: 401 });
    if (url.pathname === "/v1/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      reads.push(after);
      return Response.json({ events: events.filter((row) => row.seq > after && !acked.includes(row.seq)).slice(0, 100) });
    }
    const match = /^\/v1\/events\/(\d+)\/ack$/.exec(url.pathname);
    if (match) { acked.push(Number(match[1])); return Response.json({ ok: true }); }
    throw new Error(`Unexpected worker request ${url.pathname}`);
  }) as typeof fetch;
  const service = createVideoProduction({ baseUrl: "http://worker.test:8090", token: "worker-secret-token-for-tests", fetch: fetcher, notify, pollMs, onError: (message) => failures.push(message) });
  return { service, acked, reads, failures, setEvents: (next: VideoEvent[]) => { events = next; } };
}

describe("video production durable event outbox", () => {
  test("one failed project remains unacknowledged while an unrelated project completes", async () => {
    let failed = false;
    const called: number[] = [];
    const h = harness([event(1), event(2, "project_b"), event(3)], async (value) => {
      called.push(value.seq);
      if (value.seq === 1 && !failed) { failed = true; throw new Error("transient model disconnect"); }
    });
    await expect(h.service.pollEvents()).rejects.toThrow("transient model disconnect");
    expect(h.acked).toEqual([2]);
    expect(called).not.toContain(3);
    await h.service.pollEvents();
    expect(h.acked).toEqual([2, 1, 3]);
    expect(called.filter((seq) => seq !== 2)).toEqual([1, 1, 3]);
    expect(h.reads.every((after) => after === 0)).toBe(true);
  });

  test("a slow delivery does not lock the next outbox fetch or new unrelated work", async () => {
    const slow = deferred(), begun = deferred();
    const called: number[] = [];
    const h = harness([event(1)], async (value) => {
      called.push(value.seq);
      if (value.seq === 1) { begun.resolve(); await slow.promise; }
    });
    const pending = h.service.pollEvents();
    await begun.promise;
    h.setEvents([event(1), event(2, "project_b")]);
    try {
      const next = h.service.pollEvents();
      await until(() => h.acked.includes(2));
      await next;
      expect(called).toEqual([1, 2]);
      expect(h.acked).toEqual([2]);
    } finally { slow.resolve(); await pending; }
    expect(h.acked).toEqual([2, 1]);
  });

  test("overlapping polls never run two deliveries for the same project", async () => {
    const slow = deferred(), begun = deferred();
    const called: number[] = [];
    const h = harness([event(1)], async (value) => {
      called.push(value.seq);
      if (value.seq === 1) { begun.resolve(); await slow.promise; }
    });
    const pending = h.service.pollEvents();
    await begun.promise;
    h.setEvents([event(1), event(2)]);
    try {
      await Promise.all([h.service.pollEvents(), h.service.pollEvents()]);
      expect(called).toEqual([1]);
    } finally { slow.resolve(); await pending; }
    await h.service.pollEvents();
    expect(called).toEqual([1, 2]);
    expect(h.acked).toEqual([1, 2]);
  });

  test("delivery concurrency is bounded and free slots dispatch the remaining project", async () => {
    const slow = deferred();
    const called: number[] = [];
    const h = harness(Array.from({ length: 5 }, (_, i) => event(i + 1, `project_${i}`)), async (value) => {
      called.push(value.seq);
      await slow.promise;
    });
    const pending = h.service.pollEvents();
    await until(() => called.length === 4);
    try {
      await h.service.pollEvents();
      expect(called).toHaveLength(4);
    } finally { slow.resolve(); await pending; }
    await h.service.pollEvents();
    expect(called).toHaveLength(5);
    expect(new Set(h.acked).size).toBe(5);
  });

  test("a full worker page containing a blocked project does not hide later projects", async () => {
    const slow = deferred(), begun = deferred();
    const all = [...Array.from({ length: 100 }, (_, i) => event(i + 1)), event(101, "project_b")];
    const h = harness(all, async (value) => {
      if (value.seq === 1) { begun.resolve(); await slow.promise; }
    });
    const pending = h.service.pollEvents();
    await begun.promise;
    try {
      await until(() => h.acked.includes(101));
      expect(h.reads).toContain(100);
      expect(h.acked).not.toContain(1);
    } finally { slow.resolve(); await pending; }
  });

  test("four persistently failing projects cannot monopolize every later polling slot", async () => {
    const called: number[] = [];
    const h = harness(Array.from({ length: 5 }, (_, i) => event(i + 1, `project_${i}`)), async (value) => {
      called.push(value.seq);
      if (value.seq < 5) throw new Error("project requires attention");
    });
    await expect(h.service.pollEvents()).rejects.toThrow("project requires attention");
    expect(called).not.toContain(5);
    await expect(h.service.pollEvents()).rejects.toThrow("project requires attention");
    expect(h.acked).toEqual([5]);
    expect(called).toContain(5);
  });

  test("background ticks discover unrelated work during a slow turn; stop prevents restart", async () => {
    const slow = deferred(), begun = deferred();
    const h = harness([event(1)], async (value) => {
      if (value.seq === 1) { begun.resolve(); await slow.promise; }
    }, 5);
    h.service.start();
    try {
      await begun.promise;
      h.setEvents([event(1), event(2, "project_b")]);
      await until(() => h.acked.includes(2));
      h.service.stop();
      await delay(15);
      const readsAtStop = h.reads.length;
      slow.resolve();
      await until(() => h.acked.includes(1));
      await delay(25);
      expect(h.reads.length).toBe(readsAtStop);
    } finally { h.service.stop(); slow.resolve(); }
  });
});

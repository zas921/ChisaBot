import { afterAll, beforeAll, expect, spyOn, test, describe } from "bun:test";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend, RELAY_STALE_MS } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("long interactive runs on a dedicated database", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `long-run-test-${crypto.randomUUID()}`;
  beforeAll(async () => { database = createDatabase(testDatabaseUrl(), TEST_POOL); backend = await createLocalConversations(database); });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id=$1", [owner]);
    await database.$client.close();
  });
  test("a silent model renews its lease past two hours and still stops on explicit request", async () => {
    const threadId = `${owner}-silent`;
    const runId = crypto.randomUUID();
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: "long-probe" });
    let heartbeat: (() => void) | undefined;
    const originalInterval = globalThis.setInterval;
    const timer = spyOn(globalThis, "setInterval").mockImplementation((handler, delay, ...args) => {
      if (delay === 30_000) heartbeat = () => { if (typeof handler === "function") handler(...args); };
      return originalInterval(handler, delay, ...args);
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    class SilentAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((out) => { out.next({ type: EventType.RUN_STARTED, threadId, runId: input.runId } as BaseEvent); started(); });
      }
    }
    const agent = new SilentAgent({ agentId: "long-probe", threadId });
    const events: BaseEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      backend.runner.run({ threadId, agent, input: { threadId, runId, protocolVersion: "1.0.0", messages: [{ id: "u", role: "user", content: "think" }], tools: [], context: [], state: {}, forwardedProps: {} } })
        .subscribe({ next: (event) => events.push(event), complete: resolve, error: reject });
    });
    try {
      await ready;
      expect(heartbeat).toBeDefined();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 60_000);
      try { heartbeat!(); } finally { clock.mockRestore(); }
      await Bun.sleep(50);
      expect(await backend.runner.isRunning({ threadId })).toBe(true);
      expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
      expect(await backend.runner.stop({ threadId, runId })).toBe(true);
      await done;
      expect(await backend.runner.isRunning({ threadId })).toBe(false);
    } finally {
      timer.mockRestore();
      await backend.runner.stop({ threadId, runId });
    }
  });
});

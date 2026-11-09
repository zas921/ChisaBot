import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import { Observable } from "rxjs";
import { z } from "zod/v4";
import { sanitizeSeededHistory } from "../src/agents/history-sanitize";
import { PERSON_INITIATOR } from "../src/audit";
import { managedBrowserCommand } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function collect(stream: Observable<BaseEvent>) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) });
  });
}

suite("queued supplements across frontend wire runs", () => {
  let database: ReturnType<typeof createDatabase>;
  let unsafe: ReturnType<typeof createDatabase>["$client"]["unsafe"];
  let interceptUnsafe: ((...args: Parameters<typeof unsafe>) => Promise<unknown>) | undefined;
  let backend: LocalConversationBackend;
  const owner = `inbox-test-${randomUUID()}`;
  const bot = `${owner}-bot`;
  beforeAll(async () => {
    const real = createDatabase(testDatabaseUrl(), TEST_POOL);
    unsafe = real.$client.unsafe.bind(real.$client);
    // Keep production's recovering SQL proxy intact; inject at the test's outer boundary.
    const client = new Proxy(real.$client, { get(target, key) {
      if (key === "unsafe") return interceptUnsafe ?? unsafe;
      return Reflect.get(target, key, target);
    } });
    database = Object.create(real);
    Object.defineProperty(database, "$client", { value: client });
    backend = await createLocalConversations(database);
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
    await database.$client.unsafe("DELETE FROM chisabot_thread_inbox WHERE owner_user_id = $1", [owner]);
    await database.$client.close();
  });
  async function post(threadId: string, operation: string, body: unknown) {
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${threadId}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), owner);
    expect(response?.status).toBe(200);
    return response!.json();
  }
  async function fixture(failTool = false) {
    const threadId = `${owner}-${randomUUID()}`;
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const generated = deferred();
    const finishGeneration = deferred();
    const toolStarted = deferred();
    const finishTool = deferred();
    let modelRuns = 0;
    let executions = 0;
    const inputs: Message[][] = [];
    class ProbeModel extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          void (async () => {
            modelRuns++;
            const messages = sanitizeSeededHistory(input.messages);
            inputs.push(structuredClone(messages));
            subscriber.next({ type: EventType.RUN_STARTED, threadId, runId: input.runId } as BaseEvent);
            if (!messages.some((message) => message.role === "tool" && message.toolCallId === "probe-call")) {
              subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}`, toolCallName: "computer_run_command", parentMessageId: `command-${modelRuns}` } as BaseEvent);
              subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}`, delta: JSON.stringify({ command: `append log; sleep ${modelRuns === 1 ? 10 : 11}` }) } as BaseEvent);
              subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: `probe-call${modelRuns === 1 ? "" : `-${modelRuns}`}` } as BaseEvent);
              generated.resolve();
              await finishGeneration.promise;
            } else {
              subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" } as BaseEvent);
              subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "ONCE_FOLLOWUP_OK" } as BaseEvent);
              subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "answer" } as BaseEvent);
            }
            subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId: input.runId } as BaseEvent);
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        });
      }
    }
    class BrowserAgent extends AbstractAgent {
      run(input: RunAgentInput) {
        return backend.runner.run({ threadId, agent: new ProbeModel({ agentId: bot, threadId }), input });
      }
    }
    const agent = new BrowserAgent({ agentId: bot, threadId, initialMessages: [{ id: "primary", role: "user", content: "Run the probe exactly once" }] });
    const core = new CopilotKitCore({ agents__unsafe_dev_only: { [bot]: agent }, tools: [{
      name: "computer_run_command", description: "Probe", parameters: z.object({ command: z.string() }),
      handler: async () => { executions++; toolStarted.resolve(); await finishTool.promise; if (failTool) throw new Error("command failed"); return "ONCE_DONE; log_lines=1"; },
    }] });
    return { threadId, agent, core, generated, finishGeneration, toolStarted, finishTool, inputs,
      counts: () => ({ modelRuns, executions }) };
  }

  test("a managed command continues exactly once after the browser unsubscribes before END", async () => {
    const threadId = `${owner}-${randomUUID()}`;
    const runId = randomUUID();
    const command = { name: "computer_run_command", description: "Probe", parameters: { type: "object" } };
    const callId = "saved-command";
    const observedPartial = deferred();
    const finishArguments = deferred();
    const serverAnswered = deferred();
    let modelRuns = 0;
    let executions = 0;
    const input: RunAgentInput = {
      threadId, runId, tools: [command], state: {}, context: [], forwardedProps: {},
      messages: [{ id: "primary", role: "user", content: "Do the command once" }],
    };
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const agent = new class extends AbstractAgent {
      run(request: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          void (async () => {
            modelRuns++;
            subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
            if (modelRuns === 1) {
              subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId: callId, toolCallName: command.name, parentMessageId: "command" });
              subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: '{"command":' });
              await finishArguments.promise;
              subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: '"read report"}' });
              subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: callId });
            } else {
              expect(request.messages.find((message) => message.role === "tool")).toMatchObject({ toolCallId: callId, content: '{"ok":true}' });
              subscriber.next({ type: EventType.TEXT_MESSAGE_START, role: "assistant", messageId: "final" });
              subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "final", delta: "Managed command complete." });
              subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "final" });
              serverAnswered.resolve();
            }
            subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        });
      }
    }({ agentId: bot, threadId });
    agent.use(managedBrowserCommand(async () => ({
      definition: command,
      execute: async (args) => { expect(args).toEqual({ command: "read report" }); executions++; return { ok: true }; },
    }), PERSON_INITIATOR));
    const run = backend.runner.run({ threadId, agent, input });
    const subscription = run.subscribe({
      next(event) { if (event.type === EventType.TOOL_CALL_ARGS) observedPartial.resolve(); },
      error(error) { throw error; },
    });
    await observedPartial.promise;
    expect(backend.claimFrontendCommand(threadId, runId, callId)).toBe(false);
    subscription.unsubscribe();
    expect(executions).toBe(0);
    finishArguments.resolve();
    await serverAnswered.promise;
    // Reattaching an observer only replays the saved result; it cannot execute the command.
    const replay = await collect(run);
    expect(replay.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject([{ toolCallId: callId, content: '{"ok":true}' }]);
    expect(replay.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toMatchObject({ delta: "Managed command complete." });
    expect(backend.control.isActive(threadId)).toBe(false);
    expect(backend.claimFrontendCommand(threadId, runId, callId)).toBe(false);
    expect(await unsafe("SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2", [threadId, runId])).toEqual([{ status: "finished" }]);
    await expect(collect(backend.runner.run({ threadId, agent, input }))).rejects.toThrow("Run ID was already used");
    expect({ modelRuns, executions }).toEqual({ modelRuns: 2, executions: 1 });
  });

  test("checkpoints a burst once and replays only the unsnapshotted text before live events", async () => {
    const threadId = `${owner}-${randomUUID()}`;
    const runId = randomUUID();
    const first = Array.from({ length: 24 }, (_, i) => `fragment-${i};`);
    const live = "final-fragment;";
    const release = deferred();
    const burstDurable = deferred();
    const replayReady = deferred();
    const input: RunAgentInput = {
      threadId, runId, tools: [], state: {}, context: [], forwardedProps: {},
      messages: [{ id: "primary", role: "user", content: "Stream a response" }],
    };
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const agent = new class extends AbstractAgent {
      run(): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "streamed", role: "assistant" });
          for (const delta of first) subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "streamed", delta });
          void release.promise.then(() => {
            subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "streamed", delta: live });
            subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "streamed" });
            subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
            subscriber.complete();
          });
        });
      }
    }({ agentId: bot, threadId });
    let snapshotWrites = 0;
    interceptUnsafe = (...args) => {
      if (args[0].includes("snapshot_sequence =") && args[1]?.[0] === threadId) snapshotWrites++;
      return unsafe(...args);
    };
    let run: Promise<BaseEvent[]> | undefined;
    try {
      const source = backend.runner.run({ threadId, agent, input });
      run = collect(new Observable((subscriber) => source.subscribe({
        next(event) {
          subscriber.next(event);
          if (event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === first.at(-1)) burstDurable.resolve();
        }, error: (error) => subscriber.error(error), complete: () => subscriber.complete(),
      })));
      await Promise.race([burstDurable.promise, run.then(() => { throw new Error("Run ended before the burst"); })]);
      expect(snapshotWrites).toBeLessThan(8);
      const resumedEvents = backend.runner.connect({ threadId, agentId: bot, agent } as Parameters<typeof backend.runner.connect>[0]);
      const resumed = collect(new Observable((subscriber) => resumedEvents.subscribe({
        next(event) {
          subscriber.next(event);
          if (event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === first.at(-1)) replayReady.resolve();
        }, error: (error) => subscriber.error(error), complete: () => subscriber.complete(),
      })));
      await Promise.race([replayReady.promise, resumed.then(() => { throw new Error("Reconnect omitted the durable suffix"); })]);
      release.resolve();
      const events = await resumed;
      await run;
      const snapshot = events.find((event) => event.type === EventType.MESSAGES_SNAPSHOT);
      expect(snapshot?.type).toBe(EventType.MESSAGES_SNAPSHOT);
      const before = snapshot?.type === EventType.MESSAGES_SNAPSHOT
        ? snapshot.messages.find((message) => message.id === "streamed")?.content ?? ""
        : "";
      const deltas = events.flatMap((event) => event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : []);
      expect(deltas.filter((delta) => delta === live)).toHaveLength(1);
      expect(before + deltas.join("")).toBe(first.join("") + live);
      expect((await backend.client.getThreadMessages({ threadId, userId: owner })).messages.some((message) => message.content === first.join("") + live)).toBe(true);
    } finally {
      release.resolve();
      await run?.catch(() => {});
      interceptUnsafe = undefined;
    }
  });

  test("persists a failure instead of offering a relay when an ended command contains truncated JSON", async () => {
    const threadId = `${owner}-${randomUUID()}`;
    const runId = randomUUID();
    const toolCallId = `truncated-${runId}`;
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    const agent = new class extends AbstractAgent {
      run(): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          subscriber.next({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "computer_run_command", parentMessageId: "truncated-command" });
          subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: '{"command":"unterminated' });
          subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId });
          subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
          subscriber.complete();
        });
      }
    }({ agentId: bot, threadId });
    const events = await collect(backend.runner.run({ threadId, agent, input: {
      threadId, runId, state: {}, context: [], forwardedProps: {},
      messages: [{ id: "primary", role: "user", content: "Run the probe" }],
      tools: [{ name: "computer_run_command", description: "Probe", parameters: { type: "object" } }],
    } }));
    expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(0);
    expect(events.find((event) => event.type === EventType.RUN_ERROR)).toMatchObject({ code: "INCOMPLETE_TOOL_CALL" });
    expect(backend.control.isActive(threadId)).toBe(false);
    expect(await post(threadId, "frontend-finished", { results: [{ id: "unexpected", role: "tool", toolCallId, content: "never executed" }] })).toEqual({ finished: false });
    expect(await unsafe("SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2", [threadId, runId])).toEqual([{ status: "error" }]);
  });

  test("early and tool-time supplements wait for the original result; the SDK executes one call", async () => {
    const f = await fixture();
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      await post(f.threadId, "inbox", { id: "early", text: "Keep the original command; do not rerun" });
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
      const [completedSegment] = await unsafe<{ run_id: string }[]>("SELECT run_id FROM openbot_local_runs WHERE thread_id = $1 AND status = 'finished'", [f.threadId]);
      expect(completedSegment?.run_id).toBeTruthy();
      const finishedRunId = completedSegment!.run_id;
      expect(backend.claimFrontendCommand(f.threadId, "", "probe-call")).toBe(false);
      expect(backend.claimFrontendCommand(f.threadId, "other-run", "probe-call")).toBe(false);
      expect(backend.claimFrontendCommand(f.threadId, finishedRunId, "other-call")).toBe(false);
      expect(backend.claimFrontendCommand(f.threadId, finishedRunId, "probe-call")).toBe(true);
      expect(backend.claimFrontendCommand(f.threadId, finishedRunId, "probe-call")).toBe(false);
      expect(f.agent.isRunning).toBe(false);
      expect(backend.control.isActive(f.threadId)).toBe(true);
      expect(await backend.runner.isRunning({ threadId: f.threadId })).toBe(true);
      expect(await post(f.threadId, "inbox", { id: "during-tool", text: "Add ONCE_FOLLOWUP_OK after it completes" })).toEqual({ queued: true, status: "queued" });
      const parked = await collect(backend.runner.run({ threadId: f.threadId, agent: new class extends AbstractAgent {
        run(): Observable<BaseEvent> { throw new Error("A parked send must not run a model"); }
      }({ agentId: bot }), input: { threadId: f.threadId, runId: randomUUID(), messages: [{ id: "other-device", role: "user", content: "Another supplement" }], state: {}, tools: [], context: [], forwardedProps: {} } }));
      expect(parked.filter((event) => event.type === EventType.TOOL_CALL_START)).toHaveLength(0);
      expect((await backend.inbox.queued(f.threadId)).map((item) => item.id)).toEqual(["early", "during-tool", "other-device"]);
      f.finishTool.resolve();
      await turn;
      expect(f.counts()).toEqual({ modelRuns: 2, executions: 1 });
      expect(backend.control.isActive(f.threadId)).toBe(false);
      const input = f.inputs[1]!;
      const resultAt = input.findIndex((message) => message.role === "tool" && message.toolCallId === "probe-call");
      expect(resultAt).toBeGreaterThan(0);
      for (const id of ["early", "during-tool", "other-device"]) expect(input.findIndex((message) => message.id === id)).toBeGreaterThan(resultAt);
      const history = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(history.messages.flatMap((message) => message.toolCalls ?? [])).toHaveLength(1);
      expect((await backend.inbox.list(f.threadId)).every((item) => item.status === "answered")).toBe(true);
    } finally {
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test("Stop during lease cleanup removes the relay before active is deleted", async () => {
    const f = await fixture();
    const cleanupReached = deferred();
    const releaseCleanup = deferred();
    const cleanup = backend.client.ɵcleanupThreadLock.bind(backend.client);
    backend.client.ɵcleanupThreadLock = async (identity) => {
      if (identity.threadId === f.threadId) {
        cleanupReached.resolve();
        await releaseCleanup.promise;
      }
      await cleanup(identity);
    };
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await cleanupReached.promise;
      // Both active and relay exist here, and the browser has not received RUN_FINISHED.
      await post(f.threadId, "inbox", { id: "cleanup-queued", text: "Stay queued after Stop" });
      const [run] = await database.$client.unsafe<{ run_id: string }[]>(
        "SELECT run_id FROM openbot_local_threads WHERE id = $1", [f.threadId],
      );
      expect(await backend.runner.stop({ threadId: f.threadId, runId: "stale" })).toBe(false);
      f.core.stopAgent({ agent: f.agent });
      expect(await backend.runner.stop({ threadId: f.threadId, runId: run!.run_id })).toBe(true);
      releaseCleanup.resolve();
      await turn;
      // Stop detaches the browser before server cleanup completes, so wait for that cleanup
      // explicitly rather than using the already-resolved browser promise as a completion signal.
      for (let attempt = 0; attempt < 100 && backend.control.isActive(f.threadId); attempt++) await Bun.sleep(5);
      expect(backend.control.isActive(f.threadId)).toBe(false);
      expect(await backend.runner.isRunning({ threadId: f.threadId })).toBe(false);
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 0 });
      expect((await backend.inbox.list(f.threadId)).filter((item) => item.status === "paused").map((item) => item.id)).toEqual(["cleanup-queued"]);
      expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
      const [saved] = await database.$client.unsafe<{ status: string }[]>(
        "SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2", [f.threadId, run!.run_id],
      );
      expect(saved?.status).toBe("stopped");
    } finally {
      backend.client.ɵcleanupThreadLock = cleanup;
      releaseCleanup.resolve(); f.finishGeneration.resolve(); f.finishTool.resolve();
      await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test.each(["snapshot", "newer-run"])("frontend result compare-and-set refuses a changed %s", async (changed) => {
    const f = await fixture(true);
    const turn = f.core.runAgent({ agent: f.agent });
    const updateReached = deferred();
    const releaseUpdate = deferred();
    let intercepted = false;
    let completing: Promise<unknown> | undefined;
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      f.finishTool.resolve();
      await turn;
      const results = f.agent.messages.filter((message) => message.role === "tool");
      interceptUnsafe = async (...args: Parameters<typeof unsafe>) => {
        if (!intercepted && String(args[0]).includes("UPDATE openbot_local_threads t SET messages")) {
          intercepted = true;
          updateReached.resolve();
          await releaseUpdate.promise;
        }
        return unsafe(...args);
      };
      completing = post(f.threadId, "frontend-finished", { results });
      await updateReached.promise;
      expect(intercepted).toBe(true);
      if (changed === "snapshot") {
        await unsafe("UPDATE openbot_local_threads SET messages = $2::text::jsonb WHERE id = $1", [f.threadId, JSON.stringify([{ id: "revised", role: "user", content: "New canonical snapshot" }])]);
      } else {
        // Even identical history must not authorize an older relay after a newer run finished.
        await unsafe("INSERT INTO openbot_local_runs (thread_id, run_id, status, created_at) VALUES ($1, $2, 'finished', clock_timestamp())", [f.threadId, randomUUID()]);
      }
      releaseUpdate.resolve();
      expect(await completing).toEqual({ finished: false });
      expect(backend.control.isActive(f.threadId)).toBe(true);
      const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(saved.messages.some((message) => message.toolCallId === "probe-call")).toBe(false);
      if (changed === "snapshot") expect(saved.messages.map((message) => message.id)).toEqual(["revised"]);
    } finally {
      releaseUpdate.resolve();
      await completing;
      interceptUnsafe = undefined;
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test.each(["stopped", "failed"])("%s relay cleanup holds a new explicit turn until old pause commits", async (outcome) => {
    const f = await fixture(true);
    const oldTurn = f.core.runAgent({ agent: f.agent });
    const pauseReached = deferred();
    const releasePause = deferred();
    const newStarted = deferred();
    const finishNew = deferred();
    const settle = backend.inbox.settle.bind(backend.inbox);
    let intercepted = false;
    let newRuns = 0;
    let closing: Promise<unknown> | undefined;
    let nextTurn: Promise<unknown> | undefined;
    class NewTurn extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable((subscriber) => {
          void (async () => {
            newRuns++;
            subscriber.next({ type: EventType.RUN_STARTED, threadId: f.threadId, runId: input.runId } as BaseEvent);
            newStarted.resolve();
            await finishNew.promise;
            subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "new-answer", role: "assistant" } as BaseEvent);
            subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "new-answer", delta: "Only the new turn" } as BaseEvent);
            subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "new-answer" } as BaseEvent);
            subscriber.next({ type: EventType.RUN_FINISHED, threadId: f.threadId, runId: input.runId } as BaseEvent);
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        });
      }
    }
    try {
      await f.generated.promise; f.finishGeneration.resolve(); await f.toolStarted.promise;
      await post(f.threadId, "inbox", { id: "old-held", text: "Keep this paused" });
      f.finishTool.resolve(); await oldTurn;
      backend.inbox.settle = async (threadId, runId, state) => {
        if (threadId === f.threadId && !intercepted && state !== "answered") {
          intercepted = true; pauseReached.resolve(); await releasePause.promise;
        }
        return settle(threadId, runId, state);
      };
      closing = outcome === "stopped" ? backend.runner.stop({ threadId: f.threadId })
        : post(f.threadId, "frontend-finished", { results: f.agent.messages.filter((message) => message.role === "tool") });
      await pauseReached.promise;
      expect(backend.control.isActive(f.threadId)).toBe(true);
      const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      nextTurn = collect(backend.runner.run({ threadId: f.threadId, agent: new NewTurn(), input: {
        threadId: f.threadId, runId: randomUUID(), state: {}, tools: [], context: [], forwardedProps: {},
        messages: [...saved.messages as Message[], { id: "new-explicit", role: "user", content: "Start this separate new turn" }],
      } }));
      expect(newRuns).toBe(0);
      releasePause.resolve(); await closing; await newStarted.promise;
      expect(newRuns).toBe(1);
      expect(await backend.inbox.isPaused(f.threadId)).toBe(false);
      expect(await post(f.threadId, "inbox", { id: "new-supplement", text: "Belongs only to the new turn" })).toEqual({ queued: true, status: "queued" });
      expect((await backend.inbox.get(f.threadId, "old-held"))?.status).toBe("paused");
      expect((await backend.inbox.get(f.threadId, "new-supplement"))?.status).toBe("queued");
      finishNew.resolve(); await nextTurn;
      expect((await backend.inbox.get(f.threadId, "old-held"))?.status).toBe("paused");
      expect((await backend.inbox.get(f.threadId, "new-supplement"))?.status).toBe("answered");
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
    } finally {
      releasePause.resolve(); finishNew.resolve(); f.finishGeneration.resolve(); f.finishTool.resolve();
      await closing; await nextTurn; await oldTurn;
      backend.inbox.settle = settle;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test("a transient database failure while closing a relay recovers without a stuck busy state or model retry", async () => {
    const f = await fixture(true);
    const turn = f.core.runAgent({ agent: f.agent });
    const failedCommit = deferred();
    let failures = 0;
    let attempts = 0;
    let stopping: Promise<boolean> | undefined;
    try {
      await f.generated.promise; f.finishGeneration.resolve(); await f.toolStarted.promise;
      await post(f.threadId, "inbox", { id: "recover-held", text: "Never run automatically" });
      f.finishTool.resolve(); await turn;
      interceptUnsafe = async (...args: Parameters<typeof unsafe>) => {
        if (String(args[0]).includes("UPDATE openbot_local_runs SET status = 'stopped'") && args[1]?.[0] === f.threadId) {
          attempts++;
          if (failures === 0) { failures++; failedCommit.resolve(); throw new Error("forced transient Stop bookkeeping failure"); }
        }
        return unsafe(...args);
      };
      stopping = backend.runner.stop({ threadId: f.threadId });
      await failedCommit.promise;
      expect(backend.control.isActive(f.threadId)).toBe(true);
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
      expect(await stopping).toBe(true);
      expect(failures).toBe(1);
      expect(attempts).toBe(2);
      expect(backend.control.isActive(f.threadId)).toBe(false);
      expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
      expect((await backend.inbox.get(f.threadId, "recover-held"))?.status).toBe("paused");
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
    } finally {
      interceptUnsafe = undefined;
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn; await stopping;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });

  test.each(["failed", "stopped"])("%s frontend completion releases relay and durably pauses supplements", async (outcome) => {
    const f = await fixture(outcome === "failed");
    const turn = f.core.runAgent({ agent: f.agent });
    try {
      await f.generated.promise;
      f.finishGeneration.resolve();
      await f.toolStarted.promise;
      await post(f.threadId, "inbox", { id: "queued", text: "Never rerun the probe" });
      expect(await backend.runner.stop({ threadId: f.threadId, runId: "stale" })).toBe(false);
      if (outcome === "stopped") {
        f.core.stopAgent({ agent: f.agent });
        expect(await backend.runner.stop({ threadId: f.threadId })).toBe(true);
      } else {
        // Let the real SDK handler fail: it saves a result locally, without a follow-up /run.
        f.finishTool.resolve();
        await turn;
        expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
        expect(await post(f.threadId, "frontend-finished", { results: [{ id: "failed-result", role: "tool", toolCallId: "unrelated", content: "Error: no" }] })).toEqual({ finished: false });
        const results = f.agent.messages.filter((message) => message.role === "tool");
        expect(await post(f.threadId, "frontend-finished", { results })).toEqual({ finished: true });
      }
      f.finishTool.resolve();
      await turn;
      expect(f.counts()).toEqual({ modelRuns: 1, executions: 1 });
      expect(backend.control.isActive(f.threadId)).toBe(false);
      expect((await backend.inbox.list(f.threadId)).filter((item) => item.status === "paused").map((item) => item.id)).toEqual(["queued"]);
      expect(await backend.inbox.isPaused(f.threadId)).toBe(true);
      const saved = await backend.client.getThreadMessages({ threadId: f.threadId, userId: owner });
      expect(saved.messages.some((message) => message.id === "queued")).toBe(false);
      if (outcome === "failed") expect(saved.messages.find((message) => message.toolCallId === "probe-call")?.content).toBe("Error: command failed");
    } finally {
      f.finishGeneration.resolve(); f.finishTool.resolve(); await turn;
      await backend.runner.stop({ threadId: f.threadId });
    }
  });
});

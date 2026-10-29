import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../src/db/client";
import {
  createLocalConversations,
  type LocalConversationBackend,
} from "../src/local-conversations";
import { createTurnRunner } from "../src/turns/run-turn";
import {
  createGoalTasks,
  type GoalScope,
  type GoalJob,
} from "../src/agents/goal-tasks";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite(
  "durable goals with real background processes and artifact acceptance",
  () => {
    let db: ReturnType<typeof createDatabase>;
    let backend: LocalConversationBackend;
    const owner = `goal-test-${crypto.randomUUID()}`;
    const dirs: string[] = [];
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    beforeAll(async () => {
      db = createDatabase(testDatabaseUrl(), TEST_POOL);
      backend = await createLocalConversations(db);
    });
    afterAll(async () => {
      for (const process of processes) {
        try {
          if (process.exitCode === null) process.kill();
          await process.exited;
        } catch {}
      }
      await Bun.sleep(100);
      await db.$client.unsafe(
        "DELETE FROM openbot_local_threads WHERE owner_user_id=$1",
        [owner],
      );
      await db.$client.close();
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    });
    async function until<T>(
      fn: () => Promise<T | null | false>,
      ms = 15000,
    ): Promise<T> {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const result = await fn();
        if (result) return result;
        await Bun.sleep(20);
      }
      throw new Error("Timed out awaiting the real goal workflow");
    }
    async function rig(delay = 500) {
      const directory = await mkdtemp(join(tmpdir(), "chisabot-goal-"));
      dirs.push(directory);
      const one = join(directory, "phase-one.txt"),
        two = join(directory, "phase-two.txt");
      const releaseFile = join(directory, "release-background");
      const threadId = crypto.randomUUID(),
        agentId = `goal-agent-${crypto.randomUUID()}`;
      const scope: GoalScope = { ownerUserId: owner, agentId, threadId };
      const initial = {
        id: crypto.randomUUID(),
        role: "user",
        content: "执行两阶段真实后台任务，全部验收通过才结束。",
      };
      await backend.client.getOrCreateThread({
        threadId,
        userId: owner,
        agentId,
      });
      await db.$client.unsafe(
        "UPDATE openbot_local_threads SET messages=$2::text::jsonb WHERE id=$1",
        [threadId, JSON.stringify([initial])],
      );
      let invocations = 0,
        launches = 0,
        stage = 0;
      let job: GoalJob | undefined;
      let controller: ReturnType<typeof createGoalTasks>;
      const contexts: RunAgentInput[] = [];
      const check = async (command: string) => {
        const child = Bun.spawn([process.execPath, "-e", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        processes.push(child);
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return JSON.stringify(JSON.stringify({ exitCode, stdout, stderr }));
      };
      class WorkflowAgent extends AbstractAgent {
        run(input: RunAgentInput): Observable<BaseEvent> {
          return new Observable((out) => {
            const work = async () => {
              invocations++;
              contexts.push(structuredClone(input));
              const emit = (event: object) => out.next(event as BaseEvent);
              emit({
                type: EventType.RUN_STARTED,
                threadId,
                runId: input.runId,
              });
              const tool = async (
                name: string,
                args: object,
                execute: () => Promise<unknown>,
              ) => {
                const id = crypto.randomUUID();
                emit({
                  type: EventType.TOOL_CALL_START,
                  toolCallId: id,
                  toolCallName: name,
                  parentMessageId: crypto.randomUUID(),
                });
                emit({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: id,
                  delta: JSON.stringify(args),
                });
                emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
                const result = await execute();
                emit({
                  type: EventType.TOOL_CALL_RESULT,
                  messageId: crypto.randomUUID(),
                  toolCallId: id,
                  content: JSON.stringify(result),
                });
              };
              if (stage++ === 0) {
                await tool(
                  "device_run_shell",
                  { deviceId: "test-device", background: true },
                  async () => {
                    launches++;
                    job = {
                      deviceId: "test-device",
                      jobId: crypto.randomUUID(),
                      status: "running",
                    };
                    const spawned = Bun.spawn(
                      [
                        process.execPath,
                        "-e",
                        `const f=require('node:fs');setTimeout(()=>{const timer=setInterval(()=>{if(f.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);f.writeFileSync(${JSON.stringify(one)},'PHASE_ONE_REAL')}},20)},${delay});setTimeout(()=>process.exit(124),30000).unref()`,
                      ],
                      { stdout: "ignore", stderr: "ignore" },
                    );
                    processes.push(spawned);
                    void spawned.exited.then((code) => {
                      if (job) {
                        job.status = "exited";
                        job.exitCode = code;
                      }
                    });
                    await controller.observe(
                      scope,
                      "device_run_shell",
                      { deviceId: "test-device" },
                      JSON.stringify(job),
                    );
                    return JSON.stringify(job);
                  },
                );
              } else if (stage === 2) {
                // Deliberately claim completion while phase two has never happened.
                await tool("goal_finish", {}, async () =>
                  controller.verify(scope, undefined, true),
                );
              } else {
                expect(await readFile(one, "utf8")).toBe("PHASE_ONE_REAL");
                await tool(
                  "device_run_shell",
                  { deviceId: "test-device" },
                  async () => {
                    const code = `const f=require('node:fs');if(f.readFileSync(${JSON.stringify(one)},'utf8')!=='PHASE_ONE_REAL')process.exit(2);f.writeFileSync(${JSON.stringify(two)},'PHASE_TWO_REAL');console.log('SECOND_PHASE_EXECUTED')`;
                    return check(code);
                  },
                );
                await tool("goal_finish", {}, async () =>
                  controller.verify(scope, undefined, true),
                );
              }
              const messageId = crypto.randomUUID();
              emit({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              });
              emit({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta:
                  stage < 3 ? "本轮完成，之后再继续。" : "全部真实验收通过。",
              });
              emit({ type: EventType.TEXT_MESSAGE_END, messageId });
              emit({
                type: EventType.RUN_FINISHED,
                threadId,
                runId: input.runId,
                metadata: { finishReason: "stop" },
              });
              out.complete();
            };
            void work().catch((error: unknown) => out.error(error));
          });
        }
      }
      const runTurn = createTurnRunner({
        intelligence: backend.client,
        runner: backend.runner,
        buildAgentFor: async () => new WorkflowAgent({ agentId }),
        turnTimeoutMs: 0,
      });
      const options = {
        database: db,
        runTurn,
        pollMs: 25,
        executeCheck: async (
          _scope: GoalScope,
          spec: { args: { command: string } },
        ) => check(spec.args.command),
        pollJob: async () => JSON.stringify(JSON.stringify(job)),
        isPaused: (id: string) => backend.inbox.isPaused(id),
        clearPause: (id: string) => backend.inbox.startExplicitTurn(id),
        stopRun: async (id: string) => {
          await backend.inbox.pause(id);
          return backend.runner.stop({ threadId: id });
        },
        botPaused: async () => false,
        canUse: async () => true,
      };
      controller = createGoalTasks(options);
      await controller.ensure();
      const makeCheck = (file: string, text: string) => ({
        tool: "device_run_shell" as const,
        args: {
          deviceId: "test-device",
          command: `const f=require('node:fs');if(!f.existsSync(${JSON.stringify(file)})||f.readFileSync(${JSON.stringify(file)},'utf8')!==${JSON.stringify(text)}){console.error('真实产物缺失');process.exit(1)}console.log(${JSON.stringify(text)})`,
        },
        stdoutIncludes: [text],
      });
      const task = await controller.create(owner, {
        agentId,
        threadId,
        objective: "实际后台阶段一结束后执行阶段二，两个产物都由命令验收",
        criteria: [
          {
            id: "one",
            title: "真实后台产物一",
            check: makeCheck(one, "PHASE_ONE_REAL"),
          },
          {
            id: "two",
            title: "依赖阶段一的真实产物二",
            check: makeCheck(two, "PHASE_TWO_REAL"),
          },
        ],
      });
      return {
        task,
        scope,
        one,
        two,
        contexts,
        options,
        releaseBackground: () => writeFile(releaseFile, "released"),
        stats: () => ({ invocations, launches, stage }),
        controller: () => controller,
        restart: () => {
          controller = createGoalTasks(options);
          return controller;
        },
        state: () => controller.get(task.id, owner),
        tick: () => controller.sweep(),
      };
    }
    test("normal final replies cannot finish a goal; a real completed background process resumes the original thread", async () => {
      const r = await rig(650);
      await until(async () => {
        await r.tick();
        const task = await r.state();
        return task?.status === "waiting_background" && task;
      });
      expect(r.stats()).toMatchObject({ invocations: 1, launches: 1 });
      r.restart(); // App scheduler restart: durable rows, same device process and original thread.
      await r.releaseBackground();
      const completed = await until(async () => {
        await r.tick();
        const task = await r.state();
        return task?.status === "completed" && task;
      });
      await until(
        async () =>
          !(await backend.runner.isRunning({ threadId: r.scope.threadId })),
      );
      expect(completed.criteria.every((c) => c.passed)).toBe(true);
      expect(r.stats()).toMatchObject({ invocations: 3, launches: 1 });
      expect(await readFile(r.two, "utf8")).toBe("PHASE_TWO_REAL");
      expect(
        r.contexts.every((i) =>
          i.context.some((c) => c.value.includes(r.task.id)),
        ),
      ).toBe(true);
      const [row] = await db.$client.unsafe<{ messages: { role: string }[] }[]>(
        "SELECT messages FROM openbot_local_threads WHERE id=$1",
        [r.scope.threadId],
      );
      expect(row?.messages.filter((m) => m.role === "user")).toHaveLength(1);
    }, 20000);
    test("Stop is durable across scheduler restart and job completion; explicit resume finishes without launching the job again", async () => {
      const r = await rig(600);
      await until(async () => {
        await r.tick();
        return (await r.state())?.status === "waiting_background";
      });
      await r.controller().pause(r.task.id, owner);
      r.restart();
      await r.releaseBackground();
      await Bun.sleep(900);
      for (let i = 0; i < 5; i++) {
        await r.tick();
        await Bun.sleep(25);
      }
      expect((await r.state())?.status).toBe("paused");
      expect(r.stats().invocations).toBe(1);
      await r.controller().resume(r.task.id, owner);
      await until(async () => {
        await r.tick();
        return (await r.state())?.status === "completed";
      });
      await until(
        async () =>
          !(await backend.runner.isRunning({ threadId: r.scope.threadId })),
      );
      expect(r.stats()).toMatchObject({ invocations: 3, launches: 1 });
    }, 20000);
    test("a check needing permission does not turn into repeated background retries or completion", async () => {
      const r = await rig();
      const blocked = createGoalTasks({
        database: db,
        runTurn: async () => {
          throw new Error("must not run");
        },
        executeCheck: async () => "Refused. 验收命令需要用户批准。",
        pollJob: async () => ({}),
        isPaused: async () => false,
        clearPause: async () => {},
        stopRun: async () => {},
        botPaused: async () => false,
        canUse: async () => true,
        pollMs: 20,
      });
      await blocked.verify(r.scope, "one");
      expect((await blocked.get(r.task.id, owner))?.status).toBe(
        "waiting_approval",
      );
      for (let i = 0; i < 3; i++) {
        await blocked.sweep();
        await Bun.sleep(30);
      }
      expect((await blocked.get(r.task.id, owner))?.status).toBe(
        "waiting_approval",
      );
      expect(r.stats().invocations).toBe(0);
      await blocked.pause(r.task.id, owner);
    });
    test("another owner cannot read, pause or complete this user's task", async () => {
      const r = await rig();
      expect(await r.controller().get(r.task.id, "another-owner")).toBeNull();
      await expect(
        r.controller().pause(r.task.id, "another-owner"),
      ).rejects.toThrow();
      await expect(
        r
          .controller()
          .verify(
            { ...r.scope, ownerUserId: "another-owner" },
            undefined,
            true,
          ),
      ).rejects.toThrow();
      await r.controller().pause(r.task.id, owner);
    });
    test("two schedulers claim one durable task and never duplicate the real background launch", async () => {
      const r = await rig(400);
      const second = r.restart();
      await until(async () => {
        await Promise.all([r.tick(), second.sweep()]);
        const task = await r.state();
        if (task?.status === "waiting_background") await r.releaseBackground();
        return task?.status === "completed";
      });
      await until(
        async () =>
          !(await backend.runner.isRunning({ threadId: r.scope.threadId })),
      );
      expect(r.stats()).toMatchObject({ invocations: 3, launches: 1 });
    }, 20000);
    test("pausing while the actual acceptance command is in flight cannot mark the task completed", async () => {
      const r = await rig();
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let checking = false;
      const controller = createGoalTasks({
        ...r.options,
        executeCheck: async () => {
          checking = true;
          await gate;
          return { exitCode: 0, stdout: "PHASE_ONE_REAL PHASE_TWO_REAL" };
        },
      });
      const result = controller
        .verify(r.scope, undefined, true)
        .catch((error: unknown) => error);
      await until(async () => checking);
      await controller.pause(r.task.id, owner);
      release();
      expect(await result).toBeInstanceOf(Error);
      expect((await r.state())?.status).toBe("paused");
    });
    test("a pre-RPC launch intent survives controller recreation and is reconciled instead of blindly relaunched", async () => {
      const r = await rig();
      const marked = (await r
        .controller()
        .prepareDeviceCall(r.scope, "device_run_shell", {
          deviceId: "test-device",
          command: "sleep 1",
          background: true,
        })) as { command: string };
      expect(marked.command).toMatch(/^# chisabot-goal-operation:/);
      let polls = 0;
      const controller = createGoalTasks({
        ...r.options,
        runTurn: async () => {
          throw new Error("background is still running");
        },
        pollJob: async (_scope, job) => {
          polls++;
          expect(job.launchMarker).toBeTruthy();
          return { jobId: "original-remote-process", status: "running" };
        },
      });
      await controller.sweep();
      await until(
        async () => (await r.state())?.status === "waiting_background",
      );
      expect(polls).toBeGreaterThanOrEqual(1);
      expect((await r.state())?.jobs).toMatchObject([
        { jobId: "original-remote-process", status: "running" },
      ]);
      expect(r.stats().launches).toBe(0);
      await controller.pause(r.task.id, owner);
    });
  },
);

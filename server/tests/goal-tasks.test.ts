import { describe, expect, test } from "bun:test";
import {
  acceptanceResult,
  decodeGoalResult,
  goalInputSchema,
  jobsFromMessages,
} from "../src/agents/goal-tasks";
import type { Message } from "@ag-ui/client";

describe("goal acceptance and background result contracts", () => {
  test("unwraps real multiply encoded device results without treating a running job as success", () => {
    let raw: unknown = {
      status: "running",
      jobId: "job_live",
      exitCode: null,
      stdout: "PASS",
    };
    for (let i = 0; i < 4; i++) raw = JSON.stringify(raw);
    expect(decodeGoalResult(raw)).toMatchObject({ status: "running" });
    expect(acceptanceResult(raw, ["PASS"]).passed).toBe(false);
  });
  test("only successful actual checker results with every fixed assertion pass", () => {
    expect(
      acceptanceResult({ exitCode: 0, stdout: "SIGNATURES_OK\nPLAYMODE_OK" }, [
        "SIGNATURES_OK",
        "PLAYMODE_OK",
      ]).passed,
    ).toBe(true);
    for (const result of [
      { passed: true },
      "已经全部完成",
      { exitCode: 1, stdout: "PLAYMODE_OK" },
      { exitCode: 0, stdout: "error CS: 0" },
      { exitCode: 0, stdout: "PLAYMODE_OK", cancelled: true },
      { exitCode: 0, stdout: "PLAYMODE_OK", waiting: true },
    ]) {
      expect(acceptanceResult(result, ["PLAYMODE_OK"]).passed).toBe(false);
    }
  });
  test("a goal cannot be enrolled without an executable acceptance contract", () => {
    expect(
      goalInputSchema.safeParse({
        agentId: "bot",
        threadId: "thread",
        objective: "make playable",
        criteria: [{ id: "gameplay", title: "play a full game", passed: true }],
      }).success,
    ).toBe(false);
  });
  test("tracks the newest result of the original job instead of relaunching its command", () => {
    const calls = (id: string, name: string, args: object): Message => ({
      id,
      role: "assistant",
      toolCalls: [
        {
          id: `call-${id}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const result = (id: string, status: string): Message => ({
      id: `result-${id}`,
      role: "tool",
      toolCallId: `call-${id}`,
      content: JSON.stringify(
        JSON.stringify({
          jobId: "j1",
          status,
          exitCode: status === "exited" ? 0 : null,
        }),
      ),
    });
    const jobs = jobsFromMessages([
      calls("start", "device_run_shell", { deviceId: "pc", background: true }),
      result("start", "running"),
      calls("poll", "device_shell_output", { deviceId: "pc", jobId: "j1" }),
      result("poll", "exited"),
    ]);
    expect(jobs).toEqual([
      { deviceId: "pc", jobId: "j1", status: "exited", exitCode: 0 },
    ]);
  });
});

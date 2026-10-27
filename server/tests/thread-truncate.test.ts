import { describe, expect, test } from "bun:test";
import { dropTombstoned, planTruncation } from "../src/thread-truncate";

/** 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：从哪里截。 */
describe("planTruncation", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant", toolCalls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { id: "t2", role: "tool" },
    { id: "a3", role: "assistant" },
  ] as never[];
  const starts = [
    { sequence: "10", runId: "r1", ids: ["u1"] },
    { sequence: "20", runId: "r2", ids: ["u2"] },
    { sequence: "30", runId: "r2b", ids: ["t2"] },
  ];

  test("cuts at the run that started with this user message and everything after", () => {
    const plan = planTruncation(messages, starts, "u2");
    expect(plan).toEqual({ ok: true, index: 2, cutSequence: "20", removed: ["u2", "a2", "t2", "a3"], removedToolCalls: ["call-1"] });
  });

  test("an earlier user message removes later turns too", () => {
    const plan = planTruncation(messages, starts, "u1");
    expect(plan.ok && plan.cutSequence).toBe("10");
    expect(plan.ok && plan.removed.length).toBe(6);
  });

  test("refuses assistant messages and unknown ids", () => {
    expect(planTruncation(messages, starts, "a1")).toMatchObject({ ok: false, status: 400 });
    expect(planTruncation(messages, starts, "nope")).toMatchObject({ ok: false, status: 404 });
  });

  test("an injected user message cuts its containing run and preserves earlier messages", () => {
    const injected = [...messages.slice(0, 3), { id: "extra", role: "user" }, ...messages.slice(3)] as never[];
    const observed = [starts[0]!, { ...starts[1]!, ids: ["u2", "extra", "a2", "t2"] }, starts[2]!];
    expect(planTruncation(injected, observed, "extra")).toEqual({
      ok: true, index: 3, cutSequence: "20", removed: ["extra", "a2", "t2", "a3"], removedToolCalls: ["call-1"],
    });
  });

  test("snapshot-only history can still be edited, deleting later recorded answers", () => {
    // A previous edit removed the containing run's events but kept u2 and its prefix.
    expect(planTruncation(messages, [starts[0]!, starts[2]!], "u2")).toMatchObject({ ok: true, index: 2, cutSequence: "30" });
    expect(planTruncation(messages, [starts[0]!], "u2")).toMatchObject({ ok: true, index: 2, cutSequence: null });
  });

  test("a thread without events cuts only messages", () => {
    expect(planTruncation(messages, [], "u2")).toMatchObject({ ok: true, index: 2, cutSequence: null });
  });
});

describe("dropTombstoned", () => {
  test("filters truncated ids and keeps the same array when nothing matches", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(dropTombstoned(list, new Set())).toBe(list);
    expect(dropTombstoned(list, new Set(["x"]))).toBe(list);
    expect(dropTombstoned(list, new Set(["a"]))).toEqual([{ id: "b" }]);
  });
});

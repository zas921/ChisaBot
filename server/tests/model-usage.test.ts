import { describe, expect, test } from "bun:test";
import { summarizeUsageRows, todayIn, validTimeZone } from "../src/model-usage/ledger";

/* 2026-10-21 模型用量账本：按天汇总、补齐没有用量的日子、时区。 */
describe("model usage summary", () => {
  test("days without usage are listed as zero, newest first, models sorted by tokens", () => {
    const rows = [
      { day: "2026-10-21", model: "a/m1", input: "100", output: "20", cached: "50", calls: "2" },
      { day: "2026-10-21", model: "a/m2", input: 1000, output: 200, cached: 0, calls: 3 },
      { day: "2026-10-19", model: null, input: 10, output: 1, cached: 0, calls: 1 },
    ];
    const days = summarizeUsageRows(rows, 3, "2026-10-21");
    expect(days.map((d) => d.date)).toEqual(["2026-10-21", "2026-10-20", "2026-10-19"]);
    expect(days[0]).toMatchObject({ inputTokens: 1100, outputTokens: 220, cachedInputTokens: 50, totalTokens: 1320, calls: 5 });
    expect(days[0]?.models.map((m) => m.model)).toEqual(["a/m2", "a/m1"]);
    expect(days[1]).toMatchObject({ totalTokens: 0, calls: 0, models: [] });
    expect(days[2]?.models[0]?.model).toBe("（未知模型）");
  });

  test("rows outside the window are ignored; month boundaries roll over", () => {
    const days = summarizeUsageRows([{ day: "2026-09-29", model: "x", input: 1, output: 1, cached: 0, calls: 1 }], 2, "2026-10-01");
    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-09-30"]);
    expect(days.every((d) => d.calls === 0)).toBe(true);
  });

  test("time zones: invalid falls back to Beijing time; today follows the zone", () => {
    expect(validTimeZone("Not/AZone")).toBe("Asia/Shanghai");
    expect(validTimeZone(undefined)).toBe("Asia/Shanghai");
    expect(validTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    const at = new Date("2026-10-21T20:00:00Z");
    expect(todayIn("Asia/Shanghai", at)).toBe("2026-10-22");
    expect(todayIn("America/Los_Angeles", at)).toBe("2026-10-21");
  });
});

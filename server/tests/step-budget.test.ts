import { describe, expect, test } from "bun:test";
import { withStepBudgetNote } from "../src/copilot";

describe("step budget note (§101)", () => {
  test("adds a wrap-up note to the last three tool results of a run only", () => {
    const turn = {};
    const out: unknown[] = [];
    for (let i = 0; i < 12; i++) out.push(withStepBudgetNote(`r${i}`, turn));
    expect(out.slice(0, 9).every((r) => !String(r).includes("系统提示"))).toBe(true);
    expect(String(out[9])).toContain("最多还能再调 2 次");
    expect(String(out[11])).toContain("最多还能再调 0 次");
    // 普通对象结果加 systemNote，别的不动
    expect((withStepBudgetNote({ ok: true }, turn) as { systemNote?: string }).systemNote).toContain("停止调用工具");
    // 另一轮重新计数
    expect(withStepBudgetNote("x", {})).toBe("x");
    // 没有 run 上下文：原样返回
    expect(withStepBudgetNote("y", undefined)).toBe("y");
  });
});

/*
 * 2026-10-21：在客户端里让写面板经常写不出来。12 步里交不上面板时，以前的提醒让模型「停止调用工具」，
 * 卡片永远停在「正在搭建」。面板建了还没交上合格规范时按 20 步算，提醒改成马上 panel_update。
 */
describe("step budget while a panel is being built", () => {
  test("after panel_create the budget is 20 and the note asks for panel_update", () => {
    const turn = {};
    withStepBudgetNote("面板已建", turn, { tool: "panel_create" });
    const out: unknown[] = [];
    for (let i = 1; i < 20; i++) out.push(withStepBudgetNote(`r${i}`, turn, { tool: "web_fetch" }));
    // used 2..20：剩 2 次时（used 18）才提醒
    expect(out.slice(0, 16).every((r) => !String(r).includes("系统提示"))).toBe(true);
    expect(String(out[16])).toContain("panel_update");
    expect(String(out[16])).not.toContain("停止调用工具");
  });

  test("a refused panel_update keeps the panel pending; a saved one ends it", () => {
    const turn = {};
    withStepBudgetNote("ok", turn, { tool: "panel_create" });
    withStepBudgetNote("Refused. 面板没有保存", turn, { tool: "panel_update" });
    for (let i = 0; i < 8; i++) withStepBudgetNote("r", turn, { tool: "web_fetch" });
    // used 11：面板仍欠着，按 20 算，不提醒
    expect(String(withStepBudgetNote("r", turn, { tool: "web_fetch" }))).not.toContain("系统提示");
    withStepBudgetNote("面板「X」已更新", turn, { tool: "panel_update" });
    // used 13：面板交上了，回到 12 步，提醒收尾
    expect(String(withStepBudgetNote("r", turn, { tool: "web_fetch" }))).toContain("停止调用工具");
  });

  test("a background panel refresh owes a panel_update from the first step", () => {
    const turn = {};
    const out: unknown[] = [];
    for (let i = 0; i < 18; i++) out.push(withStepBudgetNote("r", turn, { tool: "web_fetch", panelRefresh: true }));
    expect(out.slice(0, 17).every((r) => !String(r).includes("系统提示"))).toBe(true);
    expect(String(out[17])).toContain("panel_update");
  });
});

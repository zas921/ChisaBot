import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { PanelError } from "../../shared/panels/types";
import { validatePanelDefinition } from "../../shared/panels/validate";
import { clampPanelSize, explained } from "../src/panels/authoring";

/**
 * 做面板失败（2026-10-22）：草稿工具校验失败只回一个裸错误码（`invalid_definition` / `unsafe_css`……），
 * 模型不知道错在哪，12 步都耗在盲改上。现在报错带「错在哪、怎么改」，`code` 不变（接口和界面按 code 认）。
 */
const base = {
  name: "时钟",
  html: "<main>示例</main>",
  css: "",
  script: "",
  manifest: { data: [], tasks: [] },
  schemaVersion: 1,
  stateSchema: { type: "object", properties: {} },
  initialState: {},
  size: { width: 340, height: "auto" as const },
};

function explainedError(run: () => unknown): PanelError {
  try {
    run();
  } catch (error) {
    try {
      explained(error);
    } catch (rewritten) {
      return rewritten as PanelError;
    }
  }
  throw new Error("expected a failure");
}

describe("校验错误码带上修改提示", () => {
  test("不安全的 css：message 说清楚哪些写法不行，code 不变", () => {
    const error = explainedError(() => validatePanelDefinition({ ...base, css: "@import url(x);" }));
    expect(error).toBeInstanceOf(PanelError);
    expect(["unsafe_css", "invalid_css", "unsafe_css_selector"]).toContain(error.code);
    expect(error.message).toContain("css");
    expect(error.message.length).toBeGreaterThan(error.code.length + 6);
  });

  test("html 里的 script 标签：提示只用安全标签", () => {
    const error = explainedError(() => validatePanelDefinition({ ...base, html: '<script>fetch("/")</script>' }));
    expect(error.code).toBe("unsafe_view_tag");
    expect(error.message).toContain("script");
  });

  test("多一个键：提示 definition 允许哪几个键", () => {
    const error = explainedError(() => validatePanelDefinition({ ...base, extra: 1 }));
    expect(error.code).toBe("invalid_definition");
    expect(error.message).toContain("name / html / css / script");
  });

  test("状态 schema 缺 type：提示每一层都要有 type", () => {
    const error = explainedError(() => validatePanelDefinition({ ...base, stateSchema: { properties: {} } }));
    expect(["invalid_state_schema", "unsupported_state_schema"]).toContain(error.code);
    expect(error.message).toContain("每一层都必须有 type");
  });

  test("zod 参数错误：指出是哪个字段", () => {
    const schema = z.object({ definition: z.object({ name: z.string().min(1) }) });
    const error = explainedError(() => schema.parse({ definition: { name: "" } }));
    expect(error.code).toBe("invalid_definition");
    expect(error.message).toContain("definition.name");
  });

  test("没有对应提示的错误和别的异常原样抛出", () => {
    const own = new PanelError("draft_binding", 404);
    expect(explainedError(() => { throw own; })).toBe(own);
    expect(() => explained(new Error("boom"))).toThrow("boom");
  });
});

describe("clampPanelSize", () => {
  test("宽 280–600、高 160–960 或 auto；越界夹回，其它字段不动", () => {
    expect(clampPanelSize({ ...base, size: { width: 100, height: 5000 } }).size).toEqual({ width: 280, height: 960 });
    expect(clampPanelSize({ ...base, size: { width: 9999, height: 10 } }).size).toEqual({ width: 600, height: 160 });
    expect(clampPanelSize({ ...base, size: { width: 400, height: "auto" } }).size).toEqual({ width: 400, height: "auto" });
    expect(clampPanelSize(base).name).toBe("时钟");
  });
});

import { expect, test } from "bun:test";
import type { Spec } from "@json-render/core";
import { foldablePanelSections } from "./panel-sections";

test("existing heading sections fold independently, including nested levels, without mutating the source", () => {
  const spec: Spec = {
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["intro", "news", "items", "detail", "text", "weather", "forecast"] },
      intro: { type: "Text", props: { text: "概览" } },
      news: { type: "Heading", props: { text: "新闻", level: 2, icon: "news" } },
      items: { type: "List", props: { items: [{ title: "新闻条目" }] } },
      detail: { type: "Heading", props: { text: "详情", level: 3 } },
      text: { type: "Text", props: { text: "具体内容" } },
      weather: { type: "Heading", props: { text: "天气", level: 2 } },
      forecast: { type: "Text", props: { text: "晴" } },
    },
  };
  const before = JSON.stringify(spec);
  const result = foldablePanelSections(spec);
  expect(result.elements.root?.children).toEqual(["intro", "news", "weather"]);
  expect(result.elements.news).toMatchObject({ type: "Accordion", props: { title: "新闻", icon: "news", open: true }, children: ["items", "detail"] });
  expect(result.elements.detail?.children).toEqual(["text"]);
  expect(result.elements.weather?.children).toEqual(["forecast"]);
  expect(result.elements.items).toBe(spec.elements.items);
  expect(JSON.stringify(spec)).toBe(before);
});

test("leaves horizontal layouts, grids and headings without content alone", () => {
  for (const [type, props] of [["Grid", {}], ["Stack", { direction: "horizontal" }], ["Tabs", { tabs: ["一", "二"] }]] as const) {
    const spec: Spec = { root: "root", elements: {
      root: { type, props, children: ["h", "t"] },
      h: { type: "Heading", props: { text: "标题" } },
      t: { type: "Text", props: { text: "内容" } },
    } };
    expect(foldablePanelSections(spec)).toEqual(spec);
  }
  const spec: Spec = { root: "r", elements: { r: { type: "Stack", props: {}, children: ["h"] }, h: { type: "Heading", props: { text: "空标题" } } } };
  expect(foldablePanelSections(spec)).toEqual(spec);
  expect(foldablePanelSections(null)).toBeNull();
});

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PanelCard } from "@/components/panels/panel-card";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => { cleanup(); window.localStorage.clear(); });
afterAll(() => GlobalRegistrator.unregister());

test("cards collapse independently, retain body state, and remember their preference", () => {
  const card = (key: string, title: string) => (
    <PanelCard preferenceKey={key} title={title} menu={<button type="button">更多</button>}>
      <input aria-label={`${title}内容`} defaultValue="初始值" />
      <ul><li>条目</li></ul>
    </PanelCard>
  );
  const view = render(<>{card("u:b:p1", "新闻")}{card("u:b:p2", "行情")}</>);
  const toggle = view.getByRole("button", { name: "新闻" });
  const input = view.getByLabelText("新闻内容") as HTMLInputElement;
  const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  const list = body.querySelector("ul")!;
  input.value = "保留的内容";
  list.scrollTop = 160;
  fireEvent.click(view.getAllByRole("button", { name: "更多" })[0]!);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(body.hidden).toBe(true);
  expect(view.getByRole("button", { name: "行情" }).getAttribute("aria-expanded")).toBe("true");
  expect(window.localStorage.getItem("u:b:p1")).toBe("collapsed");
  fireEvent.click(toggle);
  expect(body.hidden).toBe(false);
  expect(view.getByLabelText("新闻内容")).toBe(input);
  expect(input.value).toBe("保留的内容");
  expect(list.scrollTop).toBe(160);
  fireEvent.click(toggle);
  view.unmount();
  const restored = render(card("u:b:p1", "新闻"));
  expect(restored.getByRole("button", { name: "新闻" }).getAttribute("aria-expanded")).toBe("false");
  restored.unmount();
  expect(render(card("another-user:b:p1", "新闻")).getByRole("button", { name: "新闻" }).getAttribute("aria-expanded")).toBe("true");
});

test("refresh and failure status stays visible while a card is collapsed", () => {
  window.localStorage.setItem("p", "collapsed");
  const draw = (status: string) => <PanelCard preferenceKey="p" title="新闻" status={<span role="status">{status}</span>} menu={null}>正文</PanelCard>;
  const view = render(draw("刷新中"));
  view.rerender(draw("更新失败"));
  expect(view.getByRole("status").textContent).toBe("更新失败");
  expect(view.getByRole("button", { name: "新闻" }).getAttribute("aria-expanded")).toBe("false");
});

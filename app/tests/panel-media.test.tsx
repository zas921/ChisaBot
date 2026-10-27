import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { createStateStore, JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { inspectRenderUiSpec } from "../../shared/json-render/catalog";
import { pruneEmptySections } from "../../shared/json-render/empty-sections";
import { buildSafeView } from "../../shared/panels/view-tree";
import { RichUiProvider } from "@/lib/copilot/json-render/rich-context";
import { AudioPlayer, SwipeFeed, VideoPlayer, WebEmbed } from "@/lib/copilot/json-render/media";

beforeAll(() => { if (!globalThis.document) GlobalRegistrator.register(); });
afterEach(cleanup);
afterAll(() => { if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister(); });

test("media components are accepted without opening arbitrary HTML tags", () => {
  for (const [type, props] of [["Video", { src: "https://media.test/video.mp4", aspect: "9:16" }], ["Audio", { src: "https://media.test/audio.mp3" }], ["WebEmbed", { url: "https://outside.test/", title: "网页", mode: "browser" }], ["SwipeFeed", { height: 480 }]] as const) {
    expect(inspectRenderUiSpec({ root: "r", elements: { r: { type, props, children: [] } } }).ok).toBe(true);
  }
  for (const tag of ["iframe", "video", "audio", "script"]) expect(() => buildSafeView(`<${tag}></${tag}>`)).toThrow();
  for (const src of ["javascript:alert(1)", "file:///secret", "http://media.test/a.mp4", "https://user:pass@media.test/a.mp4"]) expect(inspectRenderUiSpec({ root: "r", elements: { r: { type: "Video", props: { src }, children: [] } } }).ok).toBe(false);
});

test("media controls load no stream automatically and reject unsafe URLs", () => {
  const view = render(<><VideoPlayer src="https://media.test/video.mp4" /><AudioPlayer src="https://media.test/audio.mp3" /><VideoPlayer src="javascript:alert(1)" /></>);
  expect(view.container.querySelectorAll("video").length).toBe(1);
  expect(view.container.querySelector("video")?.controls).toBe(true);
  expect(view.container.querySelector("video")?.autoplay).toBe(false);
  expect(view.container.querySelector("audio")?.controls).toBe(true);
  expect(view.container.querySelector("audio")?.preload).toBe("none");
});

test("vertical feed exposes content and scrolling without paging buttons", () => {
  const view = render(<SwipeFeed label="滑动内容" height={480}><p>第一页</p><p>第二页</p></SwipeFeed>);
  expect(view.getByRole("region", { name: "滑动内容" })).toBeTruthy();
  expect(view.container.querySelectorAll(".jr-swipe-page").length).toBe(2);
  expect(view.container.querySelectorAll("button").length).toBe(0);
});

test("saved panel specs render media through the real registry and pruning pipeline", async () => {
  const { jsonRenderRegistry } = await import("@/lib/copilot/json-render/registry");
  const verdict = inspectRenderUiSpec({ root: "r", elements: {
    r: { type: "SwipeFeed", props: { height: 420 }, children: ["v", "a"] },
    v: { type: "Video", props: { src: "https://media.test/v.mp4" }, children: [] },
    a: { type: "Audio", props: { src: "https://media.test/a.mp3" }, children: [] },
  } });
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) throw new Error("Invalid media spec");
  const spec = pruneEmptySections(verdict.spec as Spec);
  const view = render(<RichUiProvider value={{ surface: "panel" }}><JSONUIProvider handlers={{}} registry={jsonRenderRegistry} store={createStateStore({})}><Renderer registry={jsonRenderRegistry} spec={spec as Spec} /></JSONUIProvider></RichUiProvider>);
  expect(view.container.querySelectorAll(".jr-swipe-page").length).toBe(2);
  expect(view.container.querySelector("video")?.getAttribute("src")).toBe("https://media.test/v.mp4");
  expect(view.container.querySelector("audio")?.getAttribute("src")).toBe("https://media.test/a.mp3");
});

test("web pages require an explicit load and browser mode reports missing PC capability", () => {
  const view = render(<WebEmbed url="https://outside.test/" title="外部网页" mode="browser" />);
  expect(view.container.querySelector("iframe")).toBeNull();
  expect((view.getByRole("button", { name: "加载网页" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.container.textContent).toContain("PC 客户端");
});

test("native browser component does not provide next/previous controls", () => {
  const view = render(<WebEmbed url="https://outside.test/" title="外部网页" mode="iframe" />);
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(view.getByRole("button", { name: "加载网页" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("下一条");
  expect(view.container.textContent).not.toContain("上一条");
});

// Run from app/: node tests/panel-list.browser.mjs. Uses local Chrome; no live account.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../../../ops/panel-list-ui/", import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer({ root, server: { port: 3017, host: "127.0.0.1", open: false } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 30000, executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let revision = 0;
    const panel = (id, title, count) => ({
      id, title, botId: "test-bot", status: "ready", sources: [], instruction: "新闻", refreshMinutes: 60,
      error: null, refreshedAt: new Date().toISOString(), nextRefreshAt: null, refreshing: false, canUndoEdit: false, createdAt: new Date().toISOString(),
      spec: JSON.stringify({ root: "list", elements: { list: { type: "List", children: [], props: { items: Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, title: `第 ${i + 1} 条：面板列表支持完整的新闻标题显示`, description: `更新 ${revision} · 内容说明`, href: `https://news.test/${i}`, meta: "新闻" })) } } } }),
    });
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/me") return route.fulfill({ json: { user: { id: "test-user", email: "test@example.test", role: "user" } } });
      if (url.pathname.endsWith("/refresh")) {
        revision++;
        return route.fulfill(revision === 2 ? { status: 500, json: { error: "模拟刷新失败" } } : { json: {} });
      }
      if (url.pathname === "/api/live-panels") {
        const sections = panel("sections", "分区面板", 0);
        sections.spec = JSON.stringify({ root: "r", elements: {
          r: { type: "Stack", props: {}, children: ["h", "content", "sub", "link", "other", "text"] },
          h: { type: "Heading", props: { text: "主要内容", level: 2 } },
          content: { type: "Text", props: { text: "分区正文" } },
          sub: { type: "Heading", props: { text: "内部详情", level: 3 } },
          link: { type: "Link", props: { title: "详情链接", url: "https://example.test/" } },
          other: { type: "Heading", props: { text: "另一分区", level: 2 } },
          text: { type: "Text", props: { text: "另一分区正文" } },
        } });
        return route.fulfill({ json: { items: [panel("news", "新闻面板", 20), panel("short", "短列表", 3), sections] } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto("http://127.0.0.1:3017/tests/fixtures/panel-list.html");
    const card = page.locator('[data-live-panel="news"]');
    const list = card.locator(".jr-list");
    await list.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-live-panel="news"] .jr-list')?.clientHeight > 0);
    const dimensions = await list.evaluate((el) => ({ height: el.clientHeight, row: el.children[0].getBoundingClientRect().height, total: el.children.length, scrollHeight: el.scrollHeight }));
    assert.equal(dimensions.total, 20);
    assert.ok(dimensions.height <= dimensions.row * 5 + 1, JSON.stringify(dimensions));
    assert.ok(dimensions.scrollHeight > dimensions.height);
    assert.equal(await page.locator('[data-live-panel="short"] .is-scrollable').count(), 0);
    const sections = page.locator('[data-live-panel="sections"]');
    const section = sections.getByRole("button", { name: "主要内容", exact: true });
    const nested = sections.getByRole("button", { name: "内部详情", exact: true });
    const detailBody = sections.locator(`[id="${await nested.getAttribute("aria-controls")}"]`);
    await nested.click();
    await page.waitForFunction((id) => document.getElementById(id).getBoundingClientRect().height < 1, await nested.getAttribute("aria-controls"));
    assert.equal(await sections.getByRole("link").count(), 0);
    assert.equal(await section.getAttribute("aria-expanded"), "true");
    await section.click();
    const sectionBodyId = await section.getAttribute("aria-controls");
    await page.waitForFunction((id) => document.getElementById(id).getBoundingClientRect().height < 1, sectionBodyId);
    assert.equal(await sections.getByRole("button", { name: "另一分区", exact: true }).getAttribute("aria-expanded"), "true");
    await section.click();
    assert.equal(await nested.getAttribute("aria-expanded"), "false");
    await sections.getByRole("button", { name: "分区面板", exact: true }).click();
    await sections.getByRole("button", { name: "分区面板", exact: true }).click();
    assert.equal(await nested.getAttribute("aria-expanded"), "false");
    await page.getByRole("button", { name: "「分区面板」的更多操作" }).click();
    await page.getByRole("menuitem", { name: "立即刷新" }).click();
    await page.waitForFunction(() => document.querySelector('[data-live-panel="news"]').textContent.includes("更新 1"));
    assert.equal(await nested.getAttribute("aria-expanded"), "false");
    assert.ok(await detailBody.evaluate((el) => el.getBoundingClientRect().height < 1));
    // Keep the existing refresh-success / refresh-failure sequence below independent.
    revision = 0;
    await list.hover();
    await page.mouse.wheel(0, 480);
    await page.waitForFunction(() => document.querySelector('[data-live-panel="news"] .jr-list').scrollTop > 0);
    let position = await list.evaluate((el) => el.scrollTop);
    await card.getByRole("button", { name: "新闻面板", exact: true }).click();
    assert.equal(await card.locator(".live-panel-content").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "短列表", exact: true }).getAttribute("aria-expanded"), "true");
    await card.getByRole("button", { name: "新闻面板", exact: true }).click();
    assert.equal(await list.evaluate((el) => el.scrollTop), position);
    if (width === 390) {
      await list.evaluate((el) => { el.scrollTop = 0; });
      const bounds = await list.boundingBox();
      const cdp = await context.newCDPSession(page);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height - 40;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      for (let step = 1; step <= 10; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 20, id: 1 }] });
        await page.waitForTimeout(30);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('[data-live-panel="news"] .jr-list').scrollTop > 0);
      await page.waitForTimeout(500);
      position = await list.evaluate((el) => el.scrollTop);
      await cdp.detach();
    }
    await page.getByRole("button", { name: "「新闻面板」的更多操作" }).click();
    assert.equal(await card.getByRole("button", { name: "新闻面板", exact: true }).getAttribute("aria-expanded"), "true");
    await page.getByRole("menuitem", { name: "立即刷新" }).click();
    await page.waitForFunction(() => document.querySelector('[data-live-panel="news"]').textContent.includes("更新 1"));
    assert.equal(await list.evaluate((el) => el.scrollTop), position);
    await list.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => { const el = document.querySelector('[data-live-panel="news"] .jr-list'); return el.scrollTop >= el.scrollHeight - el.clientHeight - 1; });
    await page.screenshot({ path: `${output}/${width}.png` });
    await card.getByRole("button", { name: "新闻面板", exact: true }).click();
    await page.getByRole("button", { name: "「新闻面板」的更多操作" }).click();
    await page.getByRole("menuitem", { name: "立即刷新" }).click();
    await card.getByText("操作失败", { exact: true }).waitFor();
    assert.equal(await card.locator(".live-panel-content").isVisible(), false);
    await page.reload();
    await card.waitFor();
    assert.equal(await card.getByRole("button", { name: "新闻面板", exact: true }).getAttribute("aria-expanded"), "false");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, ...dimensions, collapse: true, nestedSections: true, retainedScroll: true, refresh: true, keyboard: true, restored: true, collapsedFailure: true }));
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}

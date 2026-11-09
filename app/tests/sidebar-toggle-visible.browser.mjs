// node tests/sidebar-toggle-visible.browser.mjs from app/. Only local fixtures and mocked APIs.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const evidence = fileURLToPath(new URL("../../../ops/sidebar-toggle-20261106/evidence/", import.meta.url));
await mkdir(evidence, { recursive: true });
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  configFile: false, root: appRoot, plugins: [react(), tailwindcss()],
  cacheDir: `${evidence}/vite-cache`,
  optimizeDeps: { entries: ["tests/fixtures/sidebar-toggle-visible.html"] },
  resolve: { alias: { "@": fileURLToPath(new URL("../src/", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 48126, open: false, fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] } },
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
const results = [];
let browser;
let lastPage;
let lastErrors = [];

async function prepare(options) {
  const context = await browser.newContext({ viewport: { width: options.width, height: 900 }, isMobile: options.mobile, hasTouch: options.mobile });
  const errors = [];
  const api = [];
  const external = [];
  let seq = 20;
  const created = new Date(Date.now() - 90_000).toISOString();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    api.push(url.pathname);
    if (url.pathname === "/api/me") return route.fulfill({ json: { user: { id: "fixture-user", name: "本地测试", email: "fixture@example.invalid", role: "admin", onboarding: null } } });
    if (url.pathname === "/api/settings/preferences") return route.fulfill({ json: { preferences: { brandAccent: "Chisa", brandRest: "Bot" } } });
    if (url.pathname.endsWith("/workers")) return route.fulfill({ json: { workers: [{ id: "fixture-worker", title: "收集资料", status: "running", step: "等待数据源返回", plan: [{ text: "读取数据", status: "current" }, { text: "整理结果", status: "pending" }], summary: null, error: null, resultMessageId: null, createdAt: created, startedAt: created, finishedAt: null }] } });
    if (url.pathname.endsWith("/sync")) return route.fulfill({ json: { current: null, thread: { threadId: url.searchParams.get("threadId"), seq: String(seq++), running: true, live: true, waiting: false, workers: null, inbox: null } } });
    errors.push(`Unexpected API: ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: "Unexpected local fixture request" } });
  });
  const page = await context.newPage();
  lastPage = page;
  lastErrors = errors;
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const query = new URLSearchParams({ desktop: options.desktop ? "1" : "0", compact: options.compact ? "1" : "0", phone: options.phone ? "1" : "0" });
  await page.goto(`${origin}/tests/fixtures/sidebar-toggle-visible.html?${query}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const toggle = page.locator("[data-sidebar-menu-toggle]");
  await toggle.waitFor({ state: "visible" });
  await page.getByText("收集资料", { exact: true }).waitFor();
  return { context, page, toggle, errors, api, external };
}

async function assertButton(page, toggle, expected) {
  assert.equal(await toggle.getAttribute("aria-expanded"), String(expected));
  assert.equal(await toggle.getAttribute("aria-label"), expected ? "折叠菜单" : "展开菜单");
  assert.match(await toggle.textContent(), expected ? /折叠菜单/ : /展开菜单/);
  if (await page.locator('[data-slot="sidebar-gap"]').count()) {
    await page.waitForFunction((open) => {
      const gap = document.querySelector('[data-slot="sidebar-gap"]');
      const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
      if (!gap || !wrapper) return false;
      const target = parseFloat(getComputedStyle(wrapper).getPropertyValue(open ? "--sidebar-width" : "--sidebar-width-icon"));
      return Math.abs(gap.getBoundingClientRect().width - target) < .75;
    }, expected);
  }
  const geometry = await toggle.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const controls = document.querySelector(".win-ctrls")?.getBoundingClientRect();
    const text = button.querySelector(".glass-menu-toggle-label") ?? button;
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewport: innerWidth, region: style.webkitAppRegion, clipped: text.scrollWidth > text.clientWidth + 1, overlapping: controls ? rect.left < controls.right && rect.right > controls.left && rect.top < controls.bottom && rect.bottom > controls.top : false };
  });
  assert(geometry.width >= 70 && geometry.height >= 30, `Visible text button needs a usable target: ${JSON.stringify(geometry)}`);
  assert(geometry.x >= 0 && geometry.right <= geometry.viewport && geometry.y >= 0, "Menu stays inside the window");
  assert.equal(geometry.clipped, false, "Menu text is not clipped");
  assert.equal(geometry.overlapping, false, "Menu does not overlap native window controls");
  assert.equal(geometry.region, "no-drag", "Window drag region must exclude the menu button");
  return geometry;
}

async function slot(page) { return page.evaluate(() => ({ ...window.__sidebarFixture, ticks: Number(document.querySelector('[data-testid="conversation-slot"]').dataset.ticks) })); }
function sameSlot(before, after) { assert.equal(after.instance, before.instance); assert.equal(after.mounts, before.mounts); assert.equal(after.unmounts, before.unmounts); assert(after.ticks >= before.ticks); }
async function stableDrawer(page) {
  await page.waitForFunction(() => {
    const popup = document.querySelector('[data-mobile="true"][data-slot="sidebar"]');
    if (!popup || popup.hasAttribute("data-starting-style") || popup.hasAttribute("data-ending-style")) return false;
    const style = getComputedStyle(popup);
    const matrix = style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
    return Number(style.opacity) >= .999 && (!matrix || Math.abs(matrix.m41) < .5 && Math.abs(matrix.m42) < .5);
  });
  const popup = page.locator('[data-mobile="true"][data-slot="sidebar"]');
  const bot = popup.getByText("复刻镜", { exact: true });
  await bot.waitFor({ state: "visible" });
  const result = await popup.evaluate((element) => {
    const nav = element.querySelector("nav");
    const rect = element.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { opacity: style.opacity, transform: style.transform, background: style.backgroundColor, text: nav.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, navTop: navRect.top, navBottom: navRect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  const botBox = await bot.boundingBox();
  assert(botBox && botBox.x >= 0 && botBox.x + botBox.width <= result.viewportWidth && botBox.y >= 0 && botBox.y + botBox.height <= result.viewportHeight, "The actual Bot name is visibly inside the mobile viewport");
  assert(result.text.includes("资料整理") && result.text.includes("每日助手"), "The drawer contains the real sidebar rows, not only its close button");
  assert(result.left >= -.5 && result.right <= result.viewportWidth + .5);
  return result;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  for (const options of [
    { width: 1440, mobile: false, desktop: false, compact: false },
    { width: 1100, mobile: false, desktop: true, compact: false },
    { width: 900, mobile: false, desktop: true, compact: true },
  ]) {
    const { context, page, toggle, errors, api, external } = await prepare(options);
    await assertButton(page, toggle, true);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("[data-sidebar-menu-toggle]")?.getAttribute("aria-expanded") === "false");
    await assertButton(page, toggle, false);
    assert.equal(await page.evaluate(() => localStorage.getItem("openbot-sidebar")), "collapsed");
    await page.reload();
    await toggle.waitFor({ state: "visible" });
    await assertButton(page, toggle, false);
    const before = await slot(page);
    await page.getByLabel("对话草稿", { exact: true }).fill("保留未发送的草稿");
    await page.getByLabel("面板草稿", { exact: true }).fill("保留面板内容");
    if (options.width === 1440) {
      await page.getByTestId("worker-live-activity").filter({ hasText: "本页检测到进展" }).waitFor({ state: "visible", timeout: 5_000 });
      assert(api.filter((path) => path.endsWith("/workers")).length >= 2, "Active workers keep refreshing without a delegation message");
      assert(api.filter((path) => path.endsWith("/sync")).length >= 2, "Live activity comes from a changed event cursor");
    }
    await toggle.focus();
    await page.keyboard.press("Enter");
    await assertButton(page, toggle, true);
    assert.equal(await toggle.evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press("Space");
    await assertButton(page, toggle, false);
    await page.keyboard.press("Control+b");
    await assertButton(page, toggle, true);
    await page.keyboard.press("Control+b");
    await assertButton(page, toggle, false);
    if (options.desktop) { await toggle.dblclick(); assert.equal((await slot(page)).windowCalls.length, 0); }
    if (options.width === 1440) await page.screenshot({ path: `${evidence}/desktop-collapsed.png` });
    for (const [name, scope] of [["设置", "settings"], ["管理", "admin"], ["Claude Code", "app"], ["机器人", "app"]]) {
      await page.getByRole("button", { name: `切换至${name}`, exact: true }).click();
      await page.waitForFunction((expected) => document.querySelector(".glass-topbar")?.getAttribute("data-scope") === expected, scope);
      await assertButton(page, toggle, false);
      await toggle.click();
      await assertButton(page, toggle, true);
      if (options.width === 1440) await page.screenshot({ path: `${evidence}/desktop-${name === "Claude Code" ? "cc" : scope}-expanded.png` });
      await toggle.click();
      await assertButton(page, toggle, false);
      sameSlot(before, await slot(page));
      assert.equal(await page.getByLabel("对话草稿", { exact: true }).inputValue(), "保留未发送的草稿");
    }
    assert.equal(await page.getByLabel("面板草稿", { exact: true }).inputValue(), "保留面板内容");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    results.push({ ...options, status: "passed", checks: ["visible text", "collapse-expand-collapse", "reload persistence", "Enter/Space/Ctrl+B", "no-drag", "native controls", "all scopes", "conversation and panel retained"], apiRequests: api.length });
    await context.close();
  }
  for (const options of [
    { width: 390, mobile: true, desktop: false, compact: false, phone: true },
    { width: 320, mobile: true, desktop: true, compact: true },
  ]) {
    const { context, page, toggle, errors, api, external } = await prepare(options);
    const before = await slot(page);
    const drawers = [];
    await page.getByLabel("对话草稿", { exact: true }).fill("手机草稿仍然保留");
    for (const name of ["机器人", "设置", "管理", "Claude Code"]) {
      await page.getByRole("button", { name: `切换至${name}`, exact: true }).click();
      await assertButton(page, toggle, false);
      await toggle.click();
      const close = page.locator("[data-sidebar-menu-close]");
      await close.waitFor({ state: "visible" });
      drawers.push({ scope: name, ...(await stableDrawer(page)) });
      assert.equal(await close.getAttribute("aria-label"), "折叠菜单");
      assert.equal(await close.evaluate((button) => getComputedStyle(button).webkitAppRegion), "no-drag");
      if (name === "机器人") await page.screenshot({ path: `${evidence}/mobile-${options.width}-drawer.png` });
      await close.click();
      await close.waitFor({ state: "hidden" });
      await assertButton(page, toggle, false);
      sameSlot(before, await slot(page));
      assert.equal(await page.getByLabel("对话草稿", { exact: true }).inputValue(), "手机草稿仍然保留");
    }
    await toggle.focus(); await page.keyboard.press("Enter");
    await page.locator("[data-sidebar-menu-close]").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("[data-sidebar-menu-close]").waitFor({ state: "hidden" });
    await assertButton(page, toggle, false);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await page.screenshot({ path: `${evidence}/mobile-${options.width}-closed.png` });
    results.push({ ...options, status: "passed", checks: ["visible text", "modal drawer explicit close", "stable opacity/transform", "Bot rows on screen", "all scopes", "Enter/Escape", "no-drag", "conversation retained"], drawers, apiRequests: api.length });
    await context.close();
  }
  await writeFile(`${evidence}/sidebar-toggle-browser-results.json`, JSON.stringify({ status: "passed", allHttpMocked: true, scenarios: results }, null, 2));
  console.log(JSON.stringify({ status: "passed", scenarios: results.length, evidence }, null, 2));
} catch (error) {
  await lastPage?.screenshot({ path: `${evidence}/sidebar-toggle-failure.png` }).catch(() => {});
  await writeFile(`${evidence}/sidebar-toggle-browser-results.json`, JSON.stringify({ status: "failed", completed: results, errors: lastErrors, error: String(error.stack ?? error) }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }

// Run from source/app: node tests/bot-switch.browser.mjs. Every API request is fulfilled locally.
import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const output = fileURLToPath(new URL("../../../ops/bot-switch-fix-20261106/evidence/", import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, root: fileURLToPath(new URL("../", import.meta.url)), server: { port: 48059, host: "127.0.0.1", strictPort: true, open: false, hmr: false } });
await server.listen();
console.log("Bot switch fixture ready");
const results = [];
let browser;
let currentPage;
let diagnostics;
const historyFor = (bot) => Array.from({ length: 24 }, (_, index) => [
  { id: `${bot}-user-${index}`, role: "user", content: `BOT_${bot.toUpperCase()}_QUESTION_${index}: 请保留这段对话的内容与滚动位置。` },
  { id: `${bot}-assistant-${index}`, role: "assistant", content: `BOT_${bot.toUpperCase()}_ANSWER_${index}: 这是机器人 ${bot.toUpperCase()} 的独立历史。切换回来应当继续显示这段内容。\n\n第 ${index + 1} 条记录，包含用于滚动验收的完整正文。` },
]).flat();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    currentPage = page;
    const errors = [], consoleErrors = [], unexpectedApi = [], externalRequests = [];
    const counts = { history: { a: 0, b: 0 }, connect: { a: 0, b: 0 } };
    diagnostics = { width, errors, consoleErrors, unexpectedApi, externalRequests, counts };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      // Application CSS/SDK may request fonts or a developer-console asset. Fulfill those here too.
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") { externalRequests.push(url.origin); return route.fulfill({ status: 200, contentType: request.resourceType() === "stylesheet" ? "text/css" : "application/javascript", body: "" }); }
      const path = url.pathname;
      if (!path.startsWith("/api/")) return route.continue();
      const json = (body) => route.fulfill({ json: body });
      if (path.endsWith("/info")) return json({ version: "local-fixture", agents: { "bot-a": { description: "Bot A", capabilities: {} }, "bot-b": { description: "Bot B", capabilities: {} } }, mode: "sse", telemetryDisabled: true });
      if (path.endsWith("/connect")) {
        let body = {}; try { body = request.postDataJSON() || {}; } catch {}
        const bot = String(body.threadId || path).includes("-b") ? "b" : "a";
        counts.connect[bot]++;
        if (bot === "b") await pause(1050);
        const events = [{ type: "RUN_STARTED", threadId: `thread-${bot}`, runId: `join-${bot}` }, { type: "MESSAGES_SNAPSHOT", messages: historyFor(bot) }, { type: "RUN_FINISHED", threadId: `thread-${bot}`, runId: `join-${bot}` }];
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      const message = path.match(/\/threads\/thread-([ab])\/messages$/);
      if (message) {
        const bot = message[1];
        if (url.searchParams.has("agentId")) counts.history[bot]++;
        if (bot === "b" && counts.history.b === 1) await pause(850);
        return json({ messages: historyFor(bot) });
      }
      const sync = path.match(/\/bot-threads\/bot-([ab])\/sync$/);
      if (sync) return json({ current: null, thread: { threadId: `thread-${sync[1]}`, seq: "0", running: false, live: false, waiting: false, workers: null, inbox: null, revision: "0" } });
      if (path === "/api/agents") return json({ agents: [] });
      const agentDetail = path.match(/^\/api\/agents\/(bot-[ab])$/);
      if (agentDetail) return json({ agent: { id: agentDetail[1], name: agentDetail[1].toUpperCase(), title: "本地验证", roleDescription: "Local fixture", avatarSeed: agentDetail[1], visibility: "private", endpoint: null, builtIn: true, hasAuth: false, hasCallbackToken: false, hidden: false, pinned: false, mine: true, systemOwned: false, canManage: true } });
      if (path === "/api/capabilities") return json({ capabilities: {} });
      if (/^\/api\/computers\/bot-[ab]\/control$/.test(path)) return json({ holder: "bot", requested: false, transitioning: false, request: null });
      if (path === "/api/models") return json({ source: "fixture", fetchedAt: 1, models: [{ id: "fixture/model", label: "Local fixture", provider: "fixture", providerName: "本地验证" }] });
      if (/\/agents\/bot-[ab]\/model$/.test(path)) return json({ agentId: path.includes("bot-b") ? "bot-b" : "bot-a", model: "fixture/model", overrideModel: null, defaultModel: "fixture/model", available: true, canManage: true, reasoningEffort: null, fastMode: false, supportsRunOptions: true });
      if (path.startsWith("/api/plugins/for/")) return json({ skills: [], tools: [] });
      if (path.endsWith("/permission")) return json({ permission: { agentId: path.includes("bot-b") ? "bot-b" : "bot-a", mode: "ask", canManage: true } });
      if (path === "/api/goal-tasks") return json({ tasks: [] });
      if (path === "/api/confirmations/requests") return json({ requests: [] });
      if (path.endsWith("/inbox")) return json({ items: [], running: false, waiting: false, paused: false });
      if (path.endsWith("/workers")) return json({ workers: [] });
      if (path.endsWith("/context")) return json({ context: null });
      if (path.endsWith("/stopped")) return json({ userMessageIds: [] });
      if (path.endsWith("/fallbacks")) return json({ turns: [] });
      if (path.endsWith("/sent-at")) return json(null);
      unexpectedApi.push({ method: request.method(), path });
      return json({});
    });
    const active = () => page.locator('[data-testid="kept-page"][data-visible="true"]');
    await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/bot-switch.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    console.log(`Fixture DOM ready at ${width}px`);
    await active().getByText(/BOT_A_ANSWER_23/).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-bot="a"] [data-slot="message-scroller-viewport"]')?.scrollHeight > 1500);
    await pause(1200);
    await page.evaluate(() => { window.savedBotANode = document.querySelector('[data-bot="a"]'); window.savedBotAScroller = document.querySelector('[data-bot="a"] [data-slot="message-scroller-viewport"]'); });

    // B's first history and connect are deliberately slower than a quick switch back to A.
    await page.getByTestId("open-b").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="kept-page"][data-visible="true"] [data-bot="b"]'));
    const backStarted = performance.now();
    await page.getByTestId("open-a").click();
    await active().getByText(/BOT_A_ANSWER_23/).waitFor();
    const rapidReturnMs = performance.now() - backStarted;
    await pause(1400);
    assert.equal(await active().locator('[data-bot="a"]').count(), 1);
    assert.equal(await active().getByText(/BOT_B_ANSWER_/).count(), 0, "late B history must never replace A");
    await page.getByTestId("open-b").click();
    await active().getByText(/BOT_B_ANSWER_23/).waitFor();
    assert.equal(await active().getByText(/BOT_A_ANSWER_/).count(), 0);
    await pause(1000);
    const settledCounts = structuredClone(counts);

    await page.getByTestId("open-a").click();
    const scroller = active().locator('[data-slot="message-scroller-viewport"]');
    await scroller.evaluate((element) => { element.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true })); element.scrollTop = Math.min(620, element.scrollHeight - element.clientHeight - 200); element.dispatchEvent(new Event("scroll")); });
    await pause(100);
    const beforeScroll = await scroller.evaluate((element) => element.scrollTop);
    assert(beforeScroll > 50, "the fixture must actually exercise a scrolled transcript");
    const warmSwitchMs = [];
    for (let index = 0; index < 8; index++) {
      for (const bot of ["b", "a"]) {
        const started = performance.now();
        await page.getByTestId(`open-${bot}`).click();
        await active().locator(`[data-bot="${bot}"]`).waitFor();
        await active().getByText(new RegExp(`BOT_${bot.toUpperCase()}_ANSWER_23`)).waitFor();
        warmSwitchMs.push(Math.round(performance.now() - started));
      }
    }
    await pause(350);
    const afterScroll = await scroller.evaluate((element) => element.scrollTop);
    const identity = await page.evaluate(() => ({ samePage: window.savedBotANode === document.querySelector('[data-bot="a"]'), sameScroller: window.savedBotAScroller === document.querySelector('[data-bot="a"] [data-slot="message-scroller-viewport"]'), lifecycle: window.botSwitchLifecycle }));
    assert(identity.samePage && identity.sameScroller, "returning must preserve the actual conversation and scroller DOM nodes");
    assert(Math.abs(afterScroll - beforeScroll) <= 2, `scroll must be retained: ${beforeScroll} -> ${afterScroll}`);
    assert.deepEqual(counts, settledCounts, "idle switching must not issue additional history or connect requests");
    assert.deepEqual(identity.lifecycle.mounts, { a: 1, b: 1 });
    assert.deepEqual(identity.lifecycle.unmounts, { a: 0, b: 0 });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedApi, []);
    assert(externalRequests.every((origin) => ["https://fonts.googleapis.com", "https://cdn.copilotkit.ai"].includes(origin)), "only known font/SDK resources may be fulfilled locally");
    assert.deepEqual(consoleErrors, []);
    await page.screenshot({ path: `${output}/bot-switch-${width}.png` });
    const sortedWarm = [...warmSwitchMs].sort((a, b) => a - b);
    const result = { width, rapidReturnMs: Math.round(rapidReturnMs), warmSwitchMs, warmSwitchMedianMs: Math.round((sortedWarm[7] + sortedWarm[8]) / 2), warmSwitchMaxMs: Math.max(...warmSwitchMs), slowBotHistoryDelayMs: 850, slowBotConnectDelayMs: 1050, counts, beforeScroll, afterScroll, ...identity, errors, consoleErrors, unexpectedApi, locallyFulfilledExternalResources: externalRequests, remoteNetworkAccess: false, passed: true };
    results.push(result);
    await writeFile(`${output}/browser-results.json`, JSON.stringify({ passed: true, results }, null, 2));
    await context.close();
    console.log(`PASS ${width}px: content isolation, late history, DOM identity, retained scroll, request counts`);
  }
  await Promise.all(["browser-failure.json", "bot-switch-failure.png"].map((name) => unlink(`${output}/${name}`).catch(() => {})));
} catch (error) {
  await currentPage?.screenshot({ path: `${output}/bot-switch-failure.png`, timeout: 5000 }).catch(() => {});
  await writeFile(`${output}/browser-failure.json`, JSON.stringify({ error: String(error.stack || error), diagnostics, body: await currentPage?.locator("body").innerText({ timeout: 3000 }).catch(() => "unavailable"), results }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }

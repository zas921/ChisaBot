// Real 12s watchdog timing. All requests, including fonts and SDK assets, are fulfilled locally.
import assert from "node:assert/strict";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const output = fileURLToPath(new URL("../../../ops/send-hang-release-20261106/evidence/", import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, root: fileURLToPath(new URL("../", import.meta.url)), server: { port: 48060, host: "127.0.0.1", strictPort: true, open: false, hmr: false } });
await server.listen();
console.log("Send receipt fixture ready");
let browser;
const results = [];
const opening = { id: "opening", role: "assistant", content: "本地对话已就绪。" };
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  await Promise.all(["accepted", "unknown-then-accepted", "unknown-manual-stop"].map(async (scenario) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [], consoleErrors = [], unexpectedApi = [], externalResources = [], trace = [], receipts = [], mutations = [];
    let runCount = 0, runStarted = 0, input, completed = false, releaseRun, runTimer, pendingHistoryReads = 0, allowedStop = false;
    const sinceRun = () => runStarted ? Math.round(performance.now() - runStarted) : null;
    const question = `SEND_RECEIPT_${scenario}: 请只执行一次并等待最终回答。`;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) { externalResources.push(url.origin); return route.fulfill({ status: 200, contentType: request.resourceType() === "stylesheet" ? "text/css" : "application/javascript", body: "" }); }
      if (!path.startsWith("/api/")) return route.continue();
      trace.push({ method: request.method(), path, ms: sinceRun() });
      const json = (body) => route.fulfill({ json: body });
      if (path.endsWith("/info")) return json({ version: "local-fixture", agents: { "receipt-bot": { description: "Receipt Bot", capabilities: {} } }, mode: "sse", telemetryDisabled: true });
      if (path.endsWith("/connect")) return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse([{ type: "RUN_STARTED", threadId: "receipt-thread", runId: "join" }, { type: "MESSAGES_SNAPSHOT", messages: [opening] }, { type: "RUN_FINISHED", threadId: "receipt-thread", runId: "join" }]) });
      if (path.endsWith("/run")) {
        runCount++; input = request.postDataJSON(); runStarted = performance.now();
        let finish;
        const wait = new Promise((resolve) => { finish = resolve; });
        releaseRun = finish;
        runTimer = setTimeout(finish, scenario === "unknown-then-accepted" ? 20_500 : 18_500);
        await wait;
        clearTimeout(runTimer);
        if (allowedStop) return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse([{ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId }, { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "cancelled" } }]) }).catch(() => {});
        completed = true;
        return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          { type: "TEXT_MESSAGE_START", messageId: "final-answer", role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: "final-answer", delta: `SEND_RECEIPT_FINAL_${scenario}: 已完成，只执行了一次。` },
          { type: "TEXT_MESSAGE_END", messageId: "final-answer" },
          { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
        ]) }).catch(() => {});
      }
      if (path.endsWith("/send-status")) {
        const received = scenario === "accepted" || (scenario === "unknown-then-accepted" && receipts.length >= 1) ? true : null;
        receipts.push({ received, ms: sinceRun(), messageId: url.searchParams.get("messageId") });
        return json({ threadId: "receipt-thread", messageId: url.searchParams.get("messageId"), received, persisted: false, running: received === true, phase: received ? "received" : "unknown", runId: received ? input?.runId : null });
      }
      if (/\/(stop|unlock|force-unlock)(?:\/|$)/.test(path)) {
        mutations.push({ path, ms: sinceRun(), userRequested: allowedStop });
        if (allowedStop) releaseRun?.();
        return json({ stopped: true, unlocked: true });
      }
      if (path.endsWith("/messages")) {
        if (runStarted && !completed) {
          pendingHistoryReads++;
          // The obsolete SEND_HANG path used this expensive history as its receipt check.
          await pause(25_000);
          return json({ messages: [opening, { id: "huge-history", role: "assistant", content: "x".repeat(7_196_309) }] }).catch(() => {});
        }
        return json({ messages: completed ? [...input.messages, { id: "final-answer", role: "assistant", content: `SEND_RECEIPT_FINAL_${scenario}: 已完成，只执行了一次。` }] : [opening] });
      }
      if (path.includes("/bot-threads/") && path.endsWith("/sync")) return json({ current: null, thread: { threadId: "receipt-thread", seq: "0", running: Boolean(runStarted && !completed && !allowedStop), live: Boolean(runStarted && !completed && !allowedStop), waiting: false, workers: null, inbox: null, revision: "0" } });
      if (path === "/api/agents") return json({ agents: [] });
      if (path === "/api/agents/receipt-bot") return json({ agent: { id: "receipt-bot", name: "Receipt Bot", title: "本地验证", roleDescription: "Local fixture", avatarSeed: "receipt-bot", visibility: "private", endpoint: null, builtIn: true, hasAuth: false, hasCallbackToken: false, hidden: false, pinned: false, mine: true, systemOwned: false, canManage: true } });
      if (path === "/api/capabilities") return json({ capabilities: {} });
      if (path === "/api/computers/receipt-bot/control") return json({ holder: "bot", requested: false, transitioning: false, request: null });
      if (path === "/api/models") return json({ source: "fixture", fetchedAt: 1, models: [{ id: "fixture/model", label: "Local fixture", provider: "fixture", providerName: "本地验证" }] });
      if (path === "/api/agents/receipt-bot/model") return json({ agentId: "receipt-bot", model: "fixture/model", overrideModel: null, defaultModel: "fixture/model", available: true, canManage: true, reasoningEffort: null, fastMode: false, supportsRunOptions: true });
      if (path.startsWith("/api/plugins/for/")) return json({ skills: [], tools: [] });
      if (path === "/api/panels/receipt-bot/authoring") return json({});
      if (path.endsWith("/permission")) return json({ permission: { agentId: "receipt-bot", mode: "ask", canManage: true } });
      if (path === "/api/goal-tasks") return json({ tasks: [] });
      if (path === "/api/confirmations/requests") return json({ requests: [] });
      if (path.endsWith("/inbox")) return json({ items: [], running: false, waiting: false, paused: false });
      if (path.endsWith("/workers")) return json({ workers: [] });
      if (path.endsWith("/context")) return json({ context: null });
      if (path.endsWith("/stopped")) return json({ userMessageIds: [] });
      if (path.endsWith("/fallbacks")) return json({ turns: [] });
      if (path.endsWith("/sent-at")) return json(null);
      if (/\/channels\/[^/]+\/(activity|busy)$/.test(path) || path.endsWith("/relay-alive")) return json({});
      if (path === "/api/ops/budget") { mutations.push({ path, code: request.postDataJSON().code, ms: sinceRun(), userRequested: allowedStop }); return json({}); }
      unexpectedApi.push({ method: request.method(), path }); return json({});
    });
    try {
      await page.goto(`${server.resolvedUrls.local[0]}tests/fixtures/send-hang.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.getByText(opening.content).waitFor();
      const editor = page.getByRole("textbox", { name: "消息", exact: true });
      await editor.fill(question);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await page.getByRole("button", { name: "停止机器人", exact: true }).waitFor();
      while (!runStarted) await pause(20);
      while (sinceRun() < 13_500) await pause(100);
      assert.equal(runCount, 1);
      assert.equal(pendingHistoryReads, 0, "receipt detection must not download hanging 7MB history");
      assert.deepEqual(mutations, [], "12s of silence must never automatically stop or unlock the send");
      assert(receipts.length >= 1, "the real 12s watchdog must issue a lightweight receipt check");
      assert.equal((await editor.innerText()).trim(), "", "the send must not restore its draft after a quiet receipt check");
      assert.equal(await page.getByText("这句迟迟没发出去。请再发一次；若反复如此，试试刷新页面。").count(), 0);
      await page.screenshot({ path: `${output}/send-receipt-${scenario}-pending.png` });
      if (scenario === "unknown-manual-stop") {
        allowedStop = true;
        await page.getByRole("button", { name: "停止机器人", exact: true }).click();
        await page.getByRole("button", { name: "停止机器人", exact: true }).waitFor({ state: "hidden", timeout: 3000 });
        await page.getByTestId("turn-stopped").first().waitFor({ timeout: 3000 });
        assert(mutations.some((mutation) => mutation.userRequested && /stop|unlock/.test(mutation.path)), "manual Stop must reach a stop or unlock endpoint");
      } else {
        await page.getByText(`SEND_RECEIPT_FINAL_${scenario}: 已完成，只执行了一次。`, { exact: true }).waitFor({ timeout: 12000 });
        await page.getByRole("button", { name: "停止机器人", exact: true }).waitFor({ state: "hidden", timeout: 3000 });
        assert.deepEqual(mutations, []);
        if (scenario === "unknown-then-accepted") assert.deepEqual(receipts.map((receipt) => receipt.received), [null, true]);
      }
      assert.equal(runCount, 1, "the same task must never be silently re-submitted");
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpectedApi, []);
      assert.deepEqual(consoleErrors.filter((error) => !error.includes("net::ERR_ABORTED")), []);
      await page.screenshot({ path: `${output}/send-receipt-${scenario}-final.png` });
      results.push({ scenario, passed: true, realSilentMs: sinceRun(), runCount, pendingHistoryReads, oversizedHistoryConfiguredBytes: 7_196_309, historyDelayWhenPendingMs: 25_000, receipts, mutations, errors, consoleErrors, unexpectedApi, locallyFulfilledExternalResources: externalResources, remoteNetworkAccess: false, trace });
      console.log(`PASS ${scenario}: real 12s receipt check, no duplicate run or automatic cancellation`);
    } catch (error) {
      await page.screenshot({ path: `${output}/send-receipt-${scenario}-failure.png`, timeout: 3000 }).catch(() => {});
      const failure = { scenario, passed: false, error: String(error.stack || error), body: await page.locator("body").innerText({ timeout: 3000 }).catch(() => "unavailable"), runCount, receipts, mutations, errors, consoleErrors, unexpectedApi, trace };
      await writeFile(`${output}/send-receipt-${scenario}-failure.json`, JSON.stringify(failure, null, 2));
      throw error;
    } finally { clearTimeout(runTimer); releaseRun?.(); await context.close(); }
  }));
  results.sort((a, b) => a.scenario.localeCompare(b.scenario));
  await writeFile(`${output}/send-receipt-browser-results.json`, JSON.stringify({ passed: true, testedAt: new Date().toISOString(), viewport: { width: 1100, height: 850 }, results }, null, 2));
  await Promise.all(results.flatMap((result) => ["json", "png"].map((extension) => unlink(`${output}/send-receipt-${result.scenario}-failure.${extension}`).catch(() => {}))));
} finally { await browser?.close(); await server.close(); }

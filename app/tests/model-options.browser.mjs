// Run from app/: node tests/model-options.browser.mjs. All API responses stay local.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const output = fileURLToPath(
  new URL("../../../ops/model-options-local/", import.meta.url),
);
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { port: 48057, host: "127.0.0.1", open: false },
});
await server.listen();
console.log("Local fixture server ready");
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  console.log("Headless browser ready");
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let state = {
      agentId: "test-bot",
      model: "vendor/gpt-6-sol",
      overrideModel: null,
      defaultModel: "vendor/gpt-6-sol",
      available: true,
      canManage: true,
      reasoningEffort: null,
      fastMode: false,
      supportsRunOptions: true,
    };
    await context.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/models")
        return route.fulfill({
          json: {
            fetchedAt: 1,
            models: [
              {
                id: state.model,
                label: "GPT-6 Sol",
                provider: "vendor",
                providerName: "模型网关",
              },
            ],
          },
        });
      if (route.request().method() === "PUT")
        state = { ...state, ...route.request().postDataJSON() };
      return route.fulfill({ json: state });
    });
    await page.goto(
      `${server.resolvedUrls.local[0]}tests/fixtures/model-options.html`,
    );
    console.log(`Fixture loaded at ${width}px`);
    await page
      .locator('[data-testid="composer"]')
      .getByRole("combobox", { name: "模型选择", exact: true })
      .click();
    const popup = page.locator(".model-popover");
    await popup
      .getByRole("combobox", { name: "思考深度", exact: true })
      .selectOption("xhigh");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('select[aria-label="思考深度"]')].every(
        (element) => element.value === "xhigh" && !element.disabled,
      ),
    );
    assert.equal(
      await popup.isVisible(),
      true,
      "Saving effort must keep the popup open",
    );
    await popup.getByRole("switch", { name: "Fast 模式" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="switch"]')].every(
        (element) =>
          element.getAttribute("aria-checked") === "true" && !element.disabled,
      ),
    );
    assert.equal(state.reasoningEffort, "xhigh");
    assert.equal(state.fastMode, true);
    assert.equal(state.model, "vendor/gpt-6-sol");
    const bounds = await popup.boundingBox();
    assert(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 900,
    );
    await page.screenshot({ path: `${output}/model-options-${width}.png` });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({
      path: `${output}/model-options-${width}-dark.png`,
    });
    await popup
      .getByRole("combobox", { name: "思考深度", exact: true })
      .selectOption("");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('select[aria-label="思考深度"]')].every(
        (element) => element.value === "" && !element.disabled,
      ),
    );
    await popup.getByRole("switch", { name: "Fast 模式" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="switch"]')].every(
        (element) => element.getAttribute("aria-checked") === "false",
      ),
    );
    assert.equal(state.reasoningEffort, null);
    assert.equal(state.fastMode, false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS ${width}px: selection, Fast, persistence, reset, light/dark layout`,
    );
  }
} finally {
  await browser?.close();
  await server.close();
}

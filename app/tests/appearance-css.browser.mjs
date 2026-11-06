import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Exercise computed styles: a variable can update successfully while the visible
// gradient still inherits a value already resolved on the document root.
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const noBlur = await readFile(new URL("../src/perf-noblur.css", import.meta.url), "utf8");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: "chrome" }),
});
try {
  const page = await browser.newPage();
  await page.setContent(`<style>${styles}\n${noBlur}\n* { transition: none !important; }</style>
    <div id="sky-root"><div id="skyph"></div></div>
    <div class="glass-side-card" style="width:200px;height:120px"></div>
    <div class="chisabot-wallpaper-img" data-blur style="--wallpaper-blur:12px"></div>`);
  for (const dark of [false, true]) {
    for (const material of ["liquid", "mist", "crystal", "frosted"]) {
      const backgrounds = await page.evaluate(({ dark, material }) => {
        const root = document.documentElement;
        root.classList.toggle("dark", dark);
        root.dataset.glass = material;
        const card = document.querySelector(".glass-side-card");
        card.style.setProperty("--lg-alpha", "0.05");
        const low = getComputedStyle(card).backgroundImage;
        card.style.setProperty("--lg-alpha", "0.55");
        return [low, getComputedStyle(card).backgroundImage];
      }, { dark, material });
      assert.notEqual(backgrounds[0], backgrounds[1], `${material} (${dark ? "dark" : "light"}) haze must change its background`);
    }
  }
  assert.equal(await page.locator(".chisabot-wallpaper-img").evaluate(el => getComputedStyle(el).filter), "blur(12px)");
  await page.evaluate(() => { document.documentElement.dataset.perf = "on"; });
  assert.equal(await page.locator(".chisabot-wallpaper-img").evaluate(el => getComputedStyle(el).filter), "none");
  assert.equal(await page.locator(".glass-side-card").evaluate(el => getComputedStyle(el).backdropFilter), "none");
  const paletteBackgrounds = await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.palette = "ruby";
    root.style.setProperty("--palette-sky-0", "red");
    root.style.setProperty("--palette-sky-1", "pink");
    root.style.setProperty("--palette-sky-2", "white");
    root.style.setProperty("--palette-sky-3", "gray");
    const before = getComputedStyle(document.querySelector("#skyph")).backgroundImage;
    root.style.setProperty("--palette-sky-0", "blue");
    return [before, getComputedStyle(document.querySelector("#skyph")).backgroundImage];
  });
  assert.notEqual(paletteBackgrounds[0], paletteBackgrounds[1], "theme sky must use palette colors");
  console.log("PASS: 8 material/theme haze combinations, wallpaper blur, performance-mode suppression, and palette sky");
} finally {
  await browser.close();
}

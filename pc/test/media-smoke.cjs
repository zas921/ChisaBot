"use strict";
const { app, BrowserWindow, WebContentsView, ipcMain, session, screen } = require("electron");
const { createMediaHost } = require("../src/media-host");
const path = require("node:path"), fs = require("node:fs"), http = require("node:http"), assert = require("node:assert/strict");
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
if (!output || !path.isAbsolute(output)) throw new Error("Pass --output=<absolute fixture build directory>");
app.setPath("userData", path.join(output, "profile"));
const result = { checks: [], success: false };
let host, server, main;
const views = [], popups = [];
const until = async (fn, label, timeout = 35000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timeout: ${label}`); };
const check = (name, value) => { assert.ok(value, name); result.checks.push(name); };
app.whenReady().then(async () => {
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const name = path.basename(url.pathname);
      if (name === "media-capabilities.js" || name === "media-capabilities.css") { res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : "text/javascript"); res.end(fs.readFileSync(path.join(output, name))); }
      else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/media-capabilities.css"><div id="root"></div><script type="module" src="/media-capabilities.js"></script></html>'); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const parentSession = session.fromPartition("persist:media-capability-smoke");
    await parentSession.setProxy({ proxyRules: "http://127.0.0.1:7897", proxyBypassRules: "<local>" });
    main = new BrowserWindow({ width: 840, height: 860, title: "ChisaBot 媒体能力验收", show: true, webPreferences: { session: parentSession, preload: path.join(__dirname, "media-smoke-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    main.setMenu(null);
    host = createMediaHost({ authorize: (event) => event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame && event.senderFrame.url.startsWith(origin + "/"), getParentWindow: () => main, electron: { BrowserWindow: function (options) { const window = new BrowserWindow(options); popups.push(window); return window; }, WebContentsView: function (options) { const view = new WebContentsView(options); views.push(view); return view; }, ipcMain, screen, session: { fromPartition(name) { const isolated = session.fromPartition(name); void isolated.setProxy({ proxyRules: "http://127.0.0.1:7897", proxyBypassRules: "<local>" }); return isolated; } } } });
    await main.loadURL(origin + "/?case=feed");
    await until(() => main.webContents.executeJavaScript("Boolean(document.querySelector('.jr-swipe-feed'))"), "feed render");
    main.show(); main.focus(); main.webContents.focus();
    main.webContents.debugger.attach("1.3");
    await main.webContents.executeJavaScript("document.addEventListener('wheel',event=>{window.__lastWheel={deltaY:event.deltaY,target:event.target.tagName}},{capture:true})");
    check("no paging buttons", await main.webContents.executeJavaScript("document.querySelectorAll('.jr-swipe-feed button').length===0"));
    const rect = await main.webContents.executeJavaScript("(()=>{const r=document.querySelector('.jr-swipe-feed').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    await main.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await main.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaY: 450, deltaX: 0 });
    await until(() => main.webContents.executeJavaScript("Math.abs(document.querySelector('.jr-swipe-feed').scrollTop-420)<2"), "wheel switches page");
    await new Promise((resolve) => setTimeout(resolve, 350));
    check("wheel scroll switches page", true);
    await main.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y - 100, button: "left", buttons: 1, clickCount: 1 });
    await main.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y + 100, button: "left", buttons: 1 });
    result.drag = await main.webContents.executeJavaScript("(()=>{const f=document.querySelector('.jr-swipe-feed');return{top:f.scrollTop,snap:f.style.scrollSnapType}})()");
    await main.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y + 100, button: "left", buttons: 0, clickCount: 1 });
    await until(() => main.webContents.executeJavaScript("document.querySelector('.jr-swipe-feed').scrollTop<10"), "mouse drag switches back");
    await new Promise((resolve) => setTimeout(resolve, 350));
    check("drag snap remains on the selected page", await main.webContents.executeJavaScript("document.querySelector('.jr-swipe-feed').scrollTop<10"));
    check("mouse drag returns previous page", true);
    await main.webContents.executeJavaScript("document.querySelector('video').play()", true);
    await until(() => main.webContents.executeJavaScript("document.querySelector('video').currentTime>0.25"), "HTTPS video playback", 45000);
    check("HTTPS video advances with native controls", await main.webContents.executeJavaScript("document.querySelector('video').controls"));
    fs.writeFileSync(path.join(output, "video-and-feed.png"), (await main.webContents.capturePage()).toPNG());
    await main.loadURL(origin + "/?case=audio");
    await until(() => main.webContents.executeJavaScript("Boolean(document.querySelector('audio'))"), "audio render");
    await main.webContents.executeJavaScript("document.querySelector('audio').play()", true);
    await until(() => main.webContents.isCurrentlyAudible(), "audio output", 45000);
    check("HTTPS audio emits sound", true);
    await main.loadURL(origin + "/?case=web");
    await until(() => main.webContents.executeJavaScript("Boolean(document.querySelector('.jr-media-toolbar button'))"), "browser render");
    check("browser waits for load gesture", views.length === 0);
    await main.webContents.executeJavaScript("document.querySelector('.jr-media-toolbar button').click()");
    await until(() => views.length === 1 && views[0].webContents.getTitle().includes("Example Domain"), "isolated external page", 45000);
    const remoteContents = views[0].webContents;
    check("external HTTPS page loads without ChisaBot bridge", await views[0].webContents.executeJavaScript("typeof window.chisabotPC==='undefined' && typeof require==='undefined'"));
    await until(() => views[0].getVisible(), "native slot visible");
    await main.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='弹出小窗').click()");
    await until(() => popups.length === 1 && popups[0].isAlwaysOnTop(), "pinned popup");
    check("same page moves to pinned popup", views[0].webContents.getTitle().includes("Example Domain"));
    fs.writeFileSync(path.join(output, "native-web-page.png"), (await views[0].webContents.capturePage()).toPNG());
    await main.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='放回面板').click()");
    await until(() => popups[0].isDestroyed(), "dock popup");
    check("popup docks back without reloading page", views[0].webContents.getTitle().includes("Example Domain"));
    await main.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='关闭网页').click()");
    await until(() => remoteContents.isDestroyed(), "release view");
    check("closing component destroys remote contents", true);
    result.success = true;
  } catch (error) {
    result.error = error.stack || String(error);
    if (main && !main.isDestroyed()) {
      result.page = await main.webContents.executeJavaScript("(()=>{const feed=document.querySelector('.jr-swipe-feed');return{title:document.title,body:document.body.innerText,feed:feed?{top:feed.scrollTop,height:feed.clientHeight,scrollHeight:feed.scrollHeight,rect:feed.getBoundingClientRect().toJSON()}:null,wheel:window.__lastWheel}})()").catch(() => null);
      fs.writeFileSync(path.join(output, "failure.png"), (await main.webContents.capturePage()).toPNG());
    }
  }
  finally {
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    host?.destroy();
    if (main && !main.isDestroyed()) main.destroy();
    server?.close();
    app.exit(result.success ? 0 : 1);
  }
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMediaHost, mediaUrl, mediaBounds } = require("../src/media-host");

function setup() {
  const handlers = new Map(), views = [], windows = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = {}; this.muted = false; this.zoom = 1; this.dead = false; }
    getURL() { return "https://chisabot.test/chat"; }
    isAudioMuted() { return this.muted; }
    setAudioMuted(value) { this.muted = value; }
    getZoomFactor() { return this.zoom; }
    setZoomFactor(value) { this.zoom = value; }
    setWindowOpenHandler(handler) { this.popupHandler = handler; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    executeJavaScript() { return Promise.resolve(); }
    reload() { this.reloaded = true; }
    send() {}
    isDestroyed() { return this.dead; }
    close() { this.dead = true; }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.children = new Set(); this.dead = false; this.pinned = false; this.contentView = { addChildView: (view) => this.children.add(view), removeChildView: (view) => this.children.delete(view) }; windows.push(this); }
    isDestroyed() { return this.dead; }
    getContentSize() { return [1000, 800]; }
    getBounds() { return { x: 0, y: 0, width: 1000, height: 800 }; }
    setMenu() {}
    loadFile() { return Promise.resolve(); }
    show() {}
    setAlwaysOnTop(value) { this.pinned = value; }
    isAlwaysOnTop() { return this.pinned; }
    destroy() { this.dead = true; }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(value) { this.visible = value; }
  }
  const isolated = new EventEmitter();
  isolated.setPermissionRequestHandler = (handler) => { isolated.permission = handler; };
  isolated.setPermissionCheckHandler = (handler) => { isolated.check = handler; };
  const parent = new Window();
  const owner = { sender: parent.webContents, senderFrame: parent.webContents.mainFrame };
  const host = createMediaHost({ getParentWindow: () => parent, authorize: (event) => event.sender === owner.sender && event.senderFrame === owner.senderFrame, electron: { BrowserWindow: Window, WebContentsView: View, session: { fromPartition: () => isolated }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) } } });
  const call = (channel, input, event = owner) => handlers.get(`media:${channel}`)(event, input);
  return { host, parent, owner, views, windows, isolated, call };
}

test("media URLs reject executable protocols, credentials and insecure transport", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///C:/secret", "http://site.test/video", "https://user:pass@site.test/"]) assert.throws(() => mediaUrl(value));
  assert.equal(mediaUrl("https://media.test/movie.mp4?signature=abc"), "https://media.test/movie.mp4?signature=abc");
});

test("native view bounds cannot escape the client or accept NaN", () => {
  assert.deepEqual(mediaBounds({ x: 700, y: 500, width: 600, height: 900 }, [1000, 800]), { x: 700, y: 500, width: 300, height: 300 });
  assert.deepEqual(mediaBounds({ x: 80, y: 40, width: 100, height: 100 }, [1000, 800], 1.25), { x: 100, y: 50, width: 125, height: 125 });
  assert.throws(() => mediaBounds({ x: NaN, y: 0, width: 10, height: 10 }, [100, 100]));
});

test("only the trusted top frame can open or control a remote view", () => {
  const ctx = setup();
  try {
    assert.throws(() => ctx.call("open", { id: "panel", url: "https://outside.test" }, { sender: ctx.parent.webContents, senderFrame: {} }));
    assert.throws(() => ctx.call("open", { id: "panel", url: "https://chisabot.test/" }));
    ctx.call("open", { id: "panel", url: "https://outside.test" });
    const view = ctx.views[0];
    assert.deepEqual(view.options.webPreferences, { session: ctx.isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false });
    assert.equal(view.webContents.popupHandler({ url: "file:///secret" }).action, "deny");
    let permission;
    ctx.isolated.permission(null, "microphone", (allowed) => { permission = allowed; });
    assert.equal(permission, false);
    assert.equal(ctx.isolated.check(), false);
    assert.throws(() => ctx.call("control", { id: "panel", action: "detach" }, { sender: view.webContents, senderFrame: view.webContents.mainFrame }));
    let blocked = false;
    view.webContents.emit("will-navigate", { preventDefault() { blocked = true; } }, "file:///secret");
    assert.equal(blocked, true);
  } finally { ctx.host.destroy(); }
});

test("hidden views are silenced; popout, dock and release preserve ownership", () => {
  const ctx = setup();
  try {
    ctx.call("open", { id: "panel", url: "https://outside.test" });
    const view = ctx.views[0];
    const bounds = { id: "panel", x: 500, y: 150, width: 350, height: 480, visible: true };
    ctx.call("layout", bounds);
    assert.equal(view.visible, true);
    assert.equal(view.webContents.muted, false);
    ctx.parent.emit("minimize");
    assert.equal(view.visible, false);
    assert.equal(view.webContents.muted, true);
    ctx.parent.emit("restore");
    assert.equal(view.visible, true);
    assert.equal(view.webContents.muted, false);
    ctx.call("layout", { ...bounds, visible: false });
    assert.equal(view.visible, false);
    assert.equal(view.webContents.muted, true);
    const detached = ctx.call("control", { id: "panel", action: "detach" });
    assert.equal(detached.detached, true);
    const popup = ctx.windows[1];
    popup.emit("ready-to-show");
    assert.equal(popup.pinned, true);
    assert.equal(ctx.parent.children.size, 0);
    assert.equal(popup.children.has(view), true);
    ctx.call("control", { id: "panel", action: "dock" });
    assert.equal(popup.dead, true);
    assert.equal(ctx.parent.children.has(view), true);
    ctx.call("release", "panel");
    assert.equal(view.webContents.dead, true);
    assert.equal(ctx.parent.children.size, 0);
  } finally { ctx.host.destroy(); }
});

test("top-level navigation and renderer failure tear down remote content", () => {
  const ctx = setup();
  try {
    ctx.call("open", { id: "panel", url: "https://outside.test" });
    ctx.parent.webContents.emit("did-start-navigation", {}, "https://chisabot.test/settings", false, true);
    assert.equal(ctx.views[0].webContents.dead, true);
    assert.throws(() => ctx.call("control", { id: "panel", action: "reload" }));
    ctx.call("open", { id: "next", url: "https://outside.test" });
    ctx.parent.webContents.emit("render-process-gone");
    assert.equal(ctx.views[1].webContents.dead, true);
  } finally { ctx.host.destroy(); }
});

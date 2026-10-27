"use strict";
const path = require("node:path");

function mediaUrl(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("网页地址无效。");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("网页必须使用不含用户名和密码的 HTTPS 地址。");
  return url.href;
}

function mediaBounds(input, size, zoom = 1) {
  if (![input?.x, input?.y, input?.width, input?.height].every(Number.isFinite)) throw new Error("网页区域无效。");
  const x = Math.max(0, Math.min(size[0], Math.round(input.x * zoom)));
  const y = Math.max(0, Math.min(size[1], Math.round(input.y * zoom)));
  return { x, y, width: Math.max(0, Math.min(size[0] - x, Math.round(input.width * zoom))), height: Math.max(0, Math.min(size[1] - y, Math.round(input.height * zoom))) };
}

function createMediaHost({ authorize, getParentWindow, electron = require("electron") }) {
  const { BrowserWindow, WebContentsView, ipcMain, session, screen } = electron;
  const items = new Map();
  const parents = new WeakSet();
  const sessions = new WeakSet();
  let shuttingDown = false;
  const state = (item) => ({ id: item.id, status: item.status, detached: Boolean(item.popup), muted: item.contents.isAudioMuted(), pinned: Boolean(item.popup?.isAlwaysOnTop()), ...(item.error ? { error: item.error } : {}) });
  const notify = (item) => {
    if (item.contents.isDestroyed()) return;
    const value = state(item);
    if (!item.parent.isDestroyed()) item.parent.webContents.send("media:state", value);
    if (item.popup && !item.popup.isDestroyed()) item.popup.webContents.send("media:state", value);
  };
  const lookup = (id, parent) => {
    const item = items.get(id);
    if (!item || item.parent !== parent) throw new Error("媒体面板已关闭。");
    return item;
  };
  const pause = (item) => {
    item.contents.setAudioMuted(true);
    void item.contents.executeJavaScript("document.querySelectorAll('video,audio').forEach(media=>media.pause())").catch(() => {});
  };
  const suspend = (item) => {
    item.view.setVisible(false);
    pause(item);
  };
  const resizePopup = (item) => {
    if (!item.popup || item.popup.isDestroyed()) return;
    const [width, height] = item.popup.getContentSize();
    item.view.setBounds({ x: 0, y: 48, width, height: Math.max(0, height - 48) });
    item.contents.setZoomFactor(Math.min(1, width / 506));
  };
  const dock = (item) => {
    const popup = item.popup;
    if (!popup) return;
    popup.contentView.removeChildView(item.view);
    item.popup = null;
    if (!popup.isDestroyed()) popup.destroy();
    if (!item.parent.isDestroyed()) {
      item.parent.contentView.addChildView(item.view);
      item.view.setBounds(item.bounds);
      item.view.setVisible(item.visible);
      item.contents.setZoomFactor(Math.min(1, item.bounds.width / 506));
      item.contents.setAudioMuted(!item.visible || item.muted);
      if (!item.visible) pause(item);
    }
    notify(item);
  };
  const release = (item) => {
    items.delete(item.id);
    const popup = item.popup;
    item.popup = null;
    if (popup && !popup.isDestroyed()) popup.destroy();
    if (!item.parent.isDestroyed()) {
      try { item.parent.contentView.removeChildView(item.view); } catch {}
    }
    if (!item.contents.isDestroyed()) item.contents.close();
  };
  const control = (item, action) => {
    if (action === "reload") { item.status = "loading"; item.error = ""; item.contents.reload(); }
    else if (action === "mute") { item.muted = !item.muted; item.contents.setAudioMuted(item.muted || (!item.popup && !item.visible)); }
    else if (action === "dock") dock(item);
    else if (action === "pin" && item.popup) item.popup.setAlwaysOnTop(!item.popup.isAlwaysOnTop(), "screen-saver");
    else if (action === "detach" && !item.popup) {
      const area = screen.getDisplayMatching(item.parent.getBounds()).workArea;
      const width = Math.min(420, area.width), height = Math.min(720, area.height);
      item.parent.contentView.removeChildView(item.view);
      const popup = new BrowserWindow({ x: area.x + area.width - width, y: area.y, width, height, minWidth: 320, minHeight: 400, show: false, title: "媒体小窗", backgroundColor: "#15171b", webPreferences: { preload: path.join(__dirname, "media-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      item.popup = popup;
      popup.setMenu(null);
      popup.contentView.addChildView(item.view);
      resizePopup(item);
      item.view.setVisible(true);
      item.contents.setAudioMuted(item.muted);
      popup.on("resize", () => resizePopup(item));
      popup.on("close", (event) => { if (item.popup === popup && !shuttingDown) { event.preventDefault(); dock(item); } });
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      popup.webContents.on("will-navigate", (event) => event.preventDefault());
      void popup.loadFile(path.join(__dirname, "ui/media-window.html"));
      popup.once("ready-to-show", () => { if (!popup.isDestroyed()) { popup.show(); popup.setAlwaysOnTop(true, "screen-saver"); notify(item); } });
    } else if (!["reload", "mute", "dock", "detach", "pin"].includes(action)) throw new Error("不支持此媒体操作。");
    notify(item);
    return state(item);
  };
  const trusted = (event) => {
    if (!authorize(event)) throw new Error("只有 ChisaBot 主页面可以使用媒体面板。");
    const parent = getParentWindow();
    if (!parent || parent.isDestroyed()) throw new Error("主窗口已关闭。");
    if (!parents.has(parent)) {
      parents.add(parent);
      const close = () => { for (const item of [...items.values()]) if (item.parent === parent) release(item); };
      parent.on("closed", close);
      parent.webContents.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
      parent.webContents.on("render-process-gone", close);
      parent.on("hide", () => { for (const item of items.values()) if (item.parent === parent && !item.popup) suspend(item); });
      parent.on("minimize", () => { for (const item of items.values()) if (item.parent === parent && !item.popup) suspend(item); });
      const restore = () => { for (const item of items.values()) if (item.parent === parent && !item.popup) viewLayout(item); };
      parent.on("show", restore);
      parent.on("restore", restore);
    }
    return parent;
  };
  ipcMain.handle("media:open", (event, input) => {
    const parent = trusted(event);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input?.id || "")) throw new Error("媒体面板标识无效。");
    const url = mediaUrl(input.url);
    if (new URL(url).origin === new URL(parent.webContents.getURL()).origin) throw new Error("外部网页必须使用独立于 ChisaBot 的来源。");
    if (items.has(input.id)) throw new Error("媒体面板已打开。");
    if (items.size >= 4) throw new Error("最多同时打开四个网页面板，请先关闭一个。");
    const originKey = require("node:crypto").createHash("sha256").update(new URL(parent.webContents.getURL()).origin).digest("hex").slice(0, 24);
    const isolated = session.fromPartition(`persist:chisabot-media-${originKey}`);
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    if (!sessions.has(isolated)) { sessions.add(isolated); isolated.on("will-download", (event) => event.preventDefault()); }
    const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const item = { id: input.id, url, parent, view, contents: view.webContents, bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: false, muted: false, popup: null, status: "loading", error: "" };
    items.set(item.id, item);
    parent.contentView.addChildView(view);
    view.setBounds(item.bounds);
    view.setVisible(false);
    view.webContents.setAudioMuted(true);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const navigation = (event, target) => { try { mediaUrl(target); } catch { event.preventDefault(); item.error = "已阻止非 HTTPS 网页跳转。"; notify(item); } };
    view.webContents.on("will-navigate", navigation);
    view.webContents.on("will-redirect", navigation);
    view.webContents.on("did-finish-load", () => { item.status = "ready"; item.error = ""; if (item.popup) resizePopup(item); else viewLayout(item); notify(item); });
    view.webContents.on("did-fail-load", (_e, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { item.status = "error"; item.error = `网页加载失败：${description}`; notify(item); } });
    view.webContents.on("render-process-gone", () => { item.status = "error"; item.error = "网页进程已退出，请关闭后重新加载。"; notify(item); });
    void view.webContents.loadURL(url).catch(() => {});
    return state(item);
  });
  ipcMain.handle("media:layout", (event, input) => {
    const parent = trusted(event), item = lookup(input?.id, parent);
    item.bounds = mediaBounds(input, parent.getContentSize(), parent.webContents.getZoomFactor());
    item.visible = input.visible === true && item.bounds.width >= 80 && item.bounds.height >= 80;
    if (item.popup) return;
    viewLayout(item);
  });
  function viewLayout(item) {
    item.view.setBounds(item.bounds);
    item.contents.setZoomFactor(Math.min(1, Math.max(0.25, item.bounds.width / 506)));
    item.view.setVisible(item.visible);
    if (!item.visible) pause(item);
    else item.contents.setAudioMuted(item.muted);
  }
  ipcMain.handle("media:control", (event, input) => control(lookup(input?.id, trusted(event)), input?.action));
  ipcMain.handle("media:release", (event, id) => { const parent = trusted(event); const item = items.get(id); if (item) release(lookup(id, parent)); });
  ipcMain.handle("media:popup", (event, action) => {
    const item = [...items.values()].find((entry) => entry.popup?.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
    if (!item) throw new Error("调用来源不是媒体小窗。");
    if (action === "state") return state(item);
    return control(item, action);
  });
  return { destroy() { shuttingDown = true; for (const item of [...items.values()]) release(item); for (const channel of ["open", "layout", "control", "release", "popup"]) ipcMain.removeHandler(`media:${channel}`); } };
}

module.exports = { createMediaHost, mediaUrl, mediaBounds };

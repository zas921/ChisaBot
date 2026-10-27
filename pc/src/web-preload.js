"use strict";
/**
 * 主窗口的 preload（docs/pc-node.md §8.2）。主窗口载入的是服务器上的 ChisaBot 网页本身。
 *
 *  - 网页（且只在已登录的那台服务器的顶层页面）里注入 window.chisabotPC：本机桥，只开放网页做不到的本机事情；
 *    主进程对每次调用再核对来源（主窗口 + 顶层框架 + 服务器 origin），放松安全的改动弹本机确认窗。
 *  - 网页的外观（深色 / 时间天空）转告主进程，本机窗口跟着网页走。
 *  - 主窗口断网时显示的本机离线页（file://）拿到和其它本机页面一样的 window.chisa（少量通道）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const isLocalPage = location.protocol === "file:";

/** 无边框主窗口的窗口控制：网页顶栏 / 离线页右上角的 小窗 · 最小化 · 最大化 · 关闭。 */
function exposeWindowControls() {
  contextBridge.exposeInMainWorld("chisabotWindow", {
    platform: process.platform,
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange(callback) {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on("window:maximized", listener);
      return () => ipcRenderer.removeListener("window:maximized", listener);
    },
    // 小窗模式（DESIGN.md §36）：手机比例的竖长小窗 ↔ 原来的大小和位置。
    toggleCompact: () => ipcRenderer.send("window:toggle-compact"),
    isCompact: () => ipcRenderer.invoke("window:is-compact"),
    onCompactChange(callback) {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on("window:compact", listener);
      return () => ipcRenderer.removeListener("window:compact", listener);
    },
  });
}

if (isLocalPage) {
  exposeWindowControls();
  const CHANNELS = new Set(["state:get", "paused:set", "chat:retry"]);
  contextBridge.exposeInMainWorld("chisa", {
    invoke(channel, payload) {
      if (!CHANNELS.has(channel)) return Promise.reject(new Error(`未知操作 ${channel}`));
      return ipcRenderer.invoke(channel, payload);
    },
    onState(callback) {
      const listener = (_event, kind) => callback(kind);
      ipcRenderer.on("state:changed", listener);
      return () => ipcRenderer.removeListener("state:changed", listener);
    },
  });
} else {
  let origin = "";
  try {
    origin = ipcRenderer.sendSync("pc:origin");
  } catch {}
  if (origin && location.origin === origin && window.top === window) {
    exposeWindowControls();
    const bool = (v) => (typeof v === "boolean" ? v : undefined);
    contextBridge.exposeInMainWorld("chisabotPC", {
      media: {
        version: 1,
        open: (input) => ipcRenderer.invoke("media:open", input),
        layout: (input) => ipcRenderer.invoke("media:layout", input),
        control: (input) => ipcRenderer.invoke("media:control", input),
        release: (id) => ipcRenderer.invoke("media:release", id),
        onState(callback) { const listener = (_event, state) => callback(state); ipcRenderer.on("media:state", listener); return () => ipcRenderer.removeListener("media:state", listener); },
      },
      state: () => ipcRenderer.invoke("pc:state"),
      setLocal: (patch) =>
        ipcRenderer.invoke("pc:set", {
          localPaused: bool(patch && patch.localPaused),
          forceLocalApproval: bool(patch && patch.forceLocalApproval),
          autoStart: bool(patch && patch.autoStart),
          startHidden: bool(patch && patch.startHidden),
          autoUpdate: bool(patch && patch.autoUpdate),
        }),
      checkUpdate: () => ipcRenderer.invoke("pc:check-update"),
      installUpdate: () => ipcRenderer.invoke("pc:install-update"),
      pickFolders: () => ipcRenderer.invoke("pc:pick-folders"),
      // 已登录但这台电脑没登记 / 令牌失效时，用当前会话重新登记（和托盘「重新登记这台电脑」同一条路径）。
      enroll: () => ipcRenderer.invoke("pc:enroll"),
      reconnect: () => ipcRenderer.invoke("pc:reconnect"),
      logout: () => ipcRenderer.invoke("pc:logout"),
      // 电脑文件夹同步（P4b，DESIGN.md §73.9）：网页里的「电脑上的文件夹」、同步面板、冲突对话框用。
      // 路径只能来自 pick() 弹出的系统对话框；主进程再核对一次。
      sync: {
        // 2（0.1.15 起）：create 失败会自己撤销；多了 forget（解除已在云端删掉的工作区留下的本机同步记录，DESIGN.md §87）
        version: 2,
        status: () => ipcRenderer.invoke("pc:sync-status"),
        pick: (opts) => ipcRenderer.invoke("pc:sync-pick", { forEnable: !!(opts && opts.forEnable) }),
        create: (input) => ipcRenderer.invoke("pc:sync-create", { path: String(input?.path || ""), name: String(input?.name || ""), enableSync: input?.enableSync !== false }),
        enable: (input) =>
          ipcRenderer.invoke("pc:sync-enable", { workspaceId: String(input?.workspaceId || ""), path: input?.path ? String(input.path) : null, name: String(input?.name || ""), source: String(input?.source || "") }),
        release: (workspaceId) => ipcRenderer.invoke("pc:sync-release", { workspaceId: String(workspaceId || "") }),
        forget: (workspaceId) => ipcRenderer.invoke("pc:sync-forget", { workspaceId: String(workspaceId || "") }),
        syncNow: (workspaceId) => ipcRenderer.invoke("pc:sync-now", { workspaceId: String(workspaceId || "") }),
        resolve: (input) => ipcRenderer.invoke("pc:sync-resolve", { workspaceId: String(input?.workspaceId || ""), path: String(input?.path || ""), choice: String(input?.choice || "") }),
        openFolder: (workspaceId) => ipcRenderer.invoke("pc:sync-open-folder", { workspaceId: String(workspaceId || "") }),
        onChange(callback) {
          const listener = () => callback();
          ipcRenderer.on("sync:changed", listener);
          return () => ipcRenderer.removeListener("sync:changed", listener);
        },
      },
      onChange(callback) {
        const listener = () => callback();
        ipcRenderer.on("state:changed", listener);
        return () => ipcRenderer.removeListener("state:changed", listener);
      },
    });

    // 外观：网页在 <html> 上切 .dark，时间天空的开关在 localStorage["chisabot-sky"]。
    const report = () => {
      let sky = true;
      try {
        sky = window.localStorage.getItem("chisabot-sky") !== "off";
      } catch {}
      ipcRenderer.invoke("pc:appearance", { dark: document.documentElement.classList.contains("dark"), sky }).catch(() => {});
    };
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(report, 200);
    };
    window.addEventListener("DOMContentLoaded", () => {
      report();
      new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-sky"] });
    });
    window.addEventListener("storage", schedule);
  }
}

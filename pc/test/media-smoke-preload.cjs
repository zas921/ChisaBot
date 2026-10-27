"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chisabotPC", { media: {
  version: 1,
  open: (input) => ipcRenderer.invoke("media:open", input),
  layout: (input) => ipcRenderer.invoke("media:layout", input),
  control: (input) => ipcRenderer.invoke("media:control", input),
  release: (id) => ipcRenderer.invoke("media:release", id),
  onState(callback) { const handler = (_event, state) => callback(state); ipcRenderer.on("media:state", handler); return () => ipcRenderer.removeListener("media:state", handler); },
} });

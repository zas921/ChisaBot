"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mediaWindow", {
  control: (action) => ipcRenderer.invoke("media:popup", action),
  onState(callback) { const listener = (_event, state) => callback(state); ipcRenderer.on("media:state", listener); return () => ipcRenderer.removeListener("media:state", listener); },
});

"use strict";
const paint = (state) => { document.querySelector("#sound").textContent = state.muted ? "开启声音" : "静音"; document.querySelector("#pin").textContent = state.pinned ? "取消置顶" : "置顶"; };
window.mediaWindow.onState(paint);
window.mediaWindow.control("state").then(paint);
for (const [id, action] of [["sound", "mute"], ["pin", "pin"], ["dock", "dock"]]) document.querySelector(`#${id}`).onclick = () => window.mediaWindow.control(action).then(paint);

import React from "react";
import { createRoot } from "react-dom/client";
import { AudioPlayer, SwipeFeed, VideoPlayer, WebEmbed } from "../../src/lib/copilot/json-render/media";

const video = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const audio = "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3";
const example = new URLSearchParams(location.search).get("case") || "feed";
const style = document.createElement("style");
style.textContent = "body{margin:0;background:#f3f5fa;color:#142037;font:14px system-ui;--border:#b7c0ce;--ring:#1674d1;--muted-foreground:#526278}main{width:350px;margin:28px auto;padding:16px;background:white;border-radius:12px}h1{font-size:16px}p{line-height:1.6}";
document.head.append(style);
createRoot(document.querySelector("#root")!).render(<main><h1>通用媒体能力验收</h1>{example === "web" ? <WebEmbed title="外部网页测试" url="https://example.org/" mode="browser" height={420} /> : example === "audio" ? <AudioPlayer title="公开音频样本" src={audio} /> : <SwipeFeed label="测试滑动翻页" height={420}><VideoPlayer title="公开视频样本" src={video} /><section style={{ background: "#e0edfc", height: "100%", display: "grid", placeItems: "center" }}>第二页：通用内容</section><section style={{ background: "#d8f1e5", height: "100%", display: "grid", placeItems: "center" }}>第三页：通用内容</section></SwipeFeed>}</main>);

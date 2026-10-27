import { Children, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { mediaHttpsUrl, type PanelWebState } from "../../../../../shared/media";
import { pcBridge } from "@/lib/pc-bridge";
import "./media.css";

function usePlayback(ref: { current: HTMLMediaElement | null }, autoplay = false, source = "") {
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    let visible = false;
    const sync = () => {
      if (!visible || document.hidden) media.pause();
      else if (autoplay) void media.play().catch(() => {});
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && entry.intersectionRatio >= 0.5; sync(); }, { threshold: [0, 0.5] });
    observer.observe(media);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); media.pause(); };
  }, [ref, autoplay, source]);
}

export function VideoPlayer({ src, title, poster, autoplay, muted, loop, aspect }: { src: string; title?: string | null; poster?: string | null; autoplay?: boolean | null; muted?: boolean | null; loop?: boolean | null; aspect?: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  usePlayback(ref, autoplay === true, src);
  useEffect(() => setFailed(false), [src]);
  const url = mediaHttpsUrl(src);
  return <figure className="jr-media jr-el">
    {title ? <figcaption>{title}</figcaption> : null}
    {url ? <video ref={ref} aria-label={title || "视频播放器"} src={url} poster={mediaHttpsUrl(poster) || undefined} controls playsInline preload="none" muted={muted === true} loop={loop === true} onError={() => setFailed(true)} style={{ aspectRatio: (aspect || "16:9").replace(":", "/"), width: "100%", maxHeight: "100%", objectFit: "contain" }} /> : null}
    {!url || failed ? <p role="status">视频无法加载，请检查地址、网络或媒体格式。</p> : null}
  </figure>;
}

export function AudioPlayer({ src, title, loop }: { src: string; title?: string | null; loop?: boolean | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  usePlayback(ref, false, src);
  useEffect(() => setFailed(false), [src]);
  const url = mediaHttpsUrl(src);
  return <figure className="jr-media jr-el">
    {title ? <figcaption>{title}</figcaption> : null}
    {url ? <audio ref={ref} aria-label={title || "音频播放器"} src={url} controls preload="none" loop={loop === true} onError={() => setFailed(true)} /> : null}
    {!url || failed ? <p role="status">音频无法加载，请检查地址、网络或媒体格式。</p> : null}
  </figure>;
}

export function SwipeFeed({ children, height, label }: { children?: ReactNode; height?: number | null; label?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; y: number; scroll: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as HTMLElement).closest("button,input,select,textarea,a,audio,iframe")) return;
    if (event.target instanceof HTMLVideoElement && event.clientY > event.target.getBoundingClientRect().bottom - 48) return;
    suppressClick.current = false;
    event.currentTarget.scrollTo({ top: event.currentTarget.scrollTop, behavior: "instant" });
    gesture.current = { pointer: event.pointerId, y: event.clientY, scroll: event.currentTarget.scrollTop, moved: false };
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null;
    if (current.moved) {
      suppressClick.current = true;
      const node = event.currentTarget;
      const delta = node.scrollTop - current.scroll;
      const start = Math.round(current.scroll / node.clientHeight);
      const page = Math.abs(delta) >= Math.min(80, node.clientHeight * 0.15) ? start + Math.sign(delta) : start;
      node.style.scrollSnapType = "";
      void node.offsetHeight;
      node.scrollTo({ top: page * node.clientHeight, behavior: "instant" });
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    }
  };
  return <div ref={ref} className="jr-swipe-feed jr-el" role="region" aria-label={label || "上下滑动翻页"} tabIndex={0} style={{ height: height || 480 }} onPointerDown={down} onPointerMove={(event) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    const delta = current.y - event.clientY;
    if (!current.moved && Math.abs(delta) < 8) return;
    current.moved = true;
    event.currentTarget.style.scrollSnapType = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.scrollTop = current.scroll + delta;
    event.preventDefault();
  }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={(event) => { gesture.current = null; event.currentTarget.style.scrollSnapType = ""; }} onClickCapture={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }} onKeyDown={(event) => {
    if (event.target !== event.currentTarget || !["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) return;
    event.preventDefault();
    event.currentTarget.scrollBy({ top: event.currentTarget.clientHeight * (["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1), behavior: "smooth" });
  }}>{Children.map(children, (child) => <section className="jr-swipe-page">{child}</section>)}</div>;
}

export function WebEmbed({ url: source, title, height, mode }: { url: string; title: string; height?: number | null; mode?: "iframe" | "browser" | null }) {
  const url = mediaHttpsUrl(source);
  const bridge = pcBridge()?.media;
  const native = mode === "browser";
  const [id] = useState(() => `media-${crypto.randomUUID()}`);
  const [started, setStarted] = useState(false);
  const [state, setState] = useState<PanelWebState | null>(null);
  const [error, setError] = useState("");
  const [frameVisible, setFrameVisible] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => { setStarted(false); setState(null); setError(""); }, [source, mode]);
  useEffect(() => {
    if (native || !started || !slot.current) return;
    let visible = false;
    const sync = () => setFrameVisible(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && entry.intersectionRatio >= 0.5; sync(); }, { threshold: [0, 0.5] });
    observer.observe(slot.current);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); setFrameVisible(false); };
  }, [native, started]);
  useEffect(() => {
    if (!native || !started || !bridge || !url) return;
    let disposed = false;
    let frame = 0;
    let intersecting = false;
    let last = "";
    const report = () => {
      frame = 0;
      const element = slot.current;
      if (disposed || !element) return;
      const rect = element.getBoundingClientRect();
      const modal = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')].some((node) => !node.contains(element) && (node as HTMLElement).getBoundingClientRect().height > 0);
      const visible = intersecting && !document.hidden && !modal && element.getClientRects().length > 0;
      const input = { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible };
      const key = JSON.stringify(input);
      if (key !== last) { last = key; void bridge.layout(input).catch((e) => { if (!disposed) setError(String(e.message)); }); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
    const stop = bridge.onState((next) => { if (!disposed && next.id === id) { setState(next); schedule(); } });
    void bridge.open({ id, url }).then((next) => { if (!disposed) { setState(next); schedule(); } }).catch((e) => { if (!disposed) setError(String(e.message)); });
    const resize = new ResizeObserver(schedule);
    const intersection = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting && entry.intersectionRatio >= 0.98; schedule(); }, { threshold: [0, 0.98, 1] });
    const mutation = new MutationObserver(schedule);
    if (slot.current) { resize.observe(slot.current); intersection.observe(slot.current); }
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-state"] });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => { disposed = true; stop(); resize.disconnect(); intersection.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("visibilitychange", schedule); void bridge.release(id).catch(() => {}); };
  }, [bridge, id, native, started, url]);
  const control = (action: "reload" | "mute" | "detach" | "dock") => void bridge?.control({ id, action }).then(setState).catch((e) => setError(String(e.message)));
  const unsupported = native && !bridge;
  const sameOrigin = Boolean(url && new URL(url).origin === location.origin);
  return <section className="jr-media jr-el" aria-label={title}>
    <div className="jr-media-toolbar"><span>{title}</span>{!started ? <button type="button" disabled={!url || unsupported || sameOrigin} onClick={() => setStarted(true)}>加载网页</button> : <>
      {native ? <><button type="button" onClick={() => control("mute")}>{state?.muted ? "开启声音" : "静音"}</button><button type="button" onClick={() => control(state?.detached ? "dock" : "detach")}>{state?.detached ? "放回面板" : "弹出小窗"}</button><button type="button" onClick={() => control("reload")}>刷新</button></> : null}
      <button type="button" onClick={() => setStarted(false)}>关闭网页</button>
    </>}</div>
    {!started ? <p className="jr-media-note">{unsupported ? "此网页模式需要支持媒体面板的 PC 客户端。" : sameOrigin ? "外部网页组件不能嵌入当前 ChisaBot 页面。" : url ? new URL(url).host : "网页地址必须使用 HTTPS。"}</p> : null}
    {started ? native ? <div ref={slot} className="jr-web-slot" style={{ height: height || 480 }}><p>{state?.detached ? "网页正在独立小窗中播放。" : state?.status === "loading" ? "正在加载网页…" : "网页随面板显示；可滚动页面或弹出小窗。"}</p></div> : <div ref={slot} style={{ height: height || 480 }}>{frameVisible ? <iframe title={title} src={url || undefined} height={height || 480} loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" allow="autoplay; fullscreen; picture-in-picture" referrerPolicy="no-referrer" allowFullScreen /> : null}</div> : null}
    {error || state?.error ? <p role="alert">{error || state?.error}</p> : null}
    {started && !native ? <p className="jr-media-note">网站可能禁止嵌入；此模式不解除网站限制。</p> : null}
  </section>;
}

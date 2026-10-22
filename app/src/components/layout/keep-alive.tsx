import { KeptHeldContext, KeptVisibleContext } from "@/lib/kept-visible";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 藏着的聊天留多久（之后卸载，回来走正常的打开：先画上次的样子，再接入）。 */
export const KEPT_TTL_MS = 10 * 60_000;

/**
 * 藏起来之后多久内「滚动位置钉住」（DESIGN.md §98.5）：离开那一刻浏览器会把藏着的滚动容器挪几十像素
 * （Chrome，1280 宽第一次去设置：设置页挂载时的强制布局，−68px，没有任何脚本改 scrollTop），回聊天位置就对不上。
 * 这段时间里藏着的容器一收到 scroll 就还原成离开前的位置；之后放开（藏着时贴底的回答照常往下走，§35 / §94）。
 */
export const KEPT_SCROLL_HOLD_MS = 1500;

export type KeptState = {
  /** 地址正停在留着的这一页上（或 `idleVisible`）。 */
  visible: boolean;
  /** 每次从藏着变回看得见时加一。 */
  epoch: number;
};

/** 一页占的「位置」：同一个 slot 就是同一个实例（换对话时复用位置 = 以前的行为，交给页面自己决定要不要重挂）。 */
type Slot<T> = { slot: number; kept: T };
type Pages<T> = { current: Slot<T> | null; held: Slot<T>[]; next: number };

/**
 * 主区里「留着的一页 + 当前路由」（DESIGN.md §98）。
 *
 * - `address` 不为 null（地址正是那一页，比如 `/channel/:id`）：留着的那页看得见，路由那一层不占位置
 *   （那条路由自己什么都不画）。`address` 换了（换了一段对话）就换成新的那页。
 * - `address` 为 null（别的页面）：路由那一层盖在上面（`absolute inset-0`，和主区一样的 flex 列），留着的那页
 *   藏在下面——不卸载，`visibility: hidden` + `inert` + `aria-hidden`，宽高冻在离开时的样子（右栏、横幅没了主区
 *   会变宽变高，不冻的话整段对话要重排，回来时滚动位置就对不上）。藏够 `ttlMs` 就卸载。
 * - `idleVisible`：地址不是那一页，但正在跳过去（`/` → 最近的对话），留着的那页先露着，不空一下。
 * - 换一段对话时，离开的那段**正在回答**（`working` 里有它的 `keyOf`，DESIGN.md §109）：不卸载，挪到「留着等它答完」
 *   的那几页里藏着（叠在主区里，不占位置），这一轮在浏览器里的工具、接力、看门狗照常跑；切回来还是同一个实例。
 *   答完（不在 `working` 里了）且没在看它，就放掉。不在回答的那段照旧：新对话复用它的位置。
 *
 * 路由那一层永远是同一个元素、只换样式，路由内容不会因为留没留着而重新挂载。
 */
export function KeepAliveStage<T>({
  address,
  idleVisible = false,
  same,
  keyOf,
  working,
  renderKept,
  ttlMs = KEPT_TTL_MS,
  children,
}: {
  address: T | null;
  /** 布尔，或按留着的那页判断（`/` 正跳向的正是它时才露着）。 */
  idleVisible?: boolean | ((kept: T) => boolean);
  same: (a: T, b: T) => boolean;
  /** 同一段对话的标识（地址里别的部分变了，比如打开设置窗格，还是同一页）。不给就不会留着正在回答的页。 */
  keyOf?: (kept: T) => string;
  /** 正在回答的那几页（`keyOf` 的值）：离开时留着，答完再放。 */
  working?: ReadonlySet<string>;
  renderKept: (kept: T, state: KeptState) => ReactNode;
  ttlMs?: number;
  children: ReactNode;
}) {
  const busy = (kept: T) => Boolean(keyOf && working?.has(keyOf(kept)));
  const sameKey = (a: T, b: T) => (keyOf ? keyOf(a) === keyOf(b) : same(a, b));

  const [pages, setPages] = useState<Pages<T>>(() => ({
    current: address === null ? null : { slot: 0, kept: address },
    held: [],
    next: 1,
  }));
  let view = pages;
  if (address !== null && (pages.current === null || !same(address, pages.current.kept))) {
    view = switchTo(pages, address, sameKey, busy);
    setPages(view);
  }
  const current = view.current;

  const idle = current !== null && (typeof idleVisible === "function" ? idleVisible(current.kept) : idleVisible);
  const shown = address !== null || idle;
  const visible = current !== null && shown;
  const currentBusy = current !== null && busy(current.kept);

  // 藏着的当前页：藏够 ttlMs 放掉；正在回答时不放（答完再从头计时）。
  useEffect(() => {
    if (visible || current === null || currentBusy) return;
    const timer = window.setTimeout(() => setPages((p) => (p.current === current ? { ...p, current: null } : p)), ttlMs);
    return () => window.clearTimeout(timer);
  }, [visible, current, currentBusy, ttlMs]);

  // 留着等它答完的那几页：答完就放。
  const heldKeys = view.held.map((page) => (keyOf ? keyOf(page.kept) : "")).join("\n");
  useEffect(() => {
    if (!heldKeys || !keyOf) return;
    setPages((p) => {
      const held = p.held.filter((page) => working?.has(keyOf(page.kept)));
      return held.length === p.held.length ? p : { ...p, held };
    });
  }, [heldKeys, working, keyOf]);

  // 按 slot 排：新的位置永远排在最后，已有的几页在 DOM 里不挪动（挪动节点会丢掉滚动位置）。
  const all = [...view.held.map((page) => ({ page, held: true })), ...(current ? [{ page: current, held: false }] : [])].sort(
    (a, b) => a.page.slot - b.page.slot,
  );

  return (
    <div className="keep-stage relative flex min-h-0 min-w-0 flex-1 flex-col" data-kept-visible={visible ? "true" : "false"}>
      {all.map(({ page, held }) => (
        <KeptPage held={held} key={page.slot} visible={!held && visible}>
          {(state) => renderKept(page.kept, state)}
        </KeptPage>
      ))}
      <div
        className={shown ? "route-layer contents" : "route-layer absolute inset-0 z-[1] flex min-h-0 min-w-0 flex-col"}
        data-testid="route-layer"
      >
        {children}
      </div>
    </div>
  );
}

/** 地址换到 `address`：当前页正在回答就挪去留着，否则让出位置；之前留着的那段就直接回到它自己的位置上。 */
function switchTo<T>(pages: Pages<T>, address: T, sameKey: (a: T, b: T) => boolean, busy: (kept: T) => boolean): Pages<T> {
  const outgoing = pages.current;
  // 同一段对话，只是地址里别的部分变了（设置窗格、`?watch`）：同一个位置。
  if (outgoing && sameKey(address, outgoing.kept)) return { ...pages, current: { slot: outgoing.slot, kept: address } };
  const back = pages.held.find((page) => sameKey(page.kept, address));
  const held = pages.held.filter((page) => page !== back);
  const keepOutgoing = outgoing !== null && busy(outgoing.kept);
  if (keepOutgoing) held.push(outgoing);
  if (back) return { ...pages, current: { slot: back.slot, kept: address }, held };
  if (outgoing && !keepOutgoing) return { ...pages, current: { slot: outgoing.slot, kept: address }, held };
  return { current: { slot: pages.next, kept: address }, held, next: pages.next + 1 };
}

/**
 * 留着的一页：看得见时一直记着尺寸和每个滚动容器的位置；藏起来那一刻用记下的尺寸冻住（§98.5）。
 * `held`（留着等它答完的别的对话）叠在主区里，不占位置。
 */
function KeptPage({ visible, held, children }: { visible: boolean; held: boolean; children: (state: KeptState) => ReactNode }) {
  const [epoch, setEpoch] = useState(0);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setEpoch((n) => n + 1);
  }

  // 看得见时一直记着尺寸；藏起来那一刻（同一次提交、新页面画出来之前）用记下的尺寸冻住。
  const box = useRef<HTMLDivElement>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) size.current = { width: rect.width, height: rect.height };
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // 看得见时记着每个滚动容器最后的位置；藏起来后 KEPT_SCROLL_HOLD_MS 内被挪了就还原（§98.5）。
  const tops = useRef(new WeakMap<Element, number>());
  useEffect(() => {
    const el = box.current;
    if (!el || !visible) return;
    const remember = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && el.contains(target)) tops.current.set(target, target.scrollTop);
    };
    el.addEventListener("scroll", remember, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", remember, { capture: true });
  }, [visible]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || visible) return;
    const hold = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !el.contains(target)) return;
      const saved = tops.current.get(target);
      if (saved !== undefined && Math.abs(target.scrollTop - saved) >= 1) target.scrollTop = saved;
    };
    el.addEventListener("scroll", hold, { capture: true, passive: true });
    const timer = window.setTimeout(() => el.removeEventListener("scroll", hold, { capture: true }), KEPT_SCROLL_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("scroll", hold, { capture: true });
    };
  }, [visible]);

  const frozen = visible ? null : size.current;
  const keptStyle: CSSProperties | undefined = visible
    ? undefined
    : {
        visibility: "hidden",
        pointerEvents: "none",
        ...(held
          ? { position: "absolute", top: 0, left: 0, ...(frozen ? { width: frozen.width, height: frozen.height } : { inset: 0 }) }
          : frozen
            ? { flex: "none", width: frozen.width, height: frozen.height }
            : {}),
      };

  return (
    <div
      aria-hidden={visible ? undefined : true}
      className="kept-chat flex min-h-0 min-w-0 flex-1 flex-col"
      data-held={held ? "true" : undefined}
      data-testid="kept-page"
      data-visible={visible ? "true" : "false"}
      inert={!visible}
      ref={box}
      style={keptStyle}
    >
      <KeptHeldContext.Provider value={held}>
        <KeptVisibleContext.Provider value={visible}>{children({ visible, epoch })}</KeptVisibleContext.Provider>
      </KeptHeldContext.Provider>
    </div>
  );
}

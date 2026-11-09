/**
 * 从网页 HTML 里取链接预览卡要的东西（标题、站点名、说明、预览图、图标），纯函数，能单测。
 *
 * 优先级：og:* → twitter:* → <title> / meta description；预览图 og:image(:secure_url) → twitter:image(:src)
 * → link rel=image_src；图标按 <link rel="icon" / "shortcut icon" / "apple-touch-icon"> 选最合适的一个，
 * 都没有就用 /favicon.ico。所有相对地址按页面地址（或 <base href>）补全，只保留 http / https。
 */

export type ParsedPage = {
  title: string;
  siteName: string;
  description: string;
  image: string | null;
  icons: string[];
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);?/g, (m, n) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#x([0-9a-f]+);?/gi, (m, n) => {
      const code = Number.parseInt(n, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(
      /&([a-z][a-z0-9]*|#39);/gi,
      (m, name) => ENTITIES[name.toLowerCase()] ?? m,
    );
}

function clean(text: string | undefined, max: number): string {
  if (!text) return "";
  const flat = decodeEntities(text)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 解析一个标签里的属性（不区分大小写，值可带单 / 双引号或不带引号）。 */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // 跳过标签名
  const body = tag.replace(/^<\s*[a-zA-Z]+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) {
    const key = (m[1] ?? "").toLowerCase();
    if (key && !(key in out)) out[key] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

export function resolveHttpUrl(
  raw: string | undefined,
  base: string,
): string | null {
  if (!raw) return null;
  const value = decodeEntities(raw.trim());
  if (!value || value.startsWith("data:") || value.startsWith("javascript:"))
    return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** 只看 <head>（没有就看前 256KB），预览需要的东西都在那里。 */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return end > 0 ? html.slice(0, end) : html.slice(0, 256 * 1024);
}

export function parsePage(html: string, pageUrl: string): ParsedPage {
  const head = headOf(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  const baseHref = /<base\b[^>]*>/i.exec(head)?.[0];
  const base =
    resolveHttpUrl(
      baseHref ? parseAttributes(baseHref).href : undefined,
      pageUrl,
    ) ?? pageUrl;

  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || "")
      .toLowerCase()
      .trim();
    const content = attrs.content;
    if (key && content?.trim() && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value?.trim()) return value;
    }
    return undefined;
  };

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const title = clean(
    first("og:title", "twitter:title") ?? titleTag ?? first("title", "name"),
    200,
  );
  const siteName = clean(
    first("og:site_name", "application-name", "apple-mobile-web-app-title"),
    80,
  );
  const description = clean(
    first("og:description", "twitter:description", "description"),
    300,
  );

  const links = (head.match(/<link\b[^>]*>/gi) ?? []).map(parseAttributes);
  const imageSrc = links.find((l) =>
    (l.rel ?? "").toLowerCase().split(/\s+/).includes("image_src"),
  )?.href;
  const image = resolveHttpUrl(
    first(
      "og:image:secure_url",
      "og:image",
      "og:image:url",
      "twitter:image",
      "twitter:image:src",
      "image",
    ) ?? imageSrc,
    base,
  );

  // 图标：普通 icon（优先 32px 左右的 png / ico）→ apple-touch-icon → /favicon.ico
  const scored: { href: string; score: number }[] = [];
  for (const link of links) {
    const rel = (link.rel ?? "").toLowerCase().split(/\s+/);
    const href = resolveHttpUrl(link.href, base);
    if (!href) continue;
    const type = (link.type ?? "").toLowerCase();
    const size = Number.parseInt(
      (link.sizes ?? "").split(/[x\s]/i)[0] ?? "",
      10,
    );
    let score = -1;
    if (rel.includes("icon")) score = 50;
    else if (
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed")
    )
      score = 30;
    else if (rel.includes("mask-icon")) score = 5;
    if (score < 0) continue;
    if (Number.isFinite(size))
      score += size >= 16 && size <= 96 ? 10 : size > 96 ? 4 : 0;
    if (type.includes("svg") || href.toLowerCase().endsWith(".svg")) score -= 8; // svg 能用，但位图更稳
    scored.push({ href, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const icons = [...new Set(scored.map((s) => s.href))].slice(0, 3);
  const fallbackIcon = resolveHttpUrl("/favicon.ico", base);
  if (fallbackIcon && !icons.includes(fallbackIcon)) icons.push(fallbackIcon);

  return { title, siteName, description, image, icons };
}

/** 响应头 / <meta charset> 里写的编码，认不出就 utf-8。 */
export function detectCharset(contentType: string, bytes: Uint8Array): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(sniff)?.[1] ?? null;
  return (fromMeta ?? "utf-8").toLowerCase();
}

export function decodeHtml(contentType: string, bytes: Uint8Array): string {
  const charset = detectCharset(contentType, bytes);
  const label = charset === "gb2312" ? "gbk" : charset;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** 预览卡上显示的域名：去掉 www.，中文域名转回汉字。 */
export function displayDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return url;
  }
}

import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { IconCode, IconEye, IconMaximize } from "@tabler/icons-react";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { renderMermaidToSvg } from "@/lib/chat/mermaid-lite";

type ParsedArtifactFence = {
  lang: "mermaid" | "svg" | "html";
  title: string;
  code: string;
  rawMarkdown: string;
};

export function parseArtifactFence(
  rawText: string,
): ParsedArtifactFence | null {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  let heading: string | undefined;
  let fenceStart = -1;
  let lang = "";
  let marker = "```";

  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? "").trim();
    if (!l) continue;
    const hm = /^#{1,6}\s+(.+)$/.exec(l);
    if (hm && fenceStart === -1) {
      heading = hm[1]?.trim();
      continue;
    }
    const fm = /^(```+|~~~+)\s*([^\s`]*)?/.exec(l);
    if (fm) {
      fenceStart = i;
      marker = fm[1] ?? "```";
      lang = (fm[2] ?? "").toLowerCase();
      break;
    }
    break;
  }

  if (fenceStart === -1) return null;
  if (lang !== "mermaid" && lang !== "svg" && lang !== "html") return null;

  const bodyLines = lines.slice(fenceStart + 1);
  if (bodyLines.length > 0) {
    const last = (bodyLines[bodyLines.length - 1] ?? "").trim();
    if (last.length >= marker.length && last.replace(/[`~]/g, "") === "") {
      bodyLines.pop();
    }
  }

  let title = heading;
  const firstBody = (bodyLines[0] ?? "").trim();
  const tm =
    /^(?:<!--\s*(?:标题|title)\s*[：:]\s*(.+?)\s*-->|(?:%%|\/\/)\s*(?:标题|title)\s*[：:]\s*(.+)|(?:标题|title)\s*[：:]\s*(.+))$/i.exec(
      firstBody,
    );
  if (tm) {
    title = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim().slice(0, 44);
    bodyLines.shift();
  }

  const code = bodyLines.join("\n").trim();
  if (!code) return null;

  // 对 html 代码块：只对包含实际 HTML 标签的片段启用微应用预览
  if (lang === "html" && !/<[a-z][\s\S]*>/i.test(code)) {
    return null;
  }

  const defaultTitle =
    lang === "mermaid"
      ? "架构与流程图"
      : lang === "svg"
        ? "SVG 矢量图"
        : "HTML 交互微应用";

  return {
    lang,
    title: title || defaultTitle,
    code,
    rawMarkdown: rawText,
  };
}

function buildHtmlSandboxDoc(code: string): string {
  if (/<html[\s>]/i.test(code)) return code;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: transparent;
    color: #e2e8f0;
    line-height: 1.5;
  }
</style>
</head>
<body>
${code}
</body>
</html>`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const XLINK_NS = "http://www.w3.org/1999/xlink";

/** 卡片内只允许引用文档内的片段（`#id`）。 */
const SVG_LOCAL_REF = /^#[\w.:-]*$/;

/** `<image>` / `<feImage>` 额外允许内嵌位图；data:image/svg+xml、外部地址一律不行。 */
const SVG_EMBEDDED_RASTER =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i;

const SVG_URL_ATTRS = new Set(["href", "xlink:href", "src"]);

/**
 * DOMPurify（SVG profile）的配置。DOMPurify 本身已经不放行 `<script>` / `<foreignObject>` /
 * `<animate>` / `<set>` 和所有 `on*` 属性；这里再显式列一遍，免得以后放宽 profile 时漏掉。
 * `<use>` 不在 DOMPurify 的 SVG 白名单里，单独放行，它的 href 由下面的钩子限制成 `#id`。
 */
const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["use"],
  // animateTransform / animateMotion 的取值。能改 href 的 <animate> / <set> 已经整个禁掉，这几个属性只影响变换和位移。
  ADD_ATTR: ["from", "to", "by"],
  FORBID_TAGS: [
    "script",
    "foreignObject",
    "iframe",
    "object",
    "embed",
    "animate",
    "set",
    "handler",
    "listener",
  ],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true as const,
};

type SvgPurifier = ReturnType<typeof DOMPurify>;

type SvgWindow = Window & typeof globalThis;

let svgPurifier: { win: SvgWindow; purifier: SvgPurifier } | null = null;

/** 每个 window 一个独立实例：钩子只挂在这个实例上，不影响别处（如 docx 预览）对 DOMPurify 的使用。 */
function getSvgPurifier(win: SvgWindow): SvgPurifier | null {
  if (svgPurifier?.win === win) return svgPurifier.purifier;
  const purifier = DOMPurify(win);
  if (!purifier.isSupported) return null;
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (!SVG_URL_ATTRS.has(data.attrName.toLowerCase())) return;
    const value = data.attrValue.trim();
    const tag = node.nodeName.toLowerCase();
    const allowed =
      SVG_LOCAL_REF.test(value) ||
      ((tag === "image" || tag === "feimage") &&
        SVG_EMBEDDED_RASTER.test(value));
    if (!allowed) data.keepAttr = false;
  });
  svgPurifier = { win, purifier };
  return purifier;
}

/**
 * 净化 ```svg 围栏里的 SVG（审查 S1）：交给 DOMPurify（SVG + SVG filters profile）按白名单清洗，
 * 再用 XMLSerializer 输出成合法的独立 SVG 文档。返回值只给 {@link svgMarkupToDataUrl} 当图片用，
 * 不再插进页面 DOM —— 即便以后白名单有漏洞，图片上下文里的 SVG 也不执行脚本、不加载外部资源、
 * 样式也漏不到主页面。
 *
 * 以前的正则清洗器只认前面带空白的 `on*` 属性，`<image/onerror=…>`、`<animate/onbegin=…>` 能原样通过。
 * 没有 DOM（DOMPurify 不可用）或清洗后根节点不是 `<svg>` 时返回 null，宁可不画也不放行。
 * `win` 只给测试传 jsdom 用（happy-dom 的 nodeName 让 DOMPurify 把所有元素都当成未知标签）。
 */
export function sanitizeSvgMarkup(
  raw: string,
  win: SvgWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): string | null {
  const m = /<svg[\s\S]*<\/svg>/i.exec(raw);
  if (!m || !win) return null;
  const purifier = getSvgPurifier(win);
  if (!purifier) return null;
  const fragment = purifier.sanitize(m[0], SVG_PURIFY_CONFIG);
  const root = fragment.firstElementChild;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== "svg")
    return null;
  let svg = new win.XMLSerializer().serializeToString(root);
  // 独立的 SVG 图片必须带命名空间声明，否则浏览器按 XML 解析失败、显示成破图。
  if (!/^<svg\b[^>]*\sxmlns="/.test(svg))
    svg = svg.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`);
  if (svg.includes("xlink:") && !/^<svg\b[^>]*\sxmlns:xlink="/.test(svg)) {
    svg = svg.replace(/^<svg\b/, `<svg xmlns:xlink="${XLINK_NS}"`);
  }
  return svg;
}

/**
 * Mermaid 卡片：本地 mermaid-lite 渲染出的 SVG 再过一遍同一个 purifier 才内联插入。
 * mermaid-lite 用 `<text>` 放标签（没有 foreignObject / htmlLabels），标签文字经过转义；
 * 这一遍是兜底，渲染器将来出漏洞也不会把节点标签里的 `<img onerror>`、`<script>` 带进页面。
 * 继续内联（不走 <img>），所以 `currentColor` / CSS 变量照常跟随主题。
 */
export function sanitizedMermaidSvg(
  code: string,
  win: SvgWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): string | null {
  const raw = renderMermaidToSvg(code);
  return raw ? sanitizeSvgMarkup(raw, win) : null;
}

/** 净化后的 SVG 转成 `<img>` 能用的 data URL（图片上下文：不跑脚本、不发请求、样式隔离）。 */
export function svgMarkupToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Mermaid / SVG / HTML 微应用内联渲染卡：
 * 支持「预览 / 源码」一键切换、点击放大弹窗交互。
 */
export function ArtifactCard({
  artifact,
  components,
}: {
  artifact: ParsedArtifactFence;
  components: Record<string, unknown>;
}) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [open, setOpen] = useState(false);

  const renderedSvg = useMemo(() => {
    if (artifact.lang === "mermaid") {
      return sanitizedMermaidSvg(artifact.code) ?? "";
    }
    return "";
  }, [artifact.lang, artifact.code]);

  const svgImageUrl = useMemo(() => {
    if (artifact.lang !== "svg") return "";
    const svg = sanitizeSvgMarkup(artifact.code);
    return svg ? svgMarkupToDataUrl(svg) : "";
  }, [artifact.lang, artifact.code]);

  const htmlDoc = useMemo(
    () => (artifact.lang === "html" ? buildHtmlSandboxDoc(artifact.code) : ""),
    [artifact.lang, artifact.code],
  );

  const badgeLabel =
    artifact.lang === "mermaid"
      ? "MERMAID"
      : artifact.lang === "svg"
        ? "SVG"
        : "HTML APP";

  const renderPreview = (inModal = false) => {
    if (artifact.lang === "html") {
      return (
        <iframe
          className={
            inModal
              ? "chat-artifact-iframe chat-artifact-iframe-modal"
              : "chat-artifact-iframe"
          }
          data-testid="artifact-html-preview"
          sandbox="allow-scripts"
          srcDoc={htmlDoc}
          title={artifact.title}
        />
      );
    }
    if (svgImageUrl) {
      // 用户 / 模型给的 SVG 只当图片显示，不进主页面 DOM（审查 S1）。
      return (
        <div
          className={
            inModal
              ? "chat-artifact-svg chat-artifact-svg-modal"
              : "chat-artifact-svg"
          }
          data-testid="artifact-svg-preview"
        >
          <img
            alt={artifact.title}
            data-testid="artifact-svg-image"
            decoding="async"
            draggable={false}
            src={svgImageUrl}
            style={{ maxWidth: "100%", height: "auto" }}
          />
        </div>
      );
    }
    if (renderedSvg) {
      return (
        <div
          className={
            inModal
              ? "chat-artifact-svg chat-artifact-svg-modal"
              : "chat-artifact-svg"
          }
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid 矢量预览：本地渲染器输出且已过 DOMPurify（sanitizedMermaidSvg）；用户 SVG 走上面的 <img>
          dangerouslySetInnerHTML={{ __html: renderedSvg }}
          data-testid="artifact-svg-preview"
        />
      );
    }
    return (
      <div className="chat-doc-inner p-3">
        <SmoothStreamdown components={components as never}>
          {artifact.rawMarkdown}
        </SmoothStreamdown>
      </div>
    );
  };

  return (
    <>
      <section
        aria-label={`${artifact.title} (${badgeLabel})`}
        className="chat-draft-card chat-doc-card chat-artifact-card"
        data-artifact-lang={artifact.lang}
        data-cb-bubble="code"
        data-testid="chat-artifact-card"
      >
        <header className="chat-artifact-head">
          <div className="chat-artifact-head-main">
            <span className="chat-artifact-badge">{badgeLabel}</span>
            <span className="chat-artifact-title">{artifact.title}</span>
          </div>
          <div className="chat-artifact-actions">
            <div className="chat-artifact-tabs" role="tablist">
              <button
                aria-selected={tab === "preview"}
                className="chat-artifact-tab"
                data-active={tab === "preview" || undefined}
                data-testid="artifact-tab-preview"
                onClick={() => setTab("preview")}
                role="tab"
                type="button"
              >
                <IconEye aria-hidden="true" className="size-3.5" />
                <span>{"预览"}</span>
              </button>
              <button
                aria-selected={tab === "code"}
                className="chat-artifact-tab"
                data-active={tab === "code" || undefined}
                data-testid="artifact-tab-code"
                onClick={() => setTab("code")}
                role="tab"
                type="button"
              >
                <IconCode aria-hidden="true" className="size-3.5" />
                <span>{"源码"}</span>
              </button>
            </div>

            <CopyButton
              className="chat-draft-copy"
              size="sm"
              value={artifact.code}
              variant="ghost"
            >
              {"复制"}
            </CopyButton>
            <button
              aria-label="全屏查看"
              className="chat-card-followup-btn"
              data-testid="artifact-expand-btn"
              onClick={() => setOpen(true)}
              title="放大查看"
              type="button"
            >
              <IconMaximize aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </header>
        <div className="chat-doc-inset chat-artifact-inset">
          {tab === "preview" ? (
            renderPreview(false)
          ) : (
            <div className="chat-doc-inner p-3">
              <SmoothStreamdown components={components as never}>
                {artifact.rawMarkdown}
              </SmoothStreamdown>
            </div>
          )}
        </div>
      </section>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="chat-doc-dialog">
          <DialogHeader className="chat-doc-dialog-head">
            <div className="chat-doc-dialog-title-wrap">
              <span className="chat-artifact-badge">{badgeLabel}</span>
              <DialogTitle className="truncate">{artifact.title}</DialogTitle>
            </div>
            <div className="mr-7 flex items-center gap-1.5">
              <CopyButton
                className="chat-draft-copy"
                size="sm"
                value={artifact.code}
                variant="ghost"
              >
                {"复制"}
              </CopyButton>
            </div>
          </DialogHeader>
          <div className="chat-doc-dialog-body">{renderPreview(true)}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

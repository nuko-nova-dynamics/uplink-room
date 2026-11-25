import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "./blockquote.css";
import frameStyle from "./chat/html-frame.css?inline";

/**
 * The message renderer, used for channel messages and project files.
 *
 *  - Markdown is parsed with `marked` and sanitized with DOMPurify before it
 *    goes into the page, so a posted message can't run script in the app.
 *  - HTML runs in an iframe from a separate origin (`uplink-frame://sandbox`,
 *    served by the main process) with `sandbox="allow-scripts"` and no
 *    `allow-same-origin`. The page can run its own scripts but gets an opaque
 *    origin: it can't read the app's localStorage, IndexedDB or cookies, or
 *    reach the parent window. It is the same frame chosen for MCP Apps.
 */

export const FRAME_URL = "uplink-frame://sandbox/frame.html";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Markdown renders in the app's own page, so raw HTML inside it must not be able to
 * restyle or cover the app (the CSP allows inline styles). No `<style>` elements, and no
 * `style`, `class` or `id` attributes: the first two position a message over the app or
 * borrow the app's own classes (`.overlay`, `.toasts`, `.dialog`), and an `id` can collide with
 * the page's. Posted HTML pages that need styling go in the sandboxed frame instead.
 */
const MARKDOWN_PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style"],
  FORBID_ATTR: ["style", "class", "id"],
};

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, MARKDOWN_PURIFY);
}

/**
 * How a message names its mentions (spec #63): each member's name, who is reading, and the
 * channels a `#name` in the text can open (lower-case name to channel id).
 */
export type MentionNames = {
  nameOf: (memberId: string) => string | undefined;
  /** A live run's name, such as Claude Code (Julio), for a `<@run:runId>` token (ADR 0026). */
  runName?: ((runId: string) => string | undefined) | undefined;
  me: string;
  channels?: Map<string, string> | undefined;
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * Mentions in rendered, sanitized HTML: a `<@memberId>` token (which Markdown left as escaped text)
 * becomes `@Name`, a `<@run:runId>` token a button with the run's name that opens it, and
 * `@everyone` is marked too. Names are escaped, so this adds no markup of a
 * member's choosing; the mark carries only a data attribute the app's CSS styles.
 */
export function markMentions(html: string, names: MentionNames): string {
  return html
    .replace(/&lt;@run:([0-9a-z]{8,64})&gt;/g, (whole, id: string) => {
      // A run is opened from its mention, so it is a button; it looks like a member's mention.
      const name = names.runName?.(id);
      if (!name) return whole;
      return `<button type="button" data-mention="run" data-run="${id}">@${escapeHtml(name)}</button>`;
    })
    .replace(/&lt;@([0-9a-z]{8,64})&gt;/g, (whole, id: string) => {
      const name = names.nameOf(id);
      if (!name) return whole;
      return `<mark data-mention="${id === names.me ? "me" : "member"}">@${escapeHtml(name)}</mark>`;
    })
    .replace(/(^|[\s>(])@everyone\b/g, '$1<mark data-mention="everyone">@everyone</mark>');
}

const SKIP_REFS = new Set(["A", "CODE", "PRE", "MARK", "BUTTON"]);

/**
 * The chat's own touches on rendered, sanitized HTML, done on its DOM rather than its text so
 * nothing lands inside an attribute or a link: `#name` of a channel you can open becomes a button
 * (outside links and code), each code block gets a Copy button, and an edited message ends with
 * "(edited)". Everything added is the app's own markup with text set as text.
 */
export function decorate(
  html: string,
  opts: {
    channels?: Map<string, string> | undefined;
    editedAt?: number | undefined;
    wrapLongWords?: boolean | undefined;
  },
): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  const root = t.content;
  if (opts.channels?.size) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const text of texts) {
      let skip = false;
      for (let el = text.parentElement; el; el = el.parentElement)
        if (SKIP_REFS.has(el.tagName)) skip = true;
      if (skip || !text.data.includes("#")) continue;
      const parts = text.data.split(/(?<![\p{L}\p{N}_#&/])#([\p{L}\p{N}_-]+)/u);
      if (parts.length === 1) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((part, i) => {
        if (i % 2 === 0) return part && frag.append(part);
        const id = opts.channels!.get(part.toLowerCase());
        if (!id) return frag.append(`#${part}`);
        const ref = document.createElement("button");
        ref.type = "button";
        ref.className = "channel-ref";
        ref.dataset["channel"] = id;
        ref.textContent = `#${part}`;
        frag.append(ref);
      });
      text.replaceWith(frag);
    }
  }
  if (opts.wrapLongWords) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    for (const text of texts) {
      if (!text.parentElement?.closest("p") || text.parentElement.closest("a, code, pre")) continue;
      const parts = text.data.split(/([a-zA-Z0-9]{24,})/);
      if (parts.length === 1) continue;
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        if (index % 2 === 0) fragment.append(part);
        else {
          const word = document.createElement("span");
          word.className = "breakable-word";
          word.textContent = part;
          fragment.append(word);
        }
      });
      text.replaceWith(fragment);
    }
  }
  for (const pre of root.querySelectorAll("pre")) {
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(pre);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = "Copy";
    block.append(copy);
  }
  if (opts.editedAt !== undefined) {
    const mark = document.createElement("span");
    mark.className = "edited-mark";
    mark.title = `Edited ${new Date(opts.editedAt).toLocaleString()}`;
    mark.textContent = "(edited)";
    const last = root.lastElementChild;
    if (last && last.tagName === "P") last.append(" ", mark);
    else root.append(mark);
  }
  return t.innerHTML;
}

export function Markdown({
  source,
  mentions,
  editedAt,
  onChannel,
  onRun,
  wrapLongWords = false,
}: {
  source: string;
  /** Allow long prose identifiers to wrap without changing their text or copy value. */
  wrapLongWords?: boolean;
  mentions?: MentionNames | undefined;
  editedAt?: number | undefined;
  onChannel?: ((channelId: string) => void) | undefined;
  onRun?: ((runId: string) => void) | undefined;
}) {
  // Whether to link channels, not the handler itself, so a new handler each render doesn't re-parse.
  const linkChannels = onChannel !== undefined;
  const html = useMemo(() => {
    const clean = renderMarkdown(source);
    const marked = mentions ? markMentions(clean, mentions) : clean;
    return decorate(marked, {
      channels: linkChannels ? mentions?.channels : undefined,
      editedAt,
      wrapLongWords,
    });
  }, [source, mentions, editedAt, linkChannels, wrapLongWords]);
  // The HTML above is sanitized by DOMPurify; markMentions adds only escaped names, and decorate
  // only the app's own elements with text content.
  return (
    <div
      className="md"
      // Delegates native button/link clicks, including keyboard activation, from sanitized HTML.
      role="presentation"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const ref = target.closest<HTMLElement>("[data-channel]");
        if (ref && onChannel) return onChannel(ref.dataset["channel"]!);
        const run = target.closest<HTMLElement>("[data-run]");
        if (run && onRun) return onRun(run.dataset["run"]!);
        const copy = target.closest(".code-copy");
        if (copy) {
          const code = copy.parentElement?.querySelector("pre")?.textContent ?? "";
          void navigator.clipboard.writeText(code).then(() => {
            copy.textContent = "Copied";
            setTimeout(() => (copy.textContent = "Copy"), 1500);
          });
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function HtmlFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [theme, setTheme] = useState(document.documentElement.dataset["theme"]);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset["theme"]),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own window counts, whatever it claims to be.
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { source?: string; type?: string; height?: number } | null;
      if (!data || data.source !== "uplink-frame") return;
      if (data.type === "ready") {
        // A sandboxed frame has an opaque origin, so the target origin can only be "*".
        // The page's HTML is what we are handing it, and the frame checks who is sending.
        const tokens = getComputedStyle(document.documentElement);
        const defaults = `:root { color-scheme: ${theme === "light" ? "light" : "dark"}; --frame-ground: ${tokens.getPropertyValue("--ground")}; --frame-text: ${tokens.getPropertyValue("--text")}; --frame-line: ${tokens.getPropertyValue("--muted")}; }`;
        const style = `<style>${defaults}${frameStyle}</style>`;
        // Preserve an authored doctype and let the page's own styles override these defaults.
        const themed = /<head\b[^>]*>/i.test(html)
          ? html.replace(/<head\b[^>]*>/i, (head) => head + style)
          : /<!doctype\b[^>]*>/i.test(html)
            ? html.replace(/<!doctype\b[^>]*>/i, (doctype) => doctype + style)
            : style + html;
        iframe.contentWindow?.postMessage(
          { source: "uplink-room", type: "render", html: themed },
          "*",
        );
      } else if (data.type === "height" && typeof data.height === "number") {
        // The reported height is the inner document. The iframe's two hairlines are outside it.
        setHeight(Math.min(720, Math.max(40, data.height)) + 2);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html, theme]);

  return (
    <iframe
      key={theme}
      ref={frame}
      className="html-frame"
      title={title}
      src={FRAME_URL}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height }}
    />
  );
}

export function MessageBody({
  format,
  body,
  title,
  mentions,
  editedAt,
  onChannel,
  onRun,
}: {
  format: "markdown" | "html";
  body: string;
  title: string;
  mentions?: MentionNames | undefined;
  /** When it was last edited: Markdown ends with "(edited)". */
  editedAt?: number | undefined;
  /** Opens a channel a `#name` in the text points at. */
  onChannel?: ((channelId: string) => void) | undefined;
  /** Opens a run a `<@run:runId>` mention names. */
  onRun?: ((runId: string) => void) | undefined;
}) {
  return format === "html" ? (
    <HtmlFrame html={body} title={title} />
  ) : (
    <Markdown
      source={body}
      mentions={mentions}
      editedAt={editedAt}
      onChannel={onChannel}
      onRun={onRun}
    />
  );
}

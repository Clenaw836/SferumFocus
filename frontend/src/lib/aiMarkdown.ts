import { Marked } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";
import { cleanAiText } from "./aiText";

/** v3.2 · PERF-01: стили и шрифты KaTeX — отдельный файл (<meta name="sf-katex">), подключаются при первом ответе ИИ. */
function ensureKatexCss(): void {
  if (typeof document === "undefined") return;
  const href = document.querySelector('meta[name="sf-katex"]')?.getAttribute("content");
  if (!href || !href.startsWith("/assets/") || document.querySelector("link[data-katex]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = href; link.setAttribute("data-katex", "");
  document.head.appendChild(link);
}
ensureKatexCss();

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));

function formula(text: string, displayMode: boolean): string {
  const rendered = katex.renderToString(text.trim(), {
    displayMode, throwOnError: false, trust: false,
    output: "htmlAndMathml", maxExpand: 1000, maxSize: 20,
    errorColor: "var(--bad)",
  });
  // Display math can be reached by keyboard when horizontal scrolling is needed.
  return displayMode
    ? `<span class="ai-math-block l-blk mw-full" role="region" aria-label="Математическая формула" tabindex="0">${rendered}</span>`
    : `<span class="ai-math-inline mw-full">${rendered}</span>`;
}

// One parser instance; no whole-document scanning and no post-render DOM mutation.
const markdown = new Marked({ gfm: true, breaks: true, async: false });
markdown.use({
  renderer: {
    // Never accept model-authored HTML/CSS. Keep it readable as source text.
    html: token => escapeHtml(token.text),
    // AI images must not cause automatic requests to third-party tracking URLs.
    image: token => escapeHtml(token.text),
  },
  extensions: [
    {
      name: "aiMathBlock", level: "block",
      start(source) {
        const index = source.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/);
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(source);
        if (m) return { type: "aiMathBlock", raw: m[0], text: m[1] ?? m[2] };
      },
      renderer: token => formula(String(token.text), true) + "\n",
    },
    {
      name: "aiMathInline", level: "inline",
      start(source) {
        const index = source.search(/\$|\\\(|\\\[/);
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        const display = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/.exec(source);
        if (display) return { type: "aiMathInline", raw: display[0], text: display[1] ?? display[2], displayMode: true };
        const inline = /^(?:\\\(([\s\S]+?)\\\)|\$(?!\$)((?:\\.|[^$\\\n])+?)\$(?!\$))/.exec(source);
        if (inline) return { type: "aiMathInline", raw: inline[0], text: inline[1] ?? inline[2], displayMode: false };
      },
      renderer: token => formula(String(token.text), token.displayMode === true),
    },
  ],
});

export function aiAnswerHtml(text: string, inline = false): string {
  const source = cleanAiText(text);
  const html = inline ? markdown.parseInline(source, { async: false }) : markdown.parse(source, { async: false });
  // MathML and KaTeX-generated SVG radicals are retained; scripts/unsafe URLs are not.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_TAGS: ["semantics", "annotation"],
    ADD_ATTR: ["encoding"],
    FORBID_TAGS: ["script", "style", "iframe", "img", "form", "input", "button", "video", "audio"],
    FORBID_ATTR: ["id", "name"],
  });
}

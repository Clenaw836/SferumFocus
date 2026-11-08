import { useEffect, useMemo, useState } from "preact/hooks";
import { cleanAiText } from "../lib/aiText";

type Md = typeof import("../lib/aiMarkdown");
let md: Md | null = null;
let loading: Promise<Md> | null = null;
/** v3.2 · PERF-01: Markdown + KaTeX + DOMPurify (~340 КБ) — отдельный чанк, грузится при первом ответе ИИ. */
export const loadAiMarkdown = (): Promise<Md> => (loading ??= import("../lib/aiMarkdown").then(m => (md = m)));

/** AI text only; user drafts stay ordinary escaped Preact text. Until the renderer arrives — the same text, plain. */
export function AiAnswer({ text, inline = false }: { text: string; inline?: boolean }) {
  const [ready, setReady] = useState(!!md);
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadAiMarkdown().then(() => { if (live) setReady(true); }, () => { /* офлайн: остаётся обычный текст */ });
    return () => { live = false; };
  }, [ready]);
  const html = useMemo(() => (ready && md ? md.aiAnswerHtml(text, inline) : null), [text, inline, ready]);
  if (html === null) {
    const plain = cleanAiText(text);
    return inline
      ? <span class="ai-answer f-b mw-full ai-answer-inline">{plain}</span>
      : <div class="ai-answer f-b mw-full">{plain.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>;
  }
  return inline
    ? <span class="ai-answer f-b mw-full ai-answer-inline" dangerouslySetInnerHTML={{ __html: html }} />
    : <div class="ai-answer f-b mw-full" dangerouslySetInnerHTML={{ __html: html }} />;
}

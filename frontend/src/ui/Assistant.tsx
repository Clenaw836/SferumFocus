/**
 * Школьный помощник на главной: не чат, а строка действия.
 * Подсказка (максимум одна) + ответ на фразу ученика: коротко, одна причина «почему», быстрые варианты.
 * Голос — там, где сказать быстрее: «я опоздаю на 30», «завтра футбол в 18». Распознанный текст видно и можно поправить.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { VoiceCapture } from "./VoiceCapture";
import type { Act, Reply } from "../lib/assistant";

export function ReplyCard({ r, onAct, onClose }: { r: Reply; onAct: (a: Act) => void; onClose?: () => void }) {
  return (
    <div class={`as-card${r.tone ? ` t-${r.tone}` : ""}`} role="status" aria-live="polite">
      {r.heard && <p class="as-heard f-b f-3 mb-1"><span class="sr">Ты: </span>«{r.heard}»</p>}
      <div class="as-body l-h">
                <div class="as-text l-grow">
          {r.strong && <b class="as-strong l-blk f-b f-w6 f-warn mb-1">{r.strong}</b>}
          {r.lines.map((l, i) => (l === "" ? <span key={i} class="as-gap" aria-hidden="true" /> : <p key={i}>{l}</p>))}
          {r.why && <p class="as-why f-b f-3 mt-1"><span class="f-2">Почему:</span> {r.why}</p>}
        </div>
        {onClose && <button class="icon-btn as-x" onClick={onClose} aria-label="Скрыть ответ"><Icon name="x" /></button>}
      </div>
      {r.chips && r.chips.length > 0 && (
        <div class="chips" role="group" aria-label="Варианты">
          {r.chips.map((c) => <button key={c.label} type="button" class={`chip${c.primary ? " chip-primary" : ""}`} onClick={() => onAct(c.act)}>{c.label}</button>)}
        </div>
      )}
    </div>
  );
}

export function Assistant({ reply, onSay, onAct, onClose, serverStt, voiceSignal }: {
  reply: Reply | null; onSay: (text: string) => void; onAct: (a: Act) => void; onClose: () => void; serverStt: boolean; voiceSignal?: number;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (voiceSignal) ref.current?.focus(); }, [voiceSignal]);
  const send = (t = text) => { const v = t.trim(); if (!v) return; onSay(v); setText(""); };
  return (
    <section class="assistant mt-6" aria-labelledby="as-h">
      <h2 id="as-h" class="eyebrow">Помощник</h2>
      {reply && <ReplyCard r={reply} onAct={onAct} onClose={onClose} />}
      <form class="as-input p-1 l-h l-g1 b-box" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input ref={ref} class="input" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} enterKeyHint="send"
          placeholder="Что изменилось? «опоздаю на 30»" aria-label="Скажи помощнику, что произошло" />
        <VoiceCapture compact label="Сказать голосом" serverStt={serverStt} onText={(t) => setText(t)} />
        <button class="btn btn-primary vc-mic l-center l-g0 b-tap mw-44 r-lg" type="submit" aria-label="Отправить" disabled={!text.trim()}><Icon name="send" /></button>
      </form>
      {!reply && (
        <div class="chips as-quick mt-2" role="group" aria-label="Быстрые вопросы">
          {["Что мне сейчас делать?", "Я не успеваю", "Что завтра?", "Что изменилось?"].map((q) => <button key={q} type="button" class="chip" onClick={() => send(q)}>{q}</button>)}
        </div>
      )}
    </section>
  );
}

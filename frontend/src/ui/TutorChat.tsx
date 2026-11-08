import {TutorPending} from './TutorPending';
import {CameraCapture} from "./CameraCapture";
import { DraftCheck } from "./DraftCheck";
import {closingGuard} from "../lib/host";
import { AiAnswer } from "./AiAnswer";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { api, ApiError, cache, fileToBase64 } from "../lib/api";
import { schoolDay } from "../lib/day";
import { taskId } from "../lib/host";

import { purgeTutorCache, tutorSession, type TutorMsg as Msg } from "../lib/tutorSession";
import type { SocraticGuide } from "../engine/guide";
const LIMIT = 12; // реплик в контексте — столько же уходит на сервер (api.hint режет до 12)
const GENERAL = "general";
const STEPS = ["Задача", "Твоя мысль", "Подсказка", "Следующий шаг"];

/** Единственная реализация репетитора: шторка задания и вкладка «Репетитор» используют её же.
 *  История — на учебный день и задание (переживает закрытие шторки и перезапуск), не дольше. */
/** Одна и та же причина деградации ИИ не повторяется в каждом ответе: плашка — только когда причина сменилась. */
function prevNotice(msgs: readonly Msg[], i: number): string | null | undefined {
  for (let j = i - 1; j >= 0; j--) if (msgs[j].role === "assistant") return msgs[j].notice;
  return undefined;
}
/** v2.1: план по предмету в автономном режиме показывается один раз на серию одинаковых (как и плашка notice). */
function prevGuide(msgs: readonly Msg[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) if (msgs[j].role === "assistant") return msgs[j].guide?.title;
  return undefined;
}
/** Автономный «план метода» (status=degraded_gracefully): шаги алгоритма, которые ученик делает сам, — не ответ. */
function GuideCard({ guide }: { guide: SocraticGuide }) {
  return <details class="tu-guide f-b f-2 b-box mt-2 mb-1" open>
    <summary><Icon name="route" /><span>{guide.title}</span></summary>
    <ol>{guide.steps.map((s) => <li key={s}>{s}</li>)}</ol>
    <p class="tu-guide-note f-m f-3 mt-1 mb-3">Пройди шаги сам и напиши, на каком застрял, — подскажу следующий вопрос.</p>
  </details>;
}
/** Поле растёт с текстом (для WebView без CSS field-sizing), без ручки изменения размера. */
const MAX_COMPOSER_PX = 168;
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
}
export function TutorChat({ context, examples = ["С чего начать?", "Не понимаю условие", "Проверь мой ход"] }: { context: string | null; examples?: string[] }) {
  const id = taskId(context || GENERAL);
  const k = `sf.tutor.${schoolDay()}.${id}`;
  // Full context avoids mixing drafts if legacy taskId hashes collide.
  const sessionKey = `${schoolDay()}|${context || GENERAL}`;
  const [, redraw] = useState(0);
  useEffect(() => { purgeTutorCache(schoolDay()); }, []);   // context lives one school day
  const state = tutorSession.get(sessionKey, () => cache.get<Msg[]>(k) ?? []);
  const { msgs, draft: q, photo } = state;
  const busy = state.pending !== null;
  const setQ = (value: string) => tutorSession.edit(sessionKey, value);
  const setPhoto = (value: { base64: string; name: string } | null) => tutorSession.attach(sessionKey, value);
  const [camera,setCamera] = useState(false);
  useEffect(() => {
    closingGuard(!!q || !!photo || busy, `tutor-draft-${id}`);
    return () => closingGuard(false, `tutor-draft-${id}`);
  }, [q,photo,busy,id]);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => tutorSession.subscribe(() => redraw(n => n + 1)), [sessionKey]);
  useEffect(() => { logRef.current?.lastElementChild?.scrollIntoView?.({ block: "nearest" }); }, [msgs.length, busy]);
  const send = async (e?: Event) => {
    e?.preventDefault();
    // Synchronous single-flight claim also covers two submits in the same render.
    const attempt = tutorSession.begin(sessionKey);
    if (!attempt) return;
    const { token, before, next, text, photo: attachment } = attempt;
    try {
      const r = await api.hint(context || "Домашнее задание (предмет не выбран)", text, before.slice(-LIMIT).map(({ role, content }) => ({ role, content })), attachment?.base64);
      const guide = r.status === "degraded_gracefully" ? r.guide ?? null : null;
      const result: Msg[] = [...next, { role: "assistant", content: r.hint, notice: r.notice, ...(guide ? { guide } : {}) }];
      if (!tutorSession.finish(sessionKey, token, result)) return;
      cache.set(k, result.slice(-LIMIT * 2));
    } catch (err) {
      if (tutorSession.fail(sessionKey, token, before, text, attachment))
        toast(err instanceof ApiError ? err.message : "Подсказка не пришла", "bad");
    }
  };
  const pick = async (f?: File | null) => {
    if (!f) return;
    const epoch = tutorSession.epoch;
    try { const r = await fileToBase64(f, 1280); if (tutorSession.epoch === epoch) setPhoto({ base64: r.base64, name: f.name || "фото" }); }
    catch { toast("Не получилось прочитать фото", "bad"); }
  };
  const inputId = `tq-${id}`;
  const ai = msgs.filter((m) => m.role === "assistant").length;
  const step = busy ? 2 : ai === 0 ? 1 : msgs[msgs.length - 1]?.role === "assistant" ? 3 : 2;
  return (
    <div class="tutor l-v l-g0 mt-6">
      {/* Метод, а не чат: ЗАДАЧА → ТВОЯ МЫСЛЬ → ПОДСКАЗКА → СЛЕДУЮЩИЙ ШАГ. Шаг виден всегда. */}
      <details class="tutor-method f-b f-3 mb-3"><summary>Как помогает тьютор</summary><ol class="tu-steps l-c4 f-m f-3 f-num mt-1 mb-3" aria-label="Как работает тьютор">
        {STEPS.map((x, i) => <li key={x} class={i < step ? "on" : i === step ? "now" : ""} aria-current={i === step ? "step" : undefined}><i aria-hidden="true" />{x}</li>)}
      </ol></details>
      {msgs.length === 0 && !busy && <p class="tu-empty f-b f-2 b-card mb-4 l-self-s">Напиши, что уже попробовал и где застрял. Я не решаю за тебя — задам один наводящий вопрос. Можно прислать фото решения.</p>}
      <div class="chat l-v l-g3 tu-log l-g4 b-tap mb-3 l-grow" role="log" aria-live="polite" aria-label="Диалог с тьютором" ref={logRef}>
        {msgs.map((m, i) => (
          <div key={i} class={`turn f-b b-card l-rel ${m.role === "user" ? "me" : "ai"}`}>
            <span class="turn-k l-blk f-c f-w6 f-a mb-2">{m.role === "user" ? "Ты" : `Подсказка ${msgs.slice(0, i + 1).filter((x) => x.role === "assistant").length}`}</span>
            {m.notice && m.notice !== prevNotice(msgs, i) && <p class="tu-notice p-2 l-h l-top f-b f-2 mt-1 mb-2 u-warn r-md" role="note"><Icon name="info" /><span>{m.notice}</span></p>}
            {m.role === "assistant" ? <AiAnswer text={m.content} /> : <p>{m.photo && <Icon name="image" label="с фото" />} {m.content}</p>}
            {m.guide && m.guide.title !== prevGuide(msgs, i) && <GuideCard guide={m.guide} />}
          </div>
        ))}
        {busy && <TutorPending photo={!!msgs[msgs.length - 1]?.photo}/>}
      </div>
      {/* Композер — паттерн 21st.dev «Attachment Composer Tray» (sean0205, id 28500): вложение-чип с превью
          и «×» внутри одной рамки с полем; адаптация — одно фото, камера слева, отправка справа, без Tailwind. */}
      {camera && <CameraCapture onClose={() => setCamera(false)} onPhoto={(f) => void pick(f)} />}
      <form class={`composer${photo ? " has-att" : ""}`} onSubmit={send}>
        {photo && (
          <div class="composer-att">
            <img src={`data:image/jpeg;base64,${photo.base64}`} alt="" width={36} height={36} />
            <span>{photo.name}</span>
            <button type="button" class="icon-btn" onClick={() => setPhoto(null)} aria-label="Убрать фото"><Icon name="x" /></button>
          </div>
        )}
        <div class="composer-row">
          <label class="sr" for={inputId}>Вопрос репетитору</label>
          <button type="button" class="icon-btn composer-cam" onClick={() => fileRef.current?.click()} aria-label="Прикрепить фото решения" disabled={busy}><Icon name="image" /></button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const el = e.target as HTMLInputElement; void pick(el.files?.[0]); el.value = ""; }} />
          <textarea id={inputId} class="composer-in" rows={2} value={q} onInput={(e) => { const el = e.target as HTMLTextAreaElement; setQ(el.value); autoGrow(el); }} placeholder={photo ? "Что проверить на фото?" : ai ? "Твой следующий шаг…" : "Что попробовал, где застрял?"} maxLength={500} autoComplete="off" aria-describedby={`${inputId}-help`} aria-keyshortcuts="Control+Enter Meta+Enter" onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
              e.preventDefault(); void send();
            }
          }} />
          <button class="composer-send" disabled={(!q.trim() && !photo) || busy} aria-label="Отправить"><Icon name="send" /></button>
        </div>
      </form>
      {photo && !busy && <DraftCheck key={photo.base64.slice(-32)} photo={photo} onAsk={(text) => { setQ(text.slice(0, 500)); requestAnimationFrame(() => { const el = document.getElementById(inputId) as HTMLTextAreaElement | null; if (el) { autoGrow(el); el.focus(); } }); }} />}
      <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCamera(true)}><Icon name="camera" />Снять фото решения</button>
      <p class="composer-help" id={`${inputId}-help`}>Enter — новая строка. Отправить — кнопкой или Ctrl / ⌘ + Enter.</p>
      {msgs.length === 0 && (
        <div class="examples l-h l-wrap mt-2">
          {examples.map((x) => <button key={x} type="button" class="example f-m f-2 b-tile b-tap" onClick={() => setQ(x)}>{x}</button>)}
        </div>
      )}
      {msgs.length > 0 && <button type="button" class="btn btn-ghost btn-sm tutor-reset mt-3 l-self-s" disabled={busy} onClick={() => { if (tutorSession.clearHistory(sessionKey)) cache.set(k, []); }}>Начать заново</button>}
    </div>
  );
}

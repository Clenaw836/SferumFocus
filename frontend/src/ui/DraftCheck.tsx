import { useRef, useState } from "preact/hooks";
import { ApiError, practicumApi } from "../lib/api";
import type { OcrBox, OcrCheck } from "../lib/ocrTypes";
import { Icon } from "./Icon";

/** v3.0 · «Где ошибка в черновике»: фото → строки (Tesseract на сервере или вручную) → ученик правит строки →
 *  проверка шагов → рамка вокруг первой неверной строки прямо на фото. Ответ не выдаётся: только «где перепроверить»
 *  и один наводящий вопрос; клик по рамке/бейджу фокусирует этот вопрос. Фото и строки не сохраняются (app/ocr_routes.py). */
type Row = { text: string; bbox: OcrBox | null };
type Phase = "idle" | "reading" | "edit" | "checking" | "result";
const STATUS_RU = { ok: "верно", error: "ошибка", carried: "следствие ошибки", unchecked: "не проверяется", unreadable: "не прочитано" } as const;

export function socraticQuestion(step: number, reason: string, prev?: string, cur?: string): string {
  const why = reason.replace(/[.\s]+$/, "");
  if (step <= 1 || !prev) return `Посмотри на шаг ${step}: ${why.toLowerCase()}. Какая часть записи не сходится?`;
  return `Сравни шаг ${step - 1} «${prev}» и шаг ${step} «${cur ?? ""}»: ${why.toLowerCase()}. Что именно поменялось при переходе?`;
}

export function DraftCheck({ photo, onAsk }: { photo: { base64: string; name: string }; onAsk: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rows, setRows] = useState<Row[]>([]);
  const [size, setSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null });
  const [note, setNote] = useState<string | null>(null);
  const [res, setRes] = useState<OcrCheck | null>(null);
  const qRef = useRef<HTMLDivElement>(null);
  const err = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

  const read = async () => {
    setPhase("reading"); setNote(null); setRes(null);
    try {
      const d = await practicumApi.ocrDraft(photo.base64, "image/jpeg");
      const got = d.lines.map((l) => ({ text: l.formula || l.text, bbox: l.bbox })).filter((r) => r.text.trim());
      setRows(got.length ? got : [{ text: "", bbox: null }, { text: "", bbox: null }]);
      setSize({ w: d.width, h: d.height }); setNote(d.message ?? null);
    } catch (e) {
      setRows([{ text: "", bbox: null }, { text: "", bbox: null }]); setSize({ w: null, h: null });
      setNote(`${err(e, "Фото не прочиталось")} — впиши строки решения вручную, проверка сработает так же.`);
    }
    setPhase("edit");
  };
  const check = async () => {
    const used = rows.map((r, i) => ({ ...r, i })).filter((r) => r.text.trim());
    if (!used.length) return;
    setPhase("checking");
    try {
      const r = await practicumApi.ocrCheck(used.map((r) => r.text.trim()), size.w ?? undefined, size.h ?? undefined, used.map((r) => r.bbox));
      setRows(used.map(({ text, bbox }) => ({ text: text.trim(), bbox }))); setRes(r); setPhase("result");
    } catch (e) { setNote(err(e, "Проверка не удалась — попробуй ещё раз")); setPhase("edit"); }
  };
  const edit = (i: number, text: string) => setRows(rows.map((r, j) => (j === i ? { ...r, text } : r)));
  const focusQ = () => { qRef.current?.focus(); qRef.current?.scrollIntoView?.({ block: "nearest" }); };

  const bad = res && res.first_error !== null ? res.first_error : null;
  const badStep = bad !== null && res ? res.steps[bad] : null;
  const question = bad !== null && badStep ? socraticQuestion(bad + 1, badStep.reason, rows[bad - 1]?.text, rows[bad]?.text) : null;
  const box = res?.error_bbox;
  return <section class="sf-draft l-v b-card mt-2 mb-2" aria-labelledby="sf-draft-h">
    <div class="sf-draft-head">
      <h3 id="sf-draft-h">Где ошибка в черновике</h3>
      <p class="f-2">Найдём первый неверный шаг на фото. Ответ не подсказываем, фото не сохраняем.</p>
    </div>
    {phase === "idle" && <button type="button" class="btn btn-ghost btn-sm sf-draft-read" onClick={() => void read()}><Icon name="target" />Найти ошибку в шагах</button>}
    {phase === "reading" && <p class="sf-draft-status f-m f-2 mt-1" role="status">Читаю строки на фото…</p>}
    {(phase === "edit" || phase === "checking") && <>
      {note && <p class="sf-draft-note f-m f-2 mt-1" role="note">{note}</p>}
      <ol class="sf-draft-lines l-v l-g1" aria-label="Строки решения — исправь, если распознано неточно">
        {rows.map((r, i) => <li key={i}>
          <label class="sf-draft-n f-m f-3 f-nw" for={`sf-draft-l${i}`}>Шаг {i + 1}</label>
          <input id={`sf-draft-l${i}`} class="sf-draft-line b-tile b-tap sf-tabular" value={r.text} maxLength={400} autoComplete="off" spellcheck={false}
            placeholder={i === 0 ? "например: 2x + 3 = 7" : "следующая строка"} onInput={(e) => edit(i, (e.target as HTMLInputElement).value)} />
          {rows.length > 1 && <button type="button" class="icon-btn" aria-label={`Убрать шаг ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="x" /></button>}
        </li>)}
      </ol>
      <div class="sf-draft-actions l-h l-je l-wrap">
        {rows.length < 12 && <button type="button" class="btn btn-ghost btn-sm" onClick={() => setRows([...rows, { text: "", bbox: null }])}><Icon name="plus" />Строка</button>}
        <button type="button" class="btn btn-primary btn-sm sf-draft-check" disabled={phase === "checking" || !rows.some((r) => r.text.trim())} onClick={() => void check()}>
          {phase === "checking" ? "Проверяю…" : "Проверить шаги"}</button>
      </div>
    </>}
    {phase === "result" && res && <>
      <div class="sf-draft-preview-wrap b-box l-w100 l-rel">
        <img class="l-blk" src={`data:image/jpeg;base64,${photo.base64}`} alt={`Фото черновика${box && bad !== null ? `, рамкой отмечен шаг ${bad + 1}` : ""}`} />
        {box && bad !== null && <div class={`sf-draft-step-box p-abs r-xs u-warn-s${box.y < 0.08 ? " is-top" : ""}`} onClick={focusQ}
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${Math.max(box.w, 0.04) * 100}%`, height: `${Math.max(box.h, 0.03) * 100}%` }}>
          <button type="button" class="sf-draft-step-badge f-c f-w6 f-nw p-abs r-xs bd-0" onClick={(e) => { e.stopPropagation(); focusQ(); }}>▲ Шаг {bad + 1} · проверь переход</button>
        </div>}
      </div>
      <ol class="sf-draft-steps l-v l-g1" aria-label="Проверка шагов">
        {res.steps.map((s, i) => <li key={i} class={`is-${s.status}${s.status === "error" ? " u-warn" : ""}`}>
          <span class="sf-draft-n f-m f-3 f-nw">Шаг {i + 1}</span><code class="sf-tabular">{rows[i]?.text ?? s.text}</code>
          <span class={`sf-draft-st f-m ${s.status === "error" ? "f-1 f-w6" : "f-2"}`}>{STATUS_RU[s.status]}</span>
        </li>)}
      </ol>
      <p class={`sf-draft-verdict f-m f-2 is-${res.verdict}`} role="status">{res.message}</p>
      {question && <div class="sf-draft-q l-v b-tile" id="sf-draft-q" tabIndex={-1} ref={qRef} role="note" aria-label={`Вопрос к шагу ${bad! + 1}`}>
        <p>{question}</p>
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => onAsk(`Шаг ${bad! + 1}: «${rows[bad!]?.text ?? ""}». ${question}`)}><Icon name="send" />Обсудить с тьютором</button>
      </div>}
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => { setRes(null); setPhase("edit"); }}>Исправить строки</button>
    </>}
  </section>;
}

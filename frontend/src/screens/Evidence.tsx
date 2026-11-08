/**
 * «Расписание изменилось?» → доказательство (фото/скриншот, голос, текст, файл; можно несколько)
 * → чтение (OCR/STT) → разбор на телефоне → дата → урок → изменения → уверенность → конфликты
 * → ПРЕДПРОСМОТР → подтверждение → применение. Без подтверждения ничего не меняется.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { DayChips } from "../ui/DayChips";
import { VoiceCapture } from "../ui/VoiceCapture";
import { api, ApiError, fileToBase64 } from "../lib/api";
import { haptic } from "../lib/host";
import { parseDay, parseSchedule, type ParsedSchedule } from "../lib/nlu";
import { buildProposal, dayLabel, lowerSubj, type Answers, type Proposal } from "../lib/proposal";
import { describe, SOURCE_LABEL, WD_ACC, weekdayOf, type DayView, type EvidenceKind, type ScheduleChange } from "../lib/schedule";

interface Ev { id: string; kind: EvidenceKind; label: string; text: string; url?: string; status: "reading" | "ok" | "error"; error?: string; legibility?: number; lessons?: { lesson_number: number | null; subject: string; start_time: string | null; end_time: string | null; room: string | null }[]; dayHint?: string | null }
interface Props {
  open: boolean; onClose: () => void; today: string; nowMin: number; lastBell: number | null; schoolWeek: number;
  ocr: boolean; stt: boolean; prefill?: string | null; view: (date: string) => DayView; onApply: (c: ScheduleChange[]) => void;
}
const KIND_LABEL: Record<EvidenceKind, string> = { photo: "Фото", screenshot: "Скриншот", file: "Файл", voice: "Голос", text: "Текст", paste: "Скопированный текст" };
let n = 0;

export function EvidenceSheet(p: Props) {
  const [evs, setEvs] = useState<Ev[]>([]);
  const [text, setText] = useState("");
  const [voiced, setVoiced] = useState(false);
  const [step, setStep] = useState<"collect" | "review">("collect");
  const [date, setDate] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [decided, setDecided] = useState<Record<string, boolean>>({});
  const [showPrev, setShowPrev] = useState(false);
  const [compare, setCompare] = useState(false);
  const [orig, setOrig] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null), fileRef = useRef<HTMLInputElement>(null), taRef = useRef<HTMLTextAreaElement>(null);

  const reset = () => { setEvs([]); setText(""); setVoiced(false); setStep("collect"); setDate(null); setAnswers({}); setDecided({}); setShowPrev(false); setCompare(false); setOrig(false); };
  useEffect(() => { if (p.open) { reset(); if (p.prefill) { setText(p.prefill); setStep("review"); } } }, [p.open]);

  const addImage = async (f: File, kind: EvidenceKind) => {
    const id = `ev${++n}`;
    const url = URL.createObjectURL(f);
    setEvs((xs) => [...xs, { id, kind, label: f.name || KIND_LABEL[kind], text: "", url, status: "reading" }]);
    try {
      if (!f.type.startsWith("image/") && (f.type.startsWith("text/") || /\.txt$/i.test(f.name))) {
        const t = await f.text();
        setEvs((xs) => xs.map((e) => (e.id === id ? { ...e, kind: "file", text: t.slice(0, 6000), status: "ok", legibility: 1 } : e)));
        return;
      }
      const img = f.type.startsWith("image/") ? await fileToBase64(f) : await rawB64(f);
      const r = await api.readEvidence(f.type.startsWith("image/") ? "photo" : "file", img.base64, img.mime, text);
      setEvs((xs) => xs.map((e) => (e.id === id ? { ...e, text: r.text, status: "ok", legibility: r.legibility, lessons: r.lessons, dayHint: r.day_hint } : e)));
    } catch (x) {
      setEvs((xs) => xs.map((e) => (e.id === id ? { ...e, status: "error", error: x instanceof ApiError ? x.message : "Не удалось прочитать" } : e)));
    }
  };
  const onPick = (kind: EvidenceKind) => (e: Event) => {
    const fs = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = "";
    fs.slice(0, 4).forEach((f) => void addImage(f, kind === "photo" && /screen|скрин/i.test(f.name) ? "screenshot" : kind));
  };
  const reading = evs.some((e) => e.status === "reading");
  const okEvs = evs.filter((e) => e.status === "ok");

  // ---- разбор: комментарий ученика — главный источник дня; затем подсказка OCR; затем текст фото
  const result = useMemo((): { parsed: ParsedSchedule; prop: Proposal } | null => {
    if (step !== "review") return null;
    const ctx = { today: p.today, nowMin: p.nowMin, lastBellToday: p.lastBell, schoolWeek: p.schoolWeek };
    const evText = okEvs.map((e) => e.text).join("\n");
    const parsed = parseSchedule([text, evText].filter(Boolean).join("\n"), ctx);
    const dc = parseDay(text, ctx);
    const dh = okEvs.map((e) => e.dayHint).find(Boolean);
    parsed.day = dc.kind !== "none" ? dc : dh ? parseDay(dh, ctx) : parseDay(evText, ctx);
    if (!parsed.list.length && !parsed.drafts.length) {
      const ai = okEvs.flatMap((e) => e.lessons ?? []);
      parsed.list = ai.map((l, i) => ({ n: l.lesson_number ?? i + 1, subject: l.subject, start_time: l.start_time, end_time: l.end_time, room: l.room }));
    }
    const hasImg = okEvs.some((e) => e.kind === "photo" || e.kind === "screenshot" || e.kind === "file");
    const leg = okEvs.filter((e) => e.legibility !== undefined).map((e) => e.legibility!);
    const sourceConf = hasImg ? Math.min(1, Math.max(0.3, ...(leg.length ? [Math.min(...leg) + 0.15] : [0.7]))) : voiced ? 0.92 : 1;
    const kinds: EvidenceKind[] = [...new Set([...okEvs.map((e) => e.kind), ...(text.trim() ? [voiced ? "voice" as const : "text" as const] : [])])];
    const note = [kinds.map((k) => KIND_LABEL[k]).join(" + "), text.trim() ? `«${text.trim().slice(0, 80)}»` : ""].filter(Boolean).join(": ");
    const prop = buildProposal(parsed, { date, view: p.view, source: hasImg ? "photo_ocr" : voiced ? "student_voice" : "text", evidence: kinds, evidenceNote: note, sourceConf, answers, table: hasImg || okEvs.some((e) => e.kind === "paste") });
    return { parsed, prop };
  }, [step, text, evs, date, answers, voiced]);

  const prop = result?.prop ?? null;
  const items = prop?.items.map((it) => ({ ...it, include: decided[it.key] ?? it.include })) ?? [];
  const chosen = items.filter((x) => x.include === true).map((x) => x.change);
  const unresolved = items.some((x) => x.include === null) || (prop?.questions.length ?? 0) > 0;
  const listMode = !!result && result.parsed.list.length > 0;
  const single = items.length === 1 && !items[0].conflict;
  const canApply = !!prop?.date && chosen.length > 0 && !unresolved;

  const apply = () => { if (!canApply) return; haptic.notify("success"); p.onApply(chosen); p.onClose(); };
  const toEdit = () => { setStep("collect"); setTimeout(() => taRef.current?.focus(), 50); };

  const footer = step === "collect"
    ? <button class="btn btn-primary btn-block" onClick={() => { setStep("review"); haptic.tap(); }} disabled={reading || (!text.trim() && !okEvs.length)}>{reading ? "Читаю фото…" : "Разобрать"}</button>
    : <div class="stack">
        <button class="btn btn-primary btn-block" onClick={apply} disabled={!canApply}>{listMode ? "Добавить" : single ? "Применить изменение" : `Применить${chosen.length ? ` (${chosen.length})` : ""}`}</button>
        <div class="ev-foot2 l-c2">
          <button class="btn btn-ghost btn-sm" onClick={toEdit}>Изменить</button>
          <button class="btn btn-ghost btn-sm" onClick={p.onClose}>Отменить</button>
        </div>
      </div>;

  return (
    <Sheet open={p.open} onClose={p.onClose} eyebrow="Расписание" title={step === "collect" ? "Что изменилось?" : listMode ? "Добавить это в расписание?" : "Проверь изменение"} footer={footer}>
      {step === "collect" ? (
        <>
          <div class="ev-tiles l-c3">
            <button class="ev-tile l-center f-b f-w6 b-box b-nob" onClick={() => photoRef.current?.click()} disabled={!p.ocr} aria-describedby={!p.ocr ? "ev-no-ocr" : undefined}><Icon name="camera" />Фото / скриншот</button>
            <button class="ev-tile l-center f-b f-w6 b-box b-nob" onClick={() => taRef.current?.focus()}><Icon name="chat" />Написать</button>
            <button class="ev-tile l-center f-b f-w6 b-box b-nob" onClick={() => fileRef.current?.click()}><Icon name="book" />Файл</button>
          </div>
          {!p.ocr && <p id="ev-no-ocr" class="hint-text">Фото сейчас не распознаётся (нет связи с сервером OCR) — напиши или скажи, что изменилось.</p>}
          <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={onPick("photo")} />
          <input ref={fileRef} type="file" accept="image/*,application/pdf,text/plain,.txt" hidden onChange={onPick("file")} />
          {evs.length > 0 && (
            <ul class="ev-list l-v mt-3" aria-label="Доказательства">
              {evs.map((e) => (
                <li key={e.id} class={`ev-item l-a1a l-mid f-b b-tile ${e.status}`}>
                  {e.url && e.kind !== "file" ? <img src={e.url} alt="" /> : <span class="ev-ico f-h f-tc" aria-hidden="true"><Icon name="book" /></span>}
                  <span class="ev-meta l-v l-g1"><b>{KIND_LABEL[e.kind]}</b>
                    <span>{e.status === "reading" ? "читаю…" : e.status === "error" ? e.error : e.legibility !== undefined && e.legibility < 0.6 ? "плохо читается" : "прочитано"}</span>
                  </span>
                  <button class="icon-btn" aria-label={`Убрать: ${KIND_LABEL[e.kind]}`} onClick={() => setEvs((xs) => xs.filter((x) => x.id !== e.id))}><Icon name="x" /></button>
                  {e.status === "reading" && <span class="sr" role="status">Читаю {KIND_LABEL[e.kind].toLowerCase()}</span>}
                </li>
              ))}
            </ul>
          )}
          <label class="field" style="margin-top:12px">
            <span class="field-label">Своими словами или вставь текст из чата</span>
            <textarea ref={taRef} class="textarea" value={text} maxLength={1500} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); setVoiced(false); }}
              placeholder="Например: «Это на среду» или «Завтра вместо физики — информатика»" onPaste={() => setTimeout(() => setEvs((xs) => xs), 0)} />
          </label>
          <VoiceCapture label="Сказать голосом" serverStt={p.stt} onText={(t) => { setText((x) => (x ? `${x} ${t}` : t)); setVoiced(true); }} />
          <p class="hint-text">Можно добавить несколько доказательств: скриншот + «это на завтра». Ничего не изменится без твоего подтверждения.</p>
        </>
      ) : prop && (
        <Review prop={prop} items={items} parsed={result!.parsed} today={p.today} schoolWeek={p.schoolWeek} heard={text} voiced={voiced}
          evs={okEvs} showPrev={showPrev} compare={compare} orig={orig} single={single}
          onDate={(d) => { setDate(d); setAnswers({}); setDecided({}); haptic.select(); }}
          onAnswer={(q, v, kind) => { if (v === "show") { setShowPrev(true); return; } setAnswers((a) => kind === "move" ? { ...a, move: { ...a.move, [q]: v as "shift" | "cancel" } } : { ...a, lesson: { ...a.lesson, [q]: Number(v) } }); haptic.select(); }}
          onDecide={(k, v) => { setDecided((d) => ({ ...d, [k]: v })); haptic.select(); }}
          onToggle={(k) => setDecided((d) => ({ ...d, [k]: !(d[k] ?? items.find((x) => x.key === k)?.include ?? false) }))}
          onShowPrev={() => setShowPrev((v) => !v)} onCompare={() => setCompare((v) => !v)} onOrig={() => setOrig((v) => !v)} onEdit={toEdit} onCancel={p.onClose} />
      )}
    </Sheet>
  );
}

async function rawB64(f: File): Promise<{ base64: string; mime: string }> {
  const buf = new Uint8Array(await f.arrayBuffer()); let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(s), mime: f.type || "application/octet-stream" };
}

type It = Proposal["items"][number];
function Review(r: {
  prop: Proposal; items: It[]; parsed: ParsedSchedule; today: string; schoolWeek: number; heard: string; voiced: boolean; evs: Ev[];
  showPrev: boolean; compare: boolean; orig: boolean; single: boolean;
  onDate: (d: string) => void; onAnswer: (q: string, v: string, kind: "lesson" | "move") => void; onDecide: (k: string, v: boolean) => void; onToggle: (k: string) => void;
  onShowPrev: () => void; onCompare: () => void; onOrig: () => void; onEdit: () => void; onCancel: () => void;
}) {
  const { prop } = r;
  const nothing = !r.items.length && !prop.questions.length;
  const low = r.items.some((x) => x.low) || (prop.sourceConf < 0.7);
  return (
    <div class="ev-review l-v l-g3">
      {r.heard && <p class="ev-heard f-b"><span class="faint">{r.voiced ? "Услышал:" : "Текст:"}</span> «{r.heard}»</p>}
      {prop.needDay ? (
        <div class="ev-q l-v u-warn r-md p-3" role="group" aria-labelledby="ev-dayq">
          <p id="ev-dayq" class="ev-qt f-s">{prop.dayGuess ? <>Я распознал {r.parsed.list.length ? "расписание" : "изменение"}, но не уверен, что оно на {WD_ACC[weekdayOf(prop.dayGuess)]}.</> : r.parsed.list.length || r.parsed.drafts.length ? <>Я распознал {r.parsed.list.length ? "расписание" : "изменение"}, но не уверен, какой день ты имеешь в виду.</> : "На какой день это расписание?"}</p>
          <DayChips today={r.today} schoolWeek={r.schoolWeek} value={null} onPick={r.onDate} label="На какой день это расписание?" />
        </div>
      ) : (
        <div class="ev-day l-v l-g1">
          <b>{dayLabel(prop.date!, r.today)}</b>
          <span class={`src-badge s-${prop.source}`}>{prop.evidence.map((k) => KIND_LABEL[k]).join(" + ") || SOURCE_LABEL[prop.source]}</span>
          <button class="btn btn-ghost btn-sm" onClick={() => r.onDate("")} style="margin-left:auto" hidden>Другой день</button>
        </div>
      )}
      {!prop.needDay && <DayChips today={r.today} schoolWeek={r.schoolWeek} value={prop.date} onPick={r.onDate} label="Другой день" />}

      {prop.questions.map((q) => (
        <div key={q.id} class="ev-q l-v u-warn r-md p-3" role="group" aria-labelledby={`q-${q.id}`}>
          <p id={`q-${q.id}`} class="ev-qt f-s">{q.text}{q.sub && <><br /><b>{q.sub}</b></>}</p>
          <div class="chips">{q.options.map((o) => <button key={o.value} class="chip" onClick={() => r.onAnswer(q.id, o.value, q.kind)}>{o.label}</button>)}</div>
        </div>
      ))}

      {!prop.needDay && nothing && (
        <div class="note warn"><Icon name="alert" /><div><b>Не нашёл изменений.</b> {r.parsed.unknown.length ? `Не понял: «${r.parsed.unknown[0]}».` : "В тексте нет уроков или предметов."} Уточни: «в четверг 5 урок — география».
          <div class="chips" style="margin-top:8px"><button class="chip" onClick={r.onEdit}>Уточнить</button>{r.evs.length > 0 && <button class="chip" onClick={r.onOrig}>Посмотреть оригинал</button>}</div></div></div>
      )}

      {!prop.needDay && r.items.length > 0 && (
        <>
          {r.single && !low ? (
            <div class="ev-one l-v">
              <p class="eyebrow">Я нашёл одно изменение:</p>
              <OneChange it={r.items[0]} />
            </div>
          ) : (
            <>
              <p class="eyebrow" style="margin-top:12px">{r.parsed.list.length ? "Что будет в расписании" : `Изменения · ${r.items.length}`}</p>
              <ul class="ev-changes l-v">
                {r.items.map((it) => {
                  const d = describe(it.change);
                  if (it.conflict) return (
                    <li key={it.key} class="ev-conf l-v b-tile"><div role="group" aria-label="Конфликт" style="display:grid;gap:8px">
                      <p><Icon name="alert" />{it.conflict.text}</p>
                      <div class="chips">
                        <button class={`chip${it.include === true ? " on" : ""}`} aria-pressed={it.include === true ? "true" : "false"} onClick={() => r.onDecide(it.key, true)}>Заменить на {lowerSubj(it.change.subject ?? "")}</button>
                        <button class={`chip${it.include === false ? " on" : ""}`} aria-pressed={it.include === false ? "true" : "false"} onClick={() => r.onDecide(it.key, false)}>Оставить {lowerSubj(it.conflict.existing.subject)}</button>
                        <button class="chip" aria-pressed={r.compare ? "true" : "false"} onClick={r.onCompare}>Сравнить</button>
                      </div>
                    </div></li>
                  );
                  return (
                    <li key={it.key} class={`ev-ch b-tile${it.low ? " low" : ""}`}>
                      <label class="ev-check">
                        <input type="checkbox" checked={it.include === true} onChange={() => r.onToggle(it.key)} />
                        <span class="ev-ic f-tc" aria-hidden="true"><Icon name={d.icon} /></span>
                        <span><b>{d.text}</b>{(it.why || it.change.reason) && <span class="ev-why l-blk f-m f-3">{it.why ?? it.change.reason}</span>}{it.low && <span class="ev-why l-blk f-m f-3 low">не уверен ({Math.round(it.change.confidence * 100)}%) — отметь, если верно</span>}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {prop.firstNote && <p class="ev-first l-h f-b f-warn"><Icon name="info" />{prop.firstNote}</p>}
          {low && (
            <div class="note warn" style="margin-top:12px"><Icon name="alert" /><div>
              <b>{r.evs.some((e) => e.kind !== "file") ? "Фотография плохо читается." : "Я не до конца уверен."}</b> Ничего не изменю, пока ты не отметишь верное.
              <div class="chips" style="margin-top:8px"><button class="chip" onClick={r.onEdit}>Уточнить</button>{r.evs.length > 0 && <button class="chip" onClick={r.onOrig}>Посмотреть оригинал</button>}<button class="chip" onClick={r.onCancel}>Отменить</button></div>
            </div></div>
          )}
          <div class="chips" style="margin-top:12px">
            <button class="chip" aria-expanded={r.showPrev ? "true" : "false"} onClick={r.onShowPrev}>{r.single ? "Посмотреть" : "Весь день"}</button>
            {!r.items.some((x) => x.conflict) && <button class="chip" aria-pressed={r.compare ? "true" : "false"} onClick={r.onCompare}>Сравнить</button>}
          </div>
        </>
      )}
      {(r.showPrev || r.compare) && !prop.needDay && <DayPreview prop={prop} items={r.items} compare={r.compare} />}
      {r.orig && (
        <div class="ev-orig f-m f-2 b-tile b-nob">
          {r.evs.map((e) => <figure key={e.id}>{e.url && e.kind !== "file" && <img src={e.url} alt={`Оригинал: ${KIND_LABEL[e.kind]}`} />}<figcaption><pre>{e.text || "(текст не распознан)"}</pre></figcaption></figure>)}
        </div>
      )}
    </div>
  );
}

function OneChange({ it }: { it: It }) {
  const c = it.change;
  const n = c.lesson_number ? `${c.lesson_number}-й урок` : "Урок";
  if (c.change_type === "REPLACE") return <div class="ev-big l-a1 l-g3 l-mid b-card"><span class="f-3 f-w6">{n}</span><dl><div><dt>было</dt><dd>{c.before}</dd></div><div><dt>стало</dt><dd><b>{c.subject}</b></dd></div></dl></div>;
  if (c.change_type === "CANCEL") return <div class="ev-big l-a1 l-g3 l-mid b-card"><span class="f-3 f-w6">{n}</span><p><b class="ev-x l-h l-inl l-g1"><Icon name="x" />отменён</b>{c.before ? ` · ${c.before}` : ""}</p></div>;
  const d = describe(c);
  return <div class="ev-big l-a1 l-g3 l-mid b-card"><span class="ev-big-ico l-center l-g0 f-2 b-box f-3 f-w6" aria-hidden="true"><Icon name={d.icon} /></span><p><b>{d.text}</b></p></div>;
}

function DayPreview({ prop, items, compare }: { prop: Proposal; items: It[]; compare: boolean }) {
  const chosen = new Set(items.filter((x) => x.include).map((x) => x.change.lesson_number));
  const rows = [...new Set([...prop.base, ...prop.preview].map((l) => l.lesson_number))].sort((a, b) => a - b);
  return (
    <table class={`ev-prev f-b l-w100${compare ? " cmp" : ""}`}>
      <caption class="sr">{compare ? "Сравнение: сейчас и после изменения" : "Расписание после изменения"}</caption>
      <thead><tr><th scope="col">№</th>{compare && <th scope="col">Сейчас</th>}<th scope="col">{compare ? "Станет" : "Урок"}</th></tr></thead>
      <tbody>
        {rows.map((nr) => {
          const b = prop.base.find((l) => l.lesson_number === nr), a = prop.preview.find((l) => l.lesson_number === nr);
          const changed = chosen.has(nr) || (b?.subject !== a?.subject) || (b?.status !== a?.status);
          return (
            <tr key={nr} class={changed ? "chg" : ""}>
              <th scope="row" class="num">{nr}</th>
              {compare && <td class={b?.status === "cancelled" ? "x" : ""}>{b ? b.subject : "—"}</td>}
              <td class={a?.status === "cancelled" ? "x" : ""}>{a ? <>{a.status === "cancelled" ? "✕ " : changed ? "→ " : ""}{a.subject}<span class="faint num"> {a.start_time}</span></> : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

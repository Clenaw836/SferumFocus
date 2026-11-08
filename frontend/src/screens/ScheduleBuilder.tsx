/**
 * v17.1 «Собрать расписание»: ученик задаёт параметры дня (начало уроков, длительности,
 * перемены, дорога, дела, сон) → сервер считает звонки и прогноз до сна →
 * PREVIEW «было → станет» → CONFIRM → APPLY (тот же импорт, что и у файла). Молча ничего не меняем.
 */
import { useEffect, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { toast } from "../ui/Toast";
import { api, ApiError, cache, type ImportPreview } from "../lib/api";
import type { BuilderExtra, BuilderOut, BuilderParams } from "../lib/studentTypes";

interface Props {
  open: boolean; onClose: () => void;
  today: string; tomorrow: string;
  subjectsFor: (date: string) => string[];
  defaults: { travel: number; bedtime: string; hwToday: number };
  onApplied: (date: string, extras: BuilderExtra[]) => void;
}
type Stage = "form" | "result" | "preview";
const KEY = "sf.builder.v1";
const ST_TXT = { ok: "Успеваешь", tight: "Впритык", overload: "Перегруз" } as const;

const clampInt = (v: string, lo: number, hi: number, d: number) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };

export function ScheduleBuilder({ open, onClose, today, tomorrow, subjectsFor, defaults, onApplied }: Props) {
  const [day, setDay] = useState<"today" | "tomorrow">("tomorrow");
  const date = day === "today" ? today : tomorrow;
  const saved = cache.get<Partial<BuilderParams>>(KEY) ?? {};
  const [p, setP] = useState<BuilderParams>(() => ({
    date, start: "08:30", lessons: 6, lesson_minutes: 45, break_minutes: 10, long_break_after: 3, long_break_minutes: 20,
    subjects: [], travel_minutes: defaults.travel, extras: [], rest_minutes: 60, homework_minutes: 0, bedtime: defaults.bedtime, ...saved,
  }));
  const [stage, setStage] = useState<Stage>("form");
  const [out, setOut] = useState<BuilderOut | null>(null);
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {      // при смене дня — предметы этого дня (если расписание есть) и д/з
    if (!open) return;
    const subs = subjectsFor(date);
    setP((x) => ({ ...x, date, subjects: subs.length ? subs : x.subjects, lessons: subs.length || x.lessons,
      homework_minutes: day === "today" ? defaults.hwToday : x.homework_minutes }));
    setStage("form"); setOut(null); setPv(null); setErr(null);
  }, [open, date]);

  const set = <K extends keyof BuilderParams>(k: K, v: BuilderParams[K]) => setP((x) => ({ ...x, [k]: v }));
  const setSubj = (i: number, v: string) => setP((x) => { const s = [...x.subjects]; s[i] = v; return { ...x, subjects: s }; });
  const setExtra = (i: number, e: Partial<BuilderExtra>) => setP((x) => ({ ...x, extras: x.extras.map((y, k) => (k === i ? { ...y, ...e } : y)) }));

  const calc = async () => {
    setBusy(true); setErr(null);
    const body: BuilderParams = { ...p, subjects: p.subjects.slice(0, p.lessons).map((s) => s.trim()),
      long_break_after: p.long_break_after && p.long_break_after < p.lessons ? p.long_break_after : null,
      extras: p.extras.filter((e) => e.title.trim()).map((e) => ({ ...e, title: e.title.trim(), start: e.start || null })) };
    try {
      const r = await api.st.build(body);
      cache.set(KEY, { ...body, date: undefined, subjects: undefined });
      setOut(r); setStage("result");
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Не удалось рассчитать"); } finally { setBusy(false); }
  };
  const preview = async () => {
    if (!out) return;
    setBusy(true); setErr(null);
    try { const r = await api.importPreview(out.import_payload, "text"); if (!r.ok) throw new ApiError(r.errors.join("; ") || "Не получилось", 422); setPv(r); setStage("preview"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Не удалось подготовить"); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pv?.token || !out) return;
    setBusy(true); setErr(null);
    try {
      await api.importConfirm(pv.token);
      toast("Расписание собрано и применено", "ok");
      onApplied(out.date, out.extras.map((e) => ({ title: e.title, start: e.start, minutes: e.minutes })));
    } catch (e) { setErr(e instanceof ApiError ? e.message : "Не удалось применить"); } finally { setBusy(false); }
  };

  const f = out?.forecast;
  const footer = stage === "form"
    ? <button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} disabled={busy} onClick={calc}><Icon name="clock" />Рассчитать день</button>
    : stage === "result"
      ? <div class="stack"><button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} disabled={busy} onClick={preview}>Применить к расписанию…</button><button class="btn btn-ghost btn-block" onClick={() => setStage("form")}>← Изменить параметры</button></div>
      : <div class="stack"><button class={`btn btn-ok btn-block${busy ? " is-loading" : ""}`} disabled={busy} onClick={confirm} data-autofocus><Icon name="check" />Подтвердить</button><button class="btn btn-ghost btn-block" onClick={() => setStage("result")}>← Назад</button></div>;

  return (
    <Sheet open={open} onClose={onClose} eyebrow="Своё расписание" title="Собрать расписание" footer={footer}>
      {err && <div class="note bad" role="alert"><Icon name="alert" /><div>{err}</div></div>}
      {stage === "form" && (
        <div class="sb l-v l-g4">
          <Segmented label="День" value={day} onChange={setDay} options={[{ value: "today", label: "Сегодня" }, { value: "tomorrow", label: "Завтра" }]} />
          <div class="time-grid">
            <label class="field"><span class="field-label">Первый урок в</span><input class="input" type="time" step={300} value={p.start} onInput={(e) => set("start", (e.target as HTMLInputElement).value)} /></label>
            <label class="field"><span class="field-label">Уроков</span><input class="input num" type="number" inputMode="numeric" min={1} max={10} value={p.lessons} onInput={(e) => set("lessons", clampInt((e.target as HTMLInputElement).value, 1, 10, 6))} /></label>
            <label class="field"><span class="field-label">Урок, мин</span><input class="input num" type="number" inputMode="numeric" min={20} max={90} value={p.lesson_minutes} onInput={(e) => set("lesson_minutes", clampInt((e.target as HTMLInputElement).value, 20, 90, 45))} /></label>
            <label class="field"><span class="field-label">Перемена, мин</span><input class="input num" type="number" inputMode="numeric" min={0} max={40} value={p.break_minutes} onInput={(e) => set("break_minutes", clampInt((e.target as HTMLInputElement).value, 0, 40, 10))} /></label>
            <label class="field"><span class="field-label">Большая после урока</span><input class="input num" type="number" inputMode="numeric" min={0} max={9} value={p.long_break_after ?? 0} onInput={(e) => set("long_break_after", clampInt((e.target as HTMLInputElement).value, 0, 9, 0) || null)} /></label>
            <label class="field"><span class="field-label">Большая, мин</span><input class="input num" type="number" inputMode="numeric" min={5} max={60} value={p.long_break_minutes} onInput={(e) => set("long_break_minutes", clampInt((e.target as HTMLInputElement).value, 5, 60, 20))} /></label>
          </div>
          <details class="sb-subj">
            <summary>Предметы по урокам <span class="faint">(необязательно)</span></summary>
            <ol class="sb-subj-list l-v l-g1 mt-2">
              {Array.from({ length: p.lessons }, (_, i) => (
                <li key={i}><input class="input" aria-label={`Урок ${i + 1}`} placeholder={`Урок ${i + 1}`} maxLength={40} value={p.subjects[i] ?? ""} onInput={(e) => setSubj(i, (e.target as HTMLInputElement).value)} /></li>
              ))}
            </ol>
          </details>
          <div class="time-grid">
            <label class="field"><span class="field-label">Дорога домой, мин</span><input class="input num" type="number" inputMode="numeric" min={0} max={180} value={p.travel_minutes} onInput={(e) => set("travel_minutes", clampInt((e.target as HTMLInputElement).value, 0, 180, 45))} /></label>
            <label class="field"><span class="field-label">Отдых, мин</span><input class="input num" type="number" inputMode="numeric" min={0} max={240} value={p.rest_minutes} onInput={(e) => set("rest_minutes", clampInt((e.target as HTMLInputElement).value, 0, 240, 60))} /></label>
            <label class="field"><span class="field-label">Д/З, мин</span><input class="input num" type="number" inputMode="numeric" min={0} max={600} value={p.homework_minutes} onInput={(e) => set("homework_minutes", clampInt((e.target as HTMLInputElement).value, 0, 600, 0))} /></label>
            <label class="field"><span class="field-label">Сон в</span><input class="input" type="time" step={300} value={p.bedtime} onInput={(e) => set("bedtime", (e.target as HTMLInputElement).value)} /></label>
          </div>
          <div class="sec-head"><h3 class="h-sec" style="font-size:calc(15px*var(--fs,1))">Доп. занятия</h3></div>
          {p.extras.map((e, i) => (
            <div class="sb-extra" key={i}>
              <input class="input" aria-label="Что" placeholder="Секция, репетитор…" maxLength={60} value={e.title} onInput={(ev) => setExtra(i, { title: (ev.target as HTMLInputElement).value })} />
              <input class="input" aria-label="Во сколько" type="time" step={300} value={e.start ?? ""} onInput={(ev) => setExtra(i, { start: (ev.target as HTMLInputElement).value || null })} />
              <input class="input num" aria-label="Минут" type="number" inputMode="numeric" min={5} max={300} value={e.minutes} onInput={(ev) => setExtra(i, { minutes: clampInt((ev.target as HTMLInputElement).value, 5, 300, 60) })} />
              <button class="btn btn-ghost btn-sm" aria-label={`Убрать ${e.title || "занятие"}`} onClick={() => set("extras", p.extras.filter((_, k) => k !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          {p.extras.length < 6 && <button class="btn btn-secondary btn-sm" onClick={() => set("extras", [...p.extras, { title: "", start: null, minutes: 60 }])}><Icon name="plus" />Добавить занятие</button>}
        </div>
      )}
      {stage === "result" && out && f && (
        <div class="sb-res" role="status">
          <p class={`sb-verdict f-s mb-3 is-${f.status}`}><b>{ST_TXT[f.status]}</b> · {f.left_minutes >= 0 ? `запас ${f.left_minutes} мин` : `не хватает ${-f.left_minutes} мин`}</p>
          <ol class="sb-lessons l-v l-g1 mb-3">
            {out.lessons.map((l) => <li key={l.n}><span class="num">{l.start}–{l.end}</span><span>{l.n}. {l.subject}</span></li>)}
          </ol>
          <dl class="ti-list l-v l-g0">
            <div class="ti-row py-2 b-sep"><dt>Последний звонок</dt><dd class="num">{out.last_bell}</dd></div>
            <div class="ti-row py-2 b-sep"><dt>Дома</dt><dd class="num">{out.home_at}</dd></div>
            {out.extras.map((e) => <div class="ti-row py-2 b-sep" key={e.title}><dt>{e.title}</dt><dd class="num">{e.start ? `${e.start}–${e.end}` : `${e.minutes} мин, когда удобно`}{e.conflict && <span class="ti-src l-blk f-m f-3 mt-1" style="color:var(--bad)">раньше, чем будешь дома</span>}</dd></div>)}
            <div class="ti-row py-2 b-sep"><dt>Свободно до сна</dt><dd class="num">{f.free_minutes} мин</dd></div>
            {f.homework_minutes > 0 && <div class="ti-row py-2 b-sep"><dt>Д/З</dt><dd class="num">с {f.homework_start}{f.done_by ? ` до ~${f.done_by}` : ""} · {f.homework_minutes} мин</dd></div>}
          </dl>
          <ul class="sb-tips f-2 mt-3">{f.tips.map((t) => <li key={t}>{t}</li>)}</ul>
          {!out.named && <p class="hint-text">Без названий уроки будут «Урок 1, 2…» — переименуешь позже.</p>}
        </div>
      )}
      {stage === "preview" && pv && (
        <div class="sb-pv">
          <p class="hint-text" style="margin-top:0">Проверь: что было и что станет. Без подтверждения ничего не меняется.</p>
          {pv.days.map((d) => (
            <div class="sb-diff l-c2 l-g3 mb-3" key={d.date}>
              <div><span class="field-label">Было</span><ul>{d.before.length ? d.before.map((x) => <li key={x}>{x}</li>) : <li class="faint">нет уроков</li>}</ul></div>
              <div><span class="field-label">Станет</span><ul>{d.after.map((x) => <li key={x}>{x}</li>)}</ul></div>
            </div>
          ))}
          {pv.warnings.length > 0 && <p class="meta">{pv.warnings.join(" · ")}</p>}
        </div>
      )}
    </Sheet>
  );
}

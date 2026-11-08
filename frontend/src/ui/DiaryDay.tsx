/**
 * Master v2.0 · Feature 2 — дневник по дням: выбор даты, перелистывание (кнопки, клавиши ←/→, свайп),
 * переход к любому дню/месяцу/году в пределах навигации, «Сегодня» одним нажатием.
 * Каждый блок грузится сам (уроки — неделями, задания и оценки — один раз), интерфейс не блокируется.
 * Только данные источника: уроки — провайдер расписания (СГО / импорт / школа / демо), задания — выдачи
 * учителя (срок + статус → «просрочено») и задания дневника (без статуса — никогда не «просрочено»),
 * оценки — снимок подключённого дневника с датой. Ничего не дорисовываем.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, onboarding, type DiaryGrade, type DiaryGrades } from "../lib/api";
import { GRADE_COPY, gradeView, gradesFromCache } from "../lib/gradeState";
import { openOnboarding } from "../lib/onboardingEvent";
import { DEMO } from "../lib/demo";
import { accountKey } from "../lib/identity";
import { principal } from "../lib/roleContext";
import { sched } from "../lib/schedStore";
import { dayView, SOURCE_LABEL, weekdayOf, type DayView, type Provider, type WeekResp } from "../lib/schedule";
import type { TeacherAssignment } from "../lib/hwTypes";
import type { InitialState } from "../lib/types";
import { clampDate, createSwipe, dayKind, fromIso, humanDate, isOverdue, MONTHS, MONTHS_GEN, mondayOf, navBounds, restoreDate, schoolYear, shift, WD_SHORT } from "../lib/diaryHistory";
import { plural } from "../lib/time";
import { Icon } from "./Icon";
import { roomLabel } from "../lib/room";
import { archiveLessons, homeworkText, sgoLessonFor, type SgoDays } from "../lib/diaryDays";

const KEY = () => accountKey("diary.day");               // по аккаунту: другой ученик на том же телефоне откроет «Сегодня»
type Load<T> = { data: T | null; err: string | null; busy: boolean };
const weeks = new Map<string, WeekResp>();                 // кэш недель на время сессии (листание туда-обратно без сети)
const STATUS_RU: Record<string, string> = { assigned: "выдано", in_progress: "в работе", paused: "на паузе", completed: "выполнено", revoked: "отозвано" };
const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Не загрузилось");
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11y === "1"; } catch { return true; } };

function useWeek(monday: string): Load<WeekResp> & { retry: () => void } {
  const [st, setSt] = useState<Load<WeekResp>>({ data: weeks.get(monday) ?? null, err: null, busy: !weeks.has(monday) });
  const [rk, setRk] = useState(0);
  useEffect(() => {
    let alive = true;
    const have = weeks.get(monday);
    setSt({ data: have ?? null, err: null, busy: !have });
    if (!have || rk) api.scheduleWeek(monday, 7).then((w) => { weeks.set(monday, w); if (alive) setSt({ data: w, err: null, busy: false }); })
      .catch((e) => { if (alive) setSt((s) => ({ data: s.data, err: errText(e), busy: false })); });
    return () => { alive = false; };
  }, [monday, rk]);
  return { ...st, retry: () => setRk((k) => k + 1) };
}
function useOnce<T>(load: () => Promise<T>): Load<T> & { retry: () => void } {
  const [st, setSt] = useState<Load<T>>({ data: null, err: null, busy: true });
  const [rk, setRk] = useState(0);
  useEffect(() => {
    let alive = true; setSt((s) => ({ ...s, busy: true, err: null }));
    load().then((d) => { if (alive) setSt({ data: d, err: null, busy: false }); }).catch((e) => { if (alive) setSt((s) => ({ data: s.data, err: errText(e), busy: false })); });
    return () => { alive = false; };
  }, [rk]);
  return { ...st, retry: () => setRk((k) => k + 1) };
}

const sgoWeeks = new Map<string, SgoDays>();              // v3.2: архив СГО по неделям (листание без повторных запросов)
function useSgoWeek(monday: string, on: boolean): { data: SgoDays | null; retry: () => void } {
  const [d, setD] = useState<SgoDays | null>(sgoWeeks.get(monday) ?? null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const have = sgoWeeks.get(monday);
    setD(have ?? null);
    if (!on || have) return;
    api.diaryDays(monday, shift(monday, 6)).then((w) => { if (w.state === "fresh") sgoWeeks.set(monday, w); if (alive) setD(w); })
      .catch(() => { if (alive) setD({ state: "upstream_error", days: [] }); });
    return () => { alive = false; };
  }, [monday, on, attempt]);
  return { data: d, retry: () => { sgoWeeks.delete(monday); setAttempt((n) => n + 1); } };
}

/** Уроки дня: в окне кэша расписания — как в остальном приложении (с изменениями ученика), иначе — из загруженной недели. */
function lessonsOf(date: string, week: WeekResp | null): { view: DayView | null; provider: Provider | null } {
  const inStore = sched.provider() && sched.base(date) !== null;
  if (inStore) return { view: sched.day(date), provider: sched.provider() };
  const d = week?.days.find((x) => x.date === date);
  if (!week || !d) return { view: null, provider: week?.provider ?? null };
  return { view: dayView(date, d.available === false ? null : d.base, sched.changes()), provider: week.provider };
}

function Card({ title, icon, badge, children }: { title: string; icon: Parameters<typeof Icon>[0]["name"]; badge?: preact.ComponentChildren; children: preact.ComponentChildren }) {
  return <section class="dd-card l-v b-card" aria-label={title}>
    <div class="dd-card-h l-h l-wrap"><Icon name={icon} /><h3>{title}</h3>{badge}</div>
    {children}
  </section>;
}
function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div class="note bad dd-note" role="status"><Icon name="alert" /><span>{text} <button type="button" class="btn btn-ghost btn-sm" onClick={onRetry}>Повторить</button></span></div>;
}

/** v2.2 · жест «листать» с ведением: слой следует за пальцем (damp — доля смещения), по отпусканию либо листаем
 *  (createSwipe решает: дистанция/скорость, горизонталь), либо слой пружинит обратно. Мышь не листает (у неё есть
 *  кнопки и клавиши), клик после распознанного свайпа гасится, вертикальная прокрутка не перехватывается. */
function useDrag(onSwipe: (s: -1 | 1) => void, damp: number) {
  const sw = useRef(createSwipe());
  const ref = useRef<HTMLDivElement>(null);
  const x0 = useRef(0);
  const swallow = useRef(false);
  const place = (dx: number | null) => {
    const el = ref.current; if (!el) return;
    if (dx === null) { el.classList.add("is-settle"); el.style.transform = ""; window.setTimeout(() => el.classList.remove("is-settle"), 260); return; }
    el.classList.remove("is-settle");
    el.style.transform = `translate3d(${Math.round(Math.max(-72, Math.min(72, dx * damp)))}px,0,0)`;
  };
  return {
    ref,
    down: (e: PointerEvent) => { if (e.pointerType === "mouse") return; x0.current = e.clientX; swallow.current = false; sw.current.start(e.clientX, e.clientY, e.timeStamp); },
    move: (e: PointerEvent) => { if (e.pointerType === "mouse") return; if (sw.current.move(e.clientX, e.clientY) === "h" && !reducedMotion()) place(e.clientX - x0.current); },
    up: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const s = sw.current.end(e.clientX, e.clientY, e.timeStamp);
      place(null);
      if (s) { swallow.current = true; onSwipe(s); }
    },
    cancel: () => { sw.current.cancel(); place(null); },
    click: (e: MouseEvent) => { if (swallow.current) { swallow.current = false; e.preventDefault(); e.stopPropagation(); } },
  };
}

export function DiaryDay({ today, initial, schoolWeek, onSubject, focus, done, onHwDone, onAddHw }: { today: string; initial: InitialState; schoolWeek: 5 | 6; onSubject?: (subject: string, hw?: string) => void; focus?: { date: string; n: number };
  /** v3.2.1 · AWWE: отметка «Выполнено» прямо под уроком (та же отметка, что в «Плане дня») и «Записать ДЗ», если в СГО пусто. */
  done?: readonly string[]; onHwDone?: (title: string, done: boolean) => void; onAddHw?: (prefill: string) => void }) {
  const b = useMemo(() => navBounds(today), [today]);
  const restored = useRef(false);                          // v3.2: день, выбранный до перезагрузки, важнее стартового «сегодня/завтра»
  const [date, setDate] = useState(() => { try { const d = restoreDate(sessionStorage.getItem(KEY()), today, Date.now(), b); restored.current = d !== today; return d; } catch { return today; } });
  const [dir, setDir] = useState(0);
  const [jump, setJump] = useState(false);
  const live = useRef<HTMLParagraphElement>(null);
  useEffect(() => { try { sessionStorage.setItem(KEY(), JSON.stringify({ d: date, at: Date.now(), on: today })); } catch { /* приватный режим */ } }, [date, today]);
  const [wdir, setWdir] = useState(0);                     // v2.2: направление смены недели (анимация полоски)
  const go = (to: string) => { const c = clampDate(to, b); if (c === date) return; setDir(c > date ? 1 : -1); setWdir(mondayOf(c) === mondayOf(date) ? 0 : c > date ? 1 : -1); setDate(c); };
  const monday = mondayOf(date);
  // v3.2 · карточка «Сегодня · на уроках | Завтра · после школы» в «Учёбе» переключает день одним тапом.
  useEffect(() => { if (!focus || (focus.n === 0 && restored.current)) return; go(focus.date); }, [focus?.n, focus?.date]);
  const week = useWeek(monday);
  const hw = useOnce(() => api.hw.mine());
  // Оценки по датам — из подключённого дневника подтверждённого аккаунта (сервер: account() → 401 без него).
  // Без подтверждённого аккаунта запрос не шлём: 401 здесь сбрасывал бы сессию («Сессия изменилась») —
  // регрессия, найденная smoke_v13 в финальном прогоне. Автономное DEMO объясняет отсутствие оценок само.
  const gradesAllowed = DEMO || !!principal()?.uid;
  const grades = useOnce<DiaryGrades | null>(() => gradesAllowed ? api.diaryGrades() : Promise.resolve(null));

  // свайп: только горизонтальный жест листает; вертикальная прокрутка — никогда.
  // v2.2: день — свайп по карточкам дня (.dd-body), неделя — свайп по полоске дней (.dd-strip, ±7 дней).
  // Пока палец ведёт, слой следует за ним (translate3d, только transform — без перерасчёта раскладки, CLS 0).
  const goWeek = (k: -1 | 1) => go(shift(date, 7 * k));
  const day = useDrag((s) => go(shift(date, s)), 0.55);
  const wk = useDrag((s) => goWeek(s), 0.45);
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,select,textarea")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(shift(date, -1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(shift(date, 1)); }
    else if (e.key === "PageUp") { e.preventDefault(); goWeek(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); goWeek(1); }
  };

  const kind = dayKind(date, schoolWeek);
  const { view, provider } = lessonsOf(date, week.data);
  const demoSrc = DEMO || !!provider?.is_demo;
  const hideDemo = demoSrc && (kind.kind === "holiday" || kind.kind === "summer");
  const sgoLoad = useSgoWeek(monday, gradesAllowed && !DEMO);
  const sgo = sgoLoad.data;
  const sgoDay = sgo?.days.find((x) => x.date === date) ?? null;
  // v3.2: прошлые недели вне кэша расписания — уроки из архива СГО (с ДЗ и отметками под каждым уроком)
  const archive = !hideDemo && (!view || !view.available) && sgoDay && sgoDay.lessons.length ? archiveLessons(sgoDay, weekdayOf(date)) : null;
  const lessons = archive ?? (view && !hideDemo ? view.lessons : []);
  const assignments = (hw.data?.assignments ?? []) as Omit<TeacherAssignment, "task_title">[];
  const due = assignments.filter((a) => a.due_date === date && a.status !== "revoked");
  const overdue = date === today ? assignments.filter((a) => isOverdue({ due: a.due_date, status: a.status }, today)) : [];
  const diaryTasks = (initial.diary_tasks ?? []).filter((t) => t.deadline === date && t.source !== "teacher");
  const dayGrades: DiaryGrade[] = (grades.data?.grades ?? []).filter((g) => g.date === date);
  const gView = gradeView(grades.data, !!grades.err && !grades.data);
  const [revealing, setRevealing] = useState(false);
  const reveal = async () => {
    setRevealing(true);
    try { await onboarding.updateProfile({ hide_grades: false }); grades.retry(); }
    catch { /* сеть: оценки остаются скрытыми, кнопку можно нажать ещё раз */ }
    finally { setRevealing(false); }
  };
  const rel = date === today ? "Сегодня" : date === shift(today, -1) ? "Вчера" : date === shift(today, 1) ? "Завтра" : null;
  const sy = schoolYear(date);
  const strip = Array.from({ length: 7 }, (_, i) => shift(monday, i));
  const years = useMemo(() => { const out: number[] = []; for (let y = Number(b.min.slice(0, 4)); y <= Number(b.max.slice(0, 4)); y++) out.push(y); return out; }, [b]);
  const d0 = fromIso(date);
  const jumpTo = (y: number, m: number) => {                 // месяц/год: тот же день месяца (или последний), в пределах навигации
    const last = new Date(y, m + 1, 0).getDate();
    go(`${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(d0.getDate(), last)).padStart(2, "0")}`);
  };
  useEffect(() => { if (live.current) live.current.textContent = `${rel ? rel + ", " : ""}${humanDate(date)}`; }, [date]);
  const anim = !reducedMotion() && dir !== 0 ? (dir > 0 ? " dd-in-next" : " dd-in-prev") : "";
  const wanim = !reducedMotion() && wdir !== 0 ? (wdir > 0 ? " dd-wk-next" : " dd-wk-prev") : "";
  const on = Math.max(0, strip.indexOf(date));

  return <section class="diary-day l-v l-g3 mb-6" aria-labelledby="dd-h" onKeyDown={onKey}>
    <div class="dd-head l-h">
      <button type="button" class="icon-btn dd-nav l-center l-g0 l-fix s-44" aria-label="Предыдущий день" disabled={date <= b.min} onClick={() => go(shift(date, -1))}><Icon name="chevron" /></button>
      <button type="button" class="dd-title l-v l-g1 l-ac f-tc b-tap l-grow" aria-expanded={jump} aria-controls="dd-jump" onClick={() => setJump(!jump)}>
        <h2 id="dd-h">{rel ?? humanDate(date).split(",")[0].replace(/^./, (c) => c.toUpperCase())}</h2>
        <span class="f-2">{rel ? humanDate(date) : humanDate(date).split(", ")[1]} · {sy.label}</span>
      </button>
      <button type="button" class="icon-btn dd-nav l-center l-g0 l-fix s-44 dd-next" aria-label="Следующий день" disabled={date >= b.max} onClick={() => go(shift(date, 1))}><Icon name="chevron" /></button>
    </div>
    <p ref={live} class="sr" aria-live="polite" />
    <div class={`dd-strip${wanim}`} key={monday} ref={wk.ref} role="group" aria-label={`Неделя с ${humanDate(monday)}. Свайп по полоске — соседняя неделя`}
      onPointerDown={wk.down} onPointerMove={wk.move} onPointerUp={wk.up} onPointerCancel={wk.cancel} onClickCapture={wk.click}>
      <span class="dd-pill p-abs r-md u-acc-bg" aria-hidden="true" style={{ "--i": on }} />
      {strip.map((d) => { const k = dayKind(d, schoolWeek).kind; return <button key={d} type="button" class={`dd-chip l-v l-jc l-g0 l-ac b-box b-tap l-rel${d === date ? " is-on" : ""}${d === today ? " is-today" : ""}${k !== "school" ? " is-off" : ""}`}
        aria-pressed={d === date} aria-current={d === today ? "date" : undefined} disabled={d < b.min || d > b.max} onClick={() => go(d)}>
        {/* Имя кнопки = видимый текст + скрытое уточнение (WCAG 2.5.3 «Label in Name»: без aria-label, который расходился с «Пн 5»). */}
        <small>{WD_SHORT[fromIso(d).getDay()]}</small>{" "}<b class="num">{fromIso(d).getDate()}</b>
        <span class="sr">{` ${MONTHS_GEN[fromIso(d).getMonth()]}${fromIso(d).getFullYear() !== new Date().getFullYear() ? " " + fromIso(d).getFullYear() : ""}${d === today ? ", сегодня" : ""}${k === "holiday" ? ", праздник" : k === "weekend" ? ", выходной" : ""}`}</span>
      </button>; })}
    </div>
    <div class="dd-tools l-h l-jc l-wrap">
      {date !== today && <button type="button" class="btn btn-secondary btn-sm" onClick={() => go(today)}><Icon name="calendar" />Сегодня</button>}
      <button type="button" class="btn btn-ghost btn-sm" aria-expanded={jump} aria-controls="dd-jump" onClick={() => setJump(!jump)}>{jump ? "Скрыть выбор даты" : "Выбрать дату"}</button>
    </div>
    {jump && <div id="dd-jump" class="dd-jump l-v b-tile" role="group" aria-label="Переход к дате">
      <label class="field"><span class="field-label">Дата</span>
        <input class="input" type="date" min={b.min} max={b.max} value={date} onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).value; if (v) go(v); }} /></label>
      <div class="dd-jump-row">
        <label class="field"><span class="field-label">Месяц</span>
          <select class="input" value={String(d0.getMonth())} onChange={(e) => jumpTo(d0.getFullYear(), Number((e.currentTarget as HTMLSelectElement).value))}>
            {MONTHS.map((m, i) => <option key={m} value={String(i)}>{m[0].toUpperCase() + m.slice(1)}</option>)}
          </select></label>
        <label class="field"><span class="field-label">Год</span>
          <select class="input" value={String(d0.getFullYear())} onChange={(e) => jumpTo(Number((e.currentTarget as HTMLSelectElement).value), d0.getMonth())}>
            {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select></label>
      </div>
      <p class="hint-text">Доступно с {humanDate(b.min)} по {humanDate(b.max)}: прошлый, текущий и следующий учебный год. Листать можно и жестом влево-вправо, и стрелками клавиатуры.</p>
    </div>}

    <div class={`dd-body${anim}`} key={date} ref={day.ref} onPointerDown={day.down} onPointerMove={day.move} onPointerUp={day.up} onPointerCancel={day.cancel} onClickCapture={day.click}>
      {kind.kind !== "school" && <p class={`dd-kind l-h l-top f-b f-2 b-tile k-${kind.kind}`} role="note"><Icon name={kind.kind === "holiday" ? "sun" : "moon"} />{kind.label}</p>}

      <Card title="Уроки" icon="book" badge={provider && <span class={`src-badge sm${demoSrc ? " demo" : provider.kind === "none" ? " none" : " real"}`}>{demoSrc ? "Демо-расписание" : provider.name}</span>}>
        {archive && <p class="hint-text">Архив «Сетевого Города»: уроки, ДЗ и отметки этого дня.</p>}
        {sgo?.state === "upstream_error" && <Retry text="Не удалось загрузить дневник СГО. Уроки и задания могут быть неполными." onRetry={sgoLoad.retry} />}
        {sgo?.state === "reauth" && <p class="note bad dd-note" role="status">Сессия СГО закончилась. Подключите дневник заново.</p>}
        {week.busy && !view && !archive ? <div class="sk" style="height:72px" role="status" aria-label="Загружаем уроки" />
          : week.err && !view && !archive ? <Retry text={`Уроки не загрузились: ${week.err}`} onRetry={week.retry} />
          : hideDemo ? <p class="muted">В демо-расписании на {kind.kind === "holiday" ? "праздники" : "летние каникулы"} уроков нет — выдумывать их не будем.</p>
          : !archive && (!view || !view.available) && (sgo?.state === "upstream_error" || sgo?.state === "reauth") ? null
          : !archive && (!view || !view.available) ? <p class="muted">Нет данных о расписании на этот день. {provider?.kind === "none" ? "Подключите школьный дневник или сообщите расписание фото/голосом." : "Источник не прислал этот день."}</p>
          : !lessons.length ? <p class="muted">{kind.kind === "school" ? "Уроков нет." : "Уроков нет — выходной."}</p>
          : <ol class="dd-lessons l-v l-g0">{lessons.map((l) => { const sl = sgoLessonFor(sgoDay, l); const hwText = homeworkText(sl) ?? lessonHw(l.subject, due, diaryTasks); const hwTask = l.status === "active" && hwText ? diaryTasks.find((t) => t.title.toLowerCase().startsWith(l.subject.toLowerCase())) : undefined; const isDone = !!hwTask && !!done?.includes(hwTask.title); const mark = dayGrades.find((g) => g.subject === l.subject) ?? (sl?.marks[0] ? { value: sl.marks[0].value } : undefined); return <li key={`${l.lesson_number}${l.subject}`} class={l.status !== "active" ? "off" : ""}>
              <span class="num dd-time l-v l-g0 f-b f-w6 l-fix">{l.start_time ?? "—"}<small>{l.end_time ?? ""}</small></span>
              <span class="dd-subj l-v l-g1 l-grow"><b>{l.status !== "active" ? <s>{l.subject}</s> : l.subject}</b>
                {(l.room || l.teacher || l.was || l.note || sl?.topic) && <small>{[l.room && roomLabel(l.room), l.teacher, l.was && l.status === "active" ? `вместо ${l.was}` : null, l.note, sl?.topic && `Тема: ${sl.topic}`].filter(Boolean).join(" · ")}</small>}
                {l.status !== "active" && <small class="dd-off f-bad">отменён</small>}
                {hwText && l.status === "active" && <span class={`dd-hw-box l-v l-g1${isDone ? " is-done" : ""}`}><small class="dd-hw">ДЗ: {hwText}</small>
                  {hwTask && onHwDone && <label class="dd-done l-h l-g1"><input type="checkbox" checked={isDone} onChange={(e) => onHwDone(hwTask.title, (e.currentTarget as HTMLInputElement).checked)} /><span>Выполнено</span></label>}</span>}
                {!hwText && l.status === "active" && sl && <span class="dd-hw-none l-h l-g1">ДЗ не указано{onAddHw && date >= today && <button type="button" class="dd-hw-add f-w6" onClick={() => onAddHw(`${l.subject}: `)} aria-label={`Записать ДЗ: ${l.subject}`}>+ Записать</button>}</span>}</span>
              {mark && <b class="num dd-mark l-center l-g0 f-s f-num b-tile l-fix grade-badge" data-grade={String(mark.value)} aria-label={`Оценка ${mark.value}`}>{mark.value}</b>}
              {l.source !== "real" && l.source !== "demo" && <span class="src-badge sm">{SOURCE_LABEL[l.source]}</span>}
              {onSubject && l.status === "active" && <button type="button" class="dd-hub l-h l-inl l-jc l-g1 f-m f-w6 f-2 b-pill l-fix mw-44" onClick={() => onSubject(l.subject, [sl?.topic, hwText ?? l.note].filter(Boolean).join(". ") || undefined)}
                aria-label={`Разобрать тему: ${l.subject} — квиз-опрос или практикум`}><span class="dd-hub-t">Разобрать тему</span><Icon name="arrowRight" /></button>}
            </li>; })}</ol>}
      </Card>

      <Card title="Домашние задания" icon="check" badge={hw.data?.is_demo ? <span class="src-badge sm demo">Демо</span> : undefined}>
        {hw.busy && !hw.data ? <div class="sk" style="height:48px" role="status" aria-label="Загружаем задания" />
          : <>
            {hw.err && !hw.data && <p class="muted">Задания учителя сейчас недоступны: {hw.err}</p>}
            {overdue.length > 0 && <div class="dd-overdue p-2" role="note"><b class="f-bad"><Icon name="alert" />Просрочено: {overdue.length}</b>
              <ul>{overdue.map((a) => <li key={a.issue_id}>{a.subject} · {a.title} <small>срок {humanDate(a.due_date!)} · {STATUS_RU[a.status] ?? a.status}</small></li>)}</ul></div>}
            {due.length > 0 && <ul class="dd-tasks l-v l-g0">{due.map((a) => <li key={a.issue_id}>
              <span class="dd-subj l-v l-g1 l-grow"><b>{a.subject}</b><small>{a.title}{a.teacher_name ? ` · ${a.teacher_name}` : ""}</small></span>
              <span class={`hw-badge b-pill s-${a.status}`}>{STATUS_RU[a.status] ?? a.status}</span>
              {isOverdue({ due: a.due_date, status: a.status }, today) && <span class="dd-late f-m f-w6 f-bad l-fix as-c">просрочено</span>}
              {onSubject && <button type="button" class="dd-hub l-h l-inl l-jc l-g1 f-m f-w6 f-2 b-pill l-fix mw-44" onClick={() => onSubject(a.subject, a.title)}
                aria-label={`Разобрать тему: ${a.subject} — по заданию «${a.title}»`}><span class="dd-hub-t">Разобрать</span><Icon name="arrowRight" /></button>}
            </li>)}</ul>}
            {diaryTasks.length > 0 && <ul class="dd-tasks l-v l-g0">{diaryTasks.map((t, i) => <li key={`${t.title}${i}`}>
              <span class="dd-subj l-v l-g1 l-grow"><b>{t.title}</b><small>из школьного дневника · срок {humanDate(t.deadline!)}</small></span>
            </li>)}</ul>}
            {!due.length && !diaryTasks.length && !overdue.length && !(hw.err && !hw.data) && <p class="muted">На этот день сроков сдачи нет.</p>}
          </>}
      </Card>

      <Card title="Оценки за день" icon="cap" badge={grades.data?.is_stale || gradesFromCache(grades.data) ? <span class="src-badge sm warn">сохранённая копия</span> : undefined}>
        {gradesFromCache(grades.data) && gView === "ok" && <p class="dd-stale p-23 f-b mb-2 u-warn r-md" role="status">{GRADE_COPY.stale}</p>}
        {grades.busy && !grades.data ? <div class="sk" style="height:40px" role="status" aria-label="Загружаем оценки" />
          : gView === "privacy_hidden" ? <div class="dd-state l-h l-btw l-wrap"><p class="muted">{GRADE_COPY.privacy_hidden}</p>
              <button type="button" class="btn btn-secondary btn-sm" disabled={revealing} onClick={() => void reveal()}>{revealing ? "Открываем…" : "Показать"}</button></div>
          : gView === "upstream_error" ? <div class="dd-state l-h l-btw l-wrap"><p class="muted" role="status">{GRADE_COPY.upstream_error}</p>
              <button type="button" class="btn btn-secondary btn-sm" disabled={grades.busy} onClick={grades.retry}>{grades.busy ? "Обновляем…" : "Обновить"}</button></div>
          : gView === "sgo_unlinked" ? <div class="dd-state l-h l-btw l-wrap"><p class="muted">{GRADE_COPY.sgo_unlinked}</p>
              {gradesAllowed && !DEMO && <button type="button" class="btn btn-primary btn-sm" onClick={openOnboarding}>Подключить дневник</button>}</div>
          : gView === "empty" ? <p class="muted">{GRADE_COPY.empty}</p>
          : !dayGrades.length ? <p class="muted">В этот день оценок нет.</p>
          : <ul class="dd-grades l-v l-g0">{dayGrades.map((g, i) => <li key={g.grade_id ?? `${g.subject}${i}`}>
              <b class="num dd-mark l-center l-g0 f-s f-num b-tile l-fix">{g.value}</b><span class="dd-subj l-v l-g1 l-grow"><b>{g.subject}</b>{(g.work_type || g.topic) && <small>{[g.work_type, g.topic].filter(Boolean).join(" · ")}</small>}</span>
            </li>)}</ul>}
        {grades.data && gView === "ok" && dayGrades.length > 0 && <p class="hint-text">{dayGrades.length} {plural(dayGrades.length, "оценка", "оценки", "оценок")} · источник — снимок школьного дневника{grades.data.last_synced_at ? `, обновлён ${grades.data.last_synced_at.slice(0, 10).split("-").reverse().join(".")}` : ""}{typeof grades.data.average_score === "number" ? ` · средний балл ${grades.data.average_score.toFixed(2)}` : ""}</p>}
      </Card>
    </div>
  </section>;
}

/** v3.2 · ДЗ прямо в строке урока: задание учителя со сроком на этот день или запись школьного дневника по предмету. */
function lessonHw(subject: string, due: readonly { subject: string; title: string }[], diary: readonly { title: string }[]): string | null {
  const low = subject.toLowerCase();
  const a = due.find((x) => x.subject.toLowerCase() === low);
  if (a) return a.title;
  const d = diary.find((x) => x.title.toLowerCase().startsWith(low));
  if (!d) return null;
  return d.title.slice(subject.length).replace(/^\s*[:·—-]?\s*/, "") || d.title;
}

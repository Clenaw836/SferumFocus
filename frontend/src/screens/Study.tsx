import { DataProvenance } from '../ui/DataProvenance';
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { Progress } from "./Progress";
import { lazy } from "../ui/lazy";
/** v3.2 · PERF-01: учительский экран — отдельный чанк (ученик его не скачивает). */
const Teacher = lazy(() => import("../lazy/teacher").then((m) => m.Teacher));
import { api, ApiError, cache, type DiaryGrade } from "../lib/api";
import { GRADE_RULE_NOTE, goalLine, marksOf, schoolPhase, summary, toneOf } from "../lib/gradeGoal";
import { nowMin } from "../lib/clock";
import { schoolDayMin } from "../lib/schoolDay";
import { toMin, plural } from "../lib/time";
import { roomLabel } from "../lib/room";
import { principal } from "../lib/roleContext";
import type { InitialState, Quarter, Rewards, Role } from "../lib/types";
import { sched } from "../lib/schedStore";
import { addDays, describe, SOURCE_LABEL, weekdayOf, type DayView } from "../lib/schedule";
import { dayLabel } from "../lib/proposal";
import { toast } from "../ui/Toast";
import { DEMO } from "../lib/demo";
import { DiaryDay } from "../ui/DiaryDay";
import { GradeSim, type SimProps, type SimRequest } from "../ui/GradeSim";
export type StudySeg = "progress" | "diary" | "grades";
/** v3.2 · «Учёба» открывается первой: [Расписание и ДЗ | Оценки | Прогресс].
 *  Сверху — умная карточка учебного дня (сегодня на уроках / завтра после школы, переключатель в 1 тап),
 *  уроки с «Разобрать тему →», панель «Обновить домашнее задание» (вписать / по фото), дашборд оценок с целью в четверти. */
export function Study({ role, seg, onSeg, rewards, onRewards, initial, onSwitchRole, today, onReport, onStats, sim, onSubject, onPlan, onAddHw, plan, done, onHwDone }: {
    role: Role;
    seg: StudySeg;
    onSeg: (s: StudySeg) => void;
    rewards: Rewards | null;
    onRewards: (r: Rewards) => void;
    initial: InitialState;
    onSwitchRole: () => void;
    today: string;
    onReport: () => void;
    onStats?: () => void;
    /** v2.2: «Симулятор оценок» (ученик). */
    sim?: SimProps;
    /** v3.0 · нажатие на предмет урока/задания → развилка [Квиз-опрос | Практикум]. */
    onSubject?: (subject: string, hw?: string) => void;
    /** v3.2 · сводка «Сегодня: N заданий · ~X мин» → «План дня». */
    onPlan?: () => void;
    onAddHw?: (intent: "text" | "photo", prefill?: string) => void;
    plan?: { count: number; minutes: number };
    done?: readonly string[];
    onHwDone?: (title: string, done: boolean) => void;
}) {
    if (role === "teacher")
        return <Teacher onSwitchRole={onSwitchRole}/>;
    const tabs = <div class="st-seg"><Segmented label="Раздел учёбы" value={seg} onChange={onSeg} options={[{ value: "diary", label: "Расписание и ДЗ" }, { value: "grades", label: "Оценки" }, { value: "progress", label: "Прогресс" }]}/></div>;
    if (seg === "progress")
        return <Progress rewards={rewards} onRewards={onRewards} seg={tabs} onStats={onStats}/>;
    if (seg === "grades")
        return (<section class="screen study" aria-labelledby="st-h">
          <header class="scr-head"><h1 id="st-h">Оценки и средний балл</h1></header>
          {tabs}
          <GradeDashboard rewards={rewards} today={today} onSubject={onSubject} sim={sim}/>
        </section>);
    return (<section class="screen study diary-workspace" aria-labelledby="di-h">
      <header class="scr-head"><h1 id="di-h">Учёба</h1></header>
      {tabs}
      <Diary initial={initial} today={today} onReport={onReport} onSubject={onSubject} onPlan={onPlan} onAddHw={onAddHw} plan={plan} done={done} onHwDone={onHwDone}/>
      <DataProvenance initial={initial}/>
    </section>);
}
/** v3.2 · 4.1: учебный день идёт → «сегодня»; уроки закончились → автоматически «завтра» (ближайший учебный день). */
function StudyNow({ today, week, mode, onMode, onPlan, plan }: { today: string; week: number; mode: "today" | "next"; onMode: (m: "today" | "next") => void; onPlan?: () => void; plan?: { count: number; minutes: number } }) {
    const vt = sched.day(today), next = schoolDates(addDays(today, 1), 1, week)[0] ?? addDays(today, 1), vn = sched.day(next);
    const ph = schoolPhase(vt.lessons, schoolDayMin(nowMin()));
    const act = vt.lessons.filter((l) => l.status === "active");
    const cur = ph.current >= 0 ? act[ph.current] : null, nx = ph.next >= 0 ? act[ph.next] : null;
    const nAct = vn.lessons.filter((l) => l.status === "active");
    const toEnd = cur?.end_time ? Math.max(0, toMin(cur.end_time) - nowMin()) : null;
    const title = ph.phase === "after" ? "Уроки на сегодня закончились" : ph.phase === "none" ? "Сегодня уроков нет" : "Идёт учебный день";
    const sub = ph.phase === "after" || ph.phase === "none" ? `Готовимся на ${dayLabel(next, today).toLowerCase()}` : "Расписание и ДЗ на сегодня";
    const line = mode === "today"
        ? cur ? <>Сейчас <b>{cur.lesson_number}. {cur.subject}</b>{cur.room ? ` · ${roomLabel(cur.room)}` : ""}{toEnd !== null ? <> · до звонка <span class="num">{toEnd}</span> мин</> : null}</>
          : nx ? <>Дальше <b>{nx.lesson_number}. {nx.subject}</b> в <span class="num">{nx.start_time}</span>{nx.room ? ` · ${roomLabel(nx.room)}` : ""}</>
          : act.length ? <>Сегодня было <span class="num">{act.length}</span> {plural(act.length, "урок", "урока", "уроков")}</> : <>Сегодня уроков нет</>
        : nAct.length ? <>{dayLabel(next, today)}: <span class="num">{nAct.length}</span> {plural(nAct.length, "урок", "урока", "уроков")}, первый в <span class="num">{nAct[0].start_time ?? "—"}</span> — {nAct[0].subject}</> : <>{dayLabel(next, today)}: уроков нет</>;
    return (<section class={`st-now is-${ph.phase}`} aria-labelledby="st-now-h">
      <p class="st-now-k"><span class="st-dot" aria-hidden="true"/>{title}</p>
      <h2 id="st-now-h" class="st-now-t">{sub}</h2>
      <p class="st-now-l">{line}</p>
      <Segmented label="Какой день показать" value={mode} onChange={onMode} options={[{ value: "today", label: "Сегодня · на уроках" }, { value: "next", label: "Завтра · после школы" }]}/>
      {onPlan && plan && <button type="button" class="st-plan" onClick={onPlan}>
        <span>{plan.count ? <>Сегодня: <span class="num">{plan.count}</span> {plural(plan.count, "задание", "задания", "заданий")} · ~<span class="num">{plan.minutes}</span> мин</> : "Сегодня заданий нет"}</span>
        <b>План дня<Icon name="arrowRight"/></b></button>}
    </section>);
}
/** v3.2 · 4.3: «Обновить домашнее задание» — вписать/изменить или по фото (OCR/AI на сервере). */
function HwUpdate({ onAddHw }: { onAddHw: (i: "text" | "photo") => void }) {
    return (<section class="st-hw" aria-labelledby="st-hw-h">
      <h2 id="st-hw-h" class="h-sec">Обновить домашнее задание</h2>
      <p class="st-hw-p">Учитель поменял задание устно? Впиши его — план дня пересчитается.</p>
      <div class="st-hw-row">
        <button type="button" class="btn btn-secondary" onClick={() => onAddHw("text")}><Icon name="pen"/>Вписать или изменить ДЗ</button>
        <button type="button" class="btn btn-secondary" onClick={() => onAddHw("photo")}><Icon name="camera"/>Внести ДЗ по фото</button>
      </div>
    </section>);
}
/** v3.2 · 4.4: дашборд оценок — средний балл, тренд недели, карточки предметов, лента и цель в четверти. */
function GradeDashboard({ rewards, today, onSubject, sim }: { rewards: Rewards | null; today: string; onSubject?: (subject: string, hw?: string) => void; sim?: SimProps }) {
    const [chip, setChip] = useState<SimRequest | null>(null);
    const [list, setList] = useState<DiaryGrade[] | null>(null);
    const allowed = DEMO || !!principal()?.uid;
    useEffect(() => { let alive = true; if (allowed) api.diaryGrades().then((d) => { if (alive) setList(d?.grades ?? []); }).catch(() => { if (alive) setList([]); }); else setList([]); return () => { alive = false; }; }, []);
    const subjects = rewards?.grades ?? [];
    if (!rewards) return <div class="sk" style="height:120px" aria-label="Загружаем оценки"/>;
    if (!subjects.length) return <p class="muted" role="status">Оценок пока нет — они появятся после загрузки из дневника.</p>;
    const feed = list ?? [];
    const s = summary(feed, subjects, today);
    return (<>
      <section class="gd-sum" aria-label="Сводка оценок">
        <div class="gd-avg"><span class="gd-k">Средний балл</span><b class="num">{s.avg !== null ? s.avg.toFixed(2) : "—"}</b>
          {s.trend !== 0 && <span class={`gd-trend ${s.trend > 0 ? "up" : "down"} num`}>{s.trend > 0 ? "+" : "−"}{Math.abs(s.trend).toFixed(2)} за неделю</span>}</div>
        <dl class="gd-stats">
          <div><dt>Пятёрок</dt><dd class="num">{s.fives}</dd></div>
          <div><dt>Четвёрок</dt><dd class="num">{s.fours}</dd></div>
          <div><dt>В зоне риска</dt><dd class="num">{s.risk}</dd></div>
        </dl>
      </section>
      <ul class="grades l-v l-g1 f-num gd-list">
        {subjects.map((g) => {
            const marks = marksOf(feed, g.subject), goal = goalLine(marks), tone = toneOf(g.average);
            const items = feed.filter((x) => x.subject === g.subject).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
            const t = TREND[g.trend] ?? TREND.flat;
            return (<li key={g.subject} class={`gd-subj t-${tone}`}>
              <div class="gd-row"><span class="g-name">{g.subject}<span class="sr">: средний {g.average.toFixed(2)}, {t[1]}</span></span>
                <span class={`trend t-${t[0]}`} aria-hidden="true"><Icon name={t[0]}/></span>
                <b class={`num gd-val t-${tone}`} aria-hidden="true">{g.average.toFixed(2)}</b></div>
              {items.length > 0 && <ol class="gd-feed" aria-label={`Последние оценки: ${g.subject}`}>{items.map((x, i) => <li key={x.grade_id ?? i} title={[x.work_type, x.topic].filter(Boolean).join(" · ")}>
                <b class="num grade-badge" data-grade={String(x.value)}>{x.value}</b><span class="num">{x.date.slice(8, 10)}.{x.date.slice(5, 7)}</span>{x.work_type && <small>{workLabel(x.work_type)}</small>}</li>)}</ol>}
              <p class={`gd-goal${goal.reached ? " ok" : ""}`}>{goal.text}</p>
              <div class="gd-acts">
                {onSubject && !goal.reached && <button type="button" class="btn btn-secondary btn-sm" onClick={() => onSubject(g.subject)}><Icon name="target"/>Подтянуть тему в Практикуме</button>}
                {sim && g.average < 4 && <button type="button" class="g-fix l-h l-inl l-jc l-g1 f-b f-w6 f-a b-pill l-fix mw-44 btn btn-ghost btn-sm" onClick={() => setChip({ subject: g.subject, at: Date.now() })}
                  aria-label={`Исправить: ${g.subject} — открыть симулятор оценок`}><span class="g-fix-t">Исправить</span></button>}
              </div>
            </li>);
        })}
      </ul>
      <p class="gd-note hint-text">{GRADE_RULE_NOTE}</p>
      {sim && <GradeSim demo={sim.demo} request={chip ?? sim.request} onConsumed={() => { setChip(null); sim.onConsumed(); }}
        onTutor={sim.onTutor} onMission={sim.onMission} lowCount={subjects.filter((g) => g.average < 4).length}/>}
    </>);
}
const workLabel = (w: string) => /контр/i.test(w) ? "Контрольная" : /дом|дз/i.test(w) ? "ДЗ" : /блиц|тест/i.test(w) ? "Блиц" : /ответ|устн/i.test(w) ? "Ответ на уроке" : w.slice(0, 18);
const WD: Record<string, string> = { monday: "Пн", tuesday: "Вт", wednesday: "Ср", thursday: "Чт", friday: "Пт", saturday: "Сб", sunday: "Вс" };
const TREND = { up: ["up", "растёт"], down: ["down", "падает"], flat: ["flat", "ровно"] } as const;
/** Ближайшие учебные дни недели (5 или 6), начиная с сегодня. */
function schoolDates(today: string, n: number, week: number): string[] {
    const out: string[] = [];
    for (let i = 0; out.length < n && i < 14; i++) {
        const d = addDays(today, i), w = weekdayOf(d);
        if (w === "sunday" || (w === "saturday" && week < 6))
            continue;
        out.push(d);
    }
    return out;
}
function LessonList({ v }: {
    v: DayView;
}) {
    if (!v.available && !v.lessons.length)
        return <span class="faint">нет данных — сообщи расписание</span>;
    if (!v.lessons.length)
        return <span class="faint">выходной</span>;
    return (<ol class="ql">
      {v.lessons.map((l) => {
            const chg = l.source !== "real" && l.source !== "demo";
            return <li key={`${l.lesson_number}${l.subject}`} class={l.status !== "active" ? "off" : chg ? "chg" : ""}>
          <span class="num faint">{l.lesson_number}</span>{l.status !== "active" ? <s>{l.subject}</s> : l.subject}
          {l.was && l.status === "active" && <span class="faint"> · вместо {l.was}</span>}{l.note && <span class="ls-note"> · {l.note}</span>}
          {chg && <span class="src-badge sm">{SOURCE_LABEL[l.source]}</span>}{l.status !== "active" && <span class="sr"> — отменён</span>}
        </li>;
        })}
    </ol>);
}
function History({ today }: {
    today: string;
}) {
    const list = [...sched.changes()].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 12);
    if (!list.length)
        return null;
    return (<>
      <div class="sec-head"><h2 class="h-sec">История изменений</h2>{sched.pending() && !DEMO && <span class="faint" style="font-size:calc(12px*var(--fs,1))">ждёт связи</span>}</div>
      <ul class="hist">
        {list.map((c) => {
            const d = describe(c);
            return (<li key={c.id} class={c.status === "reverted" ? "off" : ""}>
            <span class="hist-ico" aria-hidden="true"><Icon name={d.icon} /></span>
            <span class="hist-main"><b>{dayLabel(c.date, today)}</b> · {d.text}<span class="faint" style="display:block">{SOURCE_LABEL[c.source]}{c.created_at ? ` · ${c.created_at.slice(11, 16)}` : ""}{c.status === "reverted" ? " · отменено" : ""}</span></span>
            {c.status === "applied" && <button class="btn btn-ghost btn-sm" onClick={() => { sched.revert(c.id); toast("Изменение отменено — расписание как было", "ok"); }}>Отменить изменение</button>}
          </li>);
        })}
      </ul>
    </>);
}
function Diary({ initial, today, onReport, onSubject, onPlan, onAddHw, plan, done, onHwDone }: {
    onSubject?: (subject: string, hw?: string) => void;
    initial: InitialState;
    today: string;
    onReport: () => void;
    onPlan?: () => void;
    onAddHw?: (intent: "text" | "photo", prefill?: string) => void;
    plan?: { count: number; minutes: number };
    done?: readonly string[];
    onHwDone?: (title: string, done: boolean) => void;
}) {
    const [, setV] = useState(0);
    useEffect(() => sched.on(() => setV((v) => v + 1)), []);
    const week = sched.schoolWeek(initial.settings.school_week_days ?? 5);
    const dates = schoolDates(today, week, week);
    const nextDay = schoolDates(addDays(today, 1), 1, week)[0] ?? addDays(today, 1);
    const [mode, setMode] = useState<"today" | "next">(() => schoolPhase(sched.day(today).lessons, schoolDayMin(nowMin())).phase === "after" || !sched.day(today).lessons.length ? "next" : "today");
    const [focus, setFocus] = useState(() => ({ date: mode === "next" ? nextDay : today, n: 0 }));
    const pick = (m: "today" | "next") => { setMode(m); setFocus((f) => ({ date: m === "next" ? nextDay : today, n: f.n + 1 })); };
    const [q, setQ] = useState<Quarter | null>(cache.get<Quarter>("sf.quarter"));
    const [err, setErr] = useState<string | null>(null);
    const load = () => { setErr(null); api.quarter().then((x) => { setQ(x); cache.set("sf.quarter", x); }).catch((e) => setErr(e instanceof ApiError ? e.message : "Не загрузилось")); };
    useEffect(load, []);
    return (<>
      <StudyNow today={today} week={week} mode={mode} onMode={pick} onPlan={onPlan} plan={plan}/>
      <DiaryDay today={today} initial={initial} schoolWeek={week === 6 ? 6 : 5} onSubject={onSubject} focus={focus} done={done} onHwDone={onHwDone} onAddHw={onAddHw ? (pre) => onAddHw("text", pre) : undefined}/>
      {onAddHw && <HwUpdate onAddHw={onAddHw}/>}
      <div class="report"><span>Расписание изменилось?</span><button class="btn btn-secondary btn-sm" onClick={onReport}><Icon name="plus"/>Сообщить об изменении</button></div>
      <details class="st-more">
        <summary>Учебная неделя и история изменений{q && <span class="faint num"> · четверть до {q.quarter_end.slice(8, 10)}.{q.quarter_end.slice(5, 7)}</span>}</summary>
        <div class="st-week-days"><Segmented label="Учебных дней в неделе" value={String(week)} onChange={(v) => sched.setSchoolWeek(v === "6" ? 6 : 5)} options={[{ value: "5", label: "5 дней · ПН–ПТ" }, { value: "6", label: "6 дней · ПН–СБ" }]}/></div>
        {err && !q && <div class="note bad"><Icon name="alert"/><div>{err} <button class="btn btn-ghost btn-sm" onClick={load}>Повторить</button></div></div>}
        <div class="qdays">
          {dates.map((date) => {
              const v = sched.day(date);
              const qd = q?.days.find((x) => x.date === date);
              return (<div key={date} class={`qday${v.changed ? " changed" : ""}`}>
              <div class="qday-h"><b>{WD[v.weekday] ?? v.weekday}</b><span class="num faint">{date.slice(8, 10)}.{date.slice(5, 7)}</span>{v.changed && <span class="src-badge sm warn">изменено</span>}</div>
              <LessonList v={v}/>
              {qd?.substitutions.map((s, i) => <div key={i} class="qsub" role="note"><Icon name="alert"/><span>{s.slot}: {s.was} → <b>{s.became}</b> ({s.reason})</span></div>)}
            </div>);
          })}
        </div>
        <History today={today}/>
      </details>
    </>);
}

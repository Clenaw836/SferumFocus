import { useRef, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { TutorChat } from "../ui/TutorChat";
import { MaterialsSearch } from "../ui/MaterialsSearch";
import { useTutorClearance } from "./useTutorClearance";
import { Segmented } from "../ui/Segmented";
import { splitTitle, subjectColor } from "../lib/subjects";
import type { Lesson } from "../lib/schedule";
import type { Task } from "../lib/types";
const GENERAL = "Другое";
type Day = "today" | "tomorrow";
type Kind = "hw" | "lesson";
interface Opt {
    id: string;
    subject: string;
    detail: string | null;
    context: string | null;
    done?: boolean;
}
interface Props {
    recoveryContext?: string | null;
    tasks: Task[];
    done: string[];
    initial?: string | null;
    /** v17.1: задания на завтра (перенесённые/добавленные) и уроки сегодня/завтра — для выбора предмета */
    tomorrowTasks?: Task[];
    lessonsToday?: Lesson[];
    lessonsTomorrow?: Lesson[];
}
const lessonOpts = (ls: Lesson[] | undefined, when: string): Opt[] => {
    const seen = new Set<string>();
    return (ls ?? []).filter((l) => l.status !== "cancelled" && !seen.has(l.subject) && seen.add(l.subject)).map((l) => {
        const time = l.start_time ? `${l.start_time}${l.end_time ? `–${l.end_time}` : ""}` : null;
        const topic = (l as Lesson & {
            topic?: string | null;
        }).topic ?? null;
        return { id: `L:${l.subject}`, subject: l.subject, detail: [`${l.lesson_number}-й урок ${when}`, time, topic].filter(Boolean).join(" · "),
            context: `Подготовка к уроку: ${l.subject} (${when}${time ? `, ${time}` : ""})${topic ? `. Тема: ${topic}` : ""}` };
    });
};
const taskOpts = (ts: Task[], done: string[]): Opt[] => [...ts.filter((t) => !done.includes(t.title)), ...ts.filter((t) => done.includes(t.title))]
    .map((t) => ({ id: t.title, subject: splitTitle(t.title).subject, detail: splitTitle(t.title).detail || null, context: t.title, done: done.includes(t.title) }));
/** Вкладка «Репетитор»: день (сегодня/завтра) × что (д/з/урок) → предмет → тот же TutorChat. */
export function Tutor({ tasks, done, initial, recoveryContext, tomorrowTasks = [], lessonsToday, lessonsTomorrow }: Props) {
    const screen = useTutorClearance();
    const [expanded, setExpanded] = useState(false);
    const [day, setDay] = useState<Day>("today");
    const [kind, setKind] = useState<Kind>("hw");
    const base = kind === "hw" ? taskOpts(day === "today" ? tasks : tomorrowTasks, done)
        : lessonOpts(day === "today" ? lessonsToday : lessonsTomorrow, day === "today" ? "сегодня" : "завтра");
    if (recoveryContext) {
        // «Предмет: тема» из «Что, если…»/«Спокойно исправим» — тема видна сразу, без готовых ответов.
        const cut = recoveryContext.indexOf(':');
        const topic = cut >= 0 ? recoveryContext.slice(cut + 1).trim() : '';
        base.unshift({ id: 'recovery', subject: cut >= 0 ? recoveryContext.slice(0, cut) : recoveryContext,
            detail: topic && topic !== 'Разобрать тему' ? `Спокойно разберём: ${topic}` : 'Спокойно разберём тему шаг за шагом', context: recoveryContext });
    }
    const all: Opt[] = [...base, { id: GENERAL, subject: GENERAL, detail: null, context: null }];
    const [pickId, setPick] = useState<string>(recoveryContext ? "recovery" : initial ?? "");
    const pick = all.find((o) => o.id === pickId) ?? all[0];
    const ref = useRef<HTMLDivElement>(null);
    const onKey = (e: KeyboardEvent) => {
        const i = all.indexOf(pick);
        const n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
        if (n === null)
            return;
        e.preventDefault();
        setPick(all[(n + all.length) % all.length].id);
        requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    };
    const general = pick.id === GENERAL;
    const empty = base.length === 0;
    return (<section class="screen tu-compact" aria-labelledby="tu-h" ref={screen}>
      <header class="chat-header l-h l-g3 f-nw mb-6 o-h p-abs"><span class="tutor-avatar l-center l-g0 r-lg u-sel"><Icon name="bot"/></span><div><h1 id="tu-h">ИИ-тьютор</h1><p class="f-2">Рядом, когда нужна помощь</p></div></header><div class="tutor-workspace l-v l-g0"><aside class="tutor-context-rail b-card mb-4">
      {/* ЗАДАЧА — фокус экрана: над чем думаем прямо сейчас */}
      <div class="tu-task b-bare" style={{ "--c": general ? "var(--ink-3)" : subjectColor(pick.subject) }}>
        <p class="tu-k l-h f-c f-w6 f-2 mb-1"><i aria-hidden="true"/>{day === "today" ? "Сегодня" : "Завтра"} · {general ? "Вопрос" : pick.id === "recovery" ? "Исправляем оценку" : kind === "lesson" ? "К уроку" : "Д/З"}</p>
        <h2 class="tu-title f-s mb-1">{general ? "Любой вопрос по учёбе" : pick.subject}</h2>
        {!general && pick.detail && <p class="tu-detail f-m f-2">{pick.detail}</p>}
      </div>
      <button type="button" class="btn btn-secondary btn-sm tu-context-toggle f-c f-a b-bare b-tap mt-2 l-w100 mw-full" aria-expanded={expanded} aria-controls="tu-context-options" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Скрыть выбор задания" : "Изменить задание"}
      </button>
      <div id="tu-context-options" hidden={!expanded}>
      <div class="tu-filters l-c2 mt-4 mb-4">
        <Segmented label="День" value={day} onChange={(v) => { setDay(v); setPick(""); }} options={[{ value: "today", label: "Сегодня" }, { value: "tomorrow", label: "Завтра" }]}/>
        <Segmented label="Что разбираем" value={kind} onChange={(v) => { setKind(v); setPick(""); }} options={[{ value: "hw", label: "Д/З" }, { value: "lesson", label: "К уроку" }]}/>
      </div>
      <p class="tu-pick-l f-m f-2 mt-4 mb-2" id="tu-l">{kind === "hw" ? `Д/З ${day === "today" ? "на вечер" : "на завтра"}` : `Уроки ${day === "today" ? "сегодня" : "завтра"}`}</p>
      {empty && <p class="hint-text" style="margin-top:0">{kind === "hw" ? (day === "today" ? "Заданий на вечер нет." : "На завтра заданий пока нет — перенесённые и добавленные появятся здесь.") : "Расписания на этот день нет — уроков не придумываем. Собери или импортируй расписание на экране «План дня»."}</p>}
      <div class="tutor-pick l-h l-wrap l-g1" role="radiogroup" aria-labelledby="tu-l" ref={ref} onKeyDown={onKey}>
        {all.map((o) => (<button key={o.id} type="button" role="radio" class="chip" aria-checked={pick.id === o.id ? "true" : "false"} tabIndex={pick.id === o.id ? 0 : -1} onClick={() => setPick(o.id)}>
            {o.id !== GENERAL && <span class="chip-dot" style={{ background: subjectColor(o.subject) }} aria-hidden="true"/>}
            {o.subject}{o.done ? <span class="sr">, сделано</span> : ""}
          </button>))}
      </div>
      </div>
      <MaterialsSearch />
      </aside><div class="tutor-conversation b-bare">
      <TutorChat key={`${day}|${kind}|${pick.id}`} context={pick.context}/></div></div>
    </section>);
}

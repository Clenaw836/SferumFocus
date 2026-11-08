/**
 * Таймер задания: «Начать задание → В работе → (Пауза) → (Время вышло) → Задание завершено».
 * Время — из timestamps (lib/focus), рендер 1 раз в секунду только этого компонента;
 * типографическое табло и линейный индикатор показывают фактическое состояние.
 * Скринридер не слышит каждую секунду: объявляем смену состояния и каждые 5 минут.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { completionDisposition } from "../lib/completionOutcome";
import { TaskCompletionStatus } from "./TaskCompletionStatus";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";
import { api } from "../lib/api";
import { haptic } from "../lib/host";
import { BREAK_SEC, breakLeftSec, elapsedMs, focus, mmss, POMO_SEC, taskLeftSec, useFocusSession, useSecondClock } from "../lib/focus";
import { hwElapsed } from "../lib/hwSync";
import { splitTitle, subjectColor } from "../lib/subjects";
import type { Task } from "../lib/types";
export interface DoneInfo {
    gained: number | null;
    streak: number | null;
    allDone: boolean;
    synced: boolean;
    /** false means persistence failed, not merely a pending server ACK. */
    saved?: boolean;
}
interface Props {
    task: Task;
    onFinish: (t: Task) => Promise<DoneInfo | void>;
    onOpenOther: (title: string) => void;
    next: {
        label: string;
        onClick: () => void;
    } | null;
    blitz: {
        label: string;
        onClick: () => void;
    } | null;
    onClose: () => void;
    compact?: boolean;
    completed?: boolean;
    onExpand?: () => void;
}
export function StudyTimer({ task, onFinish, onOpenOther, next, blitz, onClose, compact = false, completed = false, onExpand }: Props) {
    const s = useFocusSession();
    const mine = s && s.title === task.title ? s : null;
    const other = s && s.title !== task.title ? s : null;
    const now = useSecondClock(!!mine && (mine.pausedAt === null || !!mine.breakAt));
    const long = task.planned_minutes > 25;
    const [mode, setMode] = useState<"pomo" | "full">(long ? "pomo" : "full");
    const [busy, setBusy] = useState(false);
    const [finishError, setFinishError] = useState<string | null>(null);
    const finishing = useRef(false);
    const timerRoot = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!finishError) return;
        const frame = requestAnimationFrame(() => timerRoot.current?.querySelector<HTMLElement>("[data-finish-task]")?.scrollIntoView({ block: "nearest", behavior: "auto" }));
        return () => cancelAnimationFrame(frame);
    }, [finishError]);
    const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; if (armedTimer.current !== null) clearTimeout(armedTimer.current); }; }, []);
    const [done, setDone] = useState<{
        worked: number;
        planned: number;
        info: DoneInfo | null;
    } | null>(null);
    const [bot, setBot] = useState(false);
    const [say, setSay] = useState("");
    const [armed, setArmed] = useState(false);
    const { subject } = splitTitle(task.title);
    const plannedSec = mine ? mine.plannedSec : (mode === "pomo" ? 25 : task.planned_minutes) * 60;
    const el = mine ? Math.floor(elapsedMs(mine, now) / 1000) : 0;
    const left = Math.max(0, plannedSec - el);
    const over = Math.max(0, el - plannedSec);
    const bLeft = mine?.breakAt ? breakLeftSec(mine, now) : 0;
    const state: "before" | "run" | "pause" | "over" | "break" | "rested" = !mine ? "before"
        : mine.breakAt ? (bLeft > 0 ? "break" : "rested")
            : el >= plannedSec ? "over" : mine.pausedAt !== null ? "pause" : "run";
    const resting = state === "break" || state === "rested";
    const pomoMode = mine ? !!mine.pomo : mode === "pomo" && long;
    const roundStart = mine?.pomo ? (mine.roundStartedSec ?? Math.min(plannedSec, ((mine.round ?? 1) - 1) * POMO_SEC)) : 0;
    const segmentSec = plannedSec - roundStart;
    const segmentElapsed = mine?.pomo ? Math.min(segmentSec, Math.max(0, segmentSec - left)) : el;
    const p = resting ? 1 - bLeft / BREAK_SEC : Math.min(1, segmentElapsed / Math.max(1,segmentSec));
    const rounds = mine?.pomo ? Math.max(1, Math.ceil((mine.taskSec ?? plannedSec) / POMO_SEC)) : 0;
    const round = mine?.round ?? 1;
    // Помидор закончился, а норматив задания ещё не закрыт → следующий шаг — перерыв, а не «Закончил»
    const moreWork = !!mine?.pomo && taskLeftSec(mine, now) > 0;
    const anotherRound = pomoMode && (mine?.taskSec ?? task.planned_minutes * 60) > Math.max(plannedSec, el);
    // объявления для скринридера: смена состояния + каждые 5 минут остатка
    const lastBucket = useRef(-1);
    useEffect(() => {
        if (state !== "run") {
            lastBucket.current = -1;
            return;
        }
        const b = Math.ceil(left / 300);
        if (lastBucket.current !== -1 && b !== lastBucket.current && left > 0)
            setSay(`Осталось ${Math.ceil(left / 60)} мин`);
        lastBucket.current = b;
    }, [left, state]);
    useEffect(() => {
        if (state === "over")
            setSay(moreWork ? `Помидор ${round} готов. Перерыв 5 минут или закончить` : "Время вышло. Можно закончить или добавить 5 минут");
        else if (state === "pause")
            setSay("Пауза");
        else if (state === "break")
            setSay("Перерыв 5 минут. Встань, разомнись");
        else if (state === "rested") {
            setSay("Перерыв окончен. Следующий помидор");
            haptic.notify("success");
        }
    }, [state]);
    const remind = (sec: number | null) => {
        api.focusReminder({ subject, ends_in_sec: sec, cancel: sec === null }).then((r) => setBot(r.scheduled)).catch(() => setBot(false));
    };
    const start = () => {
        if (other || mine)
            return; // Старт → Старт: идемпотентно
        focus.start(task.title, plannedSec, { pomo: mode === "pomo" && long, taskSec: task.planned_minutes * 60, elapsedSec: hwElapsed(task.title) });
        haptic.tap("medium");
        setSay(`Таймер запущен: ${Math.round(plannedSec / 60)} минут`);
        remind(plannedSec);
    };
    const lastToggle = useRef(0);
    const toggle = () => {
        if (!mine || Date.now() - lastToggle.current < 400)
            return; // Пауза → Пауза двойным тапом не превращается в «Продолжить»
        lastToggle.current = Date.now();
        if (mine.pausedAt === null) {
            focus.pause();
            remind(null);
            haptic.tap("light");
        }
        else {
            focus.resume();
            haptic.tap("light");
            setSay("Продолжаем");
            const cur = focus.get();
            if (cur)
                remind(Math.max(0, cur.plannedSec - Math.floor(elapsedMs(cur) / 1000)));
        }
    };
    const extend = () => {
        // +5 минут к плану: отработанное время не трогаем (оно из timestamps), «время вышло» снова впереди
        const cur = focus.extend(300);
        if (!cur)
            return;
        remind(Math.max(0, cur.plannedSec - Math.floor(elapsedMs(cur) / 1000)));
        setSay("Плюс 5 минут");
        haptic.tap("light");
    };
    const rest = () => { focus.takeBreak(); remind(null); haptic.tap("light"); };
    const nextRound = () => {
        focus.nextRound();
        haptic.tap("medium");
        const cur = focus.get();
        if (cur) {
            remind(Math.max(0, cur.plannedSec - Math.floor(elapsedMs(cur) / 1000)));
            setSay(`Помидор ${cur.round ?? 2}: ${Math.round((cur.plannedSec - Math.floor(elapsedMs(cur) / 1000)) / 60)} минут`);
        }
    };
    const finish = async () => {
        if (finishing.current || !mine) return;
        finishing.current = true;
        setBusy(true); setFinishError(null); setSay("Сохраняем результат");
        const worked = Math.floor(elapsedMs(mine) / 1000), planned = mine.taskSec ?? task.planned_minutes * 60;
        try {
            const info = await onFinish(task);
            if (!alive.current) return;
            if (completionDisposition(info) === "failed") {
                setFinishError("Не удалось сохранить завершение. Таймер сохранён. Освободи место и нажми «Закончил» ещё раз.");
                setSay("Завершение не сохранено. Можно повторить.");
                return;
            }
            remind(null);
            setDone({ worked, planned, info: info ?? null });
            setSay("Задание завершено");
            armedTimer.current = setTimeout(() => setArmed(true), 450);
        } catch {
            if (alive.current) { setFinishError("Не удалось подтвердить завершение. Результат требует проверки. Проверь соединение и повтори."); setSay("Не удалось подтвердить завершение"); }
        } finally {
            finishing.current = false;
            if (alive.current) setBusy(false);
        }
    };
    if (completed && !done)
        return compact ? null : <TaskCompletionStatus task={task} done={completed}/>;
    if (done) {
        const diff = done.worked - done.planned;
        const diffTxt = Math.abs(diff) < 60 ? "точно в план" : `${diff > 0 ? "+" : "−"}${Math.round(Math.abs(diff) / 60)} мин`;
        return (<div class="st pt-2 f-num f-tc st-done" style={{ "--c": subjectColor(task.title) }}>
        <div class="st-medal l-center l-g0 b-round l-mx l-rel" aria-hidden="true"><Icon name="check"/><span class="ring-burst"/></div>
        <h3 class="h-title" style="margin-top:20px">Задание завершено</h3>
        <p class="muted" style="margin:6px 0 0">{subject}{done.info?.allDone ? " — и это было последнее. Вечер свободен." : ""}</p>
        <dl class="duel-facts py-3 l-c3 l-g0 b-sep mt-6" style="margin-top:20px">
          <div><dt class="f-w6">Работа</dt><dd class="num f-w6">{mmss(done.worked)}</dd></div>
          <div><dt class="f-w6">План</dt><dd class="num f-w6">{mmss(done.planned)}</dd></div>
          <div><dt class="f-w6">Разница</dt><dd class={`num ${diff > 60 ? "st-d-over f-warn" : "st-d-under f-ok"}`}>{diffTxt}</dd></div>
        </dl>
        {busy ? <div class="bz-reward l-h l-jc f-b mt-4 r-md u-acc-s p-3" role="status"><span class="sk" style="display:inline-block;width:160px;height:12px"/></div> : done.info?.synced === false ? (<div class="note warn st-sync-pending" role="status"><Icon name="wifiOff"/><div><b>Выполнено на этом устройстве</b><p>Сервер не подтвердил результат. Очки и статистика пока не обновлены.</p></div></div>) : done.info && (done.info.gained || done.info.streak) ? (<div class="bz-reward l-h l-jc f-b mt-4 r-md u-acc-s p-3" role="status"><Icon name="flame"/><span>
            {done.info.gained ? <><b class="num f-a">+{done.info.gained}</b> очков</> : "Засчитано"}
            {done.info.streak ? <> · стрик <b class="num f-a">{done.info.streak}</b> дн.</> : null}
            {" · в «Моей неделе» — фактические минуты"}
          </span></div>) : <div class="bz-reward l-h l-jc f-b mt-4 r-md u-acc-s p-3" role="status"><Icon name="check"/><span>Отмечено. Фактическое время ушло в «Мою неделю».</span></div>}
        <div class="stack" style="margin-top:20px" inert={!armed || undefined}>
          {blitz && <button class="btn btn-primary btn-block btn-hero" onClick={blitz.onClick} data-autofocus><Icon name="bolt"/>{blitz.label}</button>}
          {next
                ? <button class={`btn ${blitz ? "btn-secondary" : "btn-primary btn-hero"} btn-block`} onClick={next.onClick}>{next.label}<Icon name="chevron"/></button>
                : <button class="btn btn-secondary btn-block" onClick={onClose}>К вечеру</button>}
        </div>
      </div>);
    }
    const label = state === "before" ? "Начать задание" : state === "run" ? "В работе" : state === "pause" ? "Пауза"
        : state === "break" ? "Перерыв" : state === "rested" ? "Перерыв окончен" : moreWork ? `Помидор ${round} готов` : "Время вышло";
    const big = resting ? mmss(bLeft) : state === "over" ? `+${mmss(over)}` : mmss(state === "before" ? plannedSec : left);
    const sub = state === "before" ? `ориентир по нормативу · ${task.planned_minutes} мин`
        : resting ? `работа ${mmss(el)} · дальше ${round + 1}/${Math.max(rounds, round + 1)}`
            : rounds ? `помидор ${round}/${Math.max(rounds, round)} · ${mmss(segmentElapsed)} из ${mmss(segmentSec)}`
                : `прошло ${mmss(el)} · план ${mmss(plannedSec)}`;
    return (<div ref={timerRoot} class={`st pt-2 f-num f-tc st-${state}${resting ? " st-rest" : ""}${compact ? " st-compact" : ""}`} style={{ "--c": subjectColor(task.title) }}>
      {!compact && state === "before" && long && (<Segmented label="Режим таймера" value={mode} onChange={setMode} options={[{ value: "pomo", label: "Помидор · 25 мин" }, { value: "full", label: `Целиком · ${task.planned_minutes} мин` }]}/>)}
      <div class={compact ? "st-compact-readout l-rel" : "focus-readout mt-6 mb-6 l-mx l-rel"} role="timer" aria-live="off" aria-label={`${label}. ${resting ? `Отдых: осталось ${Math.ceil(bLeft / 60)} мин` : state === "over" ? `Сверх плана ${Math.floor(over / 60)} мин` : `Осталось ${Math.ceil(left / 60)} мин из ${Math.round(segmentSec / 60)}`}`}>
        {!compact && <svg class="focus-orbit l-w100 l-fill" viewBox="0 0 240 240" aria-hidden="true"><defs><linearGradient id="focus-ring" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#059669"/><stop offset=".52" stop-color="#10B981"/><stop offset="1" stop-color="#A7F3D0"/></linearGradient></defs><circle class="orbit-track" cx="120" cy="120" r="108"/><circle class="orbit-value" cx="120" cy="120" r="108" pathLength="100" stroke-dasharray={`${Math.max(0,Math.min(100,(1-p)*100))} 100`}/></svg>}
        <div class="st-center py-2 l-v l-jc l-ac l-fill">
          <span class="st-label l-h l-inl l-g1 f-c f-a"><i class="st-dot"/>{compact ? `Работа · ${label}` : label}</span>
          <span class="st-big f-xl f-2 num">{big}</span>
          <span class="st-sub f-c f-3 num">{sub}</span>
        </div>
      </div>
      {!compact && <div class="focus-session-detail b-card mb-4"><p class="session-next l-h f-m mb-3"><Icon name="timer"/>{pomoMode ? resting ? 'Перерыв · 5 минут' : `${Math.ceil(segmentSec / 60)} мин работы · ${anotherRound ? 'затем перерыв 5 мин' : 'последний отрезок'}` : 'Работа целиком · можно поставить на паузу'}</p><div class="focus-track b-box b-nob o-h" role="progressbar" aria-label={resting ? 'Прогресс перерыва' : 'Прогресс рабочего отрезка'} aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, p * 100))}%` }}/></div><div class="focus-facts pt-3 l-h l-btw"><div><span class="f-3">Всего работал</span><b class="num">{mmss(el)}</b></div><div><span class="f-3">План задания</span><b class="num">{mmss(task.planned_minutes * 60)}</b></div><div><span class="f-3">{resting ? 'Сейчас' : 'Режим'}</span><b>{resting ? 'Перерыв' : pomoMode ? '25 / 5' : 'Целиком'}</b></div></div><p class="hint-text">{resting ? 'Отдых не входит в рабочее время.' : 'Пауза сохранит время. Завершай, когда закончишь задание.'}</p></div>}
      {finishError && <div class="note bad st-finish-error mt-3 mb-3" role="alert"><Icon name="alert"/><span>{finishError}</span></div>}
      {busy && <p class="st-finish-status f-b f-2" role="status">Сохраняем результат…</p>}
      <p class="sr" role="status" aria-live="polite">{say}</p>

      {compact && <button type="button" class="btn btn-ghost btn-sm" onClick={onExpand}>Открыть полный таймер</button>}
      {!compact && (other ? (<div class="note" style="margin-top:8px"><Icon name="timer"/><div>Сейчас в работе «{splitTitle(other.title).subject}». Один фокус за раз — так быстрее.
          <button class="btn btn-ghost btn-sm" onClick={() => onOpenOther(other.title)}>Перейти</button></div></div>) : state === "before" ? (<button class="btn btn-primary btn-block btn-hero st-go" onClick={start} data-autofocus><Icon name="play"/>Старт</button>) : resting ? (<div class="stack">
          <button class="btn btn-primary btn-block btn-hero" onClick={nextRound} data-autofocus><Icon name="play"/>{state === "rested" ? "Следующий помидор" : "Хватит отдыхать — дальше"}</button>
          <button class={`btn btn-ghost btn-block${busy ? " is-loading" : ""}`} data-finish-task onClick={finish} disabled={busy}><Icon name="check"/>Закончил задание</button>
        </div>) : state === "over" && moreWork ? (<div class="stack">
          <button class="btn btn-primary btn-block btn-hero" onClick={rest} data-autofocus><Icon name="timer"/>Перерыв 5 минут</button>
          <button class={`btn btn-secondary btn-block${busy ? " is-loading" : ""}`} data-finish-task onClick={finish} disabled={busy}><Icon name="check"/>Закончил задание</button>
        </div>) : state === "over" ? (<div class="stack">
          <button class={`btn btn-ok btn-block btn-hero${busy ? " is-loading" : ""}`} data-finish-task onClick={finish} disabled={busy} data-autofocus><Icon name="check"/>Закончил</button>
          <button class="btn btn-ghost btn-block" onClick={extend}>Ещё 5 минут</button>
        </div>) : (<div class="st-ctl l-c2 l-g3">
          <button class="btn btn-secondary st-toggle" onClick={toggle} aria-pressed={state === "pause"}>
            <Icon name={state === "pause" ? "play" : "pause"}/>{state === "pause" ? "Продолжить" : "Пауза"}
          </button>
          <button class={`btn btn-ok${busy ? " is-loading" : ""}`} data-finish-task onClick={finish} disabled={busy}><Icon name="check"/>Закончил</button>
        </div>))}
      {!compact && mine && bot && (state === "run" || state === "pause") && <p class="faint st-bot l-h l-jc l-g1 f-c f-3 mt-4"><Icon name="bot"/>Свернёшь MAX — бот напомнит в чате, когда время выйдет.</p>}
      {!compact && state === "before" && !other && <p class="faint st-bot l-h l-jc l-g1 f-c f-3 mt-4">Таймер не сбросится: можно закрыть экран или свернуть MAX — время считается по часам, не по вкладке.</p>}
    </div>);
}

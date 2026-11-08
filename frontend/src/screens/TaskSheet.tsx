import { AiAnswer } from "../ui/AiAnswer";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/Toast";
import { api, ApiError } from "../lib/api";
import { schoolDay } from "../lib/day";
import { StudyTimer, type DoneInfo } from "../ui/StudyTimer";
import { focus, useFocusSession } from "../lib/focus";
import { topicFor } from "../lib/blitzBank";
import { TutorChat } from "../ui/TutorChat";
import { CloseByQuiz, TaskInfo } from "../ui/TaskExtras";
import { appLink, share, taskId } from "../lib/host";
import { closeQuizSession } from "../lib/closeQuizSession";
import { completionDisposition } from "../lib/completionOutcome";
import { TaskCompletionStatus } from "../ui/TaskCompletionStatus";
import { TeacherTaskCard } from "../ui/TeacherTaskCard";
import { hwInfo, isTeacherTask, markHwSeen, useHw } from "../lib/hwSync";
import { HwQuiz } from "../ui/HwQuiz";
import { splitTitle } from "../lib/subjects";
import type { Flashcard, Task } from "../lib/types";

type Mode = "menu" | "focus" | "hint" | "card" | "info" | "quiz" | "hwquiz";

interface Props {
  task: Task | null;
  done: boolean;
  onClose: () => void;
  onDone: (t: Task, opts?: { fromTimer?: boolean; inlineCompletion?: boolean; inlineError?: boolean }) => Promise<DoneInfo | void>;
  onUndo: (t: Task) => void;
  onDuel: (t: Task) => void;
  onRemove: (t: Task) => void;
  /** Следующее невыполненное задание по плану — шаг после «Задание завершено». */
  nextTask: Task | null;
  onOpenTask: (title: string) => void;
  onBlitz: (topicKey: string) => void;
  aiOnline?: boolean;
  /** Ученик сам решает, устное это или письменное (ИИ/нормативы могли ошибиться). */
  onSetType?: (t: Task, type: Task["type"]) => void;
  /** Перенести на завтра утром (до уроков). */
  onTomorrow?: (t: Task) => void;
  botName?: string | null;
}

export function TaskSheet({ task, done, onClose, onDone, onUndo, onDuel, onRemove, nextTask, onOpenTask, onBlitz, onSetType, onTomorrow, botName }: Props) {
  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState(false);
  const completing = useRef(false);
  const completionGeneration = useRef(0);
  const [completionError, setCompletionError] = useState<string | null>(null);
  useLayoutEffect(() => {
    completionGeneration.current++;
    completing.current = false;
    setBusy(false);
    setCompletionError(null);
    return () => { completionGeneration.current++; };
  }, [task?.id, task?.title]);
  const session = useFocusSession();
  useHw();   // v2: статус/«Новое»/опрос задания учителя перерисовываются при синхронизации
  const hw = task && isTeacherTask(task) ? hwInfo(task.title) : null;
  const hwQuiz = hw?.kind === "quiz" ? hw : null;
  // v2: ученик открыл задание учителя — индикатор «Новое» гаснет, учитель видит «просмотрено»
  useEffect(() => { if (hw) markHwSeen(hw.issue_id); }, [hw?.issue_id]);
  // Идёт таймер по этому заданию → сразу к нему (в т.ч. из плашки, диплинка startapp=focus, после refresh)
  useEffect(() => { if (task) setMode(focus.get()?.title === task.title ? "focus" : "menu"); }, [task?.title]);
  if (!task) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const { subject, detail } = splitTitle(task.title);
  const teacher = isTeacherTask(task);   // Recovery 2: the teacher decides type/date; completion is on the teacher's record

  const markDone = async (close = true) => {
    if (completing.current || done) return;
    const ticket = completionGeneration.current;
    completing.current = true; setBusy(true); setCompletionError(null);
    try {
      const result = await onDone(task, { inlineError: true, inlineCompletion: !close });
      if (ticket !== completionGeneration.current) return;
      if (completionDisposition(result) === "failed") {
        setCompletionError(`Завершение не сохранено. Освободи место на устройстве и нажми «${close ? "Готово" : "Закрыть задание"}» ещё раз.`);
        return;
      }
      if (close) onClose();
    } catch {
      if (ticket === completionGeneration.current)
        setCompletionError("Не удалось подтвердить завершение. Карточка остаётся открытой. Проверь соединение и попробуй ещё раз.");
    } finally {
      if (ticket === completionGeneration.current) { completing.current = false; setBusy(false); }
    }
  };

  // Keep Sheet’s safe default focus (Close), not the quick-complete action.
  // Enter immediately after opening must neither award points nor start a timer.
  return (
    <Sheet open={!!task} onClose={onClose}
      eyebrow={hwQuiz ? `Блиц-опрос · ${subject} · ${hwQuiz.quiz?.time_limit_min ?? task.planned_minutes} мин` : `${task.type === "oral" ? "Устное" : "Письменное"} · ${task.planned_minutes} мин`}
      title={hwQuiz ? hwQuiz.title : subject}
      footer={mode === "menu" ? (
        hwQuiz && !done
          ? <button class="btn btn-primary btn-block" onClick={() => setMode("hwquiz")}><Icon name="bolt" />{hwQuiz.quiz?.state === "started" ? "Продолжить опрос" : hwQuiz.quiz?.state === "submitted" ? "Результат опроса" : "Пройти опрос"}</button>
          : hwQuiz && done
          ? <div class="sheet-two"><button class="btn btn-secondary" onClick={() => setMode("hwquiz")}>Результат</button><button class="btn btn-ghost" onClick={onClose}>Закрыть</button></div>
          : done && teacher
          ? <button class="btn btn-secondary btn-block" onClick={onClose}>Закрыть</button>
          : done
          ? <button class="btn btn-secondary btn-block" onClick={() => { closeQuizSession.forget(`${schoolDay()}|${task.title}`); onUndo(task); onClose(); }}>Вернуть в работу</button>
          : <button class={`btn btn-ok btn-block${busy ? " is-loading" : ""}`} onClick={() => void markDone()} disabled={busy}><Icon name="check" />Готово</button>
      ) : (
        <button class="btn btn-ghost btn-block" onClick={() => setMode("menu")}>← Назад к заданию</button>
      )}>
      {completionError && <div class="note bad task-completion-error" role="alert"><Icon name="alert"/><span>{completionError}</span></div>}
      {mode === "menu" && (
        <>
          {detail && !hwQuiz && <p class="muted" style="margin:0 0 12px">{detail}</p>}
          {teacher && <TeacherTaskCard task={task} />}
          <TaskCompletionStatus task={task} done={done} />
          {!done && onSetType && !teacher && (
            <div class="task-opts l-h l-btw l-g3 f-b mb-4">
              <span class="faint" id={`tt-${taskId(task.title)}`}>Тип</span>
              <div class="seg-mini" role="radiogroup" aria-labelledby={`tt-${taskId(task.title)}`}>
                {(["written", "oral"] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={task.type === v ? "true" : "false"} tabIndex={task.type === v ? 0 : -1}
                    onClick={() => onSetType(task, v)}
                    onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onSetType(task, task.type === "oral" ? "written" : "oral"); } }}>
                    {v === "oral" ? "Устное" : "Письменное"}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Иерархия: главное действие задания — начать его по таймеру; помощь — вторична.
              Блиц-опрос учителя проходят в самом опросе (кнопка внизу), а не по таймеру. */}
          {!done && !hwQuiz && (
            <button class="focus-cta l-a1a l-g3 l-mid b-card l-w100" onClick={() => setMode("focus")}>
              <span class="focus-cta-ico l-center l-g0 b-round s-44 u-sel"><Icon name={session?.title === task.title ? "timer" : "play"} /></span>
              <span class="focus-cta-txt l-v l-g1">{session?.title === task.title
                ? <><b>Вернуться к таймеру</b><span class="f-2">задание в работе</span></>
                : <><b>Начать задание</b><span class="f-2">Старт → работаешь → «Закончил»</span></>}</span>
              <span class="focus-cta-time f-h f-a num">{task.planned_minutes > 25 ? "25:00" : `${String(task.planned_minutes).padStart(2, "0")}:00`}</span>
            </button>
          )}
          <div class="help-row l-h mt-3">
            <button class="help-link l-h l-inl l-jc f-b f-w6 f-2 b-box b-nob b-tap l-grow" onClick={() => setMode("info")}><Icon name="info" />Подробности</button>
            <button class="help-link l-h l-inl l-jc f-b f-w6 f-2 b-box b-nob b-tap l-grow" onClick={() => setMode("hint")}><Icon name="bulb" />Тьютор</button>
            <button class="help-link l-h l-inl l-jc f-b f-w6 f-2 b-box b-nob b-tap l-grow" onClick={() => setMode("card")}><Icon name="cards" />Шпаргалка</button>
            <button class="help-link l-h l-inl l-jc f-b f-w6 f-2 b-box b-nob b-tap l-grow" onClick={async () => {
              const r = await share(`Кто понял «${subject}»? Застрял — помогите разобраться`, appLink(`task_${taskId(task.title)}`, botName));
              if (r === "copied") toast("Ссылка скопирована — вставь в чат класса", "ok");
            }}><Icon name="users" />Спросить класс</button>
          </div>
          <div class="gap-4" />
          {!done && !hwQuiz && (
            <button class="btn btn-secondary btn-block" style="margin-bottom:8px" onClick={() => setMode("quiz")}><Icon name="bolt" />Закрыть блиц-опросом</button>
          )}
          {hwQuiz ? null : task.blitz_eligible ? (
            <button class="btn btn-primary btn-block" onClick={() => onDuel(task)}><Icon name="swords" />Закрыть тему дуэлью</button>
          ) : (
            <p class="faint" style="font-size:calc(13px*var(--fs,1));margin:0">Дуэль доступна для устных предметов «на параграфах» — история, литература, география. Для письменных — свой опрос в разделе дуэли.</p>
          )}
          {!done && onTomorrow && !teacher && (
            <button class="btn btn-ghost btn-block" style="margin-top:8px" onClick={() => { onTomorrow(task); onClose(); }}><Icon name="sun" />Завтра утром, до уроков</button>
          )}
          {(task.source === "bot" || task.source === "manual") && (
            <button class="btn btn-ghost btn-block" style="margin-top:8px;color:var(--bad)" onClick={() => { closeQuizSession.forget(`${schoolDay()}|${task.title}`); onRemove(task); onClose(); }}>Удалить задание</button>
          )}
        </>
      )}
      {(mode === "focus" || mode === "quiz") && (
        <StudyTimer key={task.title} task={task} compact={mode === "quiz"} completed={done} onExpand={() => setMode("focus")} onFinish={(t) => onDone(t, { fromTimer: true })} onClose={onClose}
          onOpenOther={(t) => onOpenTask(t)}
          next={nextTask && nextTask.title !== task.title ? { label: `Следующее: ${splitTitle(nextTask.title).subject}`, onClick: () => onOpenTask(nextTask.title) } : null}
          blitz={(() => { const t = topicFor(task.title); return t ? { label: "Проверь себя в блице", onClick: () => onBlitz(t.key) } : null; })()} />
      )}
      {mode === "hwquiz" && hwQuiz && <HwQuiz issueId={hwQuiz.issue_id} />}
      {mode === "hint" && <TutorChat context={task.title} />}
      {mode === "card" && <Card task={task} />}
      {mode === "info" && <TaskInfo task={task} />}
      {mode === "focus" && !done && <button class="btn btn-ghost btn-block" onClick={() => setMode("quiz")}>К мини-блицу</button>}
      {mode === "quiz" && <CloseByQuiz task={task} done={done} onPassed={() => void markDone(false)} />}
    </Sheet>
  );
}

function Card({ task }: { task: Task }) {
  const [card, setCard] = useState<Flashcard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null); setCard(null);
    api.flashcard(task.title)
      .then((c) => { setCard(c); api.event("flashcard_used", { event_id: `flash:${schoolDay()}:${task.title}` }).catch(() => undefined); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Не удалось загрузить"));
  };
  useEffect(load, [task.title]);
  if (err) return <div class="note bad"><Icon name="alert" /><div>{err} <button class="btn btn-ghost btn-sm" onClick={load}>Повторить</button></div></div>;
  if (!card) return <div class="stack">{[0, 1, 2].map((i) => <div key={i} class="sk" style="height:44px" />)}</div>;
  return (
    <div>
      <div class="eyebrow">Повтори за перемену</div>
      <ol class="flash">{card.points.map((x, i) => <li key={i}><AiAnswer text={x} /></li>)}</ol>
      {card.notice && <p class="meta" style="margin-top:8px">{card.notice}</p>}
      <div class="note warn" style="margin-top:16px"><Icon name="alert" /><div><b>Вопрос-ловушка.</b> <AiAnswer text={card.trap_question} inline /></div></div>
    </div>
  );
}

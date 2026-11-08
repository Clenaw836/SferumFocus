/**
 * v16 «Мини-квиз перед уроком» → v16.1: тот же механизм времени, что у полноэкранного блица (lib/quizClock).
 * 3–5 вопросов из локального банка (lib/blitzBank) — БЕЗ ИИ и без сети; число вопросов выбирает подготовка
 * к уроку так, чтобы квиз точно закончился до звонка (questionsThatFit). Раунд детерминирован по дате + предмету.
 * На вопрос — QUIZ_CONFIG.questionSeconds (20 с); истекло — пропуск, ответить уже нельзя. После ответа —
 * объяснение «почему» и кнопка «Дальше» (без автоперехода: это подготовка, а не скорость). В конце — итог и разбор.
 * Очки не начисляются.
 */
import { useEffect, useMemo, useRef } from "preact/hooks";
import { makeRound, type Topic } from "../lib/blitzBank";
import { fnv1a } from "../lib/dayEngine";
import { rng } from "../lib/scene";
import { transition } from "../lib/motion";
import { QuizClock, questionMs } from "../lib/quizClock";
import { QuizTimer, useQuizClock } from "./QuizTimer";
import { Icon } from "./Icon";

export function MiniQuiz({ topic, date, count = 5, onDone, onClose }: { topic: Topic; date: string; count?: number; onDone: (ok: number, n: number) => void; onClose: () => void }) {
  const qs = useMemo(() => makeRound(topic, Math.max(1, Math.min(5, count)), rng(parseInt(fnv1a(`${date}|${topic.key}`), 16))), [topic.key, date, count]);
  const clock = useMemo(() => new QuizClock(qs.length, { durationMs: questionMs() }), [qs]);
  const { now } = useQuizClock(clock);
  const snap = clock.snapshot();
  const box = useRef<HTMLDivElement>(null);
  const qRef = useRef<HTMLParagraphElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const doneSent = useRef(false);
  const finished = snap.phase === "done";
  const i = Math.min(snap.index, qs.length - 1);
  const q = qs[i];
  const cur = snap.current;
  const ok = snap.results.filter((r) => r.ok).length;

  // старт отсчёта — только когда вопрос показан (кадр отрисован)
  useEffect(() => {
    if (snap.phase !== "idle" && snap.phase !== "loading") return;
    clock.load();
    const id = requestAnimationFrame(() => { clock.start(); });
    return () => cancelAnimationFrame(id);
  }, [clock, snap.index, snap.phase]);
  useEffect(() => { if (cur) { const t = setTimeout(() => nextRef.current?.focus({ preventScroll: true }), 40); return () => clearTimeout(t); } }, [cur?.index]);
  useEffect(() => { if (finished && !doneSent.current) { doneSent.current = true; onDone(ok, qs.length); } }, [finished]);

  const next = () => {
    if (!clock.next()) return;                                  // двойной тап — второй игнорируется
    if (box.current) void transition(box.current, { opacity: [0, 1], y: [6, 0] }, "fast");
  };
  const close = () => { clock.cancel(); onClose(); };

  if (finished) {
    return (
      <div class="quiz mt-3" ref={box} role="group" aria-label={`Мини-квиз: ${topic.label}`}>
        <div class="quiz-end">
          <b class="num" role="status">{ok} из {qs.length}</b>
          <p class="f-2">{ok === qs.length ? "Готов к уроку." : ok >= Math.ceil(qs.length * 0.6) ? "Почти готов — посмотри разбор ниже." : "Стоит повторить тему перед уроком — разбор ниже."}</p>
        <details class="quiz-review f-b mt-3 mb-3" open={ok < qs.length}>
          <summary class="f-2">Разбор ответов · верно {ok} из {qs.length}</summary>
          <ol>
            {qs.map((x, k) => {
              const r = snap.results.find((y) => y.index === k);
              return (
                <li key={k} class={r?.ok ? "ok" : "bad"}>
                  <Icon name={r?.ok ? "check" : r?.outcome === "timeout" ? "timer" : "x"} label={r?.ok ? "верно" : r?.outcome === "timeout" ? "пропуск по времени" : "неверно"} />
                  <div><b>{x.q}</b><span>Ответ: {x.options[x.answer]}{!r?.ok && <> — {x.why}</>}{r?.outcome === "timeout" && <em class="f-3"> · время вышло</em>}</span></div>
                </li>
              );
            })}
          </ol>
        </details>
        <button class="btn btn-secondary btn-sm" onClick={onClose}><Icon name="check" />Готово</button>
        </div>
      </div>
    );
  }
  const locked = snap.phase !== "asking";
  return (
    <div class="quiz mt-3" ref={box} role="group" aria-label={`Мини-квиз: ${topic.label}`}>
      <p class="quiz-n f-m f-3 num">Вопрос {i + 1} из {qs.length}</p>
      <QuizTimer clock={clock} now={now} compact />
      <p class="quiz-q f-s mt-1 mb-3" ref={qRef}>{q.q}</p>
      <div class="quiz-opts l-v">
        {q.options.map((o, k) => (
          <button key={`${i}-${k}`} class={`quiz-o f-b b-tile b-tap${cur && k === q.answer ? " right" : ""}${cur && cur.pick === k && k !== q.answer ? " wrong" : ""}`}
            onClick={() => clock.answer(k, k === q.answer)} disabled={locked} aria-pressed={cur?.pick === k}>{o}</button>
        ))}
      </div>
      {cur && (
        <div class="quiz-why f-b f-2 mt-3" role="status">
          <p><b>{cur.outcome === "timeout" ? "Время вышло — пропуск." : cur.ok ? "Верно." : "Не совсем."}</b> {cur.ok ? q.why : <>Правильно: «{q.options[q.answer]}». {q.why}</>}</p>
          <button ref={nextRef} class="btn btn-primary btn-sm" onClick={next}>{i + 1 < qs.length ? "Дальше" : "Итог"}</button>
        </div>
      )}
      <button class="link quiz-skip f-m mt-3" onClick={close}>Закрыть квиз</button>
    </div>
  );
}

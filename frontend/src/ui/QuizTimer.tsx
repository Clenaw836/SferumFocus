/**
 * v16.1 Хук и индикатор времени квиза поверх lib/quizClock (один механизм для блица и мини-квиза).
 *
 * useQuizClock(clock):
 *   • ОДИН setTimeout до дедлайна текущего вопроса (логика) + лёгкий тикер 250 мс только для цифры/полосы (вид);
 *   • оба снимаются при ответе, смене вопроса, отмене, завершении и размонтировании — дублей нет;
 *   • visibilitychange/focus/pageshow → немедленная сверка с дедлайном (троттлинг фона не даёт лишнего времени);
 *   • по умолчанию при размонтировании квиз отменяется; cancelOnUnmount:false сохраняет дедлайн в memory-only попытке задания.
 * QuizTimer: «Время на ответ: 20 секунд» + «Осталось 14 сек» + полоса по ФАКТИЧЕСКОМУ остатку.
 *   Состояния текстом (не только цветом): обычное / мало времени / последние секунды / время вышло /
 *   ответ принят / проверяю / следующий вопрос. Скринридеру — только пороги, без объявления каждой секунды.
 */
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { QUIZ_CONFIG, secondsLeft, secWord, type QuizClock, type Tone } from "../lib/quizClock";
import { Icon } from "./Icon";

export function useQuizClock(clock: QuizClock, { cancelOnUnmount = true }: { cancelOnUnmount?: boolean } = {}): { now: number } {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.subscribe(() => { setNow(clock.now()); bump(0); }), [clock]);
  const snap = clock.snapshot();
  const asking = snap.phase === "asking" && snap.timed && snap.deadline !== null;
  useEffect(() => {
    if (!asking) return;
    const deadline = snap.deadline!;
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(t); t = setTimeout(() => clock.expire(), Math.max(0, deadline - clock.now()) + 15); };
    const tick = setInterval(() => { setNow(clock.now()); clock.expire(); }, 250);
    const wake = () => { setNow(clock.now()); if (!clock.expire()) arm(); };
    arm();
    document.addEventListener("visibilitychange", wake);
    addEventListener("focus", wake); addEventListener("pageshow", wake);
    return () => {
      clearTimeout(t); clearInterval(tick);
      document.removeEventListener("visibilitychange", wake);
      removeEventListener("focus", wake); removeEventListener("pageshow", wake);
    };
  }, [clock, asking, snap.index, snap.deadline]);
  // уход со страницы/вкладки приложения посреди вопроса — отмена (таймеров после этого нет)
  useEffect(() => () => { if (cancelOnUnmount) clock.cancel(); }, [clock, cancelOnUnmount]);
  return { now };
}

const TONE_TEXT: Record<Tone, string> = {
  normal: "", warn: "Мало времени", critical: "Последние секунды", expired: "Время вышло — засчитан пропуск",
  answered: "Ответ принят", checking: "Проверяю ответ…", next: "Следующий вопрос…", untimed: "Без ограничения времени", loading: "Загружаю вопрос…",
};

export function QuizTimer({ clock, now, compact, advancing }: { clock: QuizClock; now: number; compact?: boolean; advancing?: boolean }) {
  const snap = clock.snapshot();
  const total = Math.round(snap.durationMs / 1000);
  const rem = clock.remainingMs(now);
  const sec = secondsLeft(rem);
  const tone: Tone = advancing ? "next" : clock.tone(now);
  const frac = snap.timed ? Math.max(0, Math.min(1, rem / snap.durationMs)) : 1;
  // объявляем только смену порога — без спама каждую секунду
  const [say, setSay] = useState("");
  const last = useRef<Tone | null>(null);
  useEffect(() => {
    if (last.current === tone) return;
    last.current = tone;
    const m = tone === "warn" ? `Осталось ${sec} ${secWord(sec)}` : tone === "critical" ? "Последние секунды" : tone === "expired" ? "Время вышло, засчитан пропуск" : tone === "checking" ? "Проверяю ответ" : "";
    if (m) setSay(m);
  }, [tone]);
  if (!snap.timed) return <p class="qt f-num mt-3 mb-3 qt-untimed l-h l-g1 f-m f-3"><Icon name="timer" />Без ограничения времени</p>;
  const big = tone === "answered" || tone === "next" ? TONE_TEXT[tone]
    : tone === "expired" ? "Время вышло"
    : tone === "checking" ? TONE_TEXT.checking
    : tone === "loading" ? `${total} ${secWord(total)} на ответ`
    : <>Осталось <b class="num">{sec}</b> сек</>;
  return (
    <div class={`qt f-num mt-3 mb-3 t-${tone}${compact ? " compact" : ""}`} data-remaining={sec}>
      <div class="qt-row l-h l-base l-btw l-wrap">
        <span class="qt-total l-h l-inl l-g1 f-b f-2"><Icon name="timer" />Время на ответ: <b class="num">{total}</b> {secWord(total)}</span>
        <span class="qt-left f-b f-w6 f-2 f-num" role="timer" aria-live="off" aria-atomic="true">{big}</span>
      </div>
      <div class="qt-bar mt-1 o-h r-xs u-soft" role="progressbar" aria-label="Оставшееся время на ответ" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sec}
        aria-valuetext={tone === "expired" ? "время вышло" : `осталось ${sec} ${secWord(sec)}`}>
        <i style={{ transform: `scaleX(${frac})` }} />
      </div>
      {/* строка всегда в разметке (резерв высоты) — появление текста не сдвигает вопрос и варианты */}
      <span class="qt-note l-blk f-m f-3 mt-1" aria-hidden="true">{tone === "warn" || tone === "critical" || tone === "expired" ? TONE_TEXT[tone] : ""}</span>
      <span class="sr" role="status" aria-live="polite">{say}</span>
    </div>
  );
}
export { QUIZ_CONFIG };

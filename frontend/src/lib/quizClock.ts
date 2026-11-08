/**
 * v16.1 «Единое время квиза» — ОДИН механизм для полноэкранного блица и мини-квиза перед уроком.
 *
 * Модель — абсолютные метки времени, а не счётчик тиков setInterval:
 *   startedAt = момент, когда вопрос реально показан (не когда начали его грузить);
 *   deadline  = startedAt + durationMs;  remaining = max(0, deadline − now).
 * Поэтому сворачивание, троттлинг таймеров на скрытой вкладке и лишние перерисовки не дают
 * ни «лишнего», ни «украденного» времени: после возврата остаток просто пересчитывается.
 *
 * Конечный автомат вопроса:
 *   loading → asking → (answered | timeout) → revealed → [next] → loading … → done
 *                    ↘ checking (ответ проверяет сервер) → revealed
 *   cancel() из любого незавершённого состояния → cancelled (больше ничего не записывается).
 * Инварианты:
 *   1. На вопрос записывается РОВНО один результат (ответ ИЛИ пропуск по времени).
 *   2. Ответ после deadline не принимается — фиксируется пропуск (дедлайн — источник истины,
 *      даже если колбэк таймера ещё не успел сработать из-за троттлинга).
 *   3. next() работает только из revealed; повторное нажатие «Дальше» ничего не делает.
 *   4. Каждый вопрос получает свой startedAt/deadline; перерисовка компонента их не трогает
 *      (экземпляр живёт в useRef/useMemo, а не в рендере).
 * Чистый модуль без DOM — тестируется с подставными часами (tests/unit/v161.test.mts).
 */

/** Централизованная конфигурация времени квизов (секунды). Меняется только здесь. */
export const QUIZ_CONFIG = {
  /** время на один вопрос по умолчанию */
  questionSeconds: 20,
  /** допустимый диапазон (требование: 15–20 с на вопрос) */
  minSeconds: 15,
  maxSeconds: 20,
  /** окно бонуса за скорость в блице — прежние 15 с, чтобы очки и рекорды остались сопоставимы */
  speedWindowSeconds: 15,
  /** «мало времени» и «последние секунды» для индикатора */
  warnAtSeconds: 7,
  criticalAtSeconds: 3,
  /** пауза перед автопереходом после верного ответа в блице (мс) */
  revealMs: 820,
  /** оценка «чтение вопроса + объяснение» поверх лимита — чтобы не предлагать квиз, который не успеть до урока */
  overheadSeconds: 10,
} as const;

export const clampSeconds = (s: number | null | undefined): number => {
  const v = typeof s === "number" && Number.isFinite(s) ? Math.round(s) : QUIZ_CONFIG.questionSeconds;
  return Math.min(QUIZ_CONFIG.maxSeconds, Math.max(QUIZ_CONFIG.minSeconds, v));
};
export const questionMs = (s?: number | null) => clampSeconds(s ?? QUIZ_CONFIG.questionSeconds) * 1000;

export type QPhase = "idle" | "loading" | "asking" | "checking" | "revealed" | "done" | "cancelled";
export type Outcome = "answered" | "timeout";
export interface QResult { index: number; pick: number | null; outcome: Outcome; ms: number; ok: boolean }
export interface QuizSnapshot {
  phase: QPhase; index: number; total: number; timed: boolean; durationMs: number;
  startedAt: number | null; deadline: number | null; results: QResult[];
  /** последний результат текущего вопроса (если есть) */
  current: QResult | null;
}
export type Tone = "normal" | "warn" | "critical" | "expired" | "answered" | "checking" | "next" | "untimed" | "loading";

export interface ClockOpts { durationMs?: number; timed?: boolean; now?: () => number }

export class QuizClock {
  readonly total: number;
  readonly durationMs: number;
  readonly timed: boolean;
  private nowFn: () => number;
  private phase: QPhase = "idle";
  private index = 0;
  private startedAt: number | null = null;
  private deadline: number | null = null;
  private results: QResult[] = [];
  private subs = new Set<() => void>();

  constructor(total: number, opts: ClockOpts = {}) {
    this.total = Math.max(0, Math.floor(total));
    this.durationMs = opts.durationMs ?? questionMs();
    this.timed = opts.timed ?? true;
    this.nowFn = opts.now ?? (() => Date.now());
    if (this.total === 0) this.phase = "done";
  }

  now(): number { return this.nowFn(); }
  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit() { for (const f of [...this.subs]) f(); }

  snapshot(): QuizSnapshot {
    const current = this.results.find((r) => r.index === this.index) ?? null;
    return { phase: this.phase, index: this.index, total: this.total, timed: this.timed, durationMs: this.durationMs,
      startedAt: this.startedAt, deadline: this.deadline, results: [...this.results], current };
  }

  /** Вопрос грузится: время НЕ идёт. */
  load(): boolean {
    if (this.phase === "loading") return true;                       // уже грузится — без лишнего emit
    if (this.phase !== "idle") return false;
    this.phase = "loading"; this.startedAt = null; this.deadline = null; this.emit(); return true;
  }

  /** Вопрос показан — с этого момента идёт отсчёт. Повторный вызов не продлевает время. */
  start(): boolean {
    if (this.phase !== "idle" && this.phase !== "loading") return false;
    const t = this.now();
    this.phase = "asking"; this.startedAt = t; this.deadline = this.timed ? t + this.durationMs : null;
    this.emit(); return true;
  }

  remainingMs(at: number = this.now()): number {
    if (!this.timed) return Infinity;
    if (this.phase === "loading" || this.phase === "idle") return this.durationMs;
    if (this.deadline === null) return this.durationMs;
    const cur = this.results.find((r) => r.index === this.index);
    if (cur) return Math.max(0, this.durationMs - cur.ms);    // после ответа остаток «замирает»
    return Math.max(0, this.deadline - at);
  }

  private record(pick: number | null, outcome: Outcome, ok: boolean, at: number): QResult | null {
    if (this.results.some((r) => r.index === this.index)) return null;      // инвариант 1
    const ms = Math.max(0, Math.min(this.timed ? this.durationMs : Infinity, at - (this.startedAt ?? at)));
    const r: QResult = { index: this.index, pick, outcome, ms: outcome === "timeout" ? this.durationMs : ms, ok };
    this.results.push(r);
    return r;
  }

  /**
   * Ответ ученика. ok — результат локальной проверки; если проверяет сервер — передай check: true,
   * затем resolve(ok). Возвращает записанный результат или null (ответ отклонён: не время, повтор, вышел срок).
   */
  answer(pick: number, ok: boolean | { check: true }): QResult | null {
    if (this.phase !== "asking") return null;
    const t = this.now();
    if (this.timed && this.deadline !== null && t >= this.deadline) { this.expire(t); return null; }   // инвариант 2
    const pending = typeof ok === "object";
    const r = this.record(pick, "answered", pending ? false : ok, t);
    if (!r) return null;
    this.phase = pending ? "checking" : "revealed";
    this.emit(); return r;
  }

  /** Серверная проверка ответа завершилась. */
  resolve(ok: boolean): boolean {
    if (this.phase !== "checking") return false;
    const r = this.results.find((x) => x.index === this.index);
    if (r) r.ok = ok;
    this.phase = "revealed"; this.emit(); return true;
  }

  /** Проверка дедлайна: вызывается таймером, при возврате на вкладку и перед ответом. */
  expire(at: number = this.now()): boolean {
    if (this.phase !== "asking" || !this.timed || this.deadline === null || at < this.deadline) return false;
    const r = this.record(null, "timeout", false, at);
    if (!r) return false;
    this.phase = "revealed"; this.emit(); return true;
  }

  /** Следующий вопрос (или завершение). Только из revealed — двойной тап «Дальше» безопасен. */
  next(): QPhase | null {
    if (this.phase !== "revealed") return null;
    this.startedAt = null; this.deadline = null;
    if (this.index + 1 >= this.total) { this.phase = "done"; this.index = this.total; }
    else { this.index += 1; this.phase = "loading"; }
    this.emit(); return this.phase;
  }

  cancel(): boolean {
    if (this.phase === "done" || this.phase === "cancelled") return false;
    this.phase = "cancelled"; this.startedAt = null; this.deadline = null; this.emit(); return true;
  }

  /** Тон индикатора для текущего состояния (число + текст, не только цвет). */
  tone(at: number = this.now()): Tone {
    switch (this.phase) {
      case "idle": case "loading": return "loading";
      case "checking": return "checking";
      case "done": case "cancelled": return "next";
      case "revealed": { const c = this.results.find((r) => r.index === this.index); return c?.outcome === "timeout" ? "expired" : "answered"; }
      default: {
        if (!this.timed) return "untimed";
        const s = Math.ceil(this.remainingMs(at) / 1000);
        return s <= 0 ? "expired" : s <= QUIZ_CONFIG.criticalAtSeconds ? "critical" : s <= QUIZ_CONFIG.warnAtSeconds ? "warn" : "normal";
      }
    }
  }
}

/** Секунды для показа: «Осталось 14 сек» — округление вверх (0 только когда время действительно вышло). */
export const secondsLeft = (ms: number) => (Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0);

/** «секунда/секунды/секунд» */
export const secWord = (n: number) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? "секунд" : b === 1 ? "секунда" : b >= 2 && b <= 4 ? "секунды" : "секунд"; };

/** Сколько вопросов реально успеть за `minutes` до урока (0 — квиз не предлагать). */
export function questionsThatFit(minutes: number | null, max = 5, min = 3, sec = QUIZ_CONFIG.questionSeconds): number {
  if (minutes === null) return max;                                // вечером/до завтра время не ограничено уроком
  const per = clampSeconds(sec) + QUIZ_CONFIG.overheadSeconds;
  const budget = minutes * 60 - 60;                                 // минута запаса: дойти до кабинета, достать тетрадь
  const n = Math.floor(budget / per);
  return n >= min ? Math.min(max, n) : 0;
}

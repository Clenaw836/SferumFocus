/**
 * Фокус-сессия задания: «Старт → работаю → Закончил».
 * Источник правды — timestamps, а не setInterval: прошедшее время всегда
 * = (сейчас|момент паузы) − старт − сумма пауз. Поэтому таймер переживает
 * refresh, сон телефона, сворачивание MAX и переоткрытие мини-аппа.
 * Одна активная сессия на ученика (одно задание за раз — смысл фокуса).
 * Хранение: localStorage (через nsKey — демо не трогает реальные данные)
 * + зеркало в MAX DeviceStorage (переживает очистку кэша WebView).
 */
import { useEffect, useState } from "preact/hooks";
import { nsKey } from "./demo";
import { deviceStore } from "./host";

export interface FocusSession {
  v: 1;
  title: string;
  plannedSec: number;
  startedAt: number;
  pausedAt: number | null;
  pausedMs: number;
  /** Уже сообщили «время вышло» (вибрация/тост — один раз, в том числе после refresh). */
  expiredSeen?: boolean;
  /** Помидор: 25 мин работы → 5 мин перерыва → следующий помидор, пока не закрыт норматив задания. */
  pomo?: boolean;
  round?: number;
  breakAt?: number | null;
  breakSeen?: boolean;
  taskSec?: number;
  /** Work elapsed when current Pomodoro started; additive for legacy sessions. */
  roundStartedSec?: number;
}
export const POMO_SEC = 25 * 60;
export const BREAK_SEC = 5 * 60;

const KEY = nsKey("sf.focus");
const MAX_SESSION_MS = 12 * 3600 * 1000;
// Лениво: демо-сброс (resetDemo) успевает отработать до первого чтения.
let loaded = false;
let cur: FocusSession | null = null;
// Any local/storage change invalidates an outstanding asynchronous MAX read.
let revision = 0;
const S = (): FocusSession | null => { if (!loaded) { loaded = true; cur = read(); } return cur; };
const subs = new Set<(s: FocusSession | null) => void>();
/** Recovery 2: user-initiated transitions (never restore/storage/adopt) for the server outbox. */
export type FocusTransition = { kind: "start" | "pause" | "break" | "resume" | "next_round" | "finish" | "drop"; title: string; at: number; round?: number };
const tsubs = new Set<(t: FocusTransition) => void>();
function emit(t: FocusTransition): void { tsubs.forEach((f) => { try { f(t); } catch { /* an observer never breaks the timer */ } }); }

function valid(x: unknown): x is FocusSession {
  const s = x as FocusSession;
  return !!s && s.v === 1 && typeof s.title === "string" && s.plannedSec > 0 && Number.isFinite(s.startedAt) && Number.isFinite(s.pausedMs);
}
function read(): FocusSession | null {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); return valid(s) ? s : null; } catch { return null; }
}
function write(s: FocusSession | null): void {
  revision++;
  cur = s; loaded = true;
  const raw = s ? JSON.stringify(s) : null;
  try { raw ? localStorage.setItem(KEY, raw) : localStorage.removeItem(KEY); } catch { /* приватный режим: живём в памяти */ }
  deviceStore.set(KEY, raw);
  subs.forEach((f) => f(cur));
}

/** Прошедшее рабочее время, мс. Часы перевели назад → не уходим в минус; потолок 12 ч. */
export function elapsedMs(s: FocusSession, now = Date.now()): number {
  const end = s.pausedAt ?? now;
  return Math.min(MAX_SESSION_MS, Math.max(0, end - s.startedAt - s.pausedMs));
}
export const isExpired = (s: FocusSession, now = Date.now()) => elapsedMs(s, now) >= s.plannedSec * 1000;
export const breakLeftSec = (s: FocusSession, now = Date.now()) => (s.breakAt ? Math.max(0, BREAK_SEC - Math.floor((now - s.breakAt) / 1000)) : 0);
export const taskLeftSec = (s: FocusSession, now = Date.now()) => Math.max(0, (s.taskSec ?? s.plannedSec) - Math.floor(elapsedMs(s, now) / 1000));
export const remainingSec = (s: FocusSession, now = Date.now()) => Math.max(0, s.plannedSec - Math.floor(elapsedMs(s, now) / 1000));

export const focus = {
  get: () => S(),
  subscribe(f: (s: FocusSession | null) => void) { subs.add(f); return () => { subs.delete(f); }; },
  onTransition(f: (t: FocusTransition) => void) { tsubs.add(f); return () => { tsubs.delete(f); }; },
  /** Идемпотентно: повторный «Старт» по тому же заданию не сбрасывает отсчёт.
   * elapsedSec — уже наработанное время (задание учителя на паузе на сервере): отсчёт продолжается, а не с нуля. */
  start(title: string, plannedSec: number, opts?: { pomo?: boolean; taskSec?: number; elapsedSec?: number }): FocusSession {
    const c = S(); if (c && c.title === title) return c;
    if (c) emit({ kind: "drop", title: c.title, at: Date.now() });   // the previous task's timer is replaced, not finished
    const t = Date.now(), already = Math.max(0, Math.min(MAX_SESSION_MS, Math.round((opts?.elapsedSec ?? 0) * 1000)));
    const done = Math.floor(already / 1000), taskSec = Math.max(60, Math.round(opts?.taskSec ?? plannedSec));
    // Continuing: a pomodoro runs a full round from here (as nextRound does); a plain timer keeps the task norm, at least one minute ahead.
    const target = !done ? Math.round(plannedSec) : opts?.pomo ? done + Math.min(POMO_SEC, Math.max(60, taskSec - done)) : Math.max(Math.round(plannedSec), done + 60);
    const s: FocusSession = { v: 1, title, plannedSec: Math.max(60, target), startedAt: t - already, pausedAt: null, pausedMs: 0,
      ...(opts?.pomo ? { pomo: true, roundStartedSec: done, round: 1, breakAt: null, taskSec } : {}) };
    write(s); emit({ kind: "start", title, at: t }); return s;
  },
  pause() { const c = S(); if (c && c.pausedAt === null) { const t = Date.now(); write({ ...c, pausedAt: t }); emit({ kind: "pause", title: c.title, at: t }); } },
  /** Перерыв помидора: работа замораживается (как пауза), отдельно тикает 5 минут отдыха. */
  takeBreak() { const c = S(); if (!c || c.breakAt) return; const t = Date.now(); write({ ...c, pausedAt: c.pausedAt ?? t, breakAt: t, breakSeen: false }); if (c.pausedAt === null) emit({ kind: "break", title: c.title, at: t }); },
  /** Следующий помидор: размораживаем работу, план += до 25 мин (сколько осталось по нормативу, без искусственного минимума 5 минут). */
  nextRound() {
    const c = S(); if (!c) return;
    const t = Date.now();
    const pausedMs = c.pausedMs + (c.pausedAt !== null ? Math.max(0, t - c.pausedAt) : 0);
    const base = { ...c, pausedAt: null, pausedMs, breakAt: null, expiredSeen: false };
    const el = Math.floor(elapsedMs(base, t) / 1000);
    const left = Math.max(1, (c.taskSec ?? c.plannedSec) - el);
    const round = (c.round ?? 1) + 1;
    write({ ...base, round, roundStartedSec: el, plannedSec: el + Math.min(POMO_SEC, left) });
    emit({ kind: "next_round", title: c.title, at: t, round });
  },
  markBreakSeen() { const c = S(); if (c && c.breakAt && !c.breakSeen) write({ ...c, breakSeen: true }); },
  resume() {
    const c = S(); if (!c || c.pausedAt === null) return;
    if (c.breakAt) { focus.nextRound(); return; }
    const t = Date.now(), gap = Math.max(0, t - c.pausedAt);
    write({ ...c, pausedAt: null, pausedMs: c.pausedMs + gap });
    emit({ kind: "resume", title: c.title, at: t });
  },
  extend(sec: number): FocusSession | null { const c = S(); if (!c) return null; const n = { ...c, plannedSec: c.plannedSec + sec, expiredSeen: false }; write(n); return n; },
  markExpiredSeen() { const c = S(); if (c && !c.expiredSeen) write({ ...c, expiredSeen: true }); },
  /** Read the completion result without removing the session (persist-before-finish). */
  completion(title: string) {
    const c = S(); if (!c || c.title !== title) return null;
    return { workedSec: Math.round(elapsedMs(c) / 1000), plannedSec: c.plannedSec, startedAt: c.startedAt, finishedAt: Date.now(), rounds: c.pomo ? c.round ?? 1 : null };
  },
  /** Финиш: фиксируем итог и снимаем сессию. Повторный вызов → null (двойной тап безопасен). */
  finish(title: string): { workedSec: number; plannedSec: number; startedAt: number; finishedAt: number; rounds: number | null } | null {
    const c = S(); if (!c || c.title !== title) return null;
    const r = { workedSec: Math.round(elapsedMs(c) / 1000), plannedSec: c.plannedSec, startedAt: c.startedAt, finishedAt: Date.now(), rounds: c.pomo ? c.round ?? 1 : null };
    write(null); emit({ kind: "finish", title, at: r.finishedAt }); return r;
  },
  /** silent — сервер уже знает (задание отозвано/выполнено на другом устройстве): переход не отправляется. */
  drop(opts?: { silent?: boolean }) { const c = S(); write(null); if (c && !opts?.silent) emit({ kind: "drop", title: c.title, at: Date.now() }); },
  /** Recovery 2: show the server timer of a teacher assignment on this device (no transition is sent). */
  adopt(title: string, plannedSec: number, elapsedSec: number, paused: boolean): FocusSession {
    const c = S(), t = Date.now(), already = Math.max(0, Math.min(MAX_SESSION_MS, Math.round(elapsedSec * 1000)));
    // Same task already on this device: keep its plan and pomodoro round, align only the worked time and the pause.
    const s: FocusSession = c && c.title === title
      ? { ...c, startedAt: t - already, pausedAt: paused ? t : null, pausedMs: 0, breakAt: c.breakAt && paused ? c.breakAt : null }
      : { v: 1, title, plannedSec: Math.max(60, Math.round(plannedSec)), startedAt: t - already, pausedAt: paused ? t : null, pausedMs: 0 };
    write(s); return s;
  },
  /** The teacher renamed the assignment: the running session follows it (no transition). */
  retitle(from: string, to: string) { const c = S(); if (c && c.title === from && from !== to) write({ ...c, title: to }); },
  /** localStorage пуст (очистили кэш WebView) → поднимаем сессию из DeviceStorage MAX. */
  async restore(): Promise<void> {
    if (S()) return;
    const ticket = revision;
    const raw = await deviceStore.get(KEY);
    if (!raw || ticket !== revision || S()) return;
    try { const s = JSON.parse(raw); if (valid(s)) write(s); } catch { /* битые данные — игнор */ }
  },
};

// Вторая вкладка/окно: один таймер на ученика — синхронизируемся по storage-событию.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    revision++;
    try { const s = JSON.parse(e.newValue || "null"); cur = valid(s) ? s : null; } catch { cur = null; }
    loaded = true; subs.forEach((f) => f(cur));
  });
}

/** Подписка на активную сессию. */
export function useFocusSession(): FocusSession | null {
  const [s, setS] = useState(S());
  useEffect(() => focus.subscribe(setS), []);
  return s;
}

/** «Сейчас» с тиком ровно на границе секунды (1 рендер/с только у подписчика) + мгновенный пересчёт при возврате во вкладку. */
export function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    let t = 0;
    const tick = () => { setNow(Date.now()); t = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 8); };
    t = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 8);
    const vis = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", vis); };
  }, [active]);
  // A session/phase change can render before the next scheduled tick.
  // Read the current timestamp instead of applying an older tick to new pause offsets.
  return active ? Date.now() : now;
}

export const mmss = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
};

// Локальное состояние учебного дня: выполненные, добавленные, скрытые задания, журнал выполнения,
// перенесённое «на завтра утром» и утренние шпаргалки.
// Ключ — УЧЕБНЫЙ день по местному времени с границей в 04:00: уроки, которые доделываются
// в 00:20, остаются «сегодняшним вечером» (полночь не обнуляет галочки и таймер),
// а UTC-сдвиг (Москва = UTC+3) больше не переключает день в 03:00 по ночам.
// Зеркало в MAX DeviceStorage: если WebView очистил localStorage, день поднимается обратно.
import { cache } from "./api";
import { nsKey } from "./demo";
import { deviceStore } from "./host";
import { nowDate } from "./clock";
import type { DayActivity, Flashcard, Task } from "./types";

import { schoolDay } from "./schoolDay";
export { schoolDay };
const key = (k: string, off = 0) => `sf.${k}.${schoolDay(nowDate(), off)}`;
const MIRRORED = ["done", "extra", "hidden", "built", "log", "types", "acts", "bed", "moved", "start", "reopened"];

function put(k: string, v: unknown): void {
  cache.set(k, v);
  deviceStore.set(nsKey(k), JSON.stringify(v));
  if(typeof window!=="undefined"&&typeof window.dispatchEvent==="function")window.dispatchEvent(new CustomEvent("sf-day-change"));
}

/** Журнал выполнения задания: NOT STARTED → STARTED → IN PROGRESS → FINISHED → COMPLETED. */
export interface ExecRecord {
  startedAt: number | null;
  finishedAt: number;
  workedSec: number | null;
  plannedMin: number;
  actualMin: number | null;
  rounds: number | null;
  synced: boolean;               // COMPLETED: сервер принял task_done
}
export type ExecState = "not_started" | "started" | "in_progress" | "finished" | "completed";
export interface MorningCard { title: string; card: Flashcard; until: string }

export const dayStore = {
  done(): string[] { return cache.get<string[]>(key("done")) ?? []; },
  reopened(): string[] { return cache.get<string[]>(key("reopened")) ?? []; },
  setReopened(title: string, value: boolean) {
    const next = this.reopened().filter(x => x !== title); if (value) next.push(title);
    // This marker prevents a late ACK from undoing an explicit local reopen.
    // Unlike legacy cache.set, persistence failure must be visible to the caller.
    localStorage.setItem(nsKey(key("reopened")), JSON.stringify(next)); put(key("reopened"),next);
  },
  setDone(v: string[]) { put(key("done"), v); },
  extra(): Task[] { return cache.get<Task[]>(key("extra")) ?? []; },
  setExtra(v: Task[]) { put(key("extra"), v); },
  /** Explicit user save must survive reload before the capture form is cleared. */
  commitExtra(v: Task[]) {
    const k = key("extra");
    localStorage.setItem(nsKey(k), JSON.stringify(v));
    put(k, v);
  },
  hidden(): string[] { return cache.get<string[]>(key("hidden")) ?? []; },
  setHidden(v: string[]) { put(key("hidden"), v); },
  /** «Мои дела сегодня»; null — день ещё не начат (засеять из настроек). */
  acts(): DayActivity[] | null { return cache.get<DayActivity[]>(key("acts")); },
  setActs(v: DayActivity[]) { put(key("acts"), v); },
  /** Сон только на сегодня (null — обычный). */
  bedToday(): string | null { return cache.get<string>(key("bed")); },
  setBedToday(v: string | null) { put(key("bed"), v); },
  /** Старт плана на сегодня, заданный учеником/помощником («задержусь», «опоздаю»); null — от расписания. */
  startToday(): string | null { return cache.get<string>(key("start")); },
  setStartToday(v: string | null) { put(key("start"), v); },
  /** «Мои дела» на другой день (завтра): засеваются из настроек при первом обращении. */
  actsFor(off: number): DayActivity[] | null { return cache.get<DayActivity[]>(key("acts", off)); },
  setActsFor(off: number, v: DayActivity[]) { put(key("acts", off), v); },
  /** Почему задание перенесено (на какой день: off=1 — завтра утром). */
  moved(off = 0): Record<string, string> { return cache.get<Record<string, string>>(key("moved", off)) ?? {}; },
  setMoved(off: number, title: string, reason: string | null) {
    const m = { ...this.moved(off) }; if (reason) m[title] = reason; else delete m[title];
    put(key("moved", off), m);
  },
  /** Итог дня (для «Что изменилось?» завтра): сделано / перенесено. */
  doneFor(off: number): string[] { return cache.get<string[]>(key("done", off)) ?? []; },
  extraFor(off: number): Task[] { return cache.get<Task[]>(key("extra", off)) ?? []; },
  setExtraFor(off: number, v: Task[]) { put(key("extra", off), v); },
  built(): boolean { return cache.get<boolean>(key("built")) ?? false; },
  setBuilt(v: boolean) { put(key("built"), v); },
  log(): Record<string, ExecRecord> { return cache.get<Record<string, ExecRecord>>(key("log")) ?? {}; },
  setLog(title: string, r: ExecRecord | null) {
    const l = { ...this.log() }; if (r) l[title] = r; else delete l[title];
    put(key("log"), l);
  },
  types(): Record<string, Task["type"]> { return cache.get<Record<string, Task["type"]>>(key("types")) ?? {}; },
  setType(title: string, type: Task["type"]) { put(key("types"), { ...this.types(), [title]: type }); },
  carryToTomorrow(t: Task) {
    const k = key("extra", 1);
    const list = cache.get<Task[]>(k) ?? [];
    if (!list.some((x) => x.title === t.title)) put(k, [...list, { ...t, source: "morning" }]);
  },
  cards(): MorningCard[] {
    const today = schoolDay();
    return (cache.get<MorningCard[]>("sf.cards") ?? []).filter((c) => c.until >= today);
  },
  addCard(title: string, card: Flashcard) {
    const list = this.cards().filter((c) => c.title !== title);
    put("sf.cards", [...list, { title, card, until: schoolDay(nowDate(), 1) }].slice(-8));
  },
  dropCard(title: string) { put("sf.cards", this.cards().filter((c) => c.title !== title)); },
  async hydrate(): Promise<boolean> {
    let got = false;
    await Promise.all([...MIRRORED.map((k) => key(k)), "sf.cards"].map(async (k) => {
      if (cache.get(k) !== null) return;
      const raw = await deviceStore.get(nsKey(k));
      if (!raw) return;
      try { cache.set(k, JSON.parse(raw)); got = true; } catch { /* битые данные */ }
    }));
    return got;
  },
};

export function execState(title: string, done: string[], session: { title: string; startedAt: number } | null, now = Date.now()): ExecState {
  if (done.includes(title)) return dayStore.log()[title]?.synced === false ? "finished" : "completed";
  if (session?.title === title) return now - session.startedAt < 60_000 ? "started" : "in_progress";
  return "not_started";
}

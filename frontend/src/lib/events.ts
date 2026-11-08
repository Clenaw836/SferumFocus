/**
 * Помощник думает событиями, а не экранами: EVENT → STATE CHANGE → DECISION → ACTION → FEEDBACK.
 * Журнал событий хранится по учебным дням (+ зеркало DeviceStorage), из него строятся
 * «Что изменилось?», утренний перенос и подсказки помощника.
 */
import { cache } from "./api";
import { deviceStore } from "./host";
import { nsKey } from "./demo";
import { schoolDay } from "./day";
import { nowDate } from "./clock";

export type EventType =
  | "SCHEDULE_CHANGED" | "LESSON_CANCELLED" | "LESSON_REPLACED" | "LESSON_MOVED" | "SCHEDULE_REVERTED"
  | "HOMEWORK_ADDED" | "HOMEWORK_COMPLETED" | "USER_LATE" | "USER_TIRED" | "WHATIF_APPLIED"
  | "ACTIVITY_ADDED" | "ACTIVITY_CANCELLED" | "ACTIVITY_MOVED"
  | "BEDTIME_CHANGED" | "WAKE_TIME_CHANGED" | "PLAN_OVERLOADED" | "PLAN_REBUILT" | "TASK_MOVED_TO_MORNING"
  | "MORNING_STARTED" | "SCHOOL_DAY_STARTED" | "LAST_LESSON_FINISHED" | "TRAVEL_STARTED" | "TRAVEL_FINISHED";
export interface SfEvent { id: string; type: EventType; at: number; day: string; data: Record<string, unknown> }

const KEY = "sf.events";
const all = (): SfEvent[] => cache.get<SfEvent[]>(KEY) ?? [];
const listeners = new Set<(e: SfEvent) => void>();

export const events = {
  emit(type: EventType, data: Record<string, unknown> = {}, dedupe?: string): SfEvent | null {
    const day = schoolDay();
    const list = all();
    // события фаз дня (MORNING_STARTED и т.п.) — один раз за день
    if (dedupe && list.some((e) => e.day === day && e.type === type && e.data.k === dedupe)) return null;
    const ev: SfEvent = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type, at: nowDate().getTime(), day, data: dedupe ? { ...data, k: dedupe } : data };
    const next = [...list.filter((e) => e.day >= schoolDay(nowDate(), -7)), ev].slice(-300);
    cache.set(KEY, next); deviceStore.set(nsKey(KEY), JSON.stringify(next));
    listeners.forEach((f) => f(ev));
    return ev;
  },
  on(fn: (e: SfEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
  forDay(day: string): SfEvent[] { return all().filter((e) => e.day === day); },
  since(day: string): SfEvent[] { return all().filter((e) => e.day >= day); },
  async hydrate() { if (cache.get(KEY) !== null) return; const raw = await deviceStore.get(nsKey(KEY)); if (raw) try { cache.set(KEY, JSON.parse(raw)); } catch { /* */ } },
};

/**
 * Хранилище расписания на устройстве: кэш недели провайдера + изменения ученика (офлайн-очередь).
 * Офлайн: изменение применяется сразу на телефоне (dirty) и уезжает на сервер при возврате связи.
 * Синхронизация идемпотентна (объединение по id) — повторы и гонки не создают дублей.
 */
import { api, cache, dataMode } from "./api";
import { deviceStore } from "./host";
import { DEMO, nsKey } from "./demo";
import { events } from "./events";
import { addDays, dayView, demoLessons, type DayView, type Lesson, type Provider, type ScheduleChange, type WeekResp } from "./schedule";

interface Doc { version: number; changes: ScheduleChange[]; school_week: number | null; dirty: boolean }
const DOC = "sf.sched.doc", WEEK = "sf.sched.week", ACK = "sf.sched.ack";
const listeners = new Set<() => void>();
const ping = () => listeners.forEach((f) => f());

const doc = (): Doc => cache.get<Doc>(DOC) ?? { version: 0, changes: [], school_week: null, dirty: false };
const save = (d: Doc) => { cache.set(DOC, d); deviceStore.set(nsKey(DOC), JSON.stringify(d)); ping(); };
let syncing: Promise<void> | null = null;
let loading = false;
const WEEK_AT = "sf.sched.week.at";
export type SyncStatus = "fresh" | "stale" | "partial" | "conflict" | "imported" | "demo" | "unavailable" | "none" | "updating";

export const sched = {
  on(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
  provider(): Provider | null { return cache.get<WeekResp>(WEEK)?.provider ?? (dataMode() === "local" ? { kind: "demo", name: "Демо-расписание", is_demo: true, real_status: "not_configured" } : null); },
  schoolWeek(fallback = 5): number { return doc().school_week ?? cache.get<WeekResp>(WEEK)?.school_week_days ?? fallback; },
  setSchoolWeek(n: 5 | 6) { save({ ...doc(), school_week: n, dirty: true }); void sched.sync(); },
  changes(): ScheduleChange[] { return doc().changes; },
  pending(): boolean { return doc().dirty; },
  /** База дня: кэш провайдера; в автономном/демо-режиме — демо-неделя; иначе — нет данных (не выдумываем). */
  base(date: string): Lesson[] | null {
    const w = cache.get<WeekResp>(WEEK);
    const d = w?.days.find((x) => x.date === date);
    if (d) return d.available === false ? null : d.base;   // v16: «нет данных» ≠ «нет уроков» (выходной)
    if (dataMode() === "local" || w?.provider.kind === "demo") return demoLessons(date);
    return null;
  },
  day(date: string): DayView { return dayView(date, sched.base(date), doc().changes); },
  async loadWeek(today: string): Promise<void> {
    loading = true; ping();
    try {
      const w = await api.scheduleWeek(today, 14);
      // v16: пустой ответ не затирает непустое последнее удачное расписание
      cache.set(WEEK, w); cache.set(WEEK_AT, Date.now());
    } catch { /* офлайн: работаем по кэшу (последнее удачное) */ }
    finally { loading = false; ping(); }
  },
  /** v16: статус расписания для экрана — fresh|stale|partial|conflict|imported|demo|unavailable|none|updating. */
  status(): SyncStatus { const st = sched.baseStatus(); return loading && st !== "demo" ? "updating" : st; },
  /** Статус без «обновляется» — для движка дня: идущая синхронизация не должна превращать день в «неизвестно». */
  baseStatus(): SyncStatus {
    const w = cache.get<WeekResp>(WEEK);
    if (!w) return dataMode() === "local" ? "demo" : "none";
    const p = w.provider;
    let st: SyncStatus = p.status ?? (p.is_demo ? "demo" : p.kind === "real" ? "fresh" : "none");
    const at = cache.get<number>(WEEK_AT) ?? 0;
    if ((st === "fresh" || st === "imported") && at && Date.now() - at > 24 * 3600e3) st = "stale";   // давно не обновляли на телефоне
    return st;
  },
  /** Когда телефон последний раз получил неделю (мс) и когда источник школы синхронизировался (ISO). */
  syncedAt(): { phone: number | null; source: string | null } {
    return { phone: cache.get<number>(WEEK_AT), source: cache.get<WeekResp>(WEEK)?.provider.last_sync_at ?? null };
  },
  isLoading: () => loading,
  apply(list: ScheduleChange[]): void {
    if (!list.length) return;
    const d = doc();
    const ids = new Set(d.changes.map((c) => c.id));
    save({ ...d, changes: [...d.changes, ...list.filter((c) => !ids.has(c.id))], dirty: true });
    for (const c of list) {
      const t = c.change_type === "CANCEL" || c.change_type === "REMOVE" ? "LESSON_CANCELLED" : c.change_type === "MOVE" ? "LESSON_MOVED" : c.change_type === "REPLACE" ? "LESSON_REPLACED" : "SCHEDULE_CHANGED";
      events.emit(t, { id: c.id, date: c.date, n: c.lesson_number, before: c.before, subject: c.subject, to: c.to_lesson_number, source: c.source });
    }
    events.emit("SCHEDULE_CHANGED", { count: list.length, date: list[0].date });
    void sched.sync();
  },
  revert(id: string): ScheduleChange | null {
    const d = doc();
    const c = d.changes.find((x) => x.id === id);
    if (!c || c.status === "reverted") return null;
    const upd = { ...c, status: "reverted" as const, updated_at: new Date().toISOString() };
    save({ ...d, changes: d.changes.map((x) => (x.id === id ? upd : x)), dirty: true });
    events.emit("SCHEDULE_REVERTED", { id, date: c.date, n: c.lesson_number, before: c.before, subject: c.subject });
    void sched.sync();
    return upd;
  },
  /** Отправить очередь на сервер. Ошибка сети — остаёмся dirty, повторим при online. */
  sync(): Promise<void> {
    if (syncing) return syncing;
    const d = doc();
    if (!d.dirty || DEMO) return Promise.resolve();   // демо живёт только на телефоне
    syncing = api.scheduleSync(d.changes, d.school_week)
      .then((srv) => {
        const local = doc();
        const byId = new Map(srv.changes.map((c) => [c.id, c]));
        // пока летел запрос, могли появиться новые локальные — сохраняем их и остаёмся dirty
        const extra = local.changes.filter((c) => !byId.has(c.id) || (c.updated_at ?? "") > (byId.get(c.id)!.updated_at ?? ""));
        const merged = [...srv.changes.map((c) => extra.find((e) => e.id === c.id) ?? c), ...extra.filter((e) => !byId.has(e.id))];
        save({ version: srv.version, changes: merged, school_week: srv.school_week ?? local.school_week, dirty: extra.length > 0 });
      })
      .catch(() => undefined)
      .finally(() => { syncing = null; });
    return syncing;
  },
  /** Изменения на дату, которые ученик ещё не видел («Расписание изменилось» → [Понятно]). */
  unseen(date: string): ScheduleChange[] {
    const ack = new Set(cache.get<string[]>(ACK) ?? []);
    return doc().changes.filter((c) => c.date === date && c.status === "applied" && !ack.has(c.id));
  },
  ack(ids: string[]) { cache.set(ACK, [...new Set([...(cache.get<string[]>(ACK) ?? []), ...ids])].slice(-300)); ping(); },
  async hydrate() { if (cache.get(DOC) !== null) return; const raw = await deviceStore.get(nsKey(DOC)); if (raw) try { cache.set(DOC, JSON.parse(raw)); } catch { /* */ } },
  next(date: string, n: number) { return addDays(date, n); },
};

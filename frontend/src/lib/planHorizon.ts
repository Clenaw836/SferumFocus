/**
 * v3.2.1 · Горизонт «Плана дня» для реального дневника.
 * СГО отдаёт ДЗ на две недели вперёд (снимок = текущая + следующая неделя). Раньше в вечер попадало ВСЁ:
 * live 05.11.2026 — «Сегодня: 26 заданий · ~570 мин», маршрут на 9 ч 30 мин. Это не план, а тревога.
 * Правило (как в бумажном дневнике):
 *   • без срока (своё, из бота, от учителя без даты) — всегда сегодня;
 *   • срок до ближайшего учебного дня включительно (пт → пн) — сегодня;
 *   • срок «сегодня» — только пока уроки не начались (утро), потом это уже прошедший урок;
 *   • дальше — «Задано наперёд»: видно, можно взять сегодня одной кнопкой («Сделать сегодня»);
 *   • «хвосты» — срок уже наступил, а «сделано» вчера не отмечено: тоже видны и берутся в план одной кнопкой
 *     (в план сами не встают: СГО не знает, сделано ли задание на бумаге — не раздуваем вечер догадками);
 *   • сделанное наперёд не возвращается, когда срок подойдёт.
 */
export interface Horizon { from: string; until: string }
interface Dated { title: string; deadline?: string | null }

const DAY = 864e5;
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** until = ближайший день с уроками после today (≤ maxAhead дней), иначе завтра; from = today до начала уроков. */
export function planHorizon(today: string, hasLessons: (iso: string) => boolean, beforeSchool: boolean, maxAhead = 7): Horizon {
  let until = addDays(today, 1);
  for (let i = 1; i <= maxAhead; i++) {
    const d = addDays(today, i);
    if (hasLessons(d)) { until = d; break; }
  }
  return { from: beforeSchool ? today : addDays(today, 1), until };
}

export type Bucket = "now" | "ahead" | "past";
export function bucketOf(t: Dated, h: Horizon, pulled: ReadonlySet<string>): Bucket {
  const d = t.deadline;
  if (!d || pulled.has(t.title)) return "now";
  if (d < h.from) return "past";
  return d <= h.until ? "now" : "ahead";
}

export function splitByHorizon<T extends Dated>(tasks: T[], h: Horizon, today: string, pulled: ReadonlySet<string>,
  doneAhead: ReadonlyMap<string, string>, doneBefore: ReadonlySet<string> = new Set()): { now: T[]; ahead: T[]; tails: T[] } {
  const now: T[] = [], ahead: T[] = [], tails: T[] = [];
  for (const t of tasks) {
    const doneOn = doneAhead.get(t.title);
    if (doneOn && doneOn < today) continue;            // сделано наперёд в прошлый день — не всплывает в день срока
    const b = bucketOf(t, h, pulled);
    if (b === "now") now.push(t);
    else if (b === "ahead") ahead.push(t);
    else if (!doneBefore.has(t.title)) tails.push(t);  // «хвост»: срок прошёл/идёт урок, а «сделано» не отмечали
  }
  ahead.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  return { now, ahead, tails };
}

/** Хранилище: взятые наперёд (title → срок) и сделанные наперёд (title → "срок|день отметки").
 *  Записи с прошедшим сроком вычищаются при чтении. */
const KP = "sf.ahead.pulled.v1", KD = "sf.ahead.done.v1";
type Rec = Record<string, string>;
const read = (k: string): Rec => { try { const v = JSON.parse(localStorage.getItem(k) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const write = (k: string, v: Rec) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } };
const prune = (m: Rec, today: string): Rec => Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string" && v.slice(0, 10) >= today));
export const aheadStore = {
  pulled(today: string): Set<string> { return new Set(Object.keys(prune(read(KP), today))); },
  doneAhead(today: string): Map<string, string> {
    return new Map(Object.entries(prune(read(KD), today)).map(([t, v]) => [t, v.slice(11, 21)]));
  },
  pull(title: string, deadline: string, today: string) { write(KP, { ...prune(read(KP), today), [title]: deadline }); },
  /** «Сделано» по заданию, взятому наперёд: в день срока оно не вернётся в план. */
  markDone(title: string, deadline: string | null | undefined, today: string) {
    if (!deadline || deadline <= today || !(title in read(KP))) return;
    write(KD, { ...prune(read(KD), today), [title]: `${deadline}|${today}` });
  },
  unmarkDone(title: string, today: string) { const m = prune(read(KD), today); delete m[title]; write(KD, m); },
};

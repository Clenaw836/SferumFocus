// v3.2 · архив дневника СГО (GET /api/v1/diary/days): прошлые дни, ДЗ под каждым уроком, отметки.
import type { Lesson } from "./schedule";

export interface SgoDayLesson {
  number: number | null; start: string | null; end: string | null; subject: string; room: string | null; topic: string | null;
  homework: { text: string; due: string }[]; marks: { value: string; work_type: string | null; topic: string | null }[];
}
export interface SgoDay { date: string; lessons: SgoDayLesson[] }
export interface SgoDays { state: "fresh" | "sgo_unlinked" | "reauth" | "upstream_error"; days: SgoDay[]; start?: string; end?: string }

const low = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");

/** Урок СГО для строки расписания: сначала номер + предмет, затем первый урок этого предмета в дне. */
export function sgoLessonFor(day: SgoDay | undefined | null, l: { lesson_number?: number | null; subject: string }): SgoDayLesson | null {
  if (!day) return null;
  const s = low(l.subject);
  return day.lessons.find((x) => x.number === l.lesson_number && low(x.subject) === s)
    ?? day.lessons.find((x) => low(x.subject) === s) ?? null;
}

/** День из архива СГО в формате строки расписания — когда кэш расписания этот день не покрывает (прошлые недели). */
export function archiveLessons(day: SgoDay | undefined | null, weekday: Lesson["day"]): Lesson[] {
  if (!day) return [];
  return day.lessons.map((x, i) => ({
    day: weekday, date: day.date, lesson_number: x.number ?? i + 1, start_time: x.start, end_time: x.end, subject: x.subject,
    teacher: null, room: x.room, source: "real", confidence: 1, updated_at: null, change_type: null, status: "active",
    was: null, note: null, topic: x.topic,
  }));
}

/** Текст ДЗ под уроком: все задания урока через « · ». */
export function homeworkText(l: SgoDayLesson | null): string | null {
  if (!l || !l.homework.length) return null;
  return l.homework.map((h) => h.text).join(" · ");
}

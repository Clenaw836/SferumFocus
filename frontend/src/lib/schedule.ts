/**
 * Нормализованное школьное расписание на устройстве.
 * Слои: база провайдера (Сферум | демо) → подтверждённые изменения ученика (голос/фото/текст).
 * applyChanges — паритет с app/schedule.py::apply_changes (tests/test_v13_schedule.py).
 * Изменения хранятся на телефоне (+ DeviceStorage MAX) и синхронизируются с сервером
 * объединением по id: офлайн можно менять, при возврате связи всё доезжает без дублей.
 * Оригинал базы не трогается никогда: «Отменить изменение» = статус reverted.
 */
export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export type LessonSource = "real" | "demo" | "student_voice" | "photo_ocr" | "manual" | "text";
export type ChangeType = "ADD" | "REMOVE" | "REPLACE" | "MOVE" | "TIME_CHANGE" | "TEACHER_CHANGE" | "ROOM_CHANGE" | "CANCEL" | "NOTE" | "UNKNOWN";
export type EvidenceKind = "photo" | "screenshot" | "voice" | "text" | "file" | "paste";

export interface Lesson {
  day: Weekday; date: string; lesson_number: number;
  start_time: string | null; end_time: string | null; subject: string;
  teacher: string | null; room: string | null; source: LessonSource; confidence: number;
  updated_at: string | null; change_type: ChangeType | null; status: "active" | "cancelled";
  was: string | null; note: string | null;
  /** v16: тема урока — только если её прислал источник (не выдумываем) */
  topic?: string | null;
}
export interface ScheduleChange {
  id: string; date: string; change_type: ChangeType;
  lesson_number: number | null; to_lesson_number: number | null; shift: boolean;
  subject: string | null; before: string | null; start_time: string | null; end_time: string | null;
  teacher: string | null; room: string | null; note: string | null; reason: string | null;
  source: LessonSource; evidence: EvidenceKind[]; evidence_note: string | null; confidence: number;
  created_at: string | null; updated_at: string | null; status: "applied" | "reverted";
}
export interface DayView {
  date: string; weekday: Weekday; base: Lesson[]; lessons: Lesson[];
  first_lesson: string | null; last_bell: string | null; changed: boolean; change_ids: string[]; available: boolean;
}
export interface Provider {
  kind: "real" | "demo" | "import" | "none"; name: string; is_demo: boolean; real_status: string;
  /** v16: статус синхронизации (сервер); без поля — старый сервер → считаем по kind */
  status?: "fresh" | "stale" | "partial" | "conflict" | "imported" | "demo" | "unavailable" | "none";
  last_sync_at?: string | null; error?: string | null; has_import?: boolean; school_tz?: string | null; feed_configured?: boolean;
}
export interface WeekResp { provider: Provider; school_week_days: number; bells: { lesson_number: number; start_time: string; end_time: string }[]; days: DayView[] }

export const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
export const WD_SHORT: Record<Weekday, string> = { monday: "ПН", tuesday: "ВТ", wednesday: "СР", thursday: "ЧТ", friday: "ПТ", saturday: "СБ", sunday: "ВС" };
export const WD_NAME: Record<Weekday, string> = { monday: "Понедельник", tuesday: "Вторник", wednesday: "Среда", thursday: "Четверг", friday: "Пятница", saturday: "Суббота", sunday: "Воскресенье" };
/** «на среду», «в пятницу» — винительный падеж для фраз помощника */
export const WD_ACC: Record<Weekday, string> = { monday: "понедельник", tuesday: "вторник", wednesday: "среду", thursday: "четверг", friday: "пятницу", saturday: "субботу", sunday: "воскресенье" };
export const SOURCE_LABEL: Record<LessonSource, string> = { real: "Школьный дневник", demo: "Демо", student_voice: "Голос", photo_ocr: "Фото", manual: "Вручную", text: "Текст" };

export const BELLS: [string, string][] = [
  ["08:30", "09:15"], ["09:25", "10:10"], ["10:25", "11:10"], ["11:25", "12:10"],
  ["12:20", "13:05"], ["13:55", "14:45"], ["14:55", "15:40"], ["15:50", "16:35"],
];
export const DEMO_WEEK: Partial<Record<Weekday, string[]>> = {
  monday: ["Русский язык", "Алгебра", "Английский язык", "Биология", "Литература", "Физкультура"],
  tuesday: ["Геометрия", "Физика", "Русский язык", "История", "Английский язык", "Информатика"],
  wednesday: ["Алгебра", "Русский язык", "Литература", "Физика", "История", "Физкультура"],
  thursday: ["Химия", "Алгебра", "Русский язык", "Английский язык", "История", "Биология"],
  friday: ["Физика", "Геометрия", "Русский язык", "Английский язык", "Литература", "Технология"],
  saturday: ["Информатика", "Обществознание", "География", "Алгебра"],
};
const DEMO_ROOMS: Record<string, string> = { "Физкультура": "спортзал", "Информатика": "каб. 31", "Химия": "каб. 24" };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseISO = (s: string) => new Date(`${s}T12:00:00`);
export const weekdayOf = (s: string): Weekday => WEEKDAYS[(parseISO(s).getDay() + 6) % 7];
export const addDays = (s: string, n: number) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export const bell = (n: number): [string | null, string | null] => (n >= 1 && n <= BELLS.length ? BELLS[n - 1] : [null, null]);

export function mkLesson(date: string, n: number, subject: string, source: LessonSource, o: Partial<Lesson> = {}): Lesson {
  const [s, e] = bell(n);
  return {
    day: weekdayOf(date), date, lesson_number: n, start_time: o.start_time ?? s, end_time: o.end_time ?? e, subject,
    teacher: o.teacher ?? null, room: o.room ?? null, source, confidence: o.confidence ?? 1, updated_at: o.updated_at ?? null,
    change_type: null, status: "active", was: null, note: null,
  };
}
/** Демо-провайдер на устройстве (автономный режим) — та же неделя, что DemoScheduleProvider. */
export const demoLessons = (date: string): Lesson[] =>
  (DEMO_WEEK[weekdayOf(date)] ?? []).map((s, i) => mkLesson(date, i + 1, s, "demo", { room: DEMO_ROOMS[s] ?? null }));

const slot = (ls: Lesson[], n: number | null) => (n ? ls.find((x) => x.lesson_number === n) : undefined);

export function applyChanges(base: Lesson[], changes: ScheduleChange[], date: string): Lesson[] {
  const out: Lesson[] = base.map((x) => ({ ...x }));
  for (const c of changes) {
    if (c.status !== "applied" || c.date !== date) continue;
    const ct = c.change_type, n = c.lesson_number;
    const cur = slot(out, n);
    const stamp = { source: c.source, confidence: c.confidence, updated_at: c.updated_at, change_type: ct };
    if ((ct === "ADD" || ct === "REPLACE") && n && c.subject) {
      if (cur) {
        const was = cur.status === "active" && cur.subject !== c.subject ? cur.subject : cur.was;
        if (cur.subject !== c.subject) Object.assign(cur, { room: null, teacher: null, note: null });   // кабинет/учитель/пометка прежнего урока не переносятся
        Object.assign(cur, stamp, { subject: c.subject, status: "active", was });
        if (c.start_time) cur.start_time = c.start_time;
        if (c.end_time) cur.end_time = c.end_time;
      } else {
        const nl = mkLesson(date, n, c.subject, c.source, { confidence: c.confidence, start_time: c.start_time, end_time: c.end_time, updated_at: c.updated_at });
        nl.change_type = ct;
        out.push(nl);
      }
      const tgt = slot(out, n)!;
      if (c.room) tgt.room = c.room;
      if (c.teacher) tgt.teacher = c.teacher;
    } else if ((ct === "REMOVE" || ct === "CANCEL") && cur) {
      Object.assign(cur, stamp, { status: "cancelled" });
    } else if (ct === "MOVE" && cur && cur.status === "active" && c.to_lesson_number) {
      const delta = c.to_lesson_number - n!;
      const group = out.filter((x) => x.status === "active" && (c.shift ? x.lesson_number >= n! : x.lesson_number === n));
      const snapshot = group.map((x) => ({ ...x }));
      for (const x of group) Object.assign(x, stamp, { status: "cancelled" });
      for (const x of snapshot) {
        const k = x.lesson_number + delta;
        if (k < 1 || k > BELLS.length) continue;
        const [s, e] = bell(k);
        const tgt = slot(out, k);
        const moved: Lesson = { ...x, ...stamp, lesson_number: k, start_time: s, end_time: e, status: "active", was: null };
        if (tgt) {
          if (tgt.status === "active" && tgt.subject !== x.subject) moved.was = tgt.subject;
          for (const key of Object.keys(tgt)) delete (tgt as unknown as Record<string, unknown>)[key];
          Object.assign(tgt, moved);
        } else out.push(moved);
      }
    } else if (ct === "TIME_CHANGE" && cur) {
      Object.assign(cur, stamp);
      if (c.start_time) cur.start_time = c.start_time;
      if (c.end_time) cur.end_time = c.end_time;
    } else if (ct === "TEACHER_CHANGE" && cur && c.teacher) Object.assign(cur, stamp, { teacher: c.teacher });
    else if (ct === "ROOM_CHANGE" && cur && c.room) Object.assign(cur, stamp, { room: c.room });
    else if (ct === "NOTE" && cur && c.note) cur.note = c.note;
  }
  return out.sort((a, b) => a.lesson_number - b.lesson_number);
}

export function dayView(date: string, base: Lesson[] | null, changes: ScheduleChange[]): DayView {
  const lessons = applyChanges(base ?? [], changes, date);
  const active = lessons.filter((x) => x.status === "active");
  const ids = changes.filter((c) => c.status === "applied" && c.date === date).map((c) => c.id);
  return {
    date, weekday: weekdayOf(date), base: base ?? [], lessons,
    first_lesson: active[0]?.start_time ?? null, last_bell: active[active.length - 1]?.end_time ?? null,
    changed: ids.length > 0, change_ids: ids, available: base !== null,
  };
}

export const newChangeId = () => `sc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export function change(p: Partial<ScheduleChange> & { date: string; change_type: ChangeType; source: LessonSource }): ScheduleChange {
  const now = new Date().toISOString();
  return {
    id: p.id ?? newChangeId(), date: p.date, change_type: p.change_type,
    lesson_number: p.lesson_number ?? null, to_lesson_number: p.to_lesson_number ?? null, shift: p.shift ?? false,
    subject: p.subject ?? null, before: p.before ?? null, start_time: p.start_time ?? null, end_time: p.end_time ?? null,
    teacher: p.teacher ?? null, room: p.room ?? null, note: p.note ?? null, reason: p.reason ?? null,
    source: p.source, evidence: p.evidence ?? [], evidence_note: p.evidence_note ?? null,
    confidence: p.confidence ?? 1, created_at: p.created_at ?? now, updated_at: p.updated_at ?? now, status: p.status ?? "applied",
  };
}

/** Человеческое описание изменения: «3-й урок · Физика → Информатика». icon — имя SVG из ui/Icon (v2.2: без эмодзи). */
export function describe(c: ScheduleChange): { icon: string; text: string } {
  const n = c.lesson_number ? `${c.lesson_number}-й урок` : "урок";
  switch (c.change_type) {
    case "REPLACE": return { icon: "arrows", text: `${n} · ${c.before ?? "?"} → ${c.subject}` };
    case "ADD": return { icon: "plus", text: `${n} · ${c.subject}${c.before ? ` (было: ${c.before})` : ""}` };
    case "CANCEL": case "REMOVE": return { icon: "x", text: `${n}${c.before ? ` · ${c.before}` : ""} — отменён` };
    case "MOVE": return { icon: "route", text: `${c.before ?? n} · ${c.lesson_number}-й → ${c.to_lesson_number}-й урок${c.shift ? " (сдвиг остальных)" : ""}` };
    case "TIME_CHANGE": return { icon: "clock", text: `${n}${c.before ? ` · ${c.before}` : ""} — теперь ${c.start_time ?? ""}${c.end_time ? `–${c.end_time}` : ""}` };
    case "TEACHER_CHANGE": return { icon: "user", text: `${n} · ведёт ${c.teacher}` };
    case "ROOM_CHANGE": return { icon: "door", text: `${n} · ${c.room}` };
    case "NOTE": return { icon: "pen", text: `${n}${c.before ? ` · ${c.before}` : ""}: ${c.note}` };
    default: return { icon: "info", text: c.reason ?? "Непонятное изменение" };
  }
}

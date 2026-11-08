/**
 * v16 Smart Scheduler — детерминированный движок школьного дня (порт 1:1 app/day_engine.py).
 * Единственный источник «что сейчас происходит» для главного экрана, помощника и сцены.
 * Чистая функция: время приходит явно (nowLocal), нет Date.now(), случайности и ИИ.
 * Паритет с Python — tests/test_v16_day_parity.py (47 случаев). Правка — в ОБОИХ файлах.
 */
export const ENGINE_VERSION = "16.0";
export const DAY_EDGE = 4 * 60;
export const ENDING_MIN = 10;
export const PREP_MIN_BREAK = 5;
export type DayState = "MORNING" | "BEFORE_SCHOOL" | "IN_LESSON" | "BETWEEN_LESSONS" | "SCHOOL_ENDING" | "TRAVEL_HOME" | "AFTER_SCHOOL" | "EVENING" | "NIGHT" | "NO_SCHOOL" | "UNKNOWN";
export type LegacyPhase = "night" | "morning" | "school" | "travel" | "evening" | "free";
export const LEGACY_PHASE: Record<DayState, LegacyPhase> = {
  MORNING: "morning", BEFORE_SCHOOL: "school", IN_LESSON: "school", BETWEEN_LESSONS: "school", SCHOOL_ENDING: "school",
  TRAVEL_HOME: "travel", AFTER_SCHOOL: "evening", EVENING: "evening", NIGHT: "night", NO_SCHOOL: "free", UNKNOWN: "free",
};
export type ScheduleStatus = "fresh" | "stale" | "partial" | "conflict" | "imported" | "demo" | "unavailable" | "none" | "updating";
const STATUS_OK = ["fresh", "imported", "demo", "stale", "partial", "conflict"];

export interface EngineLesson { lesson_number?: number | null; subject?: string | null; start_time?: string | null; end_time?: string | null; status?: string | null; room?: string | null; topic?: string | null }
export interface EngineTask { title: string; planned_minutes?: number | null; type?: string | null; due?: string | null }
export interface Warning { code: string; text: string; diff_min?: number; minutes?: number }
export interface DayInput {
  now_local: string;
  days: Record<string, { available?: boolean; lessons?: EngineLesson[] }>;
  settings?: { travel_minutes?: number | null; bedtime?: string | null; evening_start?: string | null; start_override?: string | null };
  schedule?: { status?: string | null; is_demo?: boolean; last_sync_at?: string | null };
  tasks?: EngineTask[];
  done?: string[];
  clock_warning?: Warning | null;
}
export interface LessonOut { n: number | null; subject: string | null; start: string; end: string; room: string | null; topic: string | null }
export interface HwRow { title: string; subject: string; minutes: number; type: string; due: string | null; reason: string; priority: number }
export interface Action { kind: string; label: string; reason: string; target?: string }
export interface DayOut {
  engine_version: string; date: string; now: string; minute: number;
  day_state: DayState; phase: LegacyPhase; schedule_status: string; data_quality: string; last_sync_at: string | null;
  current_lesson: (LessonOut & { ends_in: number; progress_pct: number }) | null;
  next_lesson: (LessonOut & { starts_in: number }) | null;
  previous_lesson: LessonOut | null;
  remaining_lessons: number;
  lessons: { n: number | null; subject: string | null; start: string | null; end: string | null; status: string }[];
  school: { first: string | null; last: string | null; leave: string | null; home: string | null };
  travel_home: { minutes: number; home_at: string | null; active: boolean; remaining: number | null };
  evening_start: string;
  next_event: { kind: string; at: string; in_min: number; label: string } | null;
  homework: HwRow[]; homework_minutes: number;
  available_time: { from: string; to: string; minutes: number; deficit: number };
  lesson_prep: { subject: string | null; n: number | null; date: string; start: string; starts_in: number | null; topic: string | null; topic_source: "schedule" | "task" | "unknown"; related_tasks: string[] } | null;
  recommended_action: Action;
  tomorrow: { date: string; available: boolean; count: number; first: string | null; subjects: (string | null)[] };
  time_budget: { school: number; travel: number; homework: number; free: number; sleep_at: string };
  warnings: Warning[];
  refresh: { next_change_min: number; next_change_at: string; per_minute: boolean };
  plan_version: string;
}

// ---------------------------------------------------------------- время
export function toMinStrict(s: string | null | undefined): number | null {
  if (!s || typeof s !== "string") return null;
  const p = s.split(":");
  if (p.length !== 2 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return null;
  const h = Number(p[0]), m = Number(p[1]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
export const hhmm = (m: number): string => { const v = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}
export function schoolDate(nowLocal: string): [string, number] {
  const m = Number(nowLocal.slice(11, 13)) * 60 + Number(nowLocal.slice(14, 16));
  const d = nowLocal.slice(0, 10);
  return m < DAY_EDGE ? [addDaysISO(d, -1), m + 1440] : [d, m];
}

/** Смещение пояса (мин) в момент t: Intl, без зависимостей. null — пояс не распознан. */
export function tzOffset(tz: string, t: Date): number | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    return Math.round((asUtc - Math.floor(t.getTime() / 60000) * 60000) / 60000);
  } catch { return null; }
}
export interface Clock { now_local: string; offset_min: number; source: "device" | "school"; school_tz: string | null; device_offset_min: number; warning: Warning | null }
/** Порт resolve_clock: устройство vs пояс школы; расхождение → предупреждение «+N ч», уроки — по школе. */
export function resolveClock(nowUtc: Date, deviceOffsetMin: number, schoolTz: string | null, schoolOffsetMin: number | null = null): Clock {
  let off = deviceOffsetMin, source: Clock["source"] = "device", warn: Warning | null = null;
  if (schoolTz) {
    const so = schoolOffsetMin ?? tzOffset(schoolTz, nowUtc);
    if (so === null) warn = { code: "tz_invalid", text: `Пояс школы «${schoolTz}» не распознан — считаю по часам телефона` };
    else {
      off = so; source = "school";
      const diff = so - deviceOffsetMin;
      if (diff) {
        const sign = diff > 0 ? "+" : "−", h = Math.floor(Math.abs(diff) / 60), mm = Math.abs(diff) % 60;
        warn = { code: "clock_mismatch", diff_min: diff, text: `Часы телефона и школы расходятся (${sign}${h} ч${mm ? ` ${mm} мин` : ""}) — время уроков по школе` };
      }
    }
  }
  const local = new Date(Math.floor(nowUtc.getTime() / 60000) * 60000 + off * 60000).toISOString().slice(0, 16);
  return { now_local: local, offset_min: off, source, school_tz: schoolTz || null, device_offset_min: deviceOffsetMin, warning: warn };
}

// ---------------------------------------------------------------- предметы
export function subjKey(s: string | null | undefined): string {
  if (!s) return "";
  let w = s.split(":")[0].trim().toLowerCase().replace(/ё/g, "е");
  w = w ? w.split(" ")[0] : "";
  return w.slice(0, 5);
}
export const taskSubject = (title: string) => (title.includes(":") ? title.split(":")[0].trim() : title.trim());
export function taskDetail(title: string): string | null {
  const i = title.indexOf(":");
  if (i < 0) return null;
  const d = title.slice(i + 1).trim();
  return d || null;
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Act extends EngineLesson { _s: number; _e: number }
function active(lessons: EngineLesson[]): [Act[], boolean, boolean] {
  const out: Act[] = [];
  let partial = false;
  for (const x of lessons ?? []) {
    if ((x.status || "active") !== "active") continue;
    const s = toMinStrict(x.start_time), e = toMinStrict(x.end_time);
    if (s === null || e === null || e <= s) { partial = true; continue; }
    out.push({ ...x, _s: s, _e: e });
  }
  out.sort((a, b) => a._s - b._s || (a.lesson_number || 0) - (b.lesson_number || 0));
  let conflict = false;
  for (let i = 1; i < out.length; i++) if (out[i]._s < out[i - 1]._e) conflict = true;
  return [out, partial, conflict];
}
const lessonOut = (x: Act | null): LessonOut | null => (x ? { n: x.lesson_number ?? null, subject: x.subject ?? null, start: hhmm(x._s), end: hhmm(x._e), room: x.room ?? null, topic: x.topic ?? null } : null);

// ---------------------------------------------------------------- приоритет домашки
export function prioritize(tasks: EngineTask[], done: string[], tomorrow: Act[], todayDate: string): HwRow[] {
  const tom = new Map<string, Act>();
  for (const x of tomorrow) { const k = subjKey(x.subject); if (k && !tom.has(k)) tom.set(k, x); }
  type Row = HwRow & { _r: [number, number]; _d: string; _w: number };
  const rows: Row[] = [];
  const t1 = addDaysISO(todayDate, 1);
  for (const t of tasks) {
    const title = t.title || "";
    if (!title || done.includes(title)) continue;
    const les = tom.get(subjKey(taskSubject(title)));
    const due = t.due ?? null, mins = Math.trunc(Number(t.planned_minutes || 0)), typ = t.type || "written";
    let reason: string, rank: [number, number];
    if (les) { reason = `завтра ${les.lesson_number || 0}-м уроком ${les.subject}`; rank = [0, les._s]; }
    else if (due && due <= t1) { reason = due === t1 ? "срок — завтра" : "срок прошёл"; rank = [1, 0]; }
    else if (due) { reason = `срок ${due.slice(8, 10)}.${due.slice(5, 7)}`; rank = [2, 0]; }
    else { reason = "урока завтра нет — можно позже"; rank = [3, 0]; }
    rows.push({ title, subject: taskSubject(title), minutes: mins, type: typ, due, reason, priority: 0, _r: rank, _d: due || "9999-99-99", _w: typ !== "oral" ? 0 : 1 });
  }
  rows.sort((a, b) => a._r[0] - b._r[0] || a._r[1] - b._r[1] || cmp(a._d, b._d) || a._w - b._w || b.minutes - a.minutes || cmp(a.title, b.title));
  return rows.map((r, i) => {
    const { _r, _d, _w, ...o } = r; void _d; void _w;
    o.priority = i + 1;
    if (i === 0 && _r[0] === 3 && o.minutes >= 30) o.reason = "самое длинное — пока есть силы";
    return o;
  });
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const dur = (m: number) => { m = Math.max(0, m); const h = Math.floor(m / 60), r = m % 60; return !h ? `${r} мин` : r ? `${h} ч ${r} мин` : `${h} ч`; };
const plural = (n: number, one: string, few: string, many: string) => { const a = Math.abs(n) % 100, b = Math.abs(n) % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };

// ---------------------------------------------------------------- главный расчёт
export function computeDay(inp: DayInput): DayOut {
  const [sdate, now] = schoolDate(inp.now_local);
  const tdate = addDaysISO(sdate, 1);
  const days = inp.days ?? {};
  const st = inp.settings ?? {};
  const tv = st.travel_minutes;
  const travel = Math.max(0, Math.min(240, Math.trunc(tv !== null && tv !== undefined ? tv : 45)));
  let bed0 = toMinStrict(st.bedtime); if (bed0 === null) bed0 = 22 * 60;
  const bed = bed0 < 12 * 60 ? bed0 + 1440 : bed0;
  let recStart = toMinStrict(st.evening_start); if (recStart === null) recStart = 15 * 60 + 30;
  const sched = inp.schedule ?? {};
  const sstatus = sched.status || "none";
  const tasks = inp.tasks ?? [], done = inp.done ?? [];
  const warnings: Warning[] = [];
  if (inp.clock_warning) warnings.push(inp.clock_warning);

  const today = days[sdate] ?? {}, tomorrow = days[tdate] ?? {};
  const tAvail = !!today.available && STATUS_OK.includes(sstatus);
  const [act, partial, conflict] = active(today.lessons ?? []);
  const [tomAct] = tomorrow.available ? active(tomorrow.lessons ?? []) : [[] as Act[]];

  const isDemo = !!sched.is_demo || sstatus === "demo";
  const quality = !tAvail ? "none" : conflict ? "conflict" : partial || sstatus === "partial" ? "partial" : sstatus === "stale" ? "stale" : isDemo ? "demo" : "ok";
  if (sstatus === "stale") warnings.push({ code: "schedule_stale", text: "Расписание устарело — показываю последнее сохранённое" });
  if (isDemo) warnings.push({ code: "schedule_demo", text: "Демо-расписание — не настоящие уроки" });
  if (conflict) warnings.push({ code: "schedule_conflict", text: "Уроки в расписании пересекаются — проверь время" });
  if (partial) warnings.push({ code: "schedule_partial", text: "У части уроков нет времени — они не учтены" });
  if (!tAvail) warnings.push({ code: "schedule_missing", text: "Расписания на сегодня нет — день не угадываю" });

  const first = act.length ? act[0]._s : null;
  const last = act.length ? Math.max(...act.map((x) => x._e)) : null;
  const leave = first !== null ? first - travel : null;
  const home = last !== null ? last + travel : null;
  let start: number | null = st.start_override ? toMinStrict(st.start_override) : null;
  if (start === null) start = home !== null && home > recStart ? home : recStart;

  const cur = act.find((x) => x._s <= now && now < x._e) ?? null;
  const nxt = act.find((x) => x._s > now) ?? null;
  let prev: Act | null = null;
  for (const x of act) if (x._e <= now) prev = x;

  let state: DayState;
  if (now >= bed) state = "NIGHT";
  else if (!tAvail) state = now >= start ? "EVENING" : "UNKNOWN";
  else if (!act.length) state = !partial ? "NO_SCHOOL" : "UNKNOWN";
  else if (now < leave!) state = "MORNING";
  else if (now < first!) state = "BEFORE_SCHOOL";
  else if (now < last!) state = cur ? (cur._e === last && last! - now <= ENDING_MIN ? "SCHOOL_ENDING" : "IN_LESSON") : "BETWEEN_LESSONS";
  else if (now < home!) state = "TRAVEL_HOME";
  else if (now < start) state = "AFTER_SCHOOL";
  else state = "EVENING";

  const lessonsOut = [...(today.lessons ?? [])].sort((a, b) => (a.lesson_number || 0) - (b.lesson_number || 0)).map((x) => {
    const s = toMinStrict(x.start_time), e = toMinStrict(x.end_time);
    let ls: string;
    if ((x.status || "active") !== "active") ls = "cancelled";
    else if (s === null || e === null) ls = "unknown";
    else if (cur && x.lesson_number === cur.lesson_number && s === cur._s) ls = "current";
    else if (e <= now) ls = "past";
    else if (nxt && x.lesson_number === nxt.lesson_number && s === nxt._s) ls = "next";
    else ls = "later";
    return { n: x.lesson_number ?? null, subject: x.subject ?? null, start: x.start_time ?? null, end: x.end_time ?? null, status: ls };
  });
  const remaining = act.filter((x) => x._e > now).length;

  const marks: [number, string, string][] = [];
  if (act.length) {
    marks.push([leave!, "leave", "выход из дома"]);
    for (const x of act) { marks.push([x._s, "lesson_start", `начало: ${x.subject}`]); marks.push([x._e, "lesson_end", `конец: ${x.subject}`]); }
    marks.push([last! - ENDING_MIN, "ending", "последние минуты"]);
    marks.push([home!, "home", "дома"]);
  }
  marks.push([start, "evening", "старт вечера"]);
  marks.push([bed, "bed", "сон"]);
  marks.push([1440 + DAY_EDGE, "day_edge", "новый учебный день"]);
  const future = marks.filter((m) => m[0] > now).sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]));
  let ne: DayOut["next_event"] = null;
  for (const m of future) { if (m[1] === "ending") continue; ne = { kind: m[1], at: hhmm(m[0]), in_min: m[0] - now, label: m[2] }; break; }
  const nextChange = future.length ? future[0][0] : 1440 + DAY_EDGE;

  const hw = prioritize(tasks, done, tomAct, sdate);
  const hwTotal = hw.reduce((s, r) => s + r.minutes, 0);
  let eveFrom = state !== "NIGHT" ? Math.max(now, start) : bed;
  if (["MORNING", "BEFORE_SCHOOL", "IN_LESSON", "BETWEEN_LESSONS", "SCHOOL_ENDING", "TRAVEL_HOME"].includes(state)) eveFrom = Math.max(start, home !== null ? home : start);
  const avail = Math.max(0, bed - eveFrom);
  const deficit = hw.length ? Math.max(0, hwTotal - avail) : 0;
  if (deficit && ["AFTER_SCHOOL", "EVENING", "NO_SCHOOL", "UNKNOWN", "TRAVEL_HOME"].includes(state)) warnings.push({ code: "deficit", minutes: deficit, text: `До сна не хватает ${dur(deficit)} — нужен план спасения` });

  let prep: DayOut["lesson_prep"] = null;
  let target: Act | null = null, tday = sdate;
  if (["MORNING", "BEFORE_SCHOOL", "BETWEEN_LESSONS", "IN_LESSON"].includes(state) && nxt) { target = nxt; tday = sdate; }
  else if (state === "MORNING" && act.length) { target = act[0]; tday = sdate; }
  else if (["SCHOOL_ENDING", "TRAVEL_HOME", "AFTER_SCHOOL", "EVENING", "NO_SCHOOL"].includes(state) && tomAct.length) { target = tomAct[0]; tday = tdate; }
  if (target) {
    const k = subjKey(target.subject);
    const rel = tasks.filter((t) => subjKey(taskSubject(t.title || "")) === k).map((t) => t.title);
    let topic: string | null = null, src: "schedule" | "task" | "unknown" = "unknown";
    if (target.topic) { topic = String(target.topic).slice(0, 120); src = "schedule"; }
    else for (const title of rel) { const d = taskDetail(title || ""); if (d) { topic = d.slice(0, 120); src = "task"; break; } }
    prep = { subject: target.subject ?? null, n: target.lesson_number ?? null, date: tday, start: hhmm(target._s), starts_in: tday === sdate ? target._s - now : null, topic, topic_source: src, related_tasks: rel.slice(0, 5) };
  }

  const top = hw[0] ?? null;
  let action: Action;
  if (state === "NIGHT") action = hw.length ? { kind: "carry_to_morning", label: "Перенести на утро", reason: `сон важнее — осталось ${hw.length} ${plural(hw.length, "задание", "задания", "заданий")}` } : { kind: "sleep", label: "Спать", reason: "всё сделано" };
  else if (state === "MORNING") action = { kind: "morning", label: "Собраться", reason: `выход в ${hhmm(leave!)}` };
  else if (state === "BEFORE_SCHOOL") action = prep ? { kind: "prep_lesson", label: `Повторить: ${prep.subject}`, reason: `первый урок в ${prep.start}` } : { kind: "view_schedule", label: "Расписание", reason: "скоро уроки" };
  else if (state === "IN_LESSON") action = { kind: "view_schedule", label: "Расписание", reason: `идёт урок до ${hhmm(cur!._e)} — телефон подождёт` };
  else if (state === "BETWEEN_LESSONS") {
    const gap = nxt ? nxt._s - now : 0;
    action = nxt && gap >= PREP_MIN_BREAK ? { kind: "prep_lesson", label: `Подготовиться: ${nxt.subject}`, reason: `перемена ${dur(gap)} — успеешь повторить` } : { kind: "view_schedule", label: "Расписание", reason: "короткая перемена" };
  } else if (state === "SCHOOL_ENDING") action = { kind: "view_evening", label: "План на вечер", reason: `уроки закончатся в ${hhmm(last!)}` };
  else if (state === "TRAVEL_HOME") action = { kind: "view_evening", label: "План на вечер", reason: `дома в ${hhmm(home!)}` };
  else if (state === "AFTER_SCHOOL") action = { kind: "rest", label: "Отдохнуть", reason: `вечер начнётся в ${hhmm(start)}` };
  else if (state === "UNKNOWN") action = { kind: "add_schedule", label: "Добавить расписание", reason: "без расписания не знаю, где ты сейчас" };
  else if (top) action = { kind: "start_task", label: `Первым — ${top.subject}`, reason: top.reason, target: top.title };
  else if (tomAct.length) action = { kind: "prep_tomorrow", label: "Посмотреть завтра", reason: "заданий нет — проверь завтрашние уроки" };
  else action = { kind: "free", label: "Свободен", reason: "заданий нет" };

  const tomOut = { date: tdate, available: !!tomorrow.available, count: tomAct.length, first: tomAct.length ? hhmm(tomAct[0]._s) : null, subjects: tomAct.map((x) => x.subject ?? null) };
  if (!tomorrow.available && ["TRAVEL_HOME", "AFTER_SCHOOL", "EVENING", "NO_SCHOOL", "NIGHT"].includes(state)) warnings.push({ code: "tomorrow_missing", text: "Расписания на завтра нет — добавь его, я покажу превью" });

  const budget = { school: act.length ? last! - first! : 0, travel: act.length ? 2 * travel : 0, homework: hwTotal, free: Math.max(0, avail - hwTotal), sleep_at: hhmm(bed) };
  const countdown = ["MORNING", "BEFORE_SCHOOL", "IN_LESSON", "BETWEEN_LESSONS", "SCHOOL_ENDING", "TRAVEL_HOME"].includes(state);
  const sig = [ENGINE_VERSION, sdate, String(now), state, sstatus, String(act.length), hw.map((r) => r.title).join(","), String(travel), String(bed), String(start)].join("|");
  return {
    engine_version: ENGINE_VERSION, date: sdate, now: hhmm(now), minute: now,
    day_state: state, phase: LEGACY_PHASE[state], schedule_status: sstatus, data_quality: quality, last_sync_at: sched.last_sync_at ?? null,
    current_lesson: cur ? { ...lessonOut(cur)!, ends_in: cur._e - now, progress_pct: Math.floor(((now - cur._s) * 100) / Math.max(1, cur._e - cur._s)) } : null,
    next_lesson: nxt ? { ...lessonOut(nxt)!, starts_in: nxt._s - now } : null,
    previous_lesson: lessonOut(prev),
    remaining_lessons: remaining, lessons: lessonsOut,
    school: { first: first !== null ? hhmm(first) : null, last: last !== null ? hhmm(last) : null, leave: leave !== null ? hhmm(leave) : null, home: home !== null ? hhmm(home) : null },
    travel_home: { minutes: travel, home_at: home !== null ? hhmm(home) : null, active: state === "TRAVEL_HOME", remaining: state === "TRAVEL_HOME" ? home! - now : null },
    evening_start: hhmm(start), next_event: ne,
    homework: hw, homework_minutes: hwTotal,
    available_time: { from: hhmm(eveFrom), to: hhmm(bed), minutes: avail, deficit },
    lesson_prep: prep, recommended_action: action, tomorrow: tomOut, time_budget: budget, warnings,
    refresh: { next_change_min: nextChange, next_change_at: hhmm(nextChange), per_minute: countdown },
    plan_version: fnv1a(sig),
  };
}

/** Для паритет-теста: resolveClock со строковым временем (как в Python). */
export const resolveClockIso = (nowUtc: string, dev: number, tz: string | null, so: number | null = null) => resolveClock(new Date(nowUtc), dev, tz, so);

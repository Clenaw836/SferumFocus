/**
 * Понимание фраз школьника на устройстве (без сети и без ИИ): день, урок, предмет, время,
 * длительность, тип изменения расписания, личное дело и намерения помощника.
 * Принцип: НЕ УГАДЫВАТЬ. Нет дня — day.kind="none"; два дня — "ambiguous"; неуверенно —
 * низкий confidence, и интерфейс спросит. Тот же разбор работает для текста, расшифровки
 * голоса и текста OCR (у каждого источника свой множитель уверенности).
 */
import { WEEKDAYS, addDays, weekdayOf, type ChangeType, type Weekday } from "./schedule";

const L = "\\p{L}";
const wb = (re: string) => new RegExp(`(?:^|[^${L}\\d])(?:${re})`, "u");
/** Глобальный поиск слова; группа 1 — само слово (без символа-границы перед ним). */
const wbg = (re: string) => new RegExp(`(?:^|[^${L}\\d])(${re})`, "gu");
export const norm = (s: string) => (s || "").toLowerCase().replace(/ё/g, "е").replace(/[«»"“”]/g, "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ предметы
const SUBJECTS: [string, string][] = [
  ["физкульт[\\p{L}]*|физр[\\p{L}]*|физ-?ра|физическ[\\p{L}]* культур[\\p{L}]*", "Физкультура"],
  ["матем[\\p{L}]*|матан[\\p{L}]*", "Математика"],
  ["алгебр[\\p{L}]*", "Алгебра"], ["геометр[\\p{L}]*", "Геометрия"],
  ["русск[\\p{L}]*|русич[\\p{L}]*", "Русский язык"], ["литер[\\p{L}]*|литр[аеуы]", "Литература"],
  ["англ[\\p{L}]*|инглиш", "Английский язык"], ["немец[\\p{L}]*|немецк[\\p{L}]*", "Немецкий язык"],
  ["физик[\\p{L}]*", "Физика"], ["хими[\\p{L}]*", "Химия"], ["биолог[\\p{L}]*|биолог", "Биология"],
  ["географ[\\p{L}]*", "География"], ["истори[\\p{L}]*", "История"], ["обществ[\\p{L}]*|общага", "Обществознание"],
  ["информат[\\p{L}]*|инф[аыуе](?![\\p{L}])", "Информатика"], ["музык[\\p{L}]*", "Музыка"],
  ["изо(?![\\p{L}])|рисовани[\\p{L}]*", "ИЗО"], ["технолог[\\p{L}]*|труд(?:[аыу]|ов)?(?![\\p{L}])", "Технология"],
  ["обж(?![\\p{L}])", "ОБЖ"], ["астроном[\\p{L}]*", "Астрономия"], ["родн[\\p{L}]* язык[\\p{L}]*", "Родной язык"],
];
const SUBJ_RE = SUBJECTS.map(([re, name]) => [wbg(re), name] as const);
export interface Found { name: string; index: number; end: number }
/** Все упоминания предметов в тексте (по порядку). */
export function findSubjects(t: string): Found[] {
  const n = norm(t), out: Found[] = [];
  for (const [re, name] of SUBJ_RE) {
    re.lastIndex = 0;
    for (let m = re.exec(n); m; m = re.exec(n)) {
      const idx = m.index + m[0].length - m[1].length, end = m.index + m[0].length;
      if (!out.some((f) => idx < f.end && end > f.index)) out.push({ name, index: idx, end });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
export const subjectOf = (t: string): string | null => findSubjects(t)[0]?.name ?? null;
const MATH = new Set(["Математика", "Алгебра", "Геометрия"]);
/** «математика» ≈ алгебра/геометрия в расписании; «русский» = «Русский язык». */
export const sameSubject = (a: string, b: string) => {
  const x = subjectOf(a) ?? a, y = subjectOf(b) ?? b;
  return x === y || (x === "Математика" && MATH.has(y)) || (y === "Математика" && MATH.has(x));
};

// ------------------------------------------------------------------ дни
const DAY_RE: [RegExp, Weekday][] = [
  [wb("понедельник[\\p{L}]*|пн(?![\\p{L}])"), "monday"], [wb("вторник[\\p{L}]*|вт(?![\\p{L}])"), "tuesday"],
  [wb("сред(?:а|у|ы|е|ой)(?![\\p{L}])|ср(?![\\p{L}])"), "wednesday"], [wb("четверг[\\p{L}]*|чт(?![\\p{L}])"), "thursday"],
  [wb("пятниц[\\p{L}]*|пт(?![\\p{L}])"), "friday"], [wb("суббот[\\p{L}]*|сб(?![\\p{L}])"), "saturday"],
  [wb("воскресень[\\p{L}]*|вс(?![\\p{L}])"), "sunday"],
];
const MONTHS = ["январ", "феврал", "март", "апрел", "ма[яй]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
export type DayRes =
  | { kind: "none" }
  | { kind: "ambiguous"; options: string[]; phrase: string }
  | { kind: "date"; date: string; weekday: Weekday; confidence: number; phrase: string; relative: "today" | "tomorrow" | "after" | null };

export interface DayCtx { today: string; nowMin: number; lastBellToday?: number | null; schoolWeek?: number }

export function parseDay(text: string, ctx: DayCtx): DayRes {
  const t = norm(text);
  const hits: { date: string; conf: number; phrase: string; rel: "today" | "tomorrow" | "after" | null }[] = [];
  const add = (date: string, conf: number, phrase: string, rel: "today" | "tomorrow" | "after" | null = null) => { if (!hits.some((h) => h.date === date)) hits.push({ date, conf, phrase, rel }); };
  if (wb("послезавтра").test(t)) add(addDays(ctx.today, 2), 0.95, "послезавтра", "after");
  else if (wb("завтра[\\p{L}]*").test(t)) add(addDays(ctx.today, 1), 0.95, "завтра", "tomorrow");
  if (wb("сегодня|сейчас на уроках").test(t)) add(ctx.today, 0.95, "сегодня", "today");
  const dm = /(?:^|[^\d:.])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/.exec(t);
  const mm = new RegExp(`(?:^|[^\\d])(\\d{1,2})\\s+(${MONTHS.join("|")})[\\p{L}]*`, "u").exec(t);
  const year = Number(ctx.today.slice(0, 4));
  const fromDM = (d: number, m: number) => {
    if (d < 1 || d > 31 || m < 1 || m > 12) return;
    let y = year; const cand = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (cand < addDays(ctx.today, -60)) y += 1;
    add(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, 0.97, `${d}.${m}`);
  };
  // «12.10» — дата; «в 9.05» / «8.30–9.15» — время, не дата
  if (dm && Number(dm[2]) <= 12 && !/(?:^|\s)(?:в|к|с|до)\s*$/.test(t.slice(0, dm.index + 1)) && !/^\s*[-–]/.test(t.slice(dm.index + dm[0].length))) fromDM(Number(dm[1]), Number(dm[2]));
  if (mm) fromDM(Number(mm[1]), MONTHS.findIndex((x) => new RegExp(`^${x}`, "u").test(mm[2])) + 1);
  const todayIdx = WEEKDAYS.indexOf(weekdayOf(ctx.today));
  for (const [re, wd] of DAY_RE) {
    const m = re.exec(t);
    if (!m) continue;
    let diff = (WEEKDAYS.indexOf(wd) - todayIdx + 7) % 7, conf = 0.92;
    if (diff === 0) {
      // «на среду», сказанное в среду: после уроков — скорее следующая неделя (но спросим)
      const past = ctx.lastBellToday != null ? ctx.nowMin >= ctx.lastBellToday : ctx.nowMin >= 15 * 60;
      if (past) { diff = 7; conf = 0.7; } else conf = 0.85;
    }
    if (wd === "sunday" || (wd === "saturday" && (ctx.schoolWeek ?? 5) < 6)) conf = Math.min(conf, 0.6);
    const date = addDays(ctx.today, diff);
    // «завтра, в четверг» — одно и то же: не дубль
    const same = hits.find((h) => h.date === date);
    if (same) { same.conf = Math.max(same.conf, 0.97); continue; }
    add(date, conf, m[0].trim());
  }
  if (!hits.length) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", options: hits.map((h) => h.date), phrase: hits.map((h) => h.phrase).join(" / ") };
  const h = hits[0];
  return { kind: "date", date: h.date, weekday: weekdayOf(h.date), confidence: h.conf, phrase: h.phrase, relative: h.rel };
}

// ------------------------------------------------------------------ номера уроков
const ORD: [string, number][] = [["перв", 1], ["втор(?!ник)", 2], ["трет", 3], ["четверт", 4], ["пят(?!ниц)", 5], ["шест", 6], ["седьм", 7], ["восьм", 8]];
const ORD_RE = ORD.map(([s, n]) => [new RegExp(`(?:^|[^\\p{L}])${s}[\\p{L}]*`, "u"), n] as const);
const ORD_ANY = new RegExp(`(?:^|[^\\p{L}])(?:${ORD.map((o) => o[0]).join("|")})[\\p{L}]*`, "gu");
export const ordinalOf = (word: string): number | null => { for (const [re, n] of ORD_RE) if (re.test(word)) return n; return null; };
/** Все ссылки на номер урока: «первым уроком», «3-й урок», «урок 4», «на второй», «после 4 урока». */
export function findLessonNumbers(t: string): { n: number; index: number; end: number }[] {
  const s = norm(t), out: { n: number; index: number; end: number }[] = [];
  ORD_ANY.lastIndex = 0;
  for (let m = ORD_ANY.exec(s); m; m = ORD_ANY.exec(s)) { const n = ordinalOf(m[0]); if (n) out.push({ n, index: m.index, end: m.index + m[0].length }); }
  const dig = /(?:^|[^\d:.])([1-8])\s*(?:-?\s*(?:й|ой|ым|ом|ого|го|м|я|ая|ую))?\s*(?=урок)|урок[\p{L}]*\s*(?:№\s*)?([1-8])(?![\d:.])|№\s*([1-8])(?![\d:.])/gu;
  for (let m = dig.exec(s); m; m = dig.exec(s)) out.push({ n: Number(m[1] ?? m[2] ?? m[3]), index: m.index, end: m.index + m[0].length });
  return out.sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------------ время и длительность
const NUMW: Record<string, number> = { "один": 1, "одного": 1, "два": 2, "двух": 2, "три": 3, "трех": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "одиннадцать": 11, "двенадцать": 12, "пятнадцать": 15, "двадцать": 20, "тридцать": 30, "сорок": 40, "сорок пять": 45, "пятьдесят": 50 };
const pad = (n: number) => String(n).padStart(2, "0");
/** «в 18:00», «к 9.20», «в 18», «в шесть вечера», «в 4 дня» → «HH:MM»; null — времени нет. */
export function parseTime(text: string): { time: string; index: number } | null {
  const t = norm(text);
  const m1 = /(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d])/.exec(t);
  if (m1) return { time: `${pad(Number(m1[1]))}:${m1[2]}`, index: m1.index };
  const m2 = new RegExp(`(?:^|[^\\p{L}\\d])(?:в|к|с|на)\\s+(\\d{1,2}|${Object.keys(NUMW).join("|")})(?:\\s*час[\\p{L}]*)?\\s*(утра|дня|вечера|ночи)?(?![\\p{L}\\d:])`, "u").exec(t);
  if (!m2) return null;
  let h = /^\d+$/.test(m2[1]) ? Number(m2[1]) : NUMW[m2[1]];
  if (h === undefined || h > 23) return null;
  const tail = t.slice(m2.index + m2[0].length, m2.index + m2[0].length + 12);
  if (/^\s*(мин|урок|кабинет|каб|класс)/u.test(tail)) return null;   // «на 30 минут», «в 5 кабинете»
  if ((m2[2] === "вечера" || m2[2] === "дня") && h < 12) h += 12;
  else if (!m2[2] && h >= 1 && h <= 7) h += 12;   // «в 6» про тренировку — это 18:00, не 06:00
  return { time: `${pad(h)}:00`, index: m2.index };
}
/** «на полтора часа» 90, «на час» 60, «45 минут», «полчаса», «2 часа», «час 15» → минуты. */
export function parseDuration(text: string): number | null {
  const t = norm(text);
  if (wb("полтора час[\\p{L}]*|1[,.]5 час[\\p{L}]*").test(t)) return 90;
  if (wb("полчаса|пол часа").test(t)) return 30;
  const hm = /(?:^|[^\d:.])(\d{1,2})\s*ч(?:ас[\p{L}]*)?\s*(?:и\s*)?(\d{1,2})\s*мин/u.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = new RegExp(`(?:^|[^\\d:.\\p{L}])(\\d{1,2}|${Object.keys(NUMW).join("|")})\\s*час(?:а|ов)?(?![\\p{L}])`, "u").exec(t);
  if (h) return (/^\d+$/.test(h[1]) ? Number(h[1]) : NUMW[h[1]]) * 60;
  const mi = new RegExp(`(?:^|[^\\d:.\\p{L}])(\\d{1,3}|${Object.keys(NUMW).join("|")})\\s*мин[\\p{L}]*`, "u").exec(t);
  if (mi) return /^\d+$/.test(mi[1]) ? Number(mi[1]) : NUMW[mi[1]];
  if (wb("(?:на\\s+)?час(?![\\p{L}])").test(t)) return 60;
  return null;
}

// ------------------------------------------------------------------ изменения расписания
export interface Draft {
  change_type: ChangeType; lesson_number: number | null; to_lesson_number?: number | null;
  subject?: string | null; before?: string | null; start_time?: string | null; end_time?: string | null;
  room?: string | null; teacher?: string | null; note?: string | null; confidence: number; phrase: string;
}
export interface ListItem { n: number; subject: string; start_time: string | null; end_time: string | null; room: string | null }
export interface ParsedSchedule { day: DayRes; drafts: Draft[]; list: ListItem[]; endsAfter: number | null; cancelAll: boolean; unknown: string[] }

const K = {
  replace: wb("вместо|замен[\\p{L}]*"),
  cancel: wb("отмен[\\p{L}]*|не будет|сняли|убрали|не состоится"),
  move: wb("перенес[\\p{L}]*|перенос[\\p{L}]*|передвинул[\\p{L}]*|сдвинул[\\p{L}]*|переставил[\\p{L}]*"),
  time: wb("начн[\\p{L}]*|начина[\\p{L}]*|начало"),
  room: /(?:кабинет[\p{L}]*|каб\.?)\s*(?:№\s*)?(\d{1,3}[а-я]?)|(?:^|[^\d])(\d{1,3}[а-я]?)\s*(?:-?м\s*)?кабинет[\p{L}]*/u,
  teacher: /(?:вест[\p{L}]*|вед[её]т|провед[\p{L}]*|замена учител[\p{L}]*|заменяет|будет у)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ]\.(?:\s*[А-ЯЁ]\.)?|\s+[А-ЯЁ][а-яё]+){0,2})/u,
  note: wb("контрольн[\\p{L}]*|самостоятельн[\\p{L}]*|проверочн[\\p{L}]*|диктант[\\p{L}]*|тест(?![\\p{L}])|зачет[\\p{L}]*|экзамен[\\p{L}]*"),
  endsAfter: /после\s+(\S+)\s+урок[\p{L}]*[^.,;]*?(?:домой|свобод|все|всё|отпуск|закончат|конча)/u,
  add: wb("добавил[\\p{L}]*|добавят|дополнительн[\\p{L}]*|еще (?:один )?урок"),
  cancelAll: wb("уроков не будет|все уроки отмен[\\p{L}]*|занятия отмен[\\p{L}]*|карантин|актированн[\\p{L}]*"),
};

/** Разбор текста/расшифровки/OCR в черновики изменений (БЕЗ сравнения с расписанием). */
export function parseSchedule(text: string, ctx: DayCtx): ParsedSchedule {
  const raw = (text || "").replace(/\r/g, "");
  const out: ParsedSchedule = { day: parseDay(raw, ctx), drafts: [], list: [], endsAfter: null, cancelAll: false, unknown: [] };
  // 1) Строки-таблица (OCR/скопированный текст): «1. Алгебра 8:30–9:15 каб. 12» или подряд предметы
  // «1 алгебра 2 русский 3 химия» одной строкой (сообщение из чата) → строки таблицы
  const expand = (ln: string): string[] => {
    const parts = ln.split(/\s(?=[1-8][.)]?\s+[А-ЯЁа-яё])/u);
    return parts.length >= 3 && parts.filter((x) => findSubjects(x).length === 1).length >= 3 ? parts : [ln];
  };
  const lines = raw.split(/\n+/).map((x) => x.trim()).filter(Boolean).flatMap(expand);
  const tableRows: ListItem[] = [];
  let seq = 0;
  for (const ln of lines) {
    const subj = findSubjects(ln);
    if (subj.length !== 1 || K.replace.test(norm(ln)) || K.cancel.test(norm(ln)) || K.move.test(norm(ln))) continue;
    const num = /^\s*([1-8])\s*(?:[.)\-–:]|урок|\s)/u.exec(norm(ln));
    const ord = findLessonNumbers(ln)[0];
    const n = num ? Number(num[1]) : ord ? ord.n : null;
    const tm = /([01]?\d|2[0-3])[:.]([0-5]\d)\s*[-–—]\s*([01]?\d|2[0-3])[:.]([0-5]\d)/.exec(ln);
    const t1 = tm ? null : /(?:^|\s)([01]?\d|2[0-3])[:]([0-5]\d)(?=\s|$)/.exec(ln);
    const room = K.room.exec(norm(ln));
    seq = n ?? seq + 1;
    tableRows.push({ n: seq, subject: subj[0].name, start_time: tm ? `${pad(Number(tm[1]))}:${tm[2]}` : t1 ? `${pad(Number(t1[1]))}:${t1[2]}` : null, end_time: tm ? `${pad(Number(tm[3]))}:${tm[4]}` : null, room: room ? `каб. ${room[1] ?? room[2]}` : null });
  }
  const isTable = tableRows.length >= 2 && lines.length >= 2;
  if (isTable) out.list = tableRows;

  // 2) Предложения: замены/отмены/переносы/время/кабинет/учитель/заметки; иначе — перечисление «первым …, вторым …»
  const sentences = isTable ? lines.filter((ln) => !tableRows.some(() => findSubjects(ln).length === 1) || K.replace.test(norm(ln)) || K.cancel.test(norm(ln)) || K.move.test(norm(ln)))
    : raw.split(/[.;!?\n]+/).map((x) => x.trim()).filter(Boolean);
  for (const sent of sentences) {
    const s = norm(sent);
    const subs = findSubjects(sent);
    const nums = findLessonNumbers(sent);
    const ea = K.endsAfter.exec(s);
    if (K.cancelAll.test(s)) { out.cancelAll = true; continue; }
    if (K.replace.test(s) && subs.length >= 2) {
      const vm = /вместо/u.exec(s);
      let before: Found, after: Found;
      if (vm) { before = subs.find((f) => f.index > vm.index) ?? subs[0]; after = subs.find((f) => f !== before)!; }
      else { const na = /\sна\s/u.exec(s.slice(subs[0].end)); before = subs[0]; after = na ? subs.find((f) => f.index > subs[0].end) ?? subs[1] : subs[1]; }
      out.drafts.push({ change_type: "REPLACE", lesson_number: nums[0]?.n ?? null, subject: after.name, before: before.name, confidence: 0.95, phrase: sent });
      continue;
    }
    if (K.move.test(s)) {
      const tm = parseTime(s.slice((K.move.exec(s)?.index ?? 0)));
      const to = nums.find((x) => x.index > (K.move.exec(s)?.index ?? 0));
      const from = nums.find((x) => x !== to);
      if (to && (from || subs[0])) { out.drafts.push({ change_type: "MOVE", lesson_number: from?.n ?? null, to_lesson_number: to.n, before: subs[0]?.name ?? null, confidence: from || subs[0] ? 0.9 : 0.6, phrase: sent }); continue; }
      if (tm && (from || subs[0] || nums[0])) { out.drafts.push({ change_type: "TIME_CHANGE", lesson_number: (from ?? nums[0])?.n ?? null, before: subs[0]?.name ?? null, start_time: tm.time, confidence: 0.85, phrase: sent }); continue; }
    }
    if (ea) {
      const n = ordinalOf(ea[1]) ?? (/^[1-8]/.test(ea[1]) ? Number(ea[1][0]) : null);
      if (n) out.endsAfter = n;
      // перечисление в той же фразе разбираем ниже, без «после N урока»
    }
    if (K.cancel.test(s) && !ea) {
      if (nums[0] || subs[0]) { out.drafts.push({ change_type: "CANCEL", lesson_number: nums[0]?.n ?? null, before: subs[0]?.name ?? null, confidence: 0.93, phrase: sent }); continue; }
    }
    if (K.time.test(s) && parseTime(s) && (nums[0] || subs[0])) {
      out.drafts.push({ change_type: "TIME_CHANGE", lesson_number: nums[0]?.n ?? null, before: subs[0]?.name ?? null, start_time: parseTime(s)!.time, confidence: 0.85, phrase: sent }); continue;
    }
    const room = K.room.exec(s);
    if (room && (nums[0] || subs[0]) && !/^\s*[1-8][.)]/.test(s)) { out.drafts.push({ change_type: "ROOM_CHANGE", lesson_number: nums[0]?.n ?? null, before: subs[0]?.name ?? null, room: `каб. ${room[1] ?? room[2]}`, confidence: 0.88, phrase: sent }); continue; }
    const teach = K.teacher.exec(sent.replace(/ё/g, "е"));
    if (teach && (nums[0] || subs[0])) { out.drafts.push({ change_type: "TEACHER_CHANGE", lesson_number: nums[0]?.n ?? null, before: subs[0]?.name ?? null, teacher: teach[1].trim(), confidence: 0.85, phrase: sent }); continue; }
    const note = K.note.exec(s);
    if (note && subs[0]) { out.drafts.push({ change_type: "NOTE", lesson_number: nums[0]?.n ?? null, before: subs[0].name, note: note[0].trim().startsWith("контрол") ? "контрольная" : note[0].trim(), confidence: 0.9, phrase: sent }); continue; }
    if (isTable) continue;
    // перечисление: «первым уроком математика, вторым русский» / «5 урок — география»
    const parts = sent.split(/,|\sи\s(?=\S+\s)/u).map((x) => x.trim()).filter(Boolean);
    let got = false;
    for (const part of parts) {
      if (K.endsAfter.test(norm(part))) continue;
      const ps = findSubjects(part), pn = findLessonNumbers(part);
      if (ps.length === 1 && pn.length >= 1) {
        const tm = parseTime(part);
        out.list.push({ n: pn[0].n, subject: ps[0].name, start_time: tm?.time ?? null, end_time: null, room: null });
        got = true;
      }
    }
    if (!got && !ea && (subs.length || nums.length)) {
      if (K.add.test(s) && subs[0]) { out.drafts.push({ change_type: "ADD", lesson_number: nums[0]?.n ?? null, subject: subs[0].name, confidence: 0.85, phrase: sent }); continue; }
      out.unknown.push(sent);
    }
  }
  return out;
}

/** Похоже ли сообщение на изменение школьного расписания (а не на личное дело/вопрос)? */
export function looksLikeSchedule(text: string): boolean {
  const s = norm(text);
  if (wb("расписан[\\p{L}]*").test(s)) return true;
  const subs = findSubjects(s).length, nums = findLessonNumbers(s).length;
  if (wb("урок[\\p{L}]*").test(s) && (K.cancel.test(s) || K.move.test(s) || K.replace.test(s) || subs || nums)) return true;
  return subs >= 1 && (K.replace.test(s) || K.cancel.test(s) || (K.move.test(s) && nums > 0)) || (subs >= 2 && nums >= 2);
}

// ------------------------------------------------------------------ личные дела
export type ActType = "tutor" | "sport" | "games" | "club" | "meet" | "road" | "other" | "misc";
const ACTS: [RegExp, ActType, string | null][] = [
  [wb("футбол[\\p{L}]*"), "sport", "Футбол"], [wb("хокке[\\p{L}]*"), "sport", "Хоккей"], [wb("баскетбол[\\p{L}]*"), "sport", "Баскетбол"],
  [wb("волейбол[\\p{L}]*"), "sport", "Волейбол"], [wb("бассейн[\\p{L}]*|плавани[\\p{L}]*"), "sport", "Бассейн"],
  [wb("танц[\\p{L}]*"), "sport", "Танцы"], [wb("борьб[\\p{L}]*|карате|дзюдо|самбо|бокс[\\p{L}]*"), "sport", "Единоборства"],
  [wb("тренировк[\\p{L}]*|секци[\\p{L}]*|спорт[\\p{L}]*"), "sport", "Тренировка"],
  [wb("репетитор[\\p{L}]*"), "tutor", "Репетитор"],
  [wb("кружок|кружк[\\p{L}]*|робототехник[\\p{L}]*|художк[\\p{L}]*|музыкалк[\\p{L}]*|студи[\\p{L}]*"), "club", "Кружок"],
  [wb("компьютер[\\p{L}]*|игр[аыу]|поиграть|пк(?![\\p{L}])|майнкрафт|приставк[\\p{L}]*"), "games", "Компьютер"],
  [wb("дорог[\\p{L}]*|поездк[\\p{L}]*"), "road", "Дорога"],
  [wb("встреч[\\p{L}]*|гулять|прогулк[\\p{L}]*|с друзьями|день рождени[\\p{L}]*"), "meet", "Встреча"],
  [wb("врач[\\p{L}]*|стоматолог[\\p{L}]*|поликлиник[\\p{L}]*|больниц[\\p{L}]*"), "misc", "Врач"],
];
export interface ParsedActivity { type: ActType; title: string; dayOffset: number | null; dayDate: string | null; startTime: string | null; duration: number | null; afterSchool: boolean; cancel: boolean }
export function parseActivity(text: string, ctx: DayCtx): ParsedActivity | null {
  const s = norm(text);
  const hit = ACTS.find(([re]) => re.test(s));
  if (!hit) return null;
  const day = parseDay(text, ctx);
  const dayDate = day.kind === "date" ? day.date : null;
  const off = dayDate ? Math.round((new Date(`${dayDate}T12:00:00`).getTime() - new Date(`${ctx.today}T12:00:00`).getTime()) / 864e5) : null;
  const tm = parseTime(s);
  return {
    type: hit[1], title: hit[2] ?? "Дело", dayOffset: off, dayDate, startTime: tm?.time ?? null, duration: parseDuration(s),
    afterSchool: wb("после (?:школ[\\p{L}]*|урок[\\p{L}]*)").test(s), cancel: K.cancel.test(s) || wb("не пойду|не будет").test(s),
  };
}

// ------------------------------------------------------------------ намерения помощника
export type Intent =
  | { kind: "late"; minutes: number | null; homeAt: string | null; stayAtSchool: boolean }
  | { kind: "overloaded" } | { kind: "tired" } | { kind: "whatNow" } | { kind: "whatTomorrow" } | { kind: "whatChanged" }
  | { kind: "done"; subject: string | null; text: string }
  | { kind: "bedtime"; time: string | null; later: number | null }
  | { kind: "activity"; act: ParsedActivity }
  | { kind: "schedule" }
  | { kind: "homework"; text: string }
  | { kind: "unknown" };

export function parseIntent(text: string, ctx: DayCtx): Intent {
  const s = norm(text);
  if (!s) return { kind: "unknown" };
  if (wb("что изменилось|какие изменения|что нового").test(s)) return { kind: "whatChanged" };
  if (wb("что (?:у меня )?завтра|какие (?:уроки|планы) завтра|что на завтра|завтра что").test(s)) return { kind: "whatTomorrow" };
  if (wb("что (?:мне )?(?:сейчас |теперь |дальше )?делать|что дальше|с чего начать|что сейчас").test(s)) return { kind: "whatNow" };
  if (wb("не успева[\\p{L}]*|не успею|не хватает времени|завал[\\p{L}]*").test(s)) return { kind: "overloaded" };
  if (wb("устал[\\p{L}]*|нет сил|выдохся|выдохлась|вымотал[\\p{L}]*|голова не варит").test(s)) return { kind: "tired" };
  if (wb("опоздаю|опаздываю|задержусь|задерживаюсь|буду (?:дома )?позже|приду позже").test(s)) {
    const tm = parseTime(s);
    return { kind: "late", minutes: parseDuration(s), homeAt: tm && wb("дома|приду|вернусь|буду в").test(s) ? tm.time : null, stayAtSchool: wb("в школе|после урок[\\p{L}]*|на продленк[\\p{L}]*").test(s) };
  }
  if (wb("(?:я )?(?:уже )?(?:сделал[аи]?|выполнил[аи]?|закончил[аи]?|доделал[аи]?|готово)").test(s) && !wb("не сделал").test(s))
    return { kind: "done", subject: subjectOf(s), text };
  if (wb("сон|спать|лягу|ложусь|отбой").test(s)) {
    const tm = parseTime(s);
    return { kind: "bedtime", time: tm?.time ?? null, later: wb("позже").test(s) ? parseDuration(s) : null };
  }
  if (looksLikeSchedule(s)) return { kind: "schedule" };
  const act = parseActivity(text, ctx);
  if (act) return { kind: "activity", act };
  if (wb("задали|домашк[\\p{L}]*|дз(?![\\p{L}])|упражнени[\\p{L}]*|параграф|§|номер[\\p{L}]*|№").test(s) || (subjectOf(s) && /\d/.test(s))) return { kind: "homework", text };
  return { kind: "unknown" };
}

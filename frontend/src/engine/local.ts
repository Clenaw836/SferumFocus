/**
 * Автономный движок: те же контракты, что у бэкенда (lib/types.ts), но целиком в браузере.
 * Включается, когда сервер недоступен (статический хостинг, 404, нет сети) — демо не
 * показывает «Сервер не отвечает», а продолжает работать честно: нормативы, планировщик,
 * офлайн-дуэль с самопроверкой, свой опрос, прогресс в localStorage.
 * Порт: app/mock_diary.py, app/ai_engine.py (офлайн-фоллбеки), app/progress.py.
 * ИИ-функции (фото) здесь честно недоступны — как на сервере без ключа.
 */
import type {
  BlitzResponse, BlitzTurn, CalculateResponse, Flashcard, Heatmap, InitialState, MyWeek,
  QuizQuestion, Quarter, Rewards, Task, TeacherDay, Triage, WhoAmI,
} from "../lib/types";
import { blitzEligible, buildPlan, estimateFromNorms, guessType } from "./norms";
import { nsKey } from "../lib/demo";

import { demoLessons } from "../lib/schedule";
import { nowDate } from "../lib/clock";

export class LocalError extends Error { constructor(m: string, public status: number) { super(m); } }

const GRADE = "8А";
const schoolISO = () => iso(new Date(nowDate().getTime() - 4 * 3600e3));
const iso = (d = nowDate()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mk = (title: string, type: Task["type"]): Task => ({ title, type, deadline: null, planned_minutes: estimateFromNorms(title, GRADE), blitz_eligible: blitzEligible(title, type) });

// ------------------------------------------------------------- initial state
export function initialState(): InitialState {
  return {
    diary_mode: "mock",
    diary_tasks: [
      mk("Алгебра: §13, упр. 355–357 (квадратные уравнения)", "written"),
      mk("Физика: §14, упр. 12; повторить формулы скорости", "written"),
      mk("Русский язык: упр. 187 (пунктуация)", "written"),
      mk("Литература: пересказ глав 2–3 «Капитанской дочки»", "oral"),
    ],
    settings: {
      recommended_start: "15:30", bedtime: "22:00",
      rest_slots: [{ start: "20:00", end: "20:40", label: "Ужин" }],
      personal_activities: [{ title: "Игры на ПК", duration_minutes: 120, is_fixed: false, time_window: null }],
      recommended_bedtime: "22:00", wake_time: "06:45", travel_minutes: 45, prep_minutes: 15, school_week_days: 5,
    },
    // Тот же демо-провайдер, что на сервере (app/schedule.py DemoScheduleProvider)
    school_day: (() => {
      const today = schoolISO();
      const ls = demoLessons(today);
      return { date: today, lessons: ls.map((l) => ({ starts_at: l.start_time!, ends_at: l.end_time!, subject: l.subject, lesson_number: l.lesson_number, source: "demo" })), last_bell: ls.length ? ls[ls.length - 1].end_time : null };
    })(),
    schedule: { kind: "demo", name: "Демо-расписание", is_demo: true, real_status: "not_configured" },
    school_name: "МОУ СОШ №17", grade: GRADE,
  };
}

export function calculate(p: Parameters<typeof buildPlan>[0]): CalculateResponse {
  if (!p.tasks.length) throw new LocalError("Нет задач для планирования", 400);
  const plan = buildPlan(p);
  return {
    plan,
    ai_reasoning: "Письменные задания идут первыми, устные — последними. Работа обходит отдых, между сегментами предусмотрены паузы.",
    negotiator_message: plan.deficit_minutes > 0 ? `Не хватает ${plan.deficit_minutes} мин. ${plan.tradeoff_suggestions.join(" ")}`.trim() : null,
  };
}

// ------------------------------------------------------------- moderation (порт screen_text)
const LAT: Record<string, string> = { a: "а", b: "б", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", "0": "о", "1": "и", "3": "з", "6": "б", "!": "и", "|": "и" };
const ROOTS = ["хуй", "хуе", "хуя", "хуи", "еба", "ебу", "еби", "ебал", "ебан", "ебат", "ебуч", "заеб", "наеб", "поеб", "уеб", "доеб", "выеб", "съеб", "въеб", "отъеб", "приеб", "разъеб", "перееб", "пизд", "бляд", "блят", "мудак", "мудил", "мудо", "гандон", "гондон", "пидор", "пидар", "пидорас", "шлюх", "сукин", "сучк", "дроч"];
const JOINED = ["хуй", "хуе", "хуя", "пизд", "бляд", "заеб", "наеб", "поеб", "уеб", "доеб", "выеб", "съеб", "въеб", "отъеб", "разъеб", "перееб", "мудак", "гандон", "гондон", "пидор", "пидар", "шлюх"];
const EXACT = new Set(["бля", "блять", "сука", "суки", "хуй", "пиздец", "ебать"]);
export function flagged(text: string): boolean {
  const norm = [...(text || "").toLowerCase().replace(/ё/g, "е")].map((c) => LAT[c] ?? c).join("");
  const words = norm.match(/[а-я*@]+/g) ?? [];
  if (words.some((w) => EXACT.has(w) || ROOTS.some((r) => w.startsWith(r)))) return true;
  const j = words.join("");
  return JOINED.some((r) => j.includes(r)) || /х[@*]й|п[@*]зд/.test(j);
}

/** Текст домашки → задания. Офлайн: каждая строка/пункт «;» с предметом — отдельное задание. */
// F9 · сообщение из чата класса: «на завтра по алгебре №355-357, по истории читать §8» → карточки по предметам.
// Паритет 1:1 с app/ai_engine.py (_CHAT_SUBJECTS, _CHAT_SPLIT, _CHAT_HEAD, _text_parts).
const CHAT_SUBJECTS: [string, string][] = [["алгебр", "Алгебра"], ["геометр", "Геометрия"], ["физик", "Физика"], ["информатик", "Информатика"],
  ["русск", "Русский язык"], ["англ", "Английский язык"], ["биолог", "Биология"], ["географ", "География"],
  ["хими", "Химия"], ["истори", "История"], ["обществ", "Обществознание"], ["литератур", "Литература"]];
const TABLE_SUBJECTS6 = ["алгебр", "геомет", "физика", "информ", "русски", "англий", "биолог", "геогра", "химия", "истори", "общест", "литера"];
const CHAT_SPLIT = /(?:[,.;]|\s+и)\s+(?=по\s+[а-яё])/i;
const CHAT_HEAD = /^(?:(?:д\/з|дз|домашка|домашнее задание)\s*[:\-–—]?\s*)?(?:на\s+(?:завтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу)\s*[:\-–—,]?\s*)?по\s+([а-яё]+)(?:\s+языку)?\s*[:\-–—,]?\s*(.+)$/i;
const TASK_MARKER = /§|№|\d|параграф|упр|стр|глав|выучи|наизусть|пересказ|прочита|читать|сочинени|конспект|вопрос|слова|задач/i;
const chatSubject = (w: string) => CHAT_SUBJECTS.find(([s]) => w.toLowerCase().startsWith(s))?.[1] ?? null;
function chatCard(piece: string): string | null {
  const m = piece.trim().match(CHAT_HEAD);
  const subj = m ? chatSubject(m[1]) : null;
  const rest = m ? m[2].replace(/^[ .,;]+|[ .,;]+$/g, "") : "";
  return subj && rest ? `${subj}: ${rest}` : null;
}
function chatLine(line: string): string[] | null {
  const cards = line.split(CHAT_SPLIT).filter((p) => p.trim()).map(chatCard);
  return cards.length && cards.every(Boolean) ? (cards as string[]) : null;
}
// F9 · строка чата без задания («Добрый вечер!», «ДЗ на завтра:») и «Предмет — задание» → «Предмет: задание».
const CHAT_NOISE = /^(?:(?:всем\s+)?(?:добр(?:ый|ое|ого)\s+(?:вечер|утро|день|дня|вечера|утра)|здравствуйте|привет(?:ствую)?|уважаемые\s+(?:родители|ученики)|дорогие\s+(?:ребята|родители))[\s!.,)]*)?(?:(?:д\/?з|домашк[аи]|домашнее\s+задание|задани[ея])(?:\s+на\s+(?:завтра|сегодня|понедельник|вторник|среду|четверг|пятницу|субботу))?[\s:!.)]*)?$/i;
const SUBJ_DASH = /^([А-ЯЁ][а-яё]+(?:\s+язык)?)\s+[—–-]\s+(.+)$/;
function subjectDash(line: string): string {
  const m = line.match(SUBJ_DASH);
  const name = m ? chatSubject(m[1]) : null;
  return m && name ? `${name}: ${m[2].trim()}` : line;
}
export function textParts(text: string): string[] {
  let chat = false;
  let lines = (text || "").trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const content = lines.filter((l) => !CHAT_NOISE.test(l));
  if (content.length && content.length < lines.length) lines = content;
  let parts = lines.map(subjectDash).flatMap((l) => {
    const cards = chatLine(l.trim());
    if (cards) { chat = true; return cards; }
    return l.split(/;\s*(?=[А-ЯЁA-Z][а-яё]+\s*[:,])/).map((s) => s.trim());
  }).filter(Boolean);
  if (chat) parts = parts.filter((p) => TABLE_SUBJECTS6.some((s) => p.toLowerCase().includes(s)) || chatSubject(p.split(":")[0].trim()) || TASK_MARKER.test(p));
  return parts.slice(0, 20);
}

export function parseText(text: string, grade: string | number | null = GRADE): { tasks: Task[]; notice?: string } {
  const clean = (text || "").trim();
  if (!clean) return { tasks: [] };
  if (flagged(clean)) throw new LocalError("Предупреждение: не засчитано — нецензурная лексика. Перепиши без этого.", 422);
  return { tasks: textParts(clean).map((p) => { const t = p.slice(0, 200); return {...mk(t, guessType(t)), planned_minutes:estimateFromNorms(t,grade)}; }) };
}

// ------------------------------------------------------------- duel / quiz / flashcard / hint
const QB = ["Какова главная мысль темы «{T}»? Сформулируй своими словами.", "Какая причина объясняет эту связь? Обоснуй своими словами.", "Какой пример подтверждает эту связь? Объясни, почему он подходит."];
const QC = ["Какой поступок героя определяет события в этих главах? Объясни своими словами.", "Почему герой поступает именно так? Назови мотив и связь с событиями.", "Каковы последствия этого выбора? Подкрепи мысль эпизодом из прочитанного."];
const q = (topic: string, i: number) => /капитанск(ой|ая) доч/i.test(topic) ? QC[Math.min(i, 2)] : QB[Math.min(i, 2)].replace("{T}", topic);

export const blitzStart = (title: string): BlitzResponse => ({ question: q(title, 0), verdict: null, feedback: null, progress: 0, done: false });
export function blitzAnswer(title: string, text: string, history: BlitzTurn[], current: string): BlitzResponse {
  if (!text.trim()) throw new LocalError("Пустой ответ: напиши текст", 400);
  const progress = Math.min(3, history.filter((h) => h.verdict === "correct").length);
  const ok = text.trim().toLowerCase().startsWith("проверил по учебник");
  const n = ok ? Math.min(3, progress + 1) : progress;
  return {
    verdict: ok ? "correct" : "partial",
    feedback: ok ? "Самопроверка подтверждена тобой; автоматическая оценка недоступна." : "Офлайн-режим: сравни свой ответ с учебником. Если верно, напиши «проверил по учебнику».",
    progress: n, done: n >= 3, question: n >= 3 ? null : (ok ? q(title, n) : current || q(title, progress)),
  };
}

const BULLETS = "-–•·";
const isOpt = (l: string) => ("*+" + BULLETS).includes(l[0] ?? " ") || l.toLowerCase().startsWith("ответ:");
export function parseManualQuiz(raw: string): QuizQuestion[] {
  const text = (raw || "").trim();
  if (!text) return [];
  const groups: string[][] = [];
  for (const block of text.split(/\n\s*\n/)) {
    let cur: string[] = [];
    for (const line of block.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (cur.length && !isOpt(line) && (line.includes("|") || cur.slice(1).some(isOpt))) { groups.push(cur); cur = []; }
      cur.push(line);
    }
    if (cur.length) groups.push(cur);
  }
  const out: QuizQuestion[] = [];
  for (let lines of groups) {
    if (lines.length === 1 && lines[0].includes("|")) { const ps = lines[0].split("|").map((s) => s.trim()).filter(Boolean); if (ps.length >= 3) lines = ps; }
    let question = lines[0].replace(new RegExp(`^[${BULLETS} \\t]+`), "").trim();
    if ("*+".includes(question[0] ?? " ")) question = question.slice(1).trim();
    const options: string[] = []; let answer: number | null = null;
    for (const line of lines.slice(1)) {
      let c = line, marked = false;
      if ("*+".includes(c[0])) { marked = true; c = c.slice(1).trim(); }
      else if (c.toLowerCase().startsWith("ответ:")) { marked = true; c = c.slice(c.indexOf(":") + 1).trim(); }
      else if (BULLETS.includes(c[0])) c = c.replace(new RegExp(`^[${BULLETS} \\t]+`), "").trim();
      if (!c) continue;
      c = c.slice(0, 200);
      if (marked) {
        let m = options.findIndex((o) => o.toLowerCase() === c.toLowerCase());
        if (m < 0 && options.length < 6) { options.push(c); m = options.length - 1; }
        if (m >= 0) answer = m;
      } else if (options.length < 6) options.push(c);
    }
    if (question && options.length >= 2 && answer !== null) out.push({ question: question.slice(0, 400), options, answer });
  }
  return out;
}
export function quizManual(raw: string, count: number): { questions: QuizQuestion[] } {
  if (flagged(raw)) throw new LocalError("Предупреждение: не засчитано — нецензурная лексика.", 422);
  const qs = parseManualQuiz(raw).slice(0, Math.max(1, count));
  if (!qs.length) throw new LocalError("Не нашёл вопросов: отметь верный вариант звёздочкой «*»", 422);
  return { questions: qs };
}

export const flashcard = (title: string): Flashcard => /капитанск(ой|ая|ую) доч/i.test(title)
  ? { points: ["Автор «Капитанской дочки» — А. С. Пушкин.", "Повествование ведётся от лица Петра Гринёва.", "Исторический фон — восстание Пугачёва."], trap_question: "Всегда ли точка зрения рассказчика совпадает с позицией автора?" }
  // v15: без ИИ не выдумываем «факты по теме» — метод самопроверки (паритет: app/ai_engine.py _flashcard_fallback)
  : { points: ["Перечитай заголовки и выделенные определения темы.", "Закрой учебник и назови три главные мысли своими словами.", "Сверь с учебником, что упустил, и повтори именно это."], trap_question: "Что из этой темы ты не смог бы объяснить однокласснику?", source: "fallback", notice: "Без ИИ — карточка-метод, а не конспект темы." };

// Сократический репетитор офлайн: НИКОГДА не выдаёт готовый ответ — только наводящий вопрос.
const ANTI = /(дай|скажи|напиши|реши|скинь|покажи)\s+(мне\s+)?(готов|ответ|решени|за меня)|какой\s+ответ|просто\s+ответ|реши\s+за/i;
const LADDER = [
  "Прочитай условие. Выпиши, что дано и что нужно найти. Какой первый шаг ты можешь сделать сам?",
  "Какое правило или формула из параграфа подходит к этому типу задания? Назови его своими словами.",
  "Сделай первый шаг сам и покажи его мне — что получилось?",
  "Проверь шаг: одинаково ли ты поступил с обеими частями? Где могла закрасться ошибка?",
  "Похоже на пример из учебника? Чем твоё задание от него отличается?",
  "Попробуй объяснить решение так, будто рассказываешь однокласснику. На каком месте запинаешься?",
];
const HINT_NOTICE = "Автономный режим — даю шаг метода, объяснить тему без ИИ не смогу.";
export function hint(query: string, turn = 0): { hint: string; notice: string } {
  const q = (query || "").trim();
  if (ANTI.test(q)) return { hint: "Готовый ответ не дам — так ты ничему не научишься. Но помогу дойти самому: с какого шага ты застрял?", notice: HINT_NOTICE };
  if (/начать|не понимаю|не знаю|с чего/i.test(q)) return { hint: LADDER[0], notice: HINT_NOTICE };
  return { hint: LADDER[Math.min(LADDER.length - 1, Math.max(0, turn) % LADDER.length)], notice: HINT_NOTICE };
}

/** Порт ai_engine._triage_fallback — паритет проверяется в tests/test_v11.py. */
export function triage(tasks: Task[], horizon = 2): Triage {
  const load = new Array(Math.max(1, horizon)).fill(0);
  const assignments = tasks.map((t) => {
    const minutes = Math.trunc(t.planned_minutes || 0);
    const oral = t.type === "oral";
    let day: number; let reason: string;
    if (t.deadline) { day = 0; reason = "дедлайн близко — делаем сегодня"; }
    else if (!oral && minutes >= 45 && horizon > 1) { day = 1; reason = "объёмная письменная — нужен запас времени"; }
    else {
      day = load[0] + minutes <= 240 ? 0 : Math.min(horizon - 1, 1);
      reason = day === 0 ? "лёгкая — успеешь сегодня" : "сегодня уже плотно — сдвиг на завтра";
    }
    load[day] += minutes;
    return { title: t.title, day, reason };
  });
  const explanation = horizon > 1
    ? "Дедлайны — в первую очередь. Объёмные письменные работы уехали на завтра, где больше запаса времени; устные и лёгкие — на сегодня."
    : "Горизонт один день: всё распределяется на сегодня по дедлайнам и объёму.";
  return { assignments, explanation };
}

const WD = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const QS = ["Алгебра", "Русский язык", "Литература", "Физика", "История", "Биология", "Английский язык", "Геометрия"];
export function quarter(days = 5): Quarter {
  const out = [];
  for (let o = 0; o < days; o++) {
    const d = nowDate(); d.setDate(d.getDate() + o);
    const wd = d.getDay(); const h = d.getDate() * 7 + d.getMonth();
    if (wd === 0 || wd === 6) { out.push({ date: iso(d), weekday: WD[wd], lessons: [], substitutions: [] }); continue; }
    const lessons = Array.from({ length: 4 + (h % 3) }, (_, i) => ({ subject: QS[(h + i * 3) % QS.length] }));
    const substitutions = o === 1 && lessons.length > 2 ? [{ slot: "3-й урок", was: lessons[2].subject, became: "История", reason: "школьные сборы" }] : [];
    out.push({ date: iso(d), weekday: WD[wd], lessons, substitutions });
  }
  return { quarter_start: "2026-09-01", quarter_end: "2026-10-30", days: out };
}

export const whoami = (role: "student" | "teacher" = "student"): WhoAmI => ({ auth: "demo", user: "demo", role, role_source: "demo", role_switch: true });

// ------------------------------------------------------------- progress (порт progress.py)
const LEVELS: [number, string, number][] = [[0, "Новичок", 1], [200, "Собиратель", 1.05], [600, "Концентрат", 1.1], [1200, "Мастер вечера", 1.15], [2000, "Легенда фокуса", 1.2]];
const ACH = [
  ["first_plan", "Первый шаг", "Собери свой первый план дня", 1, "plan_built"], ["first_duel", "Закрывший тему", "Закрой первую тему блиц-дуэлью", 1, "duels"],
  ["duels5", "Дуэлянт", "Закрой 5 тем блиц-дуэлями", 5, "duels"], ["streak3", "Три дня подряд", "Держи стрик 3 дня", 3, "streak_peak"],
  ["streak7", "Неделя фокуса", "Держи стрик 7 дней", 7, "streak_peak"], ["streak14", "Две недели огня", "Держи стрик 14 дней", 14, "streak_peak"],
  ["days5", "Пять собранных дней", "Собери 5 дней с выполнением от 65%", 5, "counted_days"], ["flashcards5", "Шпаргалочник", "Получи 5 шпаргалок на перемену", 5, "flashcards"],
  ["perfect", "Полный разгром", "Выполни все задания дня (100%)", 1, "perfect_days"], ["early", "Ранняя пташка", "Рассчитай вечер до 16:00", 1, "early_plans"],
  ["comeback", "Возвращение", "Продолжи стрик после провального дня через блиц", 1, "comebacks"],
] as const;
interface Day { done: number; total: number; blitz: number; oral_seen: boolean; study_min: number; blitz_scores: number[]; counted: boolean; missed: boolean; grew: boolean; actual_min?: number; estimate_min?: number; tasks_done?: number }
type U = Record<string, number> & { unlocked?: never };
interface Store { c: U; unlocked: string[]; days: Record<string, Day>; last: string | null }
let keyV: string | null = null;
const KEY = () => (keyV ??= nsKey("sf.local.progress"));   // lazy: first use after bindIdentity, not at module load
const load = (): Store => { try { const s = JSON.parse(localStorage.getItem(KEY()) || "null"); if (s?.c) return s; } catch { /* */ } return { c: {} as U, unlocked: [], days: {}, last: null }; };
const save = (s: Store) => { try { localStorage.setItem(KEY(), JSON.stringify(s)); } catch { /* */ } };
const n = (s: Store, k: string) => s.c[k] ?? 0;
const day = (s: Store, d: string): Day => (s.days[d] ??= { done: 0, total: 0, blitz: 0, oral_seen: false, study_min: 0, blitz_scores: [], counted: false, missed: false, grew: false });
const addDays = (d: string, k: number) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + k); return iso(x); };
const award = (s: Store, pts: number) => { let m = 1; for (const [th, , mu] of LEVELS) if (n(s, "points") >= th) m = mu; s.c.points = n(s, "points") + Math.round(pts * m); };
function closeDays(s: Store, today: string) {
  if (!s.last || s.last >= today) return;
  for (let cur = s.last; cur < today; cur = addDays(cur, 1)) {
    const d = day(s, cur);
    if (!d.counted && !d.missed && d.oral_seen && d.blitz === 0) { s.c.miss = n(s, "miss") + 1; d.missed = true; if (n(s, "miss") >= 3) { s.c.streak = 0; s.c.miss = 0; } }
  }
}
function countDay(s: Store, ds: string) {
  const d = day(s, ds), r = d.total > 0 ? d.done / d.total : 0;
  if (r < 0.65) return;
  if (!d.counted) { d.counted = true; s.c.counted_days = n(s, "counted_days") + 1; award(s, 30); if (r >= 0.999) { s.c.perfect_days = n(s, "perfect_days") + 1; award(s, 20); } }
  if (d.grew) return;
  const prev = s.days[addDays(ds, -1)], prevFailed = !!prev && !prev.counted, duel = d.blitz > 0;
  if (!prevFailed || duel) {
    s.c.streak = n(s, "streak") + 1; d.grew = true; s.c.streak_peak = Math.max(n(s, "streak_peak"), n(s, "streak")); s.c.miss = 0;
    if (prevFailed && duel) s.c.comebacks = n(s, "comebacks") + 1;
  }
}
function sync(s: Store) {
  s.c.streak_peak = Math.max(n(s, "streak_peak"), n(s, "streak"));
  for (const [id, , , target, counter] of ACH) if (!s.unlocked.includes(id) && n(s, counter) >= target) s.unlocked.push(id);
}
export function rewards(): Rewards {
  const s = load(); closeDays(s, iso()); sync(s); save(s);
  const pts = n(s, "points");
  let idx = 0; LEVELS.forEach(([th], i) => { if (pts >= th) idx = i; });
  const nxt = LEVELS[idx + 1];
  return {
    current_streak: n(s, "streak"), total_points: pts, level: idx + 1, level_name: LEVELS[idx][1],
    points_to_next_level: nxt ? Math.max(0, nxt[0] - pts) : 0,
    level_progress_percent: nxt ? Math.min(99, Math.floor(((pts - LEVELS[idx][0]) / (nxt[0] - LEVELS[idx][0])) * 100)) : 100,
    achievements: ACH.map(([id, title, description, target, counter]) => ({ title, description, unlocked: s.unlocked.includes(id), progress_percent: Math.min(100, Math.round((n(s, counter) / target) * 100)) })),
    // v2.2: средние Алгебры и Русского — из тех же демо-оценок, что и «Симулятор оценок» (lib/demoGrades.ts): экран не противоречит сам себе.
    grades: [{ subject: "Алгебра", average: 3.3, trend: "down" }, { subject: "Русский язык", average: 3.8, trend: "flat" }, { subject: "Литература", average: 5, trend: "up" }, { subject: "Физика", average: 4.2, trend: "down" }, { subject: "История", average: 4.6, trend: "flat" }],
  };
}
export function event(kind: string, payload: Record<string, unknown>): Rewards {
  const s = load(), today = iso(); closeDays(s, today);
  const d = day(s, today); s.last = today;
  const num = (k: string) => Number(payload[k] ?? 0) || 0;
  // v15: идемпотентность (паритет с progress.py): повтор event_id не начисляет очки
  const eid = String(payload.event_id ?? "").slice(0, 120);
  if (eid) {
    const seen: Record<string, string[]> = (s as unknown as { seen?: Record<string, string[]> }).seen ??= {};
    for (const k of Object.keys(seen)) if (k < addDays(today, -2)) delete seen[k];
    if (Object.values(seen).some((ids) => ids.includes(eid))) return rewards();
    (seen[today] ??= []).length < 300 && seen[today].push(eid);
  }
  if (kind === "task_done") {
    d.total = Math.max(d.total, num("day_total")); d.done = Math.max(d.done, num("day_done"));
    if (payload.oral_eligible) d.oral_seen = true;
    const actual = num("actual_minutes"); // фактическое время фокус-таймера честнее норматива (паритет с progress.py)
    const minutes = actual > 0 ? Math.min(240, Math.max(1, Math.trunc(actual))) : Math.max(0, num("planned_minutes"));
    d.study_min += minutes;
    // Master v2.0 · Feature 3 (паритет с progress.py): факт таймера отдельно от оценки времени, число «Готово».
    if (actual > 0) d.actual_min = (d.actual_min ?? 0) + minutes; else d.estimate_min = (d.estimate_min ?? 0) + minutes;
    d.tasks_done = (d.tasks_done ?? 0) + 1;
    award(s, payload.type === "oral" ? 15 : 10); countDay(s, today);
  } else if (kind === "plan_built") { s.c.plan_built = n(s, "plan_built") + 1; if (nowDate().getHours() < 16) s.c.early_plans = n(s, "early_plans") + 1; }
  else if (kind === "duel_completed") { d.blitz++; d.blitz_scores.push(Math.max(0, Math.min(3, Math.trunc(num("score")) || 0))); /* v16.1: как сервер — счёт 0..3 */ s.c.duels = n(s, "duels") + 1; award(s, num("attempt") <= 1 ? 25 : 10); countDay(s, today); }
  else if (kind === "flashcard_used") { s.c.flashcards = n(s, "flashcards") + 1; award(s, 5); }
  sync(s); save(s);
  return rewards();
}
export function myWeek(length = 7): MyWeek {
  const s = load(), today = iso(), span = Math.max(1, Math.min(31, Math.trunc(length) || 7));
  const days = Array.from({ length: span }, (_, i) => addDays(today, i - (span - 1))).map((date) => {
    const d = s.days[date]; const sc = d?.blitz_scores ?? [];
    const study = d?.study_min ?? 0;
    // Старые дни без разбивки → null («нет данных»), а не выдуманный ноль (паритет с progress.py).
    const split = study === 0 || d?.actual_min !== undefined || d?.estimate_min !== undefined;
    return { date, study_minutes: study, counted: !!d?.counted, duels: d?.blitz ?? 0, blitz_avg: sc.length ? Math.round((sc.reduce((a, b) => a + b, 0) / sc.length) * 10) / 10 : null,
      actual_minutes: split ? d?.actual_min ?? 0 : null, estimate_minutes: split ? d?.estimate_min ?? 0 : null,
      tasks_done: d?.tasks_done !== undefined ? d.tasks_done : study === 0 && !d?.done ? 0 : null };
  });
  const all = days.flatMap((d) => s.days[d.date]?.blitz_scores ?? []);
  return { days, week_study_minutes: days.reduce((a, d) => a + d.study_minutes, 0), week_duels: days.reduce((a, d) => a + d.duels, 0), blitz_average: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null, counted_days_total: n(s, "counted_days") };
}

// ------------------------------------------------------------- teacher (детерминированный демо-класс)
const STUDENTS = ["Иванов А.", "Петрова М.", "Сидоров К.", "Кузнецова Д.", "Смирнов П.", "Орлова Е.", "Васильев И.", "Морозова А.", "Николаев С.", "Фёдорова О.", "Григорьев Д.", "Захарова В."];
const SUBJ = ["Алгебра", "Геометрия", "Русский язык", "Литература", "Физика", "История", "Биология", "География", "Английский язык"];
/** Порт app/academic.stable_hash: первые 4 байта SHA-256(UTF-8) — офлайн-карта класса
 * совпадает с серверной один в один (раньше был FNV-1a и другие цифры у тех же учеников). */
const K256 = Array.from({ length: 64 }, (_, i) => {
  let n = 2; const primes: number[] = [];
  while (primes.length <= i) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) primes.push(n); n++; }
  return (Math.cbrt(primes[i]) % 1) * 2 ** 32 >>> 0;
});
export function stableHash(str: string): number {
  const bytes = [...new TextEncoder().encode(str)];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const W = new Array<number>(64);
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H[0] >>> 0;
}
const h32 = stableHash;
export function heatmap(): Heatmap {
  const roster = STUDENTS.map((name) => {
    const h = h32(name), submitted = h % 4 !== 0, blitz = h % 4;
    const problems = !submitted || blitz < 2 ? [{ title: `${SUBJ[h % SUBJ.length]}: тема №${5 + (h % 10)}`, error_rate: 25 + (h % 50), error_line: blitz < 2 ? 3 + (h % 12) : null, hint: "Отработать базовые преобразования" }] : [];
    return { display_name: name, homework_submitted: submitted, blitz_score: blitz, blitz_max: 3, submitted_tasks: submitted ? 4 : 1 + (h % 3), total_tasks: 4, error_rate: Math.round(((3 - blitz) * 100) / 3), problem_tasks: problems, error_details: [] };
  });
  const subjects = [...new Set(roster.flatMap((r) => r.problem_tasks.map((p) => p.title.split(":")[0])))].sort();
  const avg = Math.round((roster.reduce((a, r) => a + r.blitz_score, 0) / roster.length) * 10) / 10;
  const missed = roster.filter((r) => !r.homework_submitted).length;
  return {
    class_label: GRADE, generated_for: "07:15", blitz_average: avg, submitted_count: roster.length - missed, class_size: roster.length,
    subjects: subjects.map((subject) => ({ subject })), roster,
    is_demo: true,
    five_minute_brief: `Фокус урока: ${subjects[0] ?? "—"}. Не сдали ДЗ: ${missed} из ${roster.length} — начать разбор с них. Средний блиц ${avg}/3: ${avg >= 2 ? "тема усвоена, можно идти дальше." : "слабые места есть — вернуться к базовым определениям."}`,
  };
}
export const teacherDay = (): TeacherDay => ({
  date: iso(),
  lessons: [
    { starts_at: "08:30", ends_at: "09:15", subject: "Алгебра", class_label: "8А", topic: "Квадратные уравнения", prep_recommendation: "Повторить разложение на множители; проверить д/з упр. 355" },
    { starts_at: "09:25", ends_at: "10:10", subject: "Алгебра", class_label: "8Б", topic: "Квадратные уравнения", prep_recommendation: "Собрать тетради 8Б; разбор типичных ошибок упр. 350" },
    { starts_at: "10:25", ends_at: "11:10", subject: "Геометрия", class_label: "8А", topic: "Теорема Пифагора", prep_recommendation: "Подготовить доказательство у доски; чертёжные инструменты" },
    { starts_at: "12:20", ends_at: "13:05", subject: "Алгебра", class_label: "9А", topic: "Неравенства второй степени", prep_recommendation: "Проверить контрольные 9А; метод интервалов" },
  ],
});

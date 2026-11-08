/**
 * Порт app/academic.py (нормативы времени) и app/scheduler.py (планировщик) 1:1.
 * Зачем на клиенте: мини-апп обязан работать и без бэкенда — статический хостинг,
 * упавший сервер на демо, открытие файла с телефона. Числа совпадают с сервером
 * (проверяется tests/test_engine_parity.py через node).
 */
import type { PersonalActivity, PlanEntry, PlanOut, RestSlot, Task, TaskType } from "../lib/types";

const BASE_EX = 12, BASE_PARA = 25;
const GRADE_F: Record<number, number> = { 5: 0.7, 6: 0.8, 7: 0.9, 8: 1.0, 9: 1.1, 10: 1.2, 11: 1.25 };
const GROUPS: [string, string[]][] = [
  ["math", ["алгебр", "геометри", "математик", "физик", "информатик"]],
  ["lang", ["русск", "английск", "немецк", "французск", "испанск"]],
  ["natural", ["биолог", "географ", "хими", "эколог", "астроном"]],
  ["humanities", ["истори", "обществознани", "литератур", "чтени"]],
];
const GROUP_F: Record<string, number> = { math: 1.0, lang: 0.9, natural: 1.0, humanities: 1.15 };
const TABLE_SUBJECTS = ["Алгебра", "Геометрия", "Физика", "Информатика", "Русский язык", "Английский язык",
  "Биология", "География", "Химия", "История", "Обществознание", "Литература"];
const ORAL_PARA = ["истори", "литератур", "географ", "биолог", "обществознани"];
const PARA_STUDY = ["выучить", "заучить", "ответить на вопрос", "ответить на в-сы", "вопросы после", "устный опрос"];
const PARA_RE = /§|параграф[\p{L}\d_]*/gu;
const NUM_RE = /№|упр[\p{L}\d_]*|упражнени[\p{L}\d_]*|задач[\p{L}\d_]*|задани[\p{L}\d_]*/gu;
const UNIT_RE = /(\d+)(?:\s*[-\u2013\u2014]\s*(\d+))?/g;   // дефис, en- и em-тире — escape-последовательностями: бандл может встраиваться без charset

export function parseGrade(g: string | number | null | undefined): number {
  const m = String(g ?? "").match(/\d{1,2}/);
  const n = m ? Number(m[0]) : 8;
  return n >= 5 && n <= 11 ? n : 8;
}
const groupOfSubject = (s: string) => GROUPS.find(([, ks]) => ks.some((k) => s.toLowerCase().includes(k)))?.[0] ?? "math";
function groupOf(title: string): string {
  const t = (title || "").toLowerCase();
  const subj = TABLE_SUBJECTS.find((s) => t.includes(s.toLowerCase().slice(0, 6)));
  if (subj) return groupOfSubject(subj);
  return GROUPS.find(([, ks]) => ks.some((k) => t.includes(k)))?.[0] ?? "math";
}
const round5 = (m: number) => Math.max(5, Math.min(600, Math.floor(m / 5 + 0.5) * 5));
function unitsIn(seg: string): number {
  let total = 0;
  for (const m of seg.matchAll(UNIT_RE)) {
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a > 0 && a <= 9999 && b >= a) total += Math.min(10, b - a + 1);
  }
  return total;
}
function markerUnits(text: string, re: RegExp): number {
  const bounds = [...text.matchAll(PARA_RE), ...text.matchAll(NUM_RE)].map((m) => m.index!).sort((a, b) => a - b);
  let total = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index! + m[0].length;
    const segEnd = bounds.find((b) => b >= end) ?? text.length;
    total += unitsIn(text.slice(end, segEnd));
  }
  return total;
}
function kindOf(t: string) {
  if (["сочинени", "эссе", "реферат", "доклад", "проект"].some((k) => t.includes(k))) return "essay";
  if (["выучить", "наизусть", "заучить"].some((k) => t.includes(k))) return "memorize";
  if (["пересказ", "перескажи", "прочитать", "прочтени", "читать"].some((k) => t.includes(k))) return "retell";
  if (t.includes("§") || t.includes("параграф")) return "paragraph";
  return "exercise";
}
export function estimateFromNorms(title: string, grade: string | number | null = 8): number {
  const match = String(grade ?? "").match(/\d{1,2}/);
  if (!match || !GRADE_F[Number(match[0])]) {
    const t = (title || "").toLowerCase();
    if (["сочинени","эссе","реферат","доклад"].some(x=>t.includes(x))) return 50;
    if (["проект","презентац","лаборатор"].some(x=>t.includes(x))) return 45;
    if (["пересказ","выучить","наизусть","прочитать"].some(x=>t.includes(x))) return 30;
    if (["§","параграф","упр","упражнени","задач","тест"].some(x=>t.includes(x))) return 25;
    return t.includes("повтор") ? 15 : 20;
  }
  const gf = GRADE_F[Number(match[0])], grp = GROUP_F[groupOf(title)] ?? 1;
  const t = (title || "").toLowerCase();
  let min = 0;
  const paras = markerUnits(t, PARA_RE), nums = markerUnits(t, NUM_RE);
  if (paras) min += paras * BASE_PARA * gf * grp;
  if (nums) min += nums * BASE_EX * gf * grp;
  if (min <= 0) {
    const k = kindOf(t);
    const base = k === "essay" ? 50 : k === "memorize" ? 35 : (k === "paragraph" || k === "retell") ? BASE_PARA : BASE_EX;
    min = base * gf * grp;
  }
  return round5(min);
}
export function blitzEligible(title: string, type: TaskType): boolean {
  const t = (title || "").toLowerCase();
  if (PARA_STUDY.some((m) => t.includes(m))) return true;
  return type === "oral" && ORAL_PARA.some((k) => t.includes(k));
}
export const guessType = (t: string): TaskType => ["пересказ", "выучить", "прочитать"].some((k) => t.toLowerCase().includes(k)) ? "oral" : "written";

// ---------------------------------------------------------------- scheduler
export const SURVIVAL_CAP = 15;
const CHUNK = 25, BREAK = 5, FLEX_PART = 15, SLEEP_SHIFT_MAX = 30;
/** Кусок задания короче не создаём: ни хвост помидора, ни огрызок перед ужином (паритет: app/scheduler.py). */
const TASK_MIN_PART = 10;
/** Сколько помидоров займёт задание: хвост < TASK_MIN_PART присоединяется к последнему. */
export const segCount = (m: number) => { m = Math.max(1, Math.trunc(Number(m) || 0)); let n = Math.max(1, Math.ceil(m / CHUNK)); if (n > 1 && m - (n - 1) * CHUNK < TASK_MIN_PART) n--; return n; };
export const minutesOf = (s: string) => { const [h, m] = String(s).split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0; };
export const hhmmOf = (n: number) => { const t = Math.max(0, Math.trunc(n)) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

/** Абсолютная минута события в окне: если окно уходит за полночь, «00:30» — это завтра. */
const absMinute = (hhmm: string, start: number, end: number) => { const m = minutesOf(hhmm); return m < start && m + 1440 < end ? m + 1440 : m; };

type Wall = [number, number, string, "rest" | "personal"];

export function buildPlan(p: { tasks: Task[]; start_time: string; bedtime: string; rest_slots: RestSlot[]; personal_activities: PersonalActivity[]; survival: boolean; compact_breaks?: boolean; order?: "default" | "short_first"; post_school_rest_minutes?: number }): PlanOut {
  const start = minutesOf(p.start_time);
  let end = minutesOf(p.bedtime);
  if (end <= start) end += 1440;
  const capacity = end - start;
  const queue = [...p.tasks]
    // Паритет с Python (scheduler.py: coerce → cap → max(1)): мусор/undefined раньше давал NaN и пустой план молча
    .map((t) => ({ ...t, planned_minutes: Math.max(1, Math.trunc(Number(t.planned_minutes) || 0)) }))
    .sort(p.order === "short_first"
      ? (a, b) => (a.planned_minutes - b.planned_minutes) || ((a.type === "written" ? 0 : 1) - (b.type === "written" ? 0 : 1))
      : (a, b) => ((a.type === "written" ? 0 : 1) - (b.type === "written" ? 0 : 1)) || (b.planned_minutes - a.planned_minutes))
    .map((t) => ({ ...t, planned_minutes: p.survival ? Math.min(t.planned_minutes, SURVIVAL_CAP) : t.planned_minutes }));

  // Стены: rest-слоты и обязательные дела с точным временем; прошедшие отброшены, начавшиеся обрезаны.
  const raw: Wall[] = [];
  if ((p.post_school_rest_minutes ?? 0) > 0) raw.push([start, Math.min(end, start + p.post_school_rest_minutes!), "Отдых после школы", "rest"]);
  for (const r of p.rest_slots) {
    const a = absMinute(r.start, start, end);
    let b = minutesOf(r.end);
    if (b <= minutesOf(r.start)) b += 1440;
    b += a - minutesOf(r.start);
    const s = Math.max(a, start), e = Math.min(b, end);
    if (e > s) raw.push([s, e, r.label || "Отдых", "rest"]);
  }
  const flexible: PersonalActivity[] = [];
  for (const a of p.personal_activities) {
    const dur = Math.trunc(a.duration_minutes || 0);
    if (dur <= 0) continue;
    if (a.is_fixed && a.start_time) {
      const m = absMinute(a.start_time, start, end);
      const s = Math.max(m, start), e = Math.min(m + dur, end);
      if (e > s) raw.push([s, e, a.title || "Дело", "personal"]);
    } else if (a.is_fixed || !p.survival) flexible.push(a);
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const walls: Wall[] = [];
  for (const w of raw) {
    const s = walls.length ? Math.max(w[0], walls[walls.length - 1][1]) : w[0];
    if (w[1] > s) walls.push([s, w[1], w[2], w[3]]);
  }

  const needStudy = queue.reduce((s, t) => s + t.planned_minutes, 0);
  const segs = queue.reduce((s, t) => s + segCount(t.planned_minutes), 0);
  // compact_breaks (режим спасения): внутри задания перерыв раз в 50 мин, между заданиями — всегда
  const intra = queue.reduce((s, t) => s + Math.floor((segCount(t.planned_minutes) - 1) / 2), 0);
  const needBreaks = !queue.length ? 0 : p.compact_breaks ? (intra + Math.max(0, queue.length - 1)) * BREAK : Math.max(0, segs - 1) * BREAK;
  const needRest = walls.filter((w) => w[3] === "rest").reduce((s, w) => s + w[1] - w[0], 0);
  const needFixed = walls.filter((w) => w[3] === "personal").reduce((s, w) => s + w[1] - w[0], 0);
  const needFlexible = flexible.reduce((s, a) => s + Math.trunc(Number(a.duration_minutes) || 0), 0);
  const deficit = Math.max(0, needStudy + needBreaks + needRest + needFixed + needFlexible - capacity);

  const entries: PlanEntry[] = [];
  const cnt = { work: 0, break: 0, rest: 0, personal: 0 };
  const push = (kind: PlanEntry["kind"], s: number, e: number, label: string, segment: string | null = null, task: string | null = null) => {
    if (e <= s) return;
    entries.push({ start: hhmmOf(s), end: hhmmOf(e), kind, label, segment, task });
    cnt[kind] += e - s;
  };
  let t = start, wi = 0;
  const dropped: string[] = [];
  const skipWall = () => {
    while (wi < walls.length && t >= walls[wi][1]) wi++;
    if (wi < walls.length && t >= walls[wi][0]) { push(walls[wi][3], t, walls[wi][1], walls[wi][2]); t = walls[wi][1]; wi++; return true; }
    return false;
  };
  const nextWall = () => (wi < walls.length ? walls[wi][0] : end);
  queue.forEach((task, qi) => {
    let rem = task.planned_minutes;
    let no = 0;
    const segIdx: number[] = [];
    while (rem > 0) {
      if (skipWall()) continue;
      if (t >= end) { dropped.push(task.title); break; }
      let len = Math.min(CHUNK, rem);
      if (rem - len > 0 && rem - len < TASK_MIN_PART) len = rem; // короткий хвост — в этот же кусок
      const realWall = wi < walls.length && nextWall() < end;
      if (t + len > nextWall()) {
        let avail = nextWall() - t;
        if (realWall) {
          // не режем задание на огрызки вокруг ужина/секции
          if (rem - avail > 0 && rem - avail < TASK_MIN_PART) avail = rem - TASK_MIN_PART;
          if (avail < TASK_MIN_PART) { t = nextWall(); continue; }
        }
        len = avail;
      }
      if (len <= 0) { dropped.push(task.title); break; }
      no++;
      segIdx.push(entries.length);
      push("work", t, t + len, task.title, null, task.title);
      t += len; rem -= len;
      if (rem > 0 && (!p.compact_breaks || no % 2 === 0) && t + BREAK <= nextWall()) { push("break", t, t + BREAK, "Перерыв"); t += BREAK; }
    }
    if (segIdx.length > 1) segIdx.forEach((i, n) => { entries[i].segment = `${n + 1}/${segIdx.length}`; });
    if (rem <= 0 && qi + 1 < queue.length && t + BREAK <= nextWall()) { push("break", t, t + BREAK, "Перерыв"); t += BREAK; }
  });
  // Гибкие дела: после учёбы в свободные промежутки; не влезло в один — делится на части (≥ FLEX_PART) через стены.
  const unplaced: string[] = [];
  for (const a of flexible) {
    let rem = Math.trunc(a.duration_minutes);
    const title = a.title || "Дело", idx: number[] = [];
    while (rem > 0) {
      skipWall();
      if (t >= end) break;
      const take = Math.min(rem, Math.min(end, nextWall()) - t);
      if (take < Math.min(rem, FLEX_PART)) { if (wi >= walls.length) break; t = Math.max(t, walls[wi][0]); continue; }
      idx.push(entries.length);
      push("personal", t, t + take, title);
      t += take; rem -= take;
    }
    if (idx.length > 1) idx.forEach((i, n) => { entries[i].segment = `${n + 1}/${idx.length}`; });
    if (rem > 0) unplaced.push(title);
  }
  while (wi < walls.length) { const [s, e, l, k] = walls[wi]; if (e > t) { push(k, Math.max(t, s), e, l); t = e; } wi++; }

  const suggestions: string[] = [];
  if (deficit > 0) {
    for (const a of flexible) {
      if (a.is_fixed) continue;
      const dur = Math.trunc(a.duration_minutes), title = a.title || "развлечения";
      suggestions.push(dur > deficit ? `Сократить «${title}» на ${deficit} мин` : `Перенести «${title}» на другой день (−${dur} мин)`);
    }
    const orals = p.tasks.filter((x) => x.type === "oral");
    if (orals.length) suggestions.push(`Перенести устное на утро (−${orals.reduce((s, x) => s + x.planned_minutes, 0)} мин)`);
    // сон — ограничение, не ресурс: сдвиг только небольшой
    suggestions.push(deficit <= SLEEP_SHIFT_MAX ? `Лечь позже на ${deficit} мин` : "Перенести часть заданий на завтра — сон не сдвигаем");
  }
  return {
    plan: entries,
    summary: {
      window_start: hhmmOf(start), window_end: hhmmOf(end),
      total_work_minutes: cnt.work, total_break_minutes: cnt.break, total_rest_minutes: cnt.rest, total_personal_minutes: cnt.personal,
      free_minutes_left: deficit === 0 ? Math.max(0, end - t) : 0,
      utilization_percent: Math.min(100, Math.round((cnt.work / Math.max(1, capacity)) * 100)),
      capacity_minutes: capacity,
      need_work_minutes: needStudy + needBreaks,
      need_fixed_minutes: needFixed,
      need_flexible_minutes: needFlexible,
      need_rest_minutes: needRest,
      unplaced_personal: unplaced,
      study_work_minutes: needStudy,
      mandatory_rest_minutes: needBreaks + needRest,
      clean_gamepass_minutes: Math.max(0, capacity - needStudy - needBreaks - needRest - needFixed - needFlexible),
      homework_end_time: dropped.length ? null : ([...entries].reverse().find((e) => e.kind === "work")?.end ?? null),
    },
    deficit_minutes: deficit,
    tradeoff_suggestions: suggestions,
    survival_dropped: p.survival && dropped.length
      ? { message: `Режим выживания: ${dropped.slice(0, 3).map((n) => `«${n}»`).join(", ")} не помещаются сегодня — перенос на завтра. Сделай несгораемый минимум по остальным.` }
      : null,
  };
}

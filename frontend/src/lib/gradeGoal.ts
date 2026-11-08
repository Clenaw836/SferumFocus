/** v3.2 · Калькулятор цели в четверти и сводка дашборда оценок (чистые функции, покрыты unit-тестом).
 *  Пороги четвертной: 4.60 — «твёрдая 5», 3.60 — «твёрдая 4». Проверено (Perplexity, docs/v32/PERPLEXITY_VERIFICATION.md):
 *  единого федерального порога нет — его задаёт положение школы о текущем контроле (ч. 2 ст. 30 273-ФЗ), часто 4,5 или 4,6.
 *  Поэтому 4.60 — осторожная цель «с запасом», а интерфейс прямо пишет, что правило школьное (GRADE_RULE_NOTE). */
export const SOLID_FIVE = 4.6, SOLID_FOUR = 3.6;
export type Tone = "ok" | "mid" | "risk";
export const toneOf = (avg: number): Tone => avg >= 4.5 ? "ok" : avg >= SOLID_FOUR ? "mid" : "risk";
/** Сколько пятёрок подряд нужно, чтобы среднее marks достигло target (0 — уже достигнуто; null — нет оценок). */
export function fivesNeeded(marks: readonly number[], target = SOLID_FIVE): number | null {
  if (!marks.length) return null;
  const sum = marks.reduce((a, b) => a + b, 0), n = marks.length;
  if (sum / n >= target - 1e-9) return 0;
  return Math.ceil((target * n - sum) / (5 - target) - 1e-9);
}
export const GRADE_RULE_NOTE = "Порог 4,60 — цель с запасом. Точное правило четвертной задаёт положение твоей школы: часто 4,5 или 4,6.";
const WORDS = ["ноль", "одну", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять"];
const word = (n: number) => WORDS[n] ?? String(n);
const fives = (n: number) => n % 10 === 1 && n % 100 !== 11 ? "оценку 5" : "оценки 5";
/** Живая строка цели: «До твёрдой 5 в четверти (4.60) нужно ещё две оценки 5». */
export function goalLine(marks: readonly number[]): { text: string; reached: boolean } {
  const avg = marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : 0;
  if (!marks.length) return { text: "Оценок пока нет — цель появится после первой отметки.", reached: false };
  const five = fivesNeeded(marks, SOLID_FIVE)!;
  if (five === 0) return { text: "Твёрдая 5 в четверти — держи темп.", reached: true };
  if (avg >= SOLID_FOUR || five <= 3) return { text: `До твёрдой 5 в четверти (балл 4,60) нужно ещё ${word(five)} ${fives(five)}.`, reached: false };
  const four = fivesNeeded(marks, SOLID_FOUR)!;
  return { text: `До твёрдой 4 (балл 3,60) нужно ещё ${word(four)} ${fives(four)}, до 5 — ${word(five)}.`, reached: false };
}
export interface MarkLite { subject: string; value: string; date?: string | null }
const num = (v: string) => { const n = Number(String(v).replace(",", ".").replace(/[^\d.]/g, "")); return n >= 1 && n <= 5 ? n : null; };
export const marksOf = (list: readonly MarkLite[], subject?: string): number[] =>
  list.filter((g) => !subject || g.subject === subject).map((g) => num(g.value)).filter((x): x is number => x !== null);
/** Сводка: средний по предметам, тренд за неделю (среднее всех отметок минус среднее без последних 7 дней). */
export function summary(list: readonly MarkLite[], subjects: readonly { subject: string; average: number }[], today: string) {
  const avg = subjects.length ? subjects.reduce((a, s) => a + s.average, 0) / subjects.length : null;
  const all = marksOf(list), weekAgo = shiftIso(today, -7);
  const older = marksOf(list.filter((g) => (g.date ?? "") <= weekAgo));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const trend = all.length && older.length && all.length > older.length ? mean(all) - mean(older) : 0;
  return { avg, trend, fives: all.filter((x) => x === 5).length, fours: all.filter((x) => x === 4).length,
    risk: subjects.filter((s) => s.average < SOLID_FOUR).length };
}
function shiftIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
/** Учебный день: идёт (до конца последнего урока) или закончился → готовимся на завтра. */
export function schoolPhase(lessons: readonly { start_time: string | null; end_time: string | null; status?: string }[], nowMin: number):
  { phase: "before" | "during" | "after" | "none"; current: number; next: number } {
  const act = lessons.filter((l) => l.status === undefined || l.status === "active");
  const toM = (s: string | null) => { if (!s) return null; const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const ends = act.map((l) => toM(l.end_time)).filter((x): x is number => x !== null);
  if (!act.length || !ends.length) return { phase: "none", current: -1, next: -1 };
  const last = Math.max(...ends), first = Math.min(...act.map((l) => toM(l.start_time) ?? 9999));
  if (nowMin >= last) return { phase: "after", current: -1, next: -1 };
  const current = act.findIndex((l) => (toM(l.start_time) ?? 9999) <= nowMin && nowMin < (toM(l.end_time) ?? -1));
  const next = act.findIndex((l) => (toM(l.start_time) ?? -1) > nowMin);
  return { phase: nowMin < first ? "before" : "during", current, next };
}

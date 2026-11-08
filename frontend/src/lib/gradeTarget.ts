/** v2.1 · B2: «Что, если…» по оценкам предмета — точная арифметика без ИИ и без выдуманных данных.
 *
 *  Паритет 1:1 с app/grade_watcher.py::grade_recovery_trajectory (Fraction): цель 4.00, если средний < 4,
 *  иначе 4.50; будущая «5» весом 1; k = ⌈(цель·W − Σ)/(5 − цель)⌉. Считаем в целых числах (отметка и вес ×1000),
 *  поэтому деление выполняется один раз и округляется так же, как float(Fraction) в Python.
 *  Отметки и веса с более чем тремя знаками после запятой не учитываются (в СГО их нет).
 *  v2.2: разбор отметки — marksOf/weightOf, паритет с app/grade_marks.py («5/4», «4-», «Н», вес 0). */

export interface MarkLike { value: string | number | boolean | null; weight?: string | number | boolean | null }
/** Сумма Σ(отметка·вес) в единицах 10⁻⁶ и сумма весов W в единицах 10⁻³. */
export interface MarkBase { total: number; weight: number; count: number }
export interface Trajectory { average: number; target: number; fives_needed: number; projected_average: number; grade_count: number; weight_sum: number; scope: "loaded_snapshot"; future_weight: 1 }

const DEC = /^\d{1,4}(?:[.,]\d{1,3})?$/;           // как app/grade_marks.py::_DEC: точка или запятая, ≤ 3 знаков
const PART = /^(\d{1,4}(?:[.,]\d{1,3})?)[+-]?$/;  // «4», «4-», «5+», «4.5»
const scaled = (s: string): number => Math.round(Number(s.replace(",", ".")) * 1000);

/** v2.2 · Числовые части отметки ×1000 — паритет 1:1 с app/grade_marks.py::marks_of.
 *  «5/4» — двойная отметка (обе части в средний), «4-» = 4, «Н», «Б», «УП», «Зач», «ОСВ» — не входят. */
export function marksOf(raw: string | number | boolean | null | undefined): number[] {
  if (raw === null || raw === undefined || typeof raw === "boolean") return [];
  const text = String(raw).trim();
  if (!text || text.length > 32) return [];
  const parts = text.split(/\s*\/\s*/);
  if (parts.length > 3) return [];
  const out: number[] = [];
  for (const p of parts) {
    const m = PART.exec(p);
    if (!m) return [];
    const v = scaled(m[1]);
    if (v < 1000 || v > 5000) return [];
    out.push(v);
  }
  return out;
}
/** v2.2 · паритет с app/grade_marks.py::is_low: «2», «3», «3-», «2+», «5/3» — повод для плана исправления;
 *  «Н», «Зач», «4», «5/4» — нет. marksOf возвращает тысячные («3» = 3000), поэтому сравнение — с 2000/3000. */
export function isLowMark(raw: string | number | boolean | null | undefined): boolean {
  return marksOf(raw).some((v) => v === 2000 || v === 3000);
}
/** Вес ×1000: пусто → 1; 0 < w ≤ 1000 → w; 0, отрицательный, логический или битый → null (не учитывается). */
export function weightOf(raw: string | number | boolean | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return 1000;
  if (typeof raw === "boolean") return null;
  const s = String(raw).trim();
  if (!DEC.test(s)) return null;
  const w = scaled(s);
  return w > 0 && w <= 1_000_000 ? w : null;
}

/** Только числовые отметки 1…5 с весом 0 < w ≤ 1000; «5/4» даёт две отметки, текстовые отметки и битые веса пропускаются. */
export function markBase(marks: readonly MarkLike[]): MarkBase {
  let total = 0, weight = 0, count = 0;
  for (const m of marks) {
    const w = weightOf(m.weight ?? null);
    if (w === null) continue;
    for (const v of marksOf(m.value)) { total += v * w; weight += w; count += 1; }
  }
  return { total, weight, count };
}

export const averageOf = (b: MarkBase): number | null => (b.count ? b.total / (b.weight * 1000) : null);

/** Средний после гипотетических отметок весом 1 (кнопки «+5», «+4», «+3»). */
export function withMarks(b: MarkBase, extra: readonly number[]): MarkBase {
  let { total, weight, count } = b;
  for (const v of extra) if (Number.isInteger(v) && v >= 1 && v <= 5) { total += v * 1_000_000; weight += 1000; count += 1; }
  return { total, weight, count };
}

/** Сколько ещё отметок `mark` (вес 1) нужно, чтобы средний стал ≥ targetN/targetD. null — недостижимо этой отметкой. */
export function marksNeeded(b: MarkBase, targetN: number, targetD: number, mark = 5): number | null {
  if (!b.count) return null;
  if (mark * targetD <= targetN) return b.total * targetD >= targetN * b.weight * 1000 ? 0 : null;
  const num = targetN * b.weight * 1000 - b.total * targetD;            // (цель·W − Σ)·D·10⁶
  const den = 1_000_000 * (mark * targetD - targetN);                   // (отметка − цель)·D·10⁶
  return num <= 0 ? 0 : Math.floor((num - 1) / den) + 1;
}

/** Та же траектория, что на сервере (grade_recovery_trajectory). */
export function trajectory(marks: readonly MarkLike[]): Trajectory | null {
  const b = markBase(marks);
  if (!b.count) return null;
  const below4 = b.total < 4 * b.weight * 1000;
  const [tn, td] = below4 ? [4, 1] : [9, 2];
  const k = marksNeeded(b, tn, td, 5) ?? 0;
  return {
    average: b.total / (b.weight * 1000), target: tn / td, fives_needed: k,
    projected_average: (b.total + 5_000_000 * k) / (b.weight * 1000 + 1_000_000 * k),
    grade_count: b.count, weight_sum: b.weight / 1000, scope: "loaded_snapshot", future_weight: 1,
  };
}

/** Средний «4.05» (как в журнале учителя), без лишних нулей у целых: «4.00» остаётся «4.00». */
export const fmtAvg = (x: number | null): string => (x === null ? "—" : x.toFixed(2));

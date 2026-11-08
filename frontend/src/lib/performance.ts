/**
 * Единая шкала качества для учителя. ОДИН конфиг — его читают строка ученика,
 * легенда, карточка ученика и счётчик «требуют внимания»: цвет, подпись и
 * aria-текст не могут разъехаться.
 *
 * Семантика данных (app/mock_diary.heatmap, engine/local.heatmap):
 *  - ВЫПОЛНЕНИЕ = submitted_tasks / total_tasks — сколько заданий ДЗ сдано. Это не качество.
 *  - КАЧЕСТВО   = error_rate — доля неверных ответов блиц-проверки по теме ДЗ,
 *                 (blitz_max − blitz_score) / blitz_max. Цвет строки — только отсюда.
 */
export type Severity = "ok" | "attention" | "critical" | "unknown";
export type Tone = "ok" | "warn" | "bad" | "muted";
export interface SeverityInfo { severity: Severity; label: string; tone: Tone; description: string; range: string }

export const SEVERITY_SCALE: readonly (SeverityInfo & { max: number })[] = [
  { severity: "ok", max: 25, label: "В норме", tone: "ok", range: "0–25 %", description: "Тема усвоена, ошибки единичные" },
  { severity: "attention", max: 50, label: "Требует внимания", tone: "warn", range: "26–50 %", description: "Есть пробелы — проверить один пример у доски" },
  { severity: "critical", max: 100, label: "Критично", tone: "bad", range: "51–100 %", description: "Тема не усвоена — разобрать индивидуально" },
];
const UNKNOWN: SeverityInfo = { severity: "unknown", label: "Нет данных", tone: "muted", range: "—", description: "Блиц-проверки по теме ещё не было" };

export function getPerformanceSeverity(errorRate: number | null | undefined): SeverityInfo {
  if (errorRate == null || !Number.isFinite(errorRate)) return UNKNOWN;
  const r = Math.max(0, Math.min(100, Math.round(errorRate)));
  const s = SEVERITY_SCALE.find((x) => r <= x.max) ?? SEVERITY_SCALE[SEVERITY_SCALE.length - 1];
  const { max: _max, ...info } = s;
  return info;
}

/** Доля ошибок строки: из поля сервера, иначе — из блица (старый сервер без error_rate). */
export function rowErrorRate(r: { error_rate?: number | null; blitz_score: number; blitz_max?: number }): number | null {
  if (r.error_rate !== undefined) return r.error_rate;
  const max = r.blitz_max ?? 3;
  return max > 0 ? Math.round(((max - r.blitz_score) * 100) / max) : null;
}

export const needsAttention = (s: Severity) => s === "attention" || s === "critical";

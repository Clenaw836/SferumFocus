/**
 * v2.2 · «Весь класс»: ссылка и короткий код опроса, способы офлайн-сдачи и сводка для журнала.
 *
 * Код из 6 цифр — навигация («найди свой опрос в плане»), а не пароль: он выводится из id опроса,
 * и открыть опрос всё равно можно только если учитель выдал его этому ученику (проверяет сервер).
 * Совпадение кода у двух разных опросов одного ученика возможно (≈ 1 на миллион) — тогда ученик
 * видит оба и выбирает сам.
 */
import type { HwIssueRow, ManualHow } from "./hwTypes";

export const QUIZ_START_RE = /^quiz_(tpl_[0-9a-f]{32})$/;
export const quizStart = (templateId: string) => `quiz_${templateId}`;

/** FNV-1a (32 бита) от «quiz-pin:<id>» → 6 цифр. Одинаково у учителя и ученика, без сервера. */
export function quizPin(templateId: string): string {
  let h = 0x811c9dc5;
  const s = `quiz-pin:${templateId}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return String(h % 1_000_000).padStart(6, "0");
}
export const pinGroups = (pin: string) => `${pin.slice(0, 3)} ${pin.slice(3)}`;
export const normalizePin = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

export function matchPin<T extends { template_id: string; kind?: string }>(pin: string, list: readonly T[]): T[] {
  const p = normalizePin(pin);
  if (p.length !== 6) return [];
  return list.filter((x) => x.kind === "quiz" && quizPin(x.template_id) === p);
}

export const HOW_LABEL: Record<ManualHow, string> = { oral: "Сдал(а) устно", paper: "На листочке" };
export const HOW_SHORT: Record<ManualHow, string> = { oral: "устно", paper: "на листочке" };

/** Как сдана работа — для строки ученика и сводки. */
export function handedIn(s: HwIssueRow): string {
  if (s.status === "revoked") return "Отозвано";
  if (s.quiz?.state === "submitted") return "В СферумФокус";
  if (s.manual) return s.manual.how ? HOW_LABEL[s.manual.how] : "Внесено учителем";
  if (s.status === "completed") return "Отметил(а) в СферумФокус";
  if (s.quiz?.state === "started") return "Проходит сейчас";
  return s.access === "offline" ? "Ждёт отметки учителя" : "Не сдано";
}

function scoreOf(s: HwIssueRow): [number, number] | null {
  if (s.quiz?.state === "submitted" && s.quiz.score != null && s.quiz.max_score) return [s.quiz.score, s.quiz.max_score];
  if (s.manual?.score != null && s.manual.max_score) return [s.manual.score, s.manual.max_score];
  return null;
}

const cell = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim();

/**
 * Таблица для вставки в электронный журнал или таблицу (TSV: колонки разделены табуляцией).
 * Только факты — ученик, как сдано, баллы, процент. Оценку («5», «4») приложение не ставит: это решение учителя.
 */
export function journalTsv(rows: readonly HwIssueRow[]): { text: string; count: number } {
  const live = rows.filter((s) => s.status !== "revoked").slice().sort((a, b) => a.display_name.localeCompare(b.display_name, "ru"));
  const lines = [["Ученик", "Как сдано", "Баллы", "Процент"].join("\t")];
  for (const s of live) {
    const sc = scoreOf(s);
    lines.push([cell(s.display_name), handedIn(s), sc ? `${sc[0]}/${sc[1]}` : "", sc ? `${Math.round((100 * sc[0]) / sc[1])}%` : ""].join("\t"));
  }
  return { text: lines.join("\n"), count: live.length };
}

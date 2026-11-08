/** Recovery 2: wording for teacher-assignment states and history (pure — covered by unit tests). */
import type { HwCounts, HwEvent, HwStatus } from "./hwTypes";
import { plural } from "./time";

export const HW_STATUS: Record<HwStatus, string> = { assigned: "Выдано", in_progress: "В работе", paused: "Пауза", completed: "Сдано", revoked: "Отозвано" };
export const HW_TYPE = { written: "Письменное", oral: "Устное" } as const;

/** 0 → «0 мин», 1–59 s → «<1 мин», minutes, then «1 ч 05 мин». null/invalid → «—». */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec === 0) return "0 мин";
  if (sec < 60) return "<1 мин";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${String(r).padStart(2, "0")} мин` : `${h} ч`;
}

const REASON: Record<string, string> = {
  pause: "пауза таймера", break: "перерыв помидора", drop: "таймер остановлен", switch: "переключился на другое задание",
  switched: "автопауза: начато другое задание", next_round: "следующий помидор", list: "отметка «Готово»", restore: "восстановление",
  teacher_revoked: "учитель отозвал", student_rejected: "заявка отклонена", student_removed: "ученик убран из класса",
  template_archived: "задание перенесено в архив", student_left: "ученик вышел из класса",
};
const FIELD: Record<string, string> = { title: "название", instructions: "инструкции", task_type: "тип", planned_minutes: "время", due_date: "срок" };

/** Secondary line of one history event: why it happened, round, device timer, changed fields. */
export function eventDetail(e: Pick<HwEvent, "actor" | "payload">): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const reason = typeof p.reason === "string" ? REASON[p.reason] ?? "" : "";
  if (reason) parts.push(reason);
  if (typeof p.round === "number" && p.round > 1) parts.push(`помидор №${p.round}`);
  if (typeof p.client_elapsed_sec === "number") parts.push(`таймер устройства: ${fmtDur(p.client_elapsed_sec)}`);
  if (Array.isArray(p.fields) && p.fields.length) parts.push("изменено: " + p.fields.map((f) => FIELD[String(f)] ?? String(f)).join(", "));
  if (p.how === "oral") parts.push("сдал(а) устно");          // v2.2 · отметка офлайн-сдачи
  else if (p.how === "paper") parts.push("на листочке");
  if (typeof p.score === "number" && typeof p.max_score === "number") parts.push(`${p.score}/${p.max_score}`);
  if (e.actor === "system" && !reason) parts.push("автоматически");
  return parts.join(" · ");
}

/** Events delivered > 60 s after they happened (offline queue): the time is the device-measured moment. */
export function delayText(e: Pick<HwEvent, "delayed" | "delay_sec">): string | null {
  return e.delayed ? `доставлено через ${fmtDur(e.delay_sec)} — момент восстановлен по таймеру устройства` : null;
}

export const ACTOR: Record<HwEvent["actor"], string> = { teacher: "учитель", student: "ученик", system: "система" };

/** «3 из 5 сдали · 1 в работе» — no percentage over an unknown denominator. */
export function countsLine(c: HwCounts): string {
  const open = c.total - c.revoked;
  if (!c.total) return "Пока никому не выдано";
  const parts = [`${c.completed} из ${open} ${plural(c.completed, "сдал", "сдали", "сдали")}`];
  if (c.in_progress) parts.push(`${c.in_progress} в работе`);
  if (c.paused) parts.push(`${c.paused} на паузе`);
  if (c.assigned) parts.push(`${c.assigned} не ${plural(c.assigned, "начал", "начали", "начали")}`);
  if (c.revoked) parts.push(`${c.revoked} отозвано`);
  return parts.join(" · ");
}

/** Local short date-time; invalid → «—». */
export function when(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
}

/** YYYY-MM-DD → «12 окт»; null → «без срока». */
export function dueText(due: string | null | undefined): string {
  if (!due) return "без срока";
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? due : `до ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
}

/** Client mirror of the server rules (the server re-validates everything). */
export function validateAssignment(f: { title: string; instructions: string; planned_minutes: number; due_date: string | null }, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  const t = f.title.trim();
  if (!t) e.title = "Напишите название задания";
  else if (t.length > 120) e.title = "Не длиннее 120 символов";
  if (f.instructions.length > 2000) e.instructions = "Не длиннее 2000 символов";
  if (!Number.isInteger(f.planned_minutes) || f.planned_minutes < 5 || f.planned_minutes > 240) e.planned_minutes = "От 5 до 240 минут";
  if (f.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.due_date)) e.due_date = "Дата в формате ГГГГ-ММ-ДД";
  else if (f.due_date && f.due_date < today) e.due_date = "Срок уже прошёл";
  return e;
}

/** Upper-case Latin + digits; Cyrillic look-alikes typed on a Russian keyboard map to Latin. */
const LOOKALIKE: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y" };
export const normalizeClassCode = (v: string) => v.toUpperCase().replace(/[АВЕКМНОРСТХУ]/g, (c) => LOOKALIKE[c] ?? c).replace(/[^A-Z0-9]/g, "").slice(0, 12);

/** Student-facing status.  With a queued (undelivered) action the label follows the device — the student
 * pressed «Пауза», so it says «На паузе» — and says plainly that the teacher does not see it yet. */
type Next = "start" | "pause" | "resume" | "complete" | null;
export function shownStatus(status: HwStatus, pending = 0, next: Next = null): HwStatus {
  const open = status === "assigned" || status === "in_progress" || status === "paused";      // terminal server states always win
  return open && pending && next ? (next === "pause" ? "paused" : next === "complete" ? "completed" : "in_progress") : status;
}
export function studentStatusLabel(status: HwStatus, timerSec: number, pending = 0, next: Next = null): string {
  const shown = shownStatus(status, pending, next);
  const worked = timerSec >= 60 ? ` · ${Math.round(timerSec / 60)} мин` : "";
  const base = shown === "assigned" ? "Не начато" : shown === "in_progress" ? `В работе${worked}` : shown === "paused" ? `На паузе${worked}`
    : shown === "completed" ? (pending ? "Выполнено" : "Выполнено — учитель видит") : "Отозвано учителем";
  return pending ? `${base} · ждёт отправки` : base;
}

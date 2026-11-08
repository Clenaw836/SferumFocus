/** R-08 · plain-text form of the class report (copy for a staff meeting / parent chat). Pure, unit-tested. */
import type { HwReport } from "./hwTypes";

export const pct = (v: number | null) => (v === null ? "—" : `${v} %`);
export const ru = (d: string) => d.split("-").reverse().join(".");

export function reportText(r: HwReport): string {
  const t = r.totals;
  const lines = [`Класс ${r.class} · ${ru(r.from)}–${ru(r.to)}`,
    `Выдано: ${t.issued} · выполнено: ${t.completed} (${pct(t.completion_percent)}) · в работе: ${t.in_progress} · не начато: ${t.not_started} · просрочено: ${t.overdue_open}`,
    `Результаты опросов и оценок: ${t.results} · средний: ${pct(t.avg_percent)}`];
  if (t.revoked) lines.push(`Отозвано (не учитывается): ${t.revoked}`);
  if (r.students.length) lines.push("", "Ученики:", ...r.students.map((s) => `— ${s.name}: ${s.completed}/${s.issued}${s.overdue_open ? `, просрочено ${s.overdue_open}` : ""}${s.avg_percent !== null ? `, средний ${s.avg_percent} %` : ""}`));
  return lines.join("\n");
}

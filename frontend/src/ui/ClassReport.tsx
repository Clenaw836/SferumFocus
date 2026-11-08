/**
 * R-08 · «Отчёт за период» for one class: only recorded facts from the server (issues, their append-only
 * events as of the end of the period, server-graded quiz attempts, paper results entered by the teacher).
 * No estimates: an empty period says so. Copy as plain text for a staff meeting or a parent chat.
 */
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";
import { schoolDay } from "../lib/day";
import type { HwReport } from "../lib/hwTypes";
import { pct, reportText, ru } from "../lib/hwReport";
import { Icon } from "./Icon";
import { toast } from "./Toast";

export function ClassReport({ cls }: { cls: string }) {
  const [from, setFrom] = useState(() => schoolDay(undefined, -6));
  const [to, setTo] = useState(() => schoolDay());
  const [r, setR] = useState<HwReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");
  const [open, setOpen] = useState(false);
  const load = async () => {
    if (busy) return;
    setBusy(true); setFail("");
    try { setR(await api.hw.report(cls, from, to)); }
    catch (e) { setR(null); setFail(e instanceof ApiError ? e.message : "Отчёт не загрузился"); }
    finally { setBusy(false); }
  };
  useEffect(() => { setR(null); setFail(""); if (open) void load(); }, [cls]);
  const copyReport = () => {
    if (!r) return;
    const text = reportText(r);
    if (!navigator.clipboard) { toast("Скопировать не удалось — выделите текст отчёта вручную", "info"); return; }
    navigator.clipboard.writeText(text).then(() => toast("Отчёт скопирован", "ok"), () => toast("Скопировать не удалось", "info"));
  };
  const t = r?.totals;
  return <details class="hw-card b-card hw-report mt-3" open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (o && !r && !busy) void load(); }}>
    <summary><Icon name="chart" /><span><b>Отчёт за период · {cls}</b><small>Только из фактов: выдачи, события, результаты</small></span><Icon name="chevron" /></summary>
    <form class="hw-report-period l-h l-end l-wrap mt-2 mb-2" onSubmit={(e) => { e.preventDefault(); void load(); }}>
      <label class="field"><span class="field-label">С</span><input class="input" type="date" value={from} max={to} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} /></label>
      <label class="field"><span class="field-label">По</span><input class="input" type="date" value={to} min={from} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} /></label>
      <button type="submit" class="btn btn-secondary btn-sm" disabled={busy}>{busy ? "Считаем…" : "Показать"}</button>
    </form>
    {fail && <p class="field-err" role="alert">{fail}</p>}
    {r && t && (t.issued === 0
      ? <p class="hw-empty-line f-3 mt-2 mb-2" role="status">За {ru(r.from)}–{ru(r.to)} заданий этому классу не выдавалось.</p>
      : <div role="region" aria-label={`Отчёт ${r.class} за ${ru(r.from)}–${ru(r.to)}`}>
        <dl class="hw-report-totals l-fit mt-2 mb-3">
          <div><dt>Выполнено</dt><dd class="num f-w6">{t.completed} из {t.issued} · {pct(t.completion_percent)}</dd></div>
          <div><dt>В работе</dt><dd class="num f-w6">{t.in_progress}</dd></div>
          <div><dt>Не начато</dt><dd class="num f-w6">{t.not_started}</dd></div>
          <div><dt>Просрочено</dt><dd class="num f-w6">{t.overdue_open}</dd></div>
          <div><dt>Средний результат</dt><dd class="num f-w6">{pct(t.avg_percent)}{t.results ? ` · ${t.results}` : ""}</dd></div>
        </dl>
        <table class="hw-report-table f-b l-w100">
          <caption class="sr">Ученики: выполнено из выданного, просрочено, средний результат</caption>
          <thead><tr><th scope="col">Ученик</th><th scope="col">Сдано</th><th scope="col">Просрочено</th><th scope="col">Средний</th></tr></thead>
          <tbody>{r.students.map((s) => <tr key={s.name}><th scope="row">{s.name}</th><td class="num">{s.completed}/{s.issued}</td><td class="num">{s.overdue_open || "—"}</td><td class="num">{pct(s.avg_percent)}</td></tr>)}</tbody>
        </table>
        <div class="hw-row-actions l-h l-wrap"><button type="button" class="btn btn-ghost btn-sm" onClick={copyReport}><Icon name="share" />Скопировать текстом</button></div>
      </div>)}
  </details>;
}

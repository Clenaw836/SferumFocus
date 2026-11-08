/**
 * v16 «Ручной импорт расписания»: EVIDENCE → PARSE → VALIDATE → PREVIEW → CONFIRM → APPLY → VERIFY.
 * Ученик/родитель вставляет текст («Пн: 1 Алгебра 08:30-09:15 каб. 12») или JSON формата
 * sferumfocus.schedule.v1 → сервер разбирает и проверяет (app/schedule_feed.py) → превью «было → станет»
 * → только после «Сохранить» запись (атомарно, идемпотентно по token, с проверкой и откатом).
 * Без связи импорт честно недоступен: ничего не сохраняем «на потом» молча.
 */
import { useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/Toast";
import { api, ApiError, type ImportPreview } from "../lib/api";
import { dayTitle } from "../lib/time";

const EXAMPLE = "Понедельник\n1 Алгебра 08:30-09:15 каб. 21\n2 Русский язык 09:25-10:10\nВторник\n1 История 08:30-09:15";

export function ScheduleImport({ open, onClose, onApplied, hasImport }: { open: boolean; onClose: () => void; onApplied: () => void; hasImport: boolean }) {
  const [fmt, setFmt] = useState<"text" | "json">("text");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reset = () => { setPv(null); setErr(null); };
  const preview = async () => {
    if (!text.trim()) { setErr("Вставь расписание — текстом или JSON."); return; }
    setBusy(true); reset();
    try { setPv(await api.importPreview(text, fmt)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Не удалось разобрать — проверь связь."); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pv?.token) return;
    setBusy(true);
    try {
      const r = await api.importConfirm(pv.token);
      toast(r.repeat ? "Это расписание уже сохранено" : `Расписание сохранено · ${r.dates.length} дн.`, "ok");
      setText(""); reset(); onApplied();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? "Превью устарело — покажи изменения ещё раз." : e instanceof ApiError ? e.message : "Не сохранилось — ничего не изменено.");
    } finally { setBusy(false); }
  };
  const revert = async () => {
    setBusy(true);
    try { await api.importRevert(); toast("Вернул расписание из источника школы", "ok"); onApplied(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Не получилось — попробуй позже."); }
    finally { setBusy(false); }
  };
  const changed = pv?.days.filter((d) => d.changed) ?? [];
  return (
    <Sheet open={open} onClose={onClose} title="Добавить расписание" eyebrow="Импорт · с превью"
      footer={pv?.ok && pv.token
        ? <div class="stack"><button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} onClick={confirm} disabled={busy}><Icon name="check" />Сохранить расписание</button>
            <button class="btn btn-quiet btn-block" onClick={reset} disabled={busy}>Изменить текст</button></div>
        : <button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} onClick={preview} disabled={busy}><Icon name="calendar" />Показать, что изменится</button>}>
      <div class="imp l-v l-g3">
        <div class="imp-fmt l-h" role="radiogroup" aria-label="Формат">
          {(["text", "json"] as const).map((f) => (
            <button key={f} role="radio" aria-checked={fmt === f} class={`chip${fmt === f ? " on" : ""}`} onClick={() => { setFmt(f); reset(); }}>{f === "text" ? "Текст" : "JSON v1"}</button>
          ))}
        </div>
        {!pv && (
          <>
            <label class="sr" for="imp-ta">Расписание</label>
            <textarea id="imp-ta" class="imp-ta f-b b-tile l-w100" rows={8} value={text} placeholder={fmt === "text" ? EXAMPLE : '{"format":"sferumfocus.schedule.v1","days":[...]}'}
              onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); setErr(null); }} />
            <p class="hint-text">{fmt === "text" ? "День недели или дата, ниже — уроки: номер, предмет, время, кабинет. Я покажу, что понял, прежде чем сохранить." : "Формат sferumfocus.schedule.v1 — его отдаёт подключаемый источник школы."}</p>
          </>
        )}
        {err && <div class="note bad" role="alert"><Icon name="alert" /><div>{err}</div></div>}
        {pv && (
          <div class="imp-pv" role="status">
            {pv.errors.length > 0 && <div class="note bad"><Icon name="alert" /><div><b>Не сохраню — есть ошибки.</b><ul class="tips f-b f-2 mt-1">{pv.errors.map((x) => <li key={x}>{x}</li>)}</ul></div></div>}
            {pv.warnings.length > 0 && <ul class="tips f-b f-2 mt-1 imp-warn">{pv.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
            {pv.ok && <p class="imp-sum"><b>Изменится {changed.length} из {pv.days.length} дн.</b></p>}
            <ul class="imp-days l-v">
              {pv.days.map((d) => (
                <li key={d.date} class={d.changed ? "chg" : ""}>
                  <b>{dayTitle(d.date)}</b>
                  {d.changed && d.before.length > 0 && <span class="imp-was f-3">было: {d.before.join(", ")}</span>}
                  <span class="imp-now f-2">{d.changed ? "станет" : "без изменений"}: {d.after.length ? d.after.join(", ") : "нет уроков"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasImport && !pv && <button class="btn btn-quiet btn-block" onClick={revert} disabled={busy}><Icon name="refresh" />Вернуть расписание школы</button>}
      </div>
    </Sheet>
  );
}

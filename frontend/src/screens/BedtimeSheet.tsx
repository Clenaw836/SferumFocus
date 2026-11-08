/**
 * «Когда ты планируешь лечь?» — сон не постоянная настройка: рекомендация, «обычно» и «только сегодня».
 * Не просто сохраняем время, а сразу показываем, что это даёт плану (тот же планировщик, что на сервере).
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { haptic } from "../lib/host";
import { dur } from "../lib/time";
import { bedScale, latestHealthyBed } from "../lib/bedtime";
import { BED_MAX, BED_MIN, sleepSpan, stepTime, type SaveResult } from "../lib/sleep";

const STEP = 15;
// v16.1: без «заворота» через полночь (раньше 23:45 → 00:00 → план с отбоем раньше старта); границы — как в настройках
const shift = (t: string, d: number) => stepTime(t, d, BED_MIN, BED_MAX);

export function BedtimeSheet({ open, onClose, bed, wake, deficitAt, onSave }: {
  open: boolean; onClose: () => void; bed: { today: string | null; usual: string; recommended: string; effective: string }; wake: string;
  /** дефицит плана при данном отбое (минуты) — для честного «что это даёт» */
  deficitAt: (bed: string) => { deficit: number; free: number } | null;
  /** v16.1: возвращает результат записи — успех показываем только после подтверждённого сохранения */
  onSave: (time: string, scope: "today" | "usual") => SaveResult;
}) {
  const [t, setT] = useState(bed.effective);
  const [scope, setScope] = useState<"today" | "usual">("today");
  const [err, setErr] = useState<string | null>(null);
  // открытие = свежий черновик из сохранённого; закрытие без «Сохранить» ничего не применяет
  useEffect(() => { if (open) { setT(bed.effective); setScope("today"); setErr(null); } }, [open]);
  const cur = useMemo(() => (open ? deficitAt(bed.effective) : null), [open, bed.effective, deficitAt]);
  const nxt = useMemo(() => (open ? deficitAt(t) : null), [open, t, deficitAt]);
  const late = bedScale(t) > bedScale(latestHealthyBed(wake));
  let effect: string | null = null;
  if (cur && nxt && t !== bed.effective) {
    const gain = (cur.deficit - nxt.deficit) + (nxt.free - cur.free);
    if (nxt.deficit > 0) effect = `Даже до ${t} всё не помещается — не хватает ${dur(nxt.deficit)}. Лучше перенести часть на утро.`;
    else if (cur.deficit > 0) effect = `До ${t} всё помещается.`;
    else if (gain > 0) effect = `Теперь помещается ещё ${dur(gain)}.`;
    else if (gain < 0) effect = `Свободного времени станет меньше на ${dur(-gain)}.`;
  }
  return (
    <Sheet open={open} onClose={onClose} eyebrow="Отбой" title="Когда ты планируешь лечь?"
      footer={<button class="btn btn-primary btn-block" onClick={() => {
        const r = onSave(t, scope);
        if (r.ok) { haptic.notify("success"); setErr(null); } else { haptic.notify("error"); setErr(r.error); }   // значение в форме остаётся
      }}>Сохранить отбой</button>}>
      <div class="bt-dial l-h l-btw mt-2 mb-2">
        <button class="btn btn-secondary btn-sm" onClick={() => { setT(shift(t, -STEP)); haptic.select(); }} aria-label={`Раньше, ${shift(t, -STEP)}`}>← {shift(t, -STEP)}</button>
        <output class="bt-time f-xl f-tc num" aria-live="polite">{t}</output>
        <button class="btn btn-secondary btn-sm" onClick={() => { setT(shift(t, STEP)); haptic.select(); }} aria-label={`Позже, ${shift(t, STEP)}`}>{shift(t, STEP)} →</button>
      </div>
      <p class="faint bt-meta f-b f-tc mb-4">Рекомендуемый отбой — <b class="num">{bed.recommended}</b>{bed.usual !== bed.recommended ? <> · обычно <b class="num">{bed.usual}</b></> : null}</p>
      <p class="bt-span f-b f-2 f-tc mt-1 num">До подъёма в {wake} — <b>{dur(sleepSpan(t, wake))}</b> сна</p>
      <div class="bt-scope l-c2" role="radiogroup" aria-label="Насколько менять">
        {(["today", "usual"] as const).map((v) => (
          <label key={v} class={`radio${scope === v ? " on" : ""}`}><input type="radio" name="bt-scope" checked={scope === v} onChange={() => setScope(v)} />{v === "today" ? "Только сегодня" : "Обычно"}</label>
        ))}
      </div>
      {effect && <p class="note bt-effect mt-4" role="status"><Icon name="info" /><span>Ты переносишь сон с {bed.effective} на {t}. {effect}</span></p>}
      {err && <p class="bt-err p-23 l-h l-top f-b mt-3 r-sm u-bad-s" role="alert"><Icon name="alert" />{err}</p>}
      {late && <p class="hint-text">Позже {latestHealthyBed(wake)} сна будет меньше 8 часов до подъёма в {wake}. Решать тебе.</p>}
    </Sheet>
  );
}

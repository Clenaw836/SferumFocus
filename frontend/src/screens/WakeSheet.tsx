/**
 * v16.1 «Во сколько ты планируешь проснуться?» — редактор ПОДЪЁМА (раньше его не было: «Изменить»
 * рядом с подъёмом открывал отбой). Меняет только wakeTime (lib/sleep.saveWake), отбой не трогает.
 * Перед сохранением показывает, что изменится: сон (через полночь), утро до выхода и — если уже есть
 * задания, перенесённые на утро, — что перестанет помещаться. Такое изменение требует явного подтверждения.
 * Противоречивый интервал (подъём позже «выход − сборы») сохранить нельзя.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { haptic } from "../lib/host";
import { dur, toHHMM } from "../lib/time";
import { checkWake, stepTime, WAKE_MAX, WAKE_MIN, wakeImpact, type SaveResult } from "../lib/sleep";

const STEP = 15;
const shift = (t: string, d: number) => stepTime(t, d, WAKE_MIN, WAKE_MAX);

export function WakeSheet({ open, onClose, wake, serverWake, bed, leave, prep, morning, onSave }: {
  open: boolean; onClose: () => void;
  /** текущий подъём (сохранённый) и подъём из настроек школы */
  wake: string; serverWake: string;
  /** отбой сегодня — только для расчёта продолжительности сна */
  bed: string;
  /** выход из дома завтра (минуты) и сборы — граница для подъёма; null — расписания на завтра нет */
  leave: number | null; prep: number;
  /** задания, уже перенесённые на завтрашнее утро */
  morning: { title: string; minutes: number }[];
  onSave: (wake: string) => SaveResult;
}) {
  const [t, setT] = useState(wake);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (open) { setT(wake); setErr(null); setConfirm(false); } }, [open]);
  useEffect(() => { setConfirm(false); }, [t]);
  const chk = useMemo(() => checkWake(t, bed, leave, prep), [t, bed, leave, prep]);
  const imp = useMemo(() => wakeImpact(wake, t, leave, prep, morning), [wake, t, leave, prep, morning]);
  const changed = t !== wake;
  const needConfirm = changed && imp.changesPlan;
  const save = () => {
    if (chk.errors.length) { haptic.notify("error"); return; }
    if (needConfirm && !confirm) { setConfirm(true); haptic.notify("warning"); return; }
    const r = onSave(t);
    if (r.ok) { haptic.notify("success"); setErr(null); } else { haptic.notify("error"); setErr(r.error); }   // значение в форме остаётся
  };
  return (
    <Sheet open={open} onClose={onClose} eyebrow="Подъём" title="Во сколько ты планируешь проснуться?"
      footer={<button class="btn btn-primary btn-block" onClick={save} disabled={chk.errors.length > 0} aria-describedby={chk.errors.length ? "wk-err" : undefined}>
        {needConfirm && confirm ? "Да, сохранить подъём" : "Сохранить подъём"}</button>}>
      <div class="bt-dial l-h l-btw mt-2 mb-2">
        <button class="btn btn-secondary btn-sm" onClick={() => { setT(shift(t, -STEP)); haptic.select(); }} disabled={t === shift(t, -STEP)} aria-label={`Раньше, ${shift(t, -STEP)}`}>← {shift(t, -STEP)}</button>
        <output class="bt-time f-xl f-tc num" aria-live="polite" aria-label={`Подъём в ${t}`}>{t}</output>
        <button class="btn btn-secondary btn-sm" onClick={() => { setT(shift(t, STEP)); haptic.select(); }} disabled={t === shift(t, STEP)} aria-label={`Позже, ${shift(t, STEP)}`}>{shift(t, STEP)} →</button>
      </div>
      <p class="faint bt-meta f-b f-tc mb-4">По настройкам школы — <b class="num">{serverWake}</b>{leave !== null ? <> · завтра выход в <b class="num">{toHHMM(leave)}</b></> : <> · расписания на завтра нет</>}</p>
      <p class="bt-span f-b f-2 f-tc mt-1 num">Отбой в {bed} → подъём в {t}: <b>{dur(chk.sleep)}</b> сна</p>
      {imp.after !== null && changed && <p class="note bt-effect mt-4" role="status"><Icon name="info" /><span>Утром до выхода: {dur(imp.before ?? 0)} → <b>{dur(imp.after)}</b>.</span></p>}
      {imp.overflow.length > 0 && changed && (
        <p class={`note bt-effect mt-4${needConfirm ? " warn" : ""}`} role="status"><Icon name="alert" />
          <span>На утро уже перенесено {dur(imp.load)}. С подъёмом в {t} не поместится: {imp.overflow.join(", ")}. Расписание утра пересчитается — задания останутся в списке, но времени до выхода не хватит.</span></p>
      )}
      {needConfirm && confirm && <p class="bt-confirm f-b f-warn mt-3" role="alert">Нажми ещё раз, чтобы сохранить подъём и пересчитать утро.</p>}
      {chk.errors.map((e) => <p key={e} id="wk-err" class="bt-err p-23 l-h l-top f-b mt-3 r-sm u-bad-s" role="alert"><Icon name="alert" />{e}</p>)}
      {chk.warnings.map((w) => <p key={w} class="hint-text">{w} Решать тебе.</p>)}
      {err && <p class="bt-err p-23 l-h l-top f-b mt-3 r-sm u-bad-s" role="alert"><Icon name="alert" />{err}</p>}
    </Sheet>
  );
}

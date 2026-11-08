/**
 * v18: применение результата «Успею ли?» к состоянию вечера — вынесено из main.tsx.
 * Зависимости передаются явно (без глобального состояния), поэтому логика проверяема отдельно.
 * Откат («Отменить» в тосте) есть для сдвига старта и сна; режим спасения откатывается штатно через план.
 *
 * v18.1 (D-03/D-11): откат восстанавливает СЫРЫЕ значения «только сегодня» (нет override → после отмены его нет,
 * а не «15:30»/«22:00»), сон сохраняется с проверкой (ошибка → ничего не применено, без ложного «план обновлён»),
 * устаревшее «Отменить» (после него вечер уже менялся) ничего не перетирает, реплика отменённого действия убирается.
 */
import { events } from "./events";
import { haptic } from "./host";
import { toast as realToast } from "../ui/Toast";
import type { SaveResult } from "./sleep";
import type { Rescue } from "./survival";
import type { Option, WhatIf } from "./whatif";

/** Сырые значения дня: null — «не задано» (действует обычное/рекомендованное). log — журнал отбоя за сегодня. */
export interface Overrides { start: string | null; bed: string | null; log: string | null }

export interface ApplyDeps {
  start: string; bedtime: string;
  late: (startAt: string, minutes?: number) => void;
  /** at — старт, от которого считать реплику (старт мог только что измениться в этом же действии) */
  saveBed: (t: string, scope: "today" | "usual", at?: string) => SaveResult;
  applyRescue: (r: Rescue, o?: { overflow?: boolean; keepSleep?: boolean }) => void;
  overrides: () => Overrides;
  restore: (o: Overrides) => void;
  rebuild: () => void;
  /** id последней показанной реплики помощника; dropReply убирает её, только если она всё ещё на экране */
  lastReply: () => string | null;
  dropReply: (id: string) => void;
  toast?: typeof realToast;
}

const same = (a: Overrides, b: Overrides) => a.start === b.start && a.bed === b.bed && a.log === b.log;
export const UNDO_STALE = "Отменить уже нельзя: вечер изменился после этого.";
let gen = 0;   // номер последнего применения — «Отменить» действует только для него

export const makeApplyWhatIf = (d: ApplyDeps) => (w: WhatIf, o: Option | null) => {
  const toast = d.toast ?? realToast;
  const before = d.overrides(), replyBefore = d.lastReply();
  const ownReply = () => { const id = d.lastReply(); return id !== null && id !== replyBefore ? id : null; };
  const bed = o?.id === "bed" && o.bedtime ? o.bedtime : w.change.kind === "bed" ? w.after.bedtime : null;
  if (w.change.kind === "late") d.late(w.after.start, w.change.minutes);
  if (bed !== null) {
    const saved = d.saveBed(bed, "today", w.after.start);
    if (!saved.ok) {   // всё или ничего: старт этого же действия тоже возвращаем
      d.restore(before);
      const id = ownReply(); if (id) d.dropReply(id);
      d.rebuild(); haptic.notify("error");
      toast(saved.error, "bad");
      return;
    }
  }
  if (o?.id === "rescue" && o.rescue) d.applyRescue(o.rescue, { overflow: o.rescue.mode === "critical" });
  events.emit("WHATIF_APPLIED", { change: w.label, option: o?.id ?? null, deficit: w.after.deficit });
  haptic.notify("success");
  const my = ++gen, after = d.overrides(), reply = ownReply();
  const undo = o?.id === "rescue" ? undefined : { label: "Отменить", run: () => {
    if (my !== gen || !same(d.overrides(), after)) { toast(UNDO_STALE, "info"); return; }
    gen++;
    d.restore(before);
    if (reply) d.dropReply(reply);
    d.rebuild();
  } };
  toast(`${w.label}${o ? ` · ${o.title.toLowerCase()}` : ""} — план обновлён`, "ok", undo);
};

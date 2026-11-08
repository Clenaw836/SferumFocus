/**
 * Плашка активной фокус-сессии над доком: таймер живёт, даже если экран задания закрыт
 * или открыта другая вкладка. Тап → обратно к таймеру. Здесь же — единственное место,
 * где срабатывает «время вышло» (вибрация + тост ровно один раз, и после refresh тоже).
 */
import { useEffect } from "preact/hooks";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { haptic } from "../lib/host";
import { breakLeftSec, elapsedMs, focus, mmss, taskLeftSec, useFocusSession, useSecondClock } from "../lib/focus";
import { splitTitle, subjectColor } from "../lib/subjects";

export function FocusDock({ hidden, onOpen }: { hidden: boolean; onOpen: (title: string) => void }) {
  const s = useFocusSession();
  const now = useSecondClock(!!s && (s.pausedAt === null || !!s.breakAt));
  const el = s ? Math.floor(elapsedMs(s, now) / 1000) : 0;
  const resting = !!s?.breakAt;
  const bLeft = s && resting ? breakLeftSec(s, now) : 0;
  const over = !!s && !resting && el >= s.plannedSec;
  useEffect(() => {
    if (s && over && !s.expiredSeen) {
      focus.markExpiredSeen();
      haptic.notify("warning");
      toast(s.pomo && taskLeftSec(s) > 0 ? `Помидор готов — перерыв 5 минут` : `Время на «${splitTitle(s.title).subject}» вышло — заканчивай без спешки`, "info");
    }
  }, [over, s?.expiredSeen]);
  useEffect(() => {
    if (s && resting && bLeft === 0 && !s.breakSeen) { focus.markBreakSeen(); haptic.notify("success"); toast("Перерыв окончен — следующий помидор", "info"); }
  }, [resting, bLeft === 0, s?.breakSeen]);
  if (!s || hidden) return null;
  const subject = splitTitle(s.title).subject;
  const paused = s.pausedAt !== null && !resting;
  const st = resting ? (bLeft ? "Перерыв" : "Отдых окончен") : over ? "Время вышло" : paused ? "Пауза" : "В работе";
  return (
    <button class={`fdock${resting ? " rest" : over ? " over" : paused ? " paused" : ""}`} style={{ "--c": subjectColor(s.title) }} onClick={() => onOpen(s.title)}
      aria-label={`${st}: ${subject}. Открыть таймер`}>
      <i class="fdock-dot" aria-hidden="true" />
      <span class="fdock-t">{st} · <b>{subject}</b></span>
      <span class="fdock-n num" aria-hidden="true">{resting ? mmss(bLeft) : over ? `+${mmss(el - s.plannedSec)}` : mmss(s.plannedSec - el)}</span>
      <Icon name="chevron" />
    </button>
  );
}

/**
 * v2.2 · «Пиксельное» уведомление о новой выдаче учителя → пилюля наверху «Вечера».
 *
 *  • Тост (вместо общего): изумрудный #10B981/#059669 на #091914, моноширинный заголовок
 *    «[ НОВОЕ ЗАДАНИЕ ОТ УЧИТЕЛЯ ]», ступенчатые «пиксельные» углы (clip-path, без картинок).
 *  • Через 4 с (или свайпом вверх, или «Позже») тост сворачивается в пилюлю наверху экрана «Вечер»:
 *    «+1 задание от учителя · Алгебра (Блиц) → Приступить». Пока палец/фокус на тосте — таймер стоит.
 *  • Пилюля — только серверные факты: выдачи без seen_at (isHwNew); гаснет, когда ученик открыл задание
 *    (seen_at ставит сервер — учитель видит то же самое). Ничего не придумывается и не «догоняется».
 *  • prefers-reduced-motion / «Повышенная различимость»: без полёта и пружин — просто появление/скрытие.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { HwNotice } from "../lib/hwNotify";
import { hwInfos, isHwNew, useHw } from "../lib/hwSync";
import { plural } from "../lib/time";
import { Icon } from "./Icon";

export const HW_PIXEL_MS = 4000;
interface Notice { fresh: HwNotice[]; open: () => void; text: string; at: number }
let notice: Notice | null = null;
const subs = new Set<() => void>();

/** Показать уведомление (lib/hwNotify → App.announce). Повторный вызов заменяет текущее. */
export function showHwPixel(fresh: readonly HwNotice[], open: () => void, text: string): void {
  notice = { fresh: [...fresh], open, text, at: Date.now() };
  subs.forEach((f) => f());
}

const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11y === "1"; } catch { return true; } };
const kindLabel = (k: string | null | undefined) => (k === "quiz" ? "Блиц" : "ДЗ");

/** Pure: строка пилюли по серверным фактам (новейшая непросмотренная выдача + их число). */
export function pillText(list: readonly { subject?: string | null; kind?: string | null; issued_at?: string | null }[]): string {
  const n = list.length;
  if (!n) return "";
  const i = [...list].sort((a, b) => (b.issued_at ?? "").localeCompare(a.issued_at ?? ""))[0];
  return `+${n} ${plural(n, "задание", "задания", "заданий")} от учителя · ${n > 1 ? "последнее: " : ""}${i.subject || "Предмет"} (${kindLabel(i.kind)})`;
}

export function HwPixelToast() {
  const [n, setN] = useState<Notice | null>(null);
  const [held, setHeld] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const y0 = useRef<number | null>(null);
  const gone = useRef(false);
  useEffect(() => { const f = () => { gone.current = false; setHeld(false); setN(notice); }; subs.add(f); return () => { subs.delete(f); }; }, []);

  const finish = (pill: HTMLElement | null) => {
    notice = null; setN(null);
    if (pill && !reduced()) { pill.classList.add("is-arrive"); window.setTimeout(() => pill.classList.remove("is-arrive"), 700); }
  };
  const collapse = () => {
    const el = ref.current;
    if (!el || gone.current) return;
    gone.current = true;
    const pill = document.querySelector<HTMLElement>(".hw-pill");
    if (reduced()) { finish(pill); return; }
    const a = el.getBoundingClientRect(), b = pill?.getBoundingClientRect();
    const visible = !!b && b.width > 0 && b.bottom > 0 && b.top < innerHeight;
    el.style.transformOrigin = "top left";
    el.style.transform = visible
      ? `translate3d(${Math.round(b!.left - a.left)}px,${Math.round(b!.top - a.top)}px,0) scale(${(b!.width / a.width).toFixed(3)},${(b!.height / a.height).toFixed(3)})`
      : `translate3d(0,${-Math.round(a.bottom + 8)}px,0)`;
    el.classList.add("is-collapse");
    window.setTimeout(() => finish(visible ? pill! : null), 320);
  };
  useEffect(() => {
    if (!n || held) return;
    const t = window.setTimeout(collapse, HW_PIXEL_MS);
    return () => window.clearTimeout(t);
  }, [n?.at, held]);
  if (!n || !n.fresh.length) return null;
  const i = n.fresh[0];
  const many = n.fresh.length > 1;
  const open = () => { gone.current = true; notice = null; setN(null); n.open(); };
  return <div ref={ref} class="hwpx l-mx u-acc-bg" role="status" aria-live="polite" data-kind={i.kind === "quiz" ? "quiz" : "task"}
    onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocusIn={() => setHeld(true)} onFocusOut={() => setHeld(false)}
    onPointerDown={(e) => { y0.current = e.clientY; setHeld(true); }}
    onPointerMove={(e) => { if (y0.current === null || reduced()) return; const dy = Math.min(0, e.clientY - y0.current); if (ref.current) ref.current.style.transform = `translate3d(0,${dy}px,0)`; }}
    onPointerUp={(e) => { const dy = y0.current === null ? 0 : e.clientY - y0.current; y0.current = null; if (dy < -24) collapse(); else { if (ref.current) ref.current.style.transform = ""; if (e.pointerType !== "mouse") setHeld(false); } }}
    onPointerCancel={() => { y0.current = null; if (ref.current) ref.current.style.transform = ""; setHeld(false); }}>
    <div class="hwpx-in l-v l-g1 b-card b-nob">
      <p class="hwpx-tag f-c f-w6 f-a f-num" aria-hidden="true">[ НОВОЕ ЗАДАНИЕ ОТ УЧИТЕЛЯ ]</p>
      <p class="sr">{n.text}</p>
      <p class="hwpx-title f-s" aria-hidden="true">{i.title}</p>
      <p class="hwpx-meta f-m f-num" aria-hidden="true">{i.kind === "quiz" ? "Блиц-опрос" : "Задание"} от учителя{i.teacher_name ? ` · ${i.teacher_name}` : ""}{many ? ` · ещё ${n.fresh.length - 1}` : ""}</p>
      <div class="hwpx-acts l-h mt-2">
        <button type="button" class="hwpx-go px-4 f-b f-w6 b-tap u-acc bd-0" onClick={open}>Открыть</button>
        <button type="button" class="hwpx-later px-4 f-b f-w6 b-tap u-acc-s bd-0" onClick={collapse}>Позже</button>
      </div>
    </div>
  </div>;
}

/** Пилюля наверху «Вечера»: есть непросмотренные выдачи учителя → одно действие «Приступить». */
export function HwPill({ onOpen }: { onOpen: (issueId: string) => void }) {
  useHw();
  const fresh = hwInfos().filter(isHwNew).sort((a, b) => (b.issued_at ?? "").localeCompare(a.issued_at ?? ""));
  if (!fresh.length) return null;
  const text = pillText(fresh);
  return <div class="hw-pill l-h b-pill b-tap mb-3 u-acc-s" role="group" aria-label={text}>
    <span class="hw-pill-dot l-fix r-xs u-acc-bg" aria-hidden="true" />
    <span class="hw-pill-text f-b f-w6 l-grow">{text}</span>
    <button type="button" class="hw-pill-go l-h l-inl l-g1 f-b f-w6 b-pill b-tap l-fix u-acc bd-0" onClick={() => onOpen(fresh[0].issue_id)}>Приступить<Icon name="chevron" /></button>
  </div>;
}

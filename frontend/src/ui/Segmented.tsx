/**
 * Сегментированный переключатель. Адаптация 21st.dev «Segmented Tabs» (micka_design):
 * взяли паттерн скользящего «бегунка» с пружинной анимацией и семантику tablist.
 * НЕ взяли: framer-motion, Base UI, fluid-hover под курсор (на телефоне курсора нет).
 * Бегунок двигается CSS-transform — без перерисовок, 60 fps даже на слабых Android.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon";
import { haptic } from "../lib/host";

interface Opt<T extends string> { value: T; label: string; disabled?: boolean; icon?: string }

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Opt<T>[]; onChange: (v: T) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  useLayoutEffect(() => {
    const root = ref.current; if (!root) return;
    const buttons = root.querySelectorAll<HTMLButtonElement>("button");
    const btn = buttons[idx];
    const thumb = root.querySelector<HTMLElement>(".seg-thumb");
    let frame = 0;
    const measure = () => {
      if (!btn || !thumb || !btn.getClientRects().length) return;
      const width = `${btn.offsetWidth}px`, transform = `translateX(${btn.offsetLeft - 3}px)`;
      if (thumb.style.width !== width) thumb.style.width = width;
      if (thumb.style.transform !== transform) thumb.style.transform = transform;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    // Container changes, text reflow and hide/show do not necessarily resize the window.
    const observer = new ResizeObserver(schedule);
    observer.observe(root); buttons.forEach(button => observer.observe(button));
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [idx, options.length]);

  const onKey = (e: KeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const enabled = options.filter(o => !o.disabled);
    if (!enabled.length) return;
    const at = enabled.findIndex(o => o.value === value);
    const next = e.key === "Home" ? enabled[0] : e.key === "End" ? enabled[enabled.length - 1]
      : enabled[(Math.max(0, at) + (e.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
    const previous = document.activeElement;
    onChange(next.value); haptic.select();
    // Study changes its surrounding screen. Its new tablist must receive focus,
    // not a disconnected old button; do not steal focus from a subsequent action.
    queueMicrotask(() => {
      if (document.activeElement !== previous && document.activeElement !== document.body) return;
      const lists = Array.from(document.querySelectorAll<HTMLElement>('.seg[role="tablist"]')).filter(el => el.getAttribute("aria-label") === label);
      const current = ref.current?.isConnected ? ref.current : lists.length === 1 ? lists[0] : null;
      current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };

  return (
    <div ref={ref} class="seg" role="tablist" aria-label={label} onKeyDown={onKey}>
      <span class="seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} tabIndex={o.value === value ? 0 : -1} disabled={o.disabled}
          onClick={() => { if (o.value !== value) { onChange(o.value); haptic.select(); } }}>
          {o.icon && <Icon name={o.icon} />}{o.label}
        </button>
      ))}
    </div>
  );
}

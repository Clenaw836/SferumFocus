import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Icon } from "./Icon";
import { observeActiveSheet } from "./Sheet";
import { createToastTimers } from "../lib/toastTimers";
export type ToastKind = "ok" | "bad" | "warn" | "info";
type Action = { label: string; run: () => void };
type T = { id: number; text: string; kind: ToastKind; action?: Action };
let push: ((t: T) => void) | null = null;
let seq = 0;
const pending: T[] = [];
export const toast = (
  text: string,
  kind: ToastKind = "info",
  action?: Action,
) => {
  const t = { id: ++seq, text, kind, action };
  if (push) push(t);
  else {
    pending.push(t);
    if (pending.length > 8) pending.shift();
  }
};
export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const timers = useMemo(
    () =>
      createToastTimers((id) =>
        setItems((xs) => xs.filter((x) => x.id !== id)),
      ),
    [],
  );
  const observed = useRef(new Set<number>());
  const duration = (t: T) =>
    t.action ? 12000 : t.kind === "bad" ? 6000 : 4000;
  const dismiss = (id: number) => {
    timers.pause(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  };
  useEffect(() => observeActiveSheet(setSheet), []);
  // R-09: a floating toast reserves its own height at the bottom of the page (--toast-h → .app padding and
  // scroll-padding), so the end of the plan can always be scrolled above it and a focused control is never
  // hidden underneath (WCAG 2.4.11). Inside a sheet the toast is static and reserves nothing.
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = wrap.current;
    if (sheet || !items.length || !el) { root.style.removeProperty("--toast-h"); return; }
    const set = () => root.style.setProperty("--toast-h", `${Math.ceil(el.getBoundingClientRect().height) + 12}px`);
    set();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(set);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty("--toast-h"); };
  }, [sheet, items]);
  useEffect(() => {
    const receive = (t: T) => {
      setItems((xs) => [...xs.slice(-1), t]);
    };
    push = receive;
    pending.splice(0).slice(-2).forEach(receive);
    return () => {
      if (push === receive) push = null;
      timers.dispose();
    };
  }, []);
  useEffect(() => {
    const ids = new Set(items.map((t) => t.id));
    timers.retain(ids);
    for (const t of items) {
      if (!observed.current.has(t.id)) timers.arm(t.id, duration(t));
    }
    observed.current = ids;
  }, [items]);
  const ico = {
    ok: "check",
    bad: "alert",
    warn: "alert",
    info: "info",
  } as const;
  const content = (
    <div
      ref={sheet ? undefined : wrap}
      class={`toast-wrap${sheet ? " toast-in-sheet" : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {(sheet ? items.slice(-1) : items).map((t) => (
        <div
          key={t.id}
          class={`toast ${t.kind}`}
          onMouseEnter={() => {
            // Plain floating information must not pin itself over a target
            // merely because the user tries to click that underlying target.
            if (sheet || t.action) timers.pause(t.id);
          }}
          onMouseLeave={() => {
            if (!document.activeElement?.closest(".toast"))
              timers.arm(t.id, duration(t));
          }}
          onFocusIn={() => timers.pause(t.id)}
          onFocusOut={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              timers.arm(t.id, duration(t));
          }}
        >
          <Icon name={ico[t.kind]} />
          <span
            class="toast-text"
            tabIndex={sheet ? 0 : undefined}
            role={sheet ? "region" : undefined}
            aria-label={sheet ? "Текст уведомления" : undefined}
          >
            {t.text}
          </span>
          {t.action && (
            <button
              class="toast-act"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            class="toast-close"
            aria-label="Закрыть уведомление"
            onClick={() => dismiss(t.id)}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
  return sheet && items.length
    ? createPortal(content, sheet.querySelector(".sheet-feedback") ?? sheet)
    : content;
}

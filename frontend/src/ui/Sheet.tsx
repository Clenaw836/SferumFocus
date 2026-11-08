/**
 * Bottom sheet. Адаптация 21st.dev «Drawer» (wensity, Base UI):
 * взяли паттерн — свайп-вниз для закрытия, ручка, backdrop с fade, анимация через
 * CSS-переменную смещения, motion-reduce. НЕ взяли: Base UI, Tailwind, tabler-icons,
 * side-drawers и snap-points — Mini App открывается на телефоне, лишние 40 KB не нужны.
 * Добавили: нативный «Назад» MAX, focus-trap, Esc, возврат фокуса, scroll-lock.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { bindBack } from "../lib/host";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
  onAfterClose?: () => void;
  title: string;
  eyebrow?: string;
  full?: boolean;
  footer?: ComponentChildren;
  children: ComponentChildren;
  /** запрет закрытия свайпом/фоном (например, идёт дуэль) — закрыть можно только кнопкой */
  sticky?: boolean;
  /** v2.2 · дополнительный класс листа (например, «is-projector» — показ опроса классу на весь экран) */
  variant?: string;
  /** v2.2: тело без кнопок внутри (экран «Показать классу») — фокусируемая область, чтобы его можно было прокрутить с клавиатуры (axe scrollable-region-focusable). */
  bodyFocusable?: boolean;
  /** v3.2 · обязательный экран (подключение дневника): нет крестика, Escape/«Назад»/фон/свайп не закрывают. */
  locked?: boolean;
  /** v3.2 · элемент шапки вместо крестика (например, капсула «Демо жюри» на обязательном экране). */
  headAction?: ComponentChildren;
}

/** Пока открыт лист, фон (экран, док, навигация) не доступен с клавиатуры и для скринридера. */
const sheetStack: HTMLElement[] = [];
const sheetObservers = new Set<(active: HTMLElement | null) => void>();
/** Feedback belongs to the active modal, so it remains exposed and cannot cover its CTA. */
export function observeActiveSheet(listener: (active: HTMLElement | null) => void): () => void {
  sheetObservers.add(listener); listener(sheetStack[sheetStack.length - 1] ?? null);
  return () => { sheetObservers.delete(listener); };
}
/** Only the top sibling dialog is interactive/exposed, including close animations. */
const syncSheetAccessibility = () => {
  const active = sheetStack[sheetStack.length - 1];
  sheetObservers.forEach(listener => listener(active ?? null));
  for (const sheet of sheetStack) {
    const root = sheet.closest(".sheet-root") as HTMLElement | null;
    const top = sheet === active;
    sheet.setAttribute("aria-modal", String(top));
    // Do not inert an ancestor of a genuinely DOM-nested active dialog.
    const blocked = !top && !root?.contains(active ?? null);
    root?.toggleAttribute("inert", blocked);
    if (blocked) root?.setAttribute("aria-hidden", "true");
    else root?.removeAttribute("aria-hidden");
  }
};
let openSheets = 0;
let originalOverflow = "";
const BG = ["#panel", ".tabbar", ".fdock", ".brand-bar"];
const setBgInert = (on: boolean) => BG.forEach((q) => document.querySelectorAll(q).forEach((el) => (on ? el.setAttribute("inert", "") : el.removeAttribute("inert"))));

/** Drag-to-dismiss on the grab handle: distance (px) or release velocity (px/ms) after FLICK_MIN px. */
const CLOSE_DISTANCE = 110, FLICK_MIN = 16, FLICK_VELOCITY = 0.11;

export function Sheet({ open, onClose, title, eyebrow, full, footer, children, sticky: sticky0, onAfterClose, variant, bodyFocusable, locked, headAction }: Props) {
  const sticky = sticky0 || locked;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y0: number; dy: number; t0: number } | null>(null);
  const lastFocus = useRef<Element | null>(null);
  const closeRef = useRef(onClose); closeRef.current = locked ? () => {} : onClose;
  const afterCloseRef = useRef(onAfterClose); afterCloseRef.current = onAfterClose;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (!mounted && wasOpen.current) {
      wasOpen.current = false;
      afterCloseRef.current?.();
    }
  }, [open, mounted]);


  useEffect(() => {
    if (open) {
      // v3.2: ленивая шторка монтируется сразу открытой — фон уже inert, фокус мог уйти на body; держим опенер.
      const active = document.activeElement;
      if (active && active !== document.body && !sheetRef.current?.contains(active)) lastFocus.current = active;
      setMounted(true);
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setShown(false);
    const sheet = sheetRef.current;
    // Match the rendered transition, including token changes and reduced motion.
    const css = sheet ? getComputedStyle(sheet) : null;
    const millis = (value: string) => value.split(",").map(v => parseFloat(v) * (v.trim().endsWith("ms") ? 1 : 1000));
    const duration = css ? Math.max(0, ...millis(css.transitionDuration)) + Math.max(0, ...millis(css.transitionDelay)) : 0;
    const finish = (e: TransitionEvent) => { if (e.target === sheet && e.propertyName === "transform") setMounted(false); };
    sheet?.addEventListener("transitionend", finish);
    // Fallback for a transition cancelled by hide/show or a sheet never painted open.
    const t = setTimeout(() => setMounted(false), duration + 50);
    return () => { clearTimeout(t); sheet?.removeEventListener("transitionend", finish); };
  }, [open]);

  // Install keyboard/inert ownership before the visible dialog can receive input.
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const active = document.activeElement;   // до inert: фокус ещё на кнопке, открывшей шторку
    if (active && active !== document.body && !sheet.contains(active)) lastFocus.current = active;
    sheetStack.push(sheet);
    syncSheetAccessibility();
    const top = () => sheetStack[sheetStack.length - 1] === sheet;
    const focusable = () => Array.from(sheet.querySelectorAll<HTMLElement>(
      'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]'
    )).filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[hidden], [inert]")
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    const first = () => focusable().find(el => el.hasAttribute("data-autofocus")) ?? focusable()[0] ?? sheet;
    const unbindBack = bindBack(() => { if (top()) closeRef.current(); });
    if (++openSheets === 1) { originalOverflow = document.body.style.overflow; setBgInert(true); }
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (!top()) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      if (e.key === "Tab") {
        e.preventDefault();
        const f = focusable(), i = f.indexOf(document.activeElement as HTMLElement);
        if (!f.length) { sheet.focus(); return; }
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };
    const onFocus = (e: FocusEvent) => { if (top() && !sheet.contains(e.target as Node)) first().focus(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    const timer = setTimeout(() => { if (top()) first().focus(); }, 60);
    return () => {
      unbindBack();
      const i = sheetStack.indexOf(sheet); if (i >= 0) sheetStack.splice(i, 1);
      // Keep the closing animation inaccessible; restore the next active dialog.
      const root = sheet.closest(".sheet-root");
      root?.setAttribute("inert", ""); root?.setAttribute("aria-hidden", "true");
      sheet.setAttribute("aria-modal", "false");
      syncSheetAccessibility();
      if (--openSheets === 0) { setBgInert(false); document.body.style.overflow = originalOverflow; }
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      clearTimeout(timer);
      const previous = lastFocus.current as HTMLElement | null;
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
      else sheetStack[sheetStack.length - 1]?.focus();
      lastFocus.current = null;
    };
  }, [open, mounted]);

  if (!mounted) return null;

  const setDrag = (px: number) => {
    // The sheet is centred by CSS (translate(-50%, var(--drag))). Writing an inline
    // `transform` replaced that rule and dropped the -50% X offset, so the sheet jumped
    // sideways while dragging. Only the custom property is driven from JS.
    const st = sheetRef.current?.style;
    if (!st) return;
    if (px > 0) st.setProperty("--drag", `${px}px`);
    else st.removeProperty("--drag");
  };
  const onDown = (e: PointerEvent) => {
    // Multi-touch protection (emil-design-eng): a second finger mid-drag must not restart the drag
    // from its own position — the sheet would jump. Only the pointer that started the drag moves it.
    if (sticky || drag.current) return;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, t0: e.timeStamp };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sheetRef.current?.classList.add("dragging");
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current.dy = e.clientY - drag.current.y0;
    setDrag(drag.current.dy);
  };
  const onUp = (id: number, cancelled = false, at = performance.now()) => {
    if (!drag.current || id !== drag.current.id) return;
    const { dy, t0 } = drag.current;
    drag.current = null;
    sheetRef.current?.classList.remove("dragging");
    // Momentum dismissal (emil-design-eng «Momentum-based dismissal»): a quick flick closes even
    // below the distance threshold. FLICK_MIN keeps a tap with finger jitter on the handle from closing.
    const v = dy / Math.max(1, at - t0);
    if (!cancelled && (dy > CLOSE_DISTANCE || (dy > FLICK_MIN && v > FLICK_VELOCITY))) onClose();
    setDrag(0);
  };

  return (
    <div class={`sheet-root${shown ? " open" : ""}`}>
      <div class="sheet-backdrop" onClick={sticky ? undefined : onClose} aria-hidden="true" />
      <div ref={sheetRef} class={`sheet${full ? " full" : ""}${variant ? ` ${variant}` : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div class="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(e.pointerId, false, e.timeStamp)} onPointerCancel={(e) => onUp(e.pointerId, true)} aria-hidden="true"><i /></div>
        <div class="sheet-head">
          <div>
            {eyebrow && <div class="eyebrow">{eyebrow}</div>}
            <h2 class="h-sec">{title}</h2>
          </div>
          {headAction}
          {!locked && <button class="icon-btn" onClick={onClose} aria-label="Закрыть"><Icon name="x" /></button>}
        </div>
        <div class="sheet-body" tabIndex={bodyFocusable ? 0 : undefined} role={bodyFocusable ? "region" : undefined} aria-label={bodyFocusable ? title : undefined}>{children}</div>
        <div class="sheet-feedback" />
        {footer && <div class="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

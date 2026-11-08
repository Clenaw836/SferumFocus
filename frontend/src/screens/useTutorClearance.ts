import { useEffect, useRef } from "preact/hooks";

/** Local to the Tutor page. Measure existing overlays; do not move global navigation/toasts. */
export function useTutorClearance() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const observed = new Set<Element>();
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(schedule);
    function measure() {
      frame = 0;
      if (!root) return;
      const vv = window.visualViewport;
      const top = vv?.offsetTop ?? 0;
      const bottom = top + (vv?.height ?? innerHeight);
      let freeBottom = bottom;
      const layers = new Set(document.querySelectorAll('.tabbar, .fdock, .toast-wrap'));
      for (const el of observed) if (!layers.has(el)) { ro.unobserve(el); observed.delete(el); }
      for (const el of layers) {
        if (!observed.has(el)) { ro.observe(el); observed.add(el); }
        const b = el.getBoundingClientRect();
        // v3.2: только нижние слои — в низком альбомном окне тосты уходят наверх (toast-wrap top) и не перекрывают поле
        if (b.height > 0 && b.top < bottom && b.bottom > top && b.top + b.bottom > top + bottom) freeBottom = Math.min(freeBottom, b.top);
      }
      const reserve = `${Math.ceil(Math.max(0, bottom - freeBottom) + 24)}px`;
      if (root.style.getPropertyValue('--tu-clearance') !== reserve) root.style.setProperty('--tu-clearance', reserve);
      const active = document.activeElement;
      const composer = root.querySelector('.composer');
      if (composer && active && composer.contains(active)) {
        const b = composer.getBoundingClientRect();
        // Native scrolling, no focus transfer and no smooth motion while typing.
        if (b.bottom > freeBottom - 16) window.scrollBy(0, b.bottom - freeBottom + 16);
        else if (b.top < top + 8) window.scrollBy(0, b.top - top - 8);
      }
    }
    const mo = new MutationObserver(schedule);
    const app = root.closest('.app') ?? document.getElementById('app');
    if (app) mo.observe(app, { childList: true, subtree: true });
    root.addEventListener('focusin', schedule);
    root.addEventListener('input', schedule);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame);
      root.removeEventListener('focusin', schedule); root.removeEventListener('input', schedule);
      window.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, []);
  return ref;
}

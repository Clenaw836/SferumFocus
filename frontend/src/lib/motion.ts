/**
 * Единая точка анимаций СферумФОКУС (решение владельца, этап 1: Motion + Anime.js обязательны).
 *
 * Правила (Design DNA v14):
 * - длительности только из CSS-токенов --d-fast/--d-mid/--d-slow (в design-system-core.css сейчас 160/280/520 мс; в доках DNA — 140/260/460,
 *   расхождение зафиксировано в docs/STAGE1_AUDIT.md), кривая expo-out (= --ease), пружина — только у награды;
 * - prefers-reduced-motion → анимация сразу ставит конечное состояние (без движения), промис резолвится;
 * - анимировать только transform/opacity (без layout-скачков на слабых Android);
 * - экраны НЕ импортируют 'motion'/'animejs' напрямую — только этот модуль (контроль размера бандла и единые правила).
 *
 * Библиотеки:
 * - Motion `motion/mini` (~3.4 КБ gzip, WAAPI, аппаратное ускорение) — переходы состояний, появление, обратная связь.
 * - Anime.js v4 (~15 КБ gzip, tree-shaking) — сложные хореографии: stagger, таймлайны, счётчики, награды.
 * Полный `motion` (~20 КБ gzip, spring/scroll) подключать только при доказанной необходимости.
 */
import { animate as waapi } from "motion/mini";
import { animate as anime, createTimeline, stagger, createSpring } from "animejs";

type Speed = "fast" | "mid" | "slow";
const FALLBACK_MS: Record<Speed, number> = { fast: 160, mid: 280, slow: 520 }; // = design-system-core.css :root
/** Длительность из CSS-токена (единый источник правды), мс. */
export function durMs(speed: Speed): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return FALLBACK_MS[speed];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--d-${speed}`).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? (raw.endsWith("ms") ? n : n * 1000) : FALLBACK_MS[speed];
}
export const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]; // = --ease
export const EASE_OUT_CSS = "cubic-bezier(.23,1,.32,1)";

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Target = Element | Element[] | NodeListOf<Element> | string;
type Keyframes = Record<string, string | number | (string | number)[]>;

const toEls = (t: Target): Element[] =>
  typeof t === "string" ? Array.from(document.querySelectorAll(t)) : t instanceof Element ? [t] : Array.from(t);

/** Ставит конечные значения кадров без анимации (reduced motion). */
function settle(t: Target, kf: Keyframes): void {
  for (const el of toEls(t)) {
    const s = (el as HTMLElement).style;
    if (!s) continue;
    for (const [k, v] of Object.entries(kf)) {
      const last = Array.isArray(v) ? v[v.length - 1] : v;
      if (k === "x" || k === "y") s.transform = `translate${k.toUpperCase()}(${typeof last === "number" ? `${last}px` : last})`;
      else if (k === "scale") s.transform = `scale(${last})`;
      else s.setProperty(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(last));
    }
  }
}

/** Переход состояния (Motion mini / WAAPI). Возвращает промис завершения. */
export function transition(t: Target, kf: Keyframes, speed: Speed = "mid", delay = 0): Promise<void> {
  if (reducedMotion() || toEls(t).length === 0) { settle(t, kf); return Promise.resolve(); }
  const kfs = { ...kf } as Record<string, unknown>;
  for (const k of ["x", "y"] as const) if (k in kfs) { const v = kfs[k] as number | number[]; kfs.transform = (Array.isArray(v) ? v : [v]).map((n) => `translate${k.toUpperCase()}(${n}px)`); delete kfs[k]; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctl = waapi(t as any, kfs as any, { duration: durMs(speed) / 1000, ease: EASE_OUT, delay });
  return Promise.resolve(ctl).then(() => undefined, () => undefined);
}

/** Каскадное появление списка (Anime.js stagger). */
export function revealList(t: Target, step = 40): Promise<void> {
  if (reducedMotion() || toEls(t).length === 0) { settle(t, { opacity: 1, y: 0 }); return Promise.resolve(); }
  const a = anime(toEls(t), { opacity: [0, 1], translateY: [8, 0], duration: durMs("slow"), ease: "outExpo", delay: stagger(step) });
  return a.then(() => undefined);
}

/** Награда — единственное место с пружиной (DNA v14). */
export function reward(t: Target): Promise<void> {
  if (reducedMotion() || toEls(t).length === 0) return Promise.resolve();
  const a = anime(toEls(t), { scale: [0.92, 1], ease: createSpring({ stiffness: 260, damping: 18 }) });
  return a.then(() => undefined);
}

/** Плавный счётчик числа (например, минуты/очки). */
export function countTo(el: Element, from: number, to: number, format: (n: number) => string = (n) => String(Math.round(n))): Promise<void> {
  if (reducedMotion()) { el.textContent = format(to); return Promise.resolve(); }
  const o = { v: from };
  const a = anime(o, { v: to, duration: durMs("slow"), ease: "outExpo", onUpdate: () => { el.textContent = format(o.v); } });
  return a.then(() => undefined);
}

export { createTimeline, stagger };

/**
 * v16 Модель света живой сцены (чистые функции, без DOM): время → положение солнца/луны и палитра.
 * Восход/закат — ПРИБЛИЖЕНИЕ для средней полосы (~55° с. ш.) по дню года: астрономической точности
 * без координат не изображаем (координаты не запрашиваем). Палитра непрерывна по времени — нет скачков
 * в полночь, при возврате в приложение цвета доезжают CSS-переходом.
 */
export interface Light {
  /** −1 глубокая ночь … 0 горизонт … 1 полдень */
  p: number;
  /** доля дня (0 восход … 1 закат) или ночи; side — какое светило на небе */
  side: "sun" | "moon";
  t: number;
  rise: number; set: number;
  sky: [string, string, string];
  hillFar: string; firFar: string; hillMid: string; firMid: string; field: string; firNear: string;
  cloud: string; cloudA: number; starA: number; glowA: number; warm: number;
}
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const mix = (a: string, b: string, k: number) => { const x = hex(a), y = hex(b); return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * k) as RGB); };
const KEYS = ["s0", "s1", "s2", "hillFar", "firFar", "hillMid", "firMid", "field", "firNear", "cloud"] as const;
type Pal = Record<(typeof KEYS)[number], string>;
const P = (a: string[]): Pal => Object.fromEntries(KEYS.map((k, i) => [k, a[i]])) as Pal;
const DAY = P(["#3573b3", "#5e9bd2", "#a6cfec", "#3a6577", "#28525c", "#2c5a47", "#1d4434", "#3b7442", "#10291c", "#eef3fa"]);
const DUSK = P(["#1a1838", "#4a2f55", "#e0874f", "#4a3346", "#2f2233", "#2c2230", "#1f1824", "#3a2a22", "#120c12", "#f0a27a"]);
const DAWN = P(["#141a36", "#3a3d66", "#c9a08a", "#3b4258", "#262c40", "#232a36", "#1a2029", "#26332c", "#0e1218", "#d9c3c8"]);
const NIGHT = P(["#04050b", "#0a0e22", "#18203f", "#141a2c", "#0e1322", "#0d1220", "#0a0e19", "#0d1418", "#06080e", "#3a4466"]);
const mixPal = (a: Pal, b: Pal, k: number): Pal => Object.fromEntries(KEYS.map((x) => [x, mix(a[x], b[x], k)])) as Pal;

/** День года 1…366 из ISO-даты. */
export function doy(iso: string): number {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
}
/** Приближённые восход/закат (минуты местного времени) для средней полосы. */
export function sunTimes(iso: string): { rise: number; set: number } {
  const c = Math.cos((2 * Math.PI * (doy(iso) - 172)) / 365);
  return { rise: Math.round(382 - 157 * c), set: Math.round(1120 + 160 * c) };
}
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const TW = 75;   // сумерки, мин

export function light(minute: number, iso: string): Light {
  const m = ((minute % 1440) + 1440) % 1440;
  const { rise, set } = sunTimes(iso);
  let p: number, side: Light["side"], t: number, evening: boolean;
  if (m >= rise && m <= set) {
    side = "sun"; t = (m - rise) / (set - rise);
    p = Math.sin(Math.PI * t); evening = t > 0.5;
  } else {
    side = "moon";
    const len = 1440 - (set - rise);
    const since = m > set ? m - set : m + 1440 - set;
    t = since / len;
    const near = Math.min(since, len - since);
    p = -clamp(near / TW); evening = since < len / 2;
  }
  const tw = evening ? DUSK : DAWN;
  const pal = p >= 0 ? mixPal(tw, DAY, Math.pow(clamp(p * 1.35), 0.7)) : mixPal(tw, NIGHT, Math.pow(-p, 0.8));
  const warm = p >= 0 && evening ? clamp(1 - p * 2.2) : p < 0 && evening ? clamp(1 + p * 1.6) : 0;
  return {
    p, side, t, rise, set,
    sky: [pal.s0, pal.s1, pal.s2],
    hillFar: pal.hillFar, firFar: pal.firFar, hillMid: pal.hillMid, firMid: pal.firMid, field: pal.field, firNear: pal.firNear,
    cloud: pal.cloud, cloudA: p >= 0 ? 0.32 + 0.22 * p : 0.32 + 0.14 * p,
    starA: p < 0 ? clamp(-p * 1.2) * 0.9 : 0, glowA: p >= 0 ? 0.25 + 0.35 * (1 - p) : 0.2 * clamp(-p * 3), warm,
  };
}
/** Верхняя граница светила во viewBox: ниже шапки (аватар, дата, чипы ≈ 0–72 px) и выше подписи героя (≈ 118 px).
 *  v17: раньше апогей был y=56 — в 13:00 солнце, а в 23:00 луна наезжали на текст шапки. Дугу «срезаем» сверху. */
export const ORBIT_TOP = 92;
/** Позиция светила на дуге во viewBox 400×320 (горизонт y=232); вершина дуги — не выше ORBIT_TOP. */
export function orbit(t: number): { x: number; y: number } {
  return { x: 36 + 328 * t, y: Math.max(ORBIT_TOP, 232 - 176 * Math.sin(Math.PI * clamp(t))) };
}
/** Детерминированный ГПСЧ (LCG) — расстановка деревьев/звёзд одинакова при каждом рендере. */
export function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
/** Ель в три яруса (контур), x — ось, y — земля. */
export function fir(x: number, y: number, h: number, w: number): string {
  const t = (k: number) => (y - h * k).toFixed(1), X = (k: number) => (x + w * k).toFixed(1);
  return `M${X(0)} ${t(1)}L${X(.3)} ${t(.68)}H${X(.15)}L${X(.42)} ${t(.38)}H${X(.22)}L${X(.5)} ${t(.07)}H${X(.06)}V${y}H${X(-.06)}V${t(.07)}H${X(-.5)}L${X(-.22)} ${t(.38)}H${X(-.42)}L${X(-.15)} ${t(.68)}H${X(-.3)}Z`;
}
export function forest(seed: number, n: number, y0: number, hMin: number, hMax: number, xFrom = -10, xTo = 410, jitterY = 6): string {
  const r = rng(seed); let d = "";
  for (let i = 0; i < n; i++) {
    const x = xFrom + ((xTo - xFrom) * (i + r() * 0.8)) / n, h = hMin + (hMax - hMin) * r();
    d += fir(x, y0 + r() * jitterY, h, h * (0.42 + r() * 0.12));
  }
  return d;
}

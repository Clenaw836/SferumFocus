/**
 * Светлая тема на этапе сборки. Берёт итоговый CSS бандла (тёмная тема — источник правды) и сразу после
 * каждого правила с цветами вставляет «близнеца» для :root[data-theme="light"] — в том же @media/@supports.
 * Близнец оборачивает корень в :where(), поэтому его специфичность равна исходной, а порядок каскада
 * сохраняется: всё, что перекрывало правило в тёмной теме, перекрывает его и в светлой.
 *
 * Цвета переводятся в OKLCH по роли свойства:
 *   текст (color/caret…)       светлый → тёмный, оттенок сохраняется; тёмный текст на ярких кнопках не трогаем;
 *   фон                         тёмные поверхности → светлые (приподнятые — ещё светлее), яркие заливки остаются;
 *   границы/обводки             тёмные линии → светлые, яркие (мятные, фокус) → глубокие, чтобы держать 3:1;
 *   тени                        мягче (альфа ×0.4), цветные свечения слабее;
 *   SVG fill/stroke             яркие — как текст, тёмные дорожки — как линии.
 * Не генерируются: пользовательские свойства (--*), url(...), @keyframes, @media print и правила, где уже есть
 * data-theme/data-a11y, — это ручной слой (секция @light-manual в src/design-system-core.css), который сборка ставит в самый конец.
 */
import { fromLch, hasColor, mapColors, scanCss, splitSelectors, toLch } from "./tools/css-color.mjs";

export const LIGHT_ATTR = '[data-theme="light"]';
const SCOPE = `:where(:root${LIGHT_ATTR})`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const achromatic = (C) => C < 0.035;

/** Selector list → light twin selector list (null: rule is theme-aware already). */
export function lightSelector(selector) {
  const out = [];
  for (const s of splitSelectors(selector)) {
    if (/data-theme|data-a11y/.test(s)) return null;
    if (/^:root(?![\w-])/.test(s)) out.push(`:root:where(${LIGHT_ATTR})${s.slice(5)}`);
    else if (/^html(?![\w-])/i.test(s)) out.push(`html:where(${LIGHT_ATTR})${s.slice(4)}`);
    else out.push(`${SCOPE} ${s}`);
  }
  return out.join(",");
}

// ------------------------------------------------------------------ colour roles
export function fgColor(c) {
  const { L, C, h } = toLch(c);
  if (L < 0.5) return null;                                   // already dark (text on bright fills)
  const a = c.a ?? 1;
  const L2 = achromatic(C) ? Math.max(0.24, 1.2 - L) : clamp(1.25 - L, 0.36, 0.52);
  return fromLch(L2, achromatic(C) ? Math.min(C, 0.02) : Math.min(C, 0.16), achromatic(C) ? 200 : h, a < 1 ? Math.min(1, a * 1.25 + 0.05) : 1);
}
export function bgColor(c) {
  const { L, C, h } = toLch(c);
  const a = c.a ?? 1;
  if (L >= 0.6) {
    if (a < 0.999 && achromatic(C)) return fromLch(0.3, 0.03, 210, Math.min(1, a * 0.9));   // white veil → teal-grey veil
    return null;                                                                            // bright fills & tints stay
  }
  if (L < 0.45) {
    if (C < 0.05) return fromLch(clamp(0.95 + (L - 0.17) * 0.5, 0.9, 1), Math.min(C, 0.008), 200, a);
    return fromLch(clamp(0.92 + (L - 0.17) * 0.2, 0.88, 0.96), Math.min(C * 0.5, 0.045), h, a);
  }
  return fromLch(Math.min(0.97, L + 0.35), Math.min(C, 0.08), h, a);
}
export function borderColor(c) {
  const { L, C, h } = toLch(c);
  const a = c.a ?? 1;
  if (a < 0.999) {
    if (L >= 0.6 && achromatic(C)) return fromLch(0.3, 0.03, 210, Math.min(1, a * 1.5));   // white hairline → dark hairline
    if (L >= 0.6) return fromLch(Math.min(0.55, 1.17 - L), C, h, Math.min(1, a * 1.3));     // mint/amber tint → deeper
    if (L < 0.3) return { ...c, a: a * 0.5 };
    return null;
  }
  if (L >= 0.6) return fromLch(achromatic(C) ? Math.max(0.35, 1.1 - L) : clamp(1.17 - L, 0.38, 0.55), C, h, 1);
  return fromLch(clamp(1.13 - L, 0.55, 0.88), Math.min(C, 0.025), C < 0.05 ? 200 : h, 1);
}
export function shadowColor(c) {
  const { L, C } = toLch(c);
  const a = c.a ?? 1;
  if (L < 0.3) return { ...c, a: a * 0.4 };
  if (achromatic(C) && L >= 0.9) return null;                 // white inset highlights
  return { ...c, a: a * 0.7 };
}

/** SVG shapes: bright strokes behave like text (darken), dark strokes are quiet tracks (lighten like lines). */
export function shapeColor(c) {
  return toLch(c).L < 0.45 ? borderColor(c) : fgColor(c);
}

const FG = new Set(["color", "fill", "stroke", "caret-color", "text-decoration-color", "text-decoration", "text-emphasis-color",
  "-webkit-text-fill-color", "-webkit-text-stroke-color", "column-rule-color", "scrollbar-color", "accent-color"]);
export function roleOf(prop) {
  const p = prop.toLowerCase();
  if (p.startsWith("--")) return null;
  if (p === "fill" || p === "stroke") return shapeColor;
  if (FG.has(p)) return fgColor;
  if (p === "background" || p.startsWith("background-")) return bgColor;
  if (p.startsWith("border") || p.startsWith("outline")) return borderColor;
  if (p === "box-shadow" || p === "text-shadow" || p === "-webkit-box-shadow") return shadowColor;
  return null;                                                // filter, mask, … stay as is
}

/** One declaration → light value, or null when unchanged / not ours. */
export function lightValue(prop, value) {
  const p = prop.toLowerCase();
  if (p === "color-scheme") return /\bdark\b/.test(value) ? value.replace(/\bdark\b/g, "light").replace(/\blight light\b/, "light") : null;
  const role = roleOf(p);
  if (!role || /url\(/i.test(value) || !hasColor(value)) return null;
  const v = mapColors(value, (c) => role(c));
  return v === value ? null : v;
}

/** Whole stylesheet → stylesheet with interleaved light twins. */
export function addLightTheme(css) {
  const inserts = [];
  let rules = 0, decls = 0;
  const visit = (nodes, skip) => {
    for (const n of nodes) {
      if (n.type === "at") { visit(n.children, skip || (n.name === "media" && /\bprint\b/i.test(n.prelude))); continue; }
      if (n.type !== "rule" || skip) continue;
      const sel = lightSelector(n.selector);
      if (!sel) continue;
      const body = [];
      for (const d of n.decls) { const v = lightValue(d.prop, d.value); if (v !== null) body.push(`${d.prop}:${v.trim()}`); }
      if (!body.length) continue;
      rules++; decls += body.length;
      inserts.push([n.end, `${sel}{${body.join(";")}}`]);
    }
  };
  visit(scanCss(css), false);
  inserts.sort((x, y) => x[0] - y[0]);
  let out = "", at = 0;
  for (const [pos, text] of inserts) { out += css.slice(at, pos) + text; at = pos; }
  out += css.slice(at);
  return { css: out, rules, decls };
}

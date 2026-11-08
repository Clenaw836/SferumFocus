/**
 * Цвет и CSS без зависимостей — общая основа для build-time светлой темы (light-theme.mjs)
 * и разовой перекраски под референс (recolor-reference.mjs).
 *
 *  - parseColor / formatColor: #rgb(a), #rrggbb(aa), rgb()/rgba() (запятые и «/»), hsl()/hsla(), white/black/transparent
 *  - toLch / fromLch: OKLCH (OKLab, Björn Ottosson) с уменьшением хромы до попадания в sRGB
 *  - mapColors(value, fn): заменяет цвета в значении CSS, не трогая url(...) и строки
 *  - scanCss(css): дерево правил с позициями объявлений (комментарии, строки, @media/@supports/@keyframes)
 */

// ------------------------------------------------------------------ color math
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function toOklab({ r, g, b }) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
}
function fromOklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const f = (x) => (x > 0 ? gam(x) : x);
  return { r: f(R), g: f(G), b: f(B) };
}
export function toLch(c) {
  const { L, a, b } = toOklab(c);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
const inGamut = (c, e = 1e-4) => [c.r, c.g, c.b].every((x) => x >= -e && x <= 1 + e);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** OKLCH → sRGB; hue and lightness are kept, chroma is reduced until the colour is displayable. */
export function fromLch(L, C, h, alpha = 1) {
  L = clamp01(L); C = Math.max(0, C);
  const rad = (h * Math.PI) / 180, conv = (c) => fromOklab(L, c * Math.cos(rad), c * Math.sin(rad));
  let out = conv(C);
  if (!inGamut(out)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (inGamut(conv(mid))) lo = mid; else hi = mid; }
    out = conv(lo);
  }
  return { r: clamp01(out.r), g: clamp01(out.g), b: clamp01(out.b), a: alpha };
}
export const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(x, y) {
  const a = luminance(typeof x === "string" ? parseColor(x) : x), b = luminance(typeof y === "string" ? parseColor(y) : y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** Colour of a translucent layer over an opaque backdrop. */
export function over(top, back) {
  const a = top.a ?? 1;
  return { r: top.r * a + back.r * (1 - a), g: top.g * a + back.g * (1 - a), b: top.b * a + back.b * (1 - a), a: 1 };
}

// ------------------------------------------------------------------ parse / format
const NAMED = { white: [1, 1, 1, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
function num(t, scale = 255) {
  t = t.trim();
  if (t.endsWith("%")) return parseFloat(t) / 100;
  return parseFloat(t) / scale;
}
function hsl2rgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}
export function parseColor(s) {
  s = s.trim().toLowerCase();
  if (NAMED[s]) { const [r, g, b, a] = NAMED[s]; return { r, g, b, a }; }
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].includes(",") ? m[2].split(",") : m[2].replace("/", " / ").split(/\s+/).filter((x) => x && x !== "/");
  if (parts.length < 3) return null;
  const alpha = parts[3] !== undefined ? num(parts[3], 1) : 1;
  if (m[1].startsWith("rgb")) return { r: num(parts[0]), g: num(parts[1]), b: num(parts[2]), a: alpha };
  const { r, g, b } = hsl2rgb(parseFloat(parts[0]), num(parts[1], 100), num(parts[2], 100));
  return { r, g, b, a: alpha };
}
const hx = (x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");
export function formatColor(c) {
  const a = c.a ?? 1;
  if (a >= 0.999) return `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
  const n = (x) => Math.round(clamp01(x) * 255);
  return `rgba(${n(c.r)},${n(c.g)},${n(c.b)},${+a.toFixed(3)})`;
}

// ------------------------------------------------------------------ values
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)|(?<![\w-])(?:white|black)(?![\w-])/g;
/**
 * Replace every colour token in a CSS value.  url(...) and quoted strings are copied verbatim.
 * fn(color, token) returns a new colour object, a string, or null/undefined (keep).
 */
export function mapColors(value, fn) {
  let out = "", i = 0;
  const plain = (text) => text.replace(COLOR_RE, (tok) => {
    const c = parseColor(tok);
    if (!c) return tok;
    const r = fn(c, tok);
    return r == null ? tok : typeof r === "string" ? r : formatColor(r);
  });
  while (i < value.length) {
    const u = value.slice(i).search(/url\(|["']/i);
    if (u < 0) { out += plain(value.slice(i)); break; }
    out += plain(value.slice(i, i + u));
    i += u;
    if (value[i] === '"' || value[i] === "'") {
      const q = value[i]; let j = i + 1;
      while (j < value.length && value[j] !== q) j += value[j] === "\\" ? 2 : 1;
      out += value.slice(i, j + 1); i = j + 1;
    } else {
      let j = i + 4, depth = 1;
      while (j < value.length && depth) { const ch = value[j]; if (ch === '"' || ch === "'") { const q = ch; j++; while (j < value.length && value[j] !== q) j += value[j] === "\\" ? 2 : 1; } else if (ch === "(") depth++; else if (ch === ")") depth--; j++; }
      out += value.slice(i, j); i = j;
    }
  }
  return out;
}
export const hasColor = (value) => { COLOR_RE.lastIndex = 0; const t = value.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/gi, ""); return COLOR_RE.test(t); };

// ------------------------------------------------------------------ CSS scanner
const RULE_LISTS = new Set(["media", "supports", "layer", "container", "document"]);
const DECL_AT = new Set(["font-face", "page", "property", "counter-style", "viewport"]);
/**
 * Minimal CSS scanner (no nesting).  Returns top-level nodes:
 *  { type: "rule", selector, start, bodyStart, end, decls: [{ prop, value, start, valueStart, end }] }
 *  { type: "at", name, prelude, start, bodyStart, end, children: [...] }      (@media/@supports/…)
 *  { type: "at-decl", name, ... decls }                                       (@font-face …)
 *  { type: "keyframes", name, start, end }                                    (copied verbatim)
 *  { type: "statement", start, end }                                          (@import …;)
 * Offsets index the original text; `end` is one past the closing brace.
 */
export function scanCss(css) {
  let i = 0;
  const n = css.length;
  const skipComment = () => { if (css.startsWith("/*", i)) { const e = css.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; return true; } return false; };
  const skipString = () => { const q = css[i]; i++; while (i < n && css[i] !== q) i += css[i] === "\\" ? 2 : 1; i++; };
  function readPrelude() {   // until { or ; at depth 0
    const s = i; let depth = 0;
    while (i < n) {
      if (skipComment()) continue;
      const ch = css[i];
      if (ch === '"' || ch === "'") { skipString(); continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && (ch === "{" || ch === ";" || ch === "}")) break;
      i++;
    }
    return css.slice(s, i);
  }
  function skipBlock() {     // i at "{" → after matching "}"
    let depth = 0;
    while (i < n) {
      if (skipComment()) continue;
      const ch = css[i];
      if (ch === '"' || ch === "'") { skipString(); continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { i++; return; } }
      i++;
    }
  }
  function readDecls() {     // i after "{" → at "}" (consumed)
    const decls = [];
    while (i < n) {
      while (i < n && /[\s;]/.test(css[i])) i++;
      if (skipComment()) continue;
      if (css[i] === "}") { i++; break; }
      const start = i;
      while (i < n && css[i] !== ":" && css[i] !== ";" && css[i] !== "}") { if (skipComment()) continue; i++; }
      const prop = css.slice(start, i).trim();
      if (css[i] !== ":") { continue; }
      i++;
      const valueStart = i; let depth = 0;
      while (i < n) {
        if (skipComment()) continue;
        const ch = css[i];
        if (ch === '"' || ch === "'") { skipString(); continue; }
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (depth <= 0 && (ch === ";" || ch === "}")) break;
        i++;
      }
      decls.push({ prop, value: css.slice(valueStart, i), start, valueStart, end: i });
    }
    return decls;
  }
  function readList(stopAtBrace) {
    const nodes = [];
    while (i < n) {
      while (i < n && /\s/.test(css[i])) i++;
      if (skipComment()) continue;
      if (i >= n) break;
      if (css[i] === "}") { if (stopAtBrace) { i++; return nodes; } i++; continue; }
      const start = i;
      const prelude = readPrelude();
      if (css[i] === ";") { i++; nodes.push({ type: "statement", start, end: i }); continue; }
      if (css[i] !== "{") { if (css[i] === "}") continue; break; }
      const bodyStart = i + 1;
      const p = prelude.trim();
      if (p.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(p)?.[1]?.toLowerCase() ?? "";
        if (name.endsWith("keyframes")) { skipBlock(); nodes.push({ type: "keyframes", name, start, end: i }); continue; }
        if (DECL_AT.has(name)) { i++; const decls = readDecls(); nodes.push({ type: "at-decl", name, prelude: p, start, bodyStart, end: i, decls }); continue; }
        if (RULE_LISTS.has(name)) { i++; const children = readList(true); nodes.push({ type: "at", name, prelude: p, start, bodyStart, end: i, children }); continue; }
        skipBlock(); nodes.push({ type: "keyframes", name, start, end: i }); continue;
      }
      i++;
      const decls = readDecls();
      nodes.push({ type: "rule", selector: p, start, bodyStart, end: i, decls });
    }
    return nodes;
  }
  return readList(false);
}

/** Split a selector list on top-level commas (not inside :is()/:not()/[attr="a,b"]). */
export function splitSelectors(sel) {
  const out = []; let depth = 0, cur = "", q = null;
  for (const ch of sel) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Разовая перекраска исходных стилей под основной референс (тёмно-бирюзовая «петроль»-гамма
 * с мятным акцентом, docs/design/reference-teal/). Меняются только литералы цвета:
 *
 *  - фиолетовые/индиго акценты (OKLCH h 245–335°, C ≥ 0.06)  → мятно-бирюзовые (h 182°), светлота сохраняется;
 *  - тонированные фиолетом нейтральные поверхности/линии (C < 0.06) и непрозрачные тёмно-серые
 *    поверхности → «петроль» (h ≈ 222°, хрома по светлоте, как в референсе: #00141c, #00202c, #002830);
 *  - светлые лавандовые тексты → светлые бирюзово-серые;
 *  - остальные оттенки (тёплые, красные, зелёные, жёлтые, голубые), белый, чёрный и прозрачности
 *    белого/чёрного не трогаются.
 * Запуск: node tools/recolor-reference.mjs [--write]  → отчёт ../docs/design/reference-teal/recolor-map.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatColor, fromLch, mapColors, scanCss, toLch } from "./css-color.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["src/design-system-core.css"];  // v3.0 · CSS-01: единое ядро стилей
const write = process.argv.includes("--write");

export function remap(c) {
  const { L, C, h } = toLch(c);
  const a = c.a ?? 1;
  const violet = h >= 245 && h <= 335;
  if (C < 0.004) {
    // pure greys: opaque dark surfaces become petrol; white/black/light greys and translucent layers stay
    if (a >= 0.6 && L > 0.06 && L < 0.5) return fromLch(Math.min(0.5, L + 0.012), petrolC(L), 222, a);
    return null;
  }
  if (!violet) return null;
  if (C < 0.06) {
    if (L < 0.5) return fromLch(Math.min(0.5, L + 0.012), Math.max(C * 0.9, petrolC(L)), 222, a);   // surfaces, lines
    return fromLch(L, C * 0.85, 200, a);                                                              // grey-lavender text → teal-grey
  }
  if (L < 0.5) return fromLch(L, C * 0.85, 198, a);   // deep accent backgrounds (selected, chips) → deep teal
  return fromLch(Math.max(0.78, Math.min(0.95, L + 0.1)), Math.min(C * 0.8, 0.15), 182, a);   // accents → mint (как #5ce8d4)
}
function petrolC(L) { return Math.max(0.028, Math.min(0.06, 0.03 + 0.09 * (L - 0.15))); }

const report = {};
let total = 0;
for (const rel of FILES) {
  const path = resolve(here, "..", rel);
  const css = readFileSync(path, "utf8");
  const edits = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === "at") visit(node.children);
      else if (node.type === "rule" || node.type === "at-decl") {
        for (const d of node.decls) {
          const next = mapColors(d.value, (c, tok) => {
            const r = remap(c);
            if (!r) return null;
            const out = formatColor(r);
            if (out.toLowerCase() !== tok.toLowerCase()) { (report[rel] ??= {})[tok.toLowerCase()] = out; }
            return out;
          });
          if (next !== d.value) edits.push([d.valueStart, d.end, next]);
        }
      }
    }
  };
  // @keyframes are copied verbatim by the scanner; recolour them too (glows/pulses use brand colours)
  const kf = [];
  visit(scanCss(css));
  for (const node of scanCss(css)) if (node.type === "keyframes" && /keyframes/.test(node.name)) kf.push(node);
  let out = css;
  for (const [s, e, v] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, s) + v + out.slice(e);
  // second pass for keyframe bodies (positions shift → rescan the edited text)
  out = out.replace(/@(?:-webkit-)?keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, (block) => block.replace(/:\s*([^;{}]+)/g, (m, v) => {
    const next = mapColors(v, (c, tok) => { const r = remap(c); if (!r) return null; const o = formatColor(r); if (o.toLowerCase() !== tok.toLowerCase()) (report[rel] ??= {})[tok.toLowerCase()] = o; return o; });
    return m.replace(v, next);
  }));
  const n = Object.keys(report[rel] ?? {}).length;
  total += edits.length;
  console.log(`${rel}: ${edits.length} declarations, ${n} distinct colours`);
  if (write && out !== css) writeFileSync(path, out);
}
const outDir = resolve(here, "../../docs/design/reference-teal");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "recolor-map.json"), JSON.stringify(report, null, 1) + "\n");
console.log(`total ${total} declarations${write ? " — written" : " — dry run"}`);

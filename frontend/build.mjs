// v3.2 · PERF-01: сборка Mini App с разбиением кода.
// app/static/index.html — критический путь: ES5-сторож, тема, инлайн-CSS ядра и инлайн ES-модуль входа
// (bootstrap). Экраны, учительский режим, KaTeX/Markdown и демо-данные — отдельные чанки
// app/static/assets/c-<hash>.js (маршрут сервера /assets/*, immutable-кэш), стартовая цепочка
// объявлена <link rel="modulepreload">. Итоговый файл по-прежнему пишется в "../app/static/index.html".
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { addLightTheme } from "./light-theme.mjs";
import { splitCore } from "./tools/core-css.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../app/static/index.html");
const assets = resolve(here, "../app/static/assets");
const watch = process.argv.includes("--watch");
// v2.4 · версии из одного места: semver фронтенда и метка выпуска продукта (= app.__release__).
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version || "") || !/^\d+\.\d+\.\d+$/.test(pkg.sferumRelease || "")) throw new Error("package.json: version и sferumRelease обязаны быть semver");
const TARGET = ["es2020", "safari14"];
/** Чанки, без которых ученик не увидит первый экран: вход (main.tsx + RoleRoot.tsx) → App (динамический импорт). */
const STARTUP = ["src/main.tsx", "src/App.tsx"];

const katexWoff2 = {
  name: "katex-local-woff2",
  setup(build) {
    build.onLoad({ filter: /[/\\]katex[/\\]dist[/\\]katex\.min\.css$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8").replace(/src:([^;}]+)(?=[;}])/g, (_, sources) =>
        "src:" + (sources.split(",").find(part => part.includes('format("woff2")')) ?? sources)),
      loader: "css", resolveDir: dirname(path),
    }));
  },
};

async function bundle() {
  const res = await esbuild.build({
    entryPoints: { main: resolve(here, "src/main.tsx") },
    bundle: true, splitting: true, format: "esm",
    minify: true, charset: "utf8", target: TARGET,
    jsx: "automatic", jsxImportSource: "preact",
    write: false, outdir: assets, entryNames: "[name]-[hash]", chunkNames: "c-[hash]",
    loader: { ".css": "css", ".webp": "dataurl", ".woff2": "dataurl" },
    // Master v2.0 · шрифты «Персонализации» — отдельные файлы /fonts/* (маршрут сервера, immutable-кэш).
    external: ["/fonts/*"],
    plugins: [{
      // v3.0 · CSS-01: единое ядро стилей; ручной слой светлой темы (@light-manual) собирается отдельно.
      name: "design-system-core",
      setup(build) {
        build.onLoad({ filter: /[/\\]design-system-core\.css$/ }, ({ path }) => ({
          contents: splitCore(readFileSync(path, "utf8")).main, loader: "css", resolveDir: dirname(path),
        }));
      },
    }],
    legalComments: "none", metafile: true,
    define: { __SF_VERSION__: JSON.stringify(pkg.version), __SF_RELEASE__: JSON.stringify(pkg.sferumRelease) },
  });
  const meta = res.metafile.outputs;
  const rel = (p) => p.replace(/\\/g, "/").replace(/^.*?app\/static\/assets\//, "");
  const file = (p) => res.outputFiles.find((f) => rel(f.path) === rel(p));
  const entryKey = Object.keys(meta).find((k) => meta[k].entryPoint === "src/main.tsx" && k.endsWith(".js"));
  if (!entryKey) throw new Error("build: нет выхода для src/main.tsx");
  if (Object.keys(meta).some((k) => k.endsWith(".css") && k !== meta[entryKey].cssBundle)) throw new Error("build: CSS разрешён только во входе (ядро стилей); KaTeX — отдельный файл");
  // Стартовая цепочка: статические импорты входа, RoleRoot и App (транзитивно).
  const byEntry = (src) => Object.keys(meta).find((k) => meta[k].entryPoint === src && k.endsWith(".js"));
  const preload = new Set();
  const walk = (k) => { for (const i of meta[k].imports) if (i.kind === "import-statement" && !preload.has(i.path)) { preload.add(i.path); walk(i.path); } };
  for (const src of STARTUP) { const k = byEntry(src); if (!k) throw new Error(`build: ${src} не стал отдельным чанком`); if (k !== entryKey) preload.add(k); walk(k); }
  preload.delete(entryKey);
  // Вход инлайнится в index.html: относительные импорты чанков → абсолютные /assets/… (работает на любом пути SPA).
  const entryJs = file(entryKey).text.replace(/(["'])\.\/(c-[A-Za-z0-9]+\.js)\1/g, "$1/assets/$2$1");
  if (/["']\.\//.test(entryJs.replace(/["']\.\/(?:fonts)/g, ""))) console.warn("  warn: относительный путь во входе");

  // Светлая тема: близнецы правил с цветами (light-theme.mjs) + ручной слой (секция @light-manual ядра) строго в конце.
  const dark = meta[entryKey].cssBundle ? file(meta[entryKey].cssBundle).text : "";
  const light = addLightTheme(dark);
  const manual = await esbuild.build({
    stdin: { contents: splitCore(readFileSync(resolve(here, "src/design-system-core.css"), "utf8")).light, loader: "css", resolveDir: resolve(here, "src") },
    bundle: true, minify: true, charset: "utf8", write: false, outdir: "out",
    loader: { ".webp": "dataurl" }, legalComments: "none",
  });
  const css0 = light.css + (manual.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "");
  // Размер текста (lib/theme.ts): каждый px-размер шрифта умножается на --fs (по умолчанию 1).
  let scaled = 0;
  const css = css0.replace(/font-size:(\d+(?:\.\d+)?)px/g, (_, n) => { scaled++; return `font-size:calc(${n}px*var(--fs,1))`; });
  console.log(`  light theme: ${light.rules} rule twins, ${light.decls} declarations · text size: ${scaled} font-size declarations scale with --fs`);

  // KaTeX: вендорные стили формул + 20 woff2 — отдельные файлы, их подключает lib/aiMarkdown.ts при первом ответе с формулой.
  const kx = await esbuild.build({
    stdin: { contents: '@import "katex/dist/katex.min.css";', loader: "css", resolveDir: here },
    bundle: true, minify: true, charset: "utf8", write: false, outdir: assets,
    loader: { ".woff2": "file", ".woff": "empty", ".ttf": "empty" }, assetNames: "f-[name]-[hash]", publicPath: "/assets",
    plugins: [katexWoff2], legalComments: "none",
  });
  const kxCss = kx.outputFiles.find((f) => f.path.endsWith(".css")).text;
  const kxName = `katex-${createHash("sha256").update(kxCss).digest("hex").slice(0, 10)}.css`;

  const chunks = res.outputFiles.filter((f) => f.path.endsWith(".js") && rel(f.path) !== rel(entryKey));
  const build = createHash("sha256").update(entryJs).update(css).update(chunks.map((c) => c.hash).join()).digest("hex").slice(0, 12);
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  for (const c of chunks) writeFileSync(resolve(assets, basename(c.path)), c.contents);
  for (const f of kx.outputFiles) if (!f.path.endsWith(".css")) writeFileSync(resolve(assets, basename(f.path)), f.contents);
  writeFileSync(resolve(assets, kxName), kxCss);

  const tpl = readFileSync(resolve(here, "src/index.html"), "utf8");
  // P0 MAX: идентификатор сборки (<meta name="sf-build">) и ES5-сторож загрузки.
  const guard = esbuild.transformSync(readFileSync(resolve(here, "src/bootguard.js"), "utf8").replaceAll("__SF_BUILD__", build),
    { target: "es5", minify: true, legalComments: "none", charset: "utf8" }).code.trim();
  if (/=>|`|\blet\s|\bconst\s|\bclass\s/.test(guard)) throw new Error("bootguard.js: синтаксис новее ES5 — сторож обязан разбираться любым WebView");
  const links = [...preload].map((k) => `<link rel="modulepreload" href="/assets/${rel(k)}">`).join("\n");
  const html = tpl
    .replace("/*__GUARD__*/", () => guard.replace(/<\/script/gi, "<\\/script"))
    .replaceAll("__SF_BUILD__", build)
    .replaceAll("__SF_RELEASE__", pkg.sferumRelease)
    .replaceAll("__SF_VERSION__", pkg.version)
    .replace("__SF_KATEX__", `/assets/${kxName}`)
    .replace("<!--__PRELOAD__-->", () => links)
    .replace("/*__CSS__*/", () => css)
    .replace("/*__JS__*/", () => entryJs.replace(/<\/script/gi, "<\\/script"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  // 404.html = тот же апп: статические хостинги отдают его на любой «не тот» путь — SPA-фоллбек без настройки сервера.
  writeFileSync(resolve(dirname(out), "404.html"), html);
  const size = (b) => (b / 1024).toFixed(1);
  const startKB = Buffer.byteLength(entryJs) + [...preload].reduce((s, k) => s + meta[k].bytes, 0);
  const lazyKB = chunks.reduce((s, c) => s + c.contents.length, 0) - [...preload].reduce((s, k) => s + meta[k].bytes, 0);
  console.log(`✓ app/static/index.html — ${size(Buffer.byteLength(html))} KB (CSS ${size(Buffer.byteLength(css))} KB, entry ${size(Buffer.byteLength(entryJs))} KB) · startup JS ${size(startKB)} KB in ${preload.size + 1} files · lazy ${size(lazyKB)} KB in ${chunks.length - preload.size} chunks · build ${build} · boot guard ${size(Buffer.byteLength(guard))} KB (ES5)`);
}

if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  await bundle();
  fsWatch(resolve(here, "src"), { recursive: true }, () => bundle().catch(console.error));
} else {
  await bundle();
}

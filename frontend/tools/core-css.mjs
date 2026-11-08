// v3.0 · CSS-01: доступ к единому ядру стилей src/design-system-core.css для сборки и тестов.
// Секции «@section <имя>» сохраняют прежний порядок каскада; ручной слой светлой темы лежит
// между «@light-manual:start» и «@light-manual:end» и в бандл попадает последним (build.mjs).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/design-system-core.css");
const START = "/* @light-manual:start", END = "/* @light-manual:end */";

export const coreCss = () => readFileSync(CORE_PATH, "utf8");

/** Split the core into the main bundle part and the manual light layer. */
export function splitCore(css = coreCss()) {
  const a = css.indexOf(START), b = css.indexOf(END);
  if (a < 0 || b < a) throw new Error("design-system-core.css: нет маркеров @light-manual");
  return { main: css.slice(0, a) + css.slice(b + END.length), light: css.slice(a, b + END.length) };
}

/** Text of one legacy section, e.g. section("final.css"). */
export function section(name, css = coreCss()) {
  const open = `/* @section ${name}`, close = `/* @endsection ${name} */`;
  const a = css.indexOf(open), b = css.indexOf(close, a);
  if (a < 0 || b < 0) throw new Error(`design-system-core.css: секция ${name} не найдена`);
  return css.slice(css.indexOf("*/", a) + 2, b);
}

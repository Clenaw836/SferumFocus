/** v3.2 · PERF-01: общий чанк синхронизации аккаунта (тьютор + план дня) — один запрос модуля вместо двух. */
export { installTutorSync } from "./tutorSync";
export { installDaySync } from "./daySync";

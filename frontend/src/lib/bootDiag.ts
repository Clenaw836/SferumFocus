/** Типизированный мост к ES5-сторожу загрузки (src/bootguard.js → window.__sfBoot).
 *  Сторож живёт отдельно от бандла: он показывает экран с кодом, если бандл не стартовал, и шлёт
 *  обезличенный сигнал. Здесь — только отметки этапов и коды; никаких initData, токенов и имён. */
interface BootGuard {
  stage?: string; id?: string; halted?: boolean; inMax?: boolean;
  mark?(stage: string): void; recovery?(code: string): void; ok?(): void; sendReady?(): boolean;
}
const guard = (): BootGuard | undefined =>
  typeof window !== "undefined" ? (window as unknown as { __sfBoot?: BootGuard }).__sfBoot : undefined;
const safe = (f: () => void): void => { try { f(); } catch { /* сторож недоступен — диагностика не должна ломать вход */ } };

export type BootStage = "bundle" | "bridge" | "launch" | "session" | "verify" | "role" | "render";
export const bootStage = (stage: BootStage): void => safe(() => guard()?.mark?.(stage));
/** Наш экран восстановления показан (вход не подтверждён): сигнал + WebApp.ready(), чтобы MAX показал его. */
export const bootRecovery = (code: string): void => safe(() => guard()?.recovery?.(code));
/** Интерфейс отрисован после подтверждённого входа. */
export const bootOk = (): void => safe(() => guard()?.ok?.());
/** Сторож остановил цикл перезагрузок — бандл ничего не запускает. */
export const bootHalted = (): boolean => { try { return !!guard()?.halted; } catch { return false; } };
/** true — сторож взял доставку WebApp.ready() на себя (он ждёт поздний async-bridge).
 *  Только если сторож САМ распознал запуск в MAX (hash/sessionStorage/WebViewHandler): иначе его sendReady()
 *  никогда не отправит ready(), и при мосте, отдающем initData иным путём, ready() терялся бы совсем
 *  (найдено MAX-харнессом A2 в финальном прогоне: мост с initData без WebAppData в URL). */
export const guardOwnsReady = (): boolean => { try { const g = guard(); return typeof g?.sendReady === "function" && g.inMax === true; } catch { return false; } };
export const guardSendReady = (): boolean => { try { return !!guard()?.sendReady?.(); } catch { return false; } };
/** Код диагностики и этап для экрана восстановления (код случайный, без личных данных). */
export const bootInfo = (): { id: string; stage: string } | null => {
  try { const g = guard(); return g?.id ? { id: String(g.id).slice(0, 8), stage: String(g.stage || "").slice(0, 24) } : null; } catch { return null; }
};

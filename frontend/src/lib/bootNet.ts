/** v2.1: сетевые правила загрузки. Таймаут одной попытки 10 с и два повтора (600 мс, 1500 мс)
 *  только для сетевых сбоев и таймаута — ответы сервера (401/403/5xx) не повторяются вслепую. */
export const BOOT_TIMEOUT_MS = 10000;
export const BOOT_RETRY_DELAYS: readonly number[] = [600, 1500];

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withBootRetries<T>(attempt: (timeoutMs: number) => Promise<T>,
  retryable: (error: unknown) => boolean, sleep: Sleep = realSleep,
  delays: readonly number[] = BOOT_RETRY_DELAYS): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await attempt(BOOT_TIMEOUT_MS); }
    catch (error) {
      if (!retryable(error) || i >= delays.length) throw error;
      await sleep(delays[i]);
    }
  }
}

/** fetch с AbortController: таймаут превращается в именованную ошибку, а не «висящий» запрос. */
export class BootNetError extends Error {
  constructor(public readonly kind: "timeout" | "network") { super(kind); }
}
export async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number,
  fetcher: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(input, {...init, signal: controller.signal}); }
  catch { throw new BootNetError(controller.signal.aborted ? "timeout" : "network"); }
  finally { clearTimeout(timer); }
}

/** sessionStorage может быть недоступен (приватный режим, политика WebView) — тогда просто без кэша. */
export function readSession<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : null;
  } catch { return null; }
}
export function writeSession(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* квота/запрет — без кэша */ }
}
export function dropSession(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* недоступно */ }
}

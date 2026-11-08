/**
 * P0-02 · «Живая демонстрация»: изолированная серверная песочница (app/demo_sandbox.py).
 * Токен подписан сервером и живёт только в sessionStorage этой вкладки. Личность (персонаж) и роль
 * задаёт сервер: клиент не присылает ни user id, ни роль — только X-Demo-Session.
 * Модуль без зависимостей: его читают platform/api/bootstrap до проверки личности.
 */
const KEY = "sf.demo.session";
const TOKEN = /^v1\.[A-Za-z0-9_-]{8,400}\.[A-Za-z0-9_-]{20,100}$/;
const query = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();

/** `?demo=live` — песочница на настоящем сервере (в отличие от `?demo=1` — автономной копии без сети). */
export const LIVE: boolean = query.get("demo") === "live";

export type PersonaId = "teacher" | "s1" | "s2" | "s3";
export interface SandboxPersona { id: PersonaId; role: "teacher" | "student"; full_name: string; label: string }
export interface SandboxInfo {
  sandbox: true; persona: SandboxPersona; personas: SandboxPersona[]; expires_at: number;
  class: string; school: string; offline_students: string[]; notice: string;
}

export function sandboxToken(): string {
  if (!LIVE) return "";
  try { const t = sessionStorage.getItem(KEY) || ""; return TOKEN.test(t) ? t : ""; } catch { return ""; }
}
export const inSandbox = (): boolean => sandboxToken() !== "";
export const sandboxHeaders = (): Record<string, string> => { const t = sandboxToken(); return t ? { "X-Demo-Session": t } : {}; };
export function storeSandboxToken(token: string | null): void {
  try { if (token) sessionStorage.setItem(KEY, token); else sessionStorage.removeItem(KEY); } catch { /* приватный режим: см. enter() */ }
}

/** Excellence v3 (v2 report §9 п.5): browser storage of the sandbox personas is erased with the sandbox.
 *  Every identity namespace bound while a sandbox is active is remembered for this tab only. */
const SCOPES = "sf.demo.scopes";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const sess = (): Store | null => { try { return sessionStorage; } catch { return null; } };
const local = (): Store | null => { try { return localStorage; } catch { return null; } };
export function rememberSandboxScope(namespace: string, session: Store | null = sess()): void {
  if (!session || !/^[0-9a-f]{16,128}$/.test(namespace)) return;
  try {
    const list: string[] = JSON.parse(session.getItem(SCOPES) || "[]");
    if (!list.includes(namespace)) session.setItem(SCOPES, JSON.stringify([...list, namespace].slice(-16)));
  } catch { session.setItem(SCOPES, JSON.stringify([namespace])); }
}
export function purgeSandboxStorage(storage: Store | null = local(), session: Store | null = sess()): number {
  if (!session) return 0;
  let list: string[] = [];
  try { list = JSON.parse(session.getItem(SCOPES) || "[]"); } catch { list = []; }
  let removed = 0;
  if (storage && Array.isArray(list) && list.length) {
    const prefixes = list.filter((n) => typeof n === "string" && /^[0-9a-f]{16,128}$/.test(n)).map((n) => `sf.account.${n}.`);
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && prefixes.some((p) => k.startsWith(p))) doomed.push(k); }
    doomed.forEach((k) => storage.removeItem(k)); removed = doomed.length;
  }
  try { session.removeItem(SCOPES); } catch { /* private mode */ }
  return removed;
}
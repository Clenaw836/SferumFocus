/** Действия «Живой демонстрации»: создать песочницу, сменить персонажа, начать заново, завершить.
 * Каждая смена персонажа — новый JS-realm (reload): состояние прошлого персонажа не переживает переход. */
import { LIVE, purgeSandboxStorage, sandboxHeaders, sandboxToken, storeSandboxToken, type PersonaId, type SandboxInfo } from "./sandbox";
import { invalidateIdentity } from "./identity";
import { trustedApiURL, apiRedirectRejected } from "./apiPolicy";
import { juryURL } from "./jury";

export class SandboxError extends Error { constructor(message: string, public status: number) { super(message); } }
type Issued = { token: string } & SandboxInfo;

async function call<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let url: string;
  try { url = trustedApiURL(path, location.origin); } catch { throw new SandboxError("Небезопасный адрес сервера демонстрации", -2); }
  let r: Response;
  try {
    r = await fetch(url, { method, redirect: "manual", credentials: "omit",
      headers: { "Content-Type": "application/json", ...sandboxHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new SandboxError("Нет связи с сервером демонстрации. Проверьте интернет и попробуйте снова.", 0); }
  if (apiRedirectRejected(r.type, r.status)) throw new SandboxError("Перенаправление заблокировано", -2);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* не JSON */ }
  if (!r.ok) {
    const detail = data && typeof (data as { detail?: unknown }).detail === "string" ? (data as { detail: string }).detail : `Ошибка ${r.status}`;
    throw new SandboxError(r.status === 429 ? "Слишком много новых демонстраций с этого адреса. Продолжите текущую или попробуйте через час." : detail, r.status);
  }
  return data as T;
}

function enter(token: string, role: "teacher" | "student"): void {
  storeSandboxToken(token);
  if (sandboxToken() !== token) throw new SandboxError("Браузер не сохранил демо-сессию (приватный режим или запрет хранилища). Откройте обычную вкладку.", -3);
  invalidateIdentity();
  const u = new URL(location.href);
  u.search = "?demo=live"; u.hash = role === "teacher" ? "#teacher-today" : "#tonight";
  history.replaceState(null, "", u.href);
  location.reload();
}

/** Новая песочница (с действующим токеном сервер удаляет прежнюю — «начать заново»). */
export async function startSandbox(persona: PersonaId = "teacher"): Promise<void> {
  purgeSandboxStorage();             // «Начать заново» / first entry: no browser data of a previous sandbox survives
  try {
    const r = await call<Issued>("POST", "/api/v1/demo/session", { persona });
    enter(r.token, r.persona.role);
  } catch (e) {
    if (e instanceof SandboxError && e.status === 401 && sandboxToken()) { storeSandboxToken(null); return startSandbox(persona); }
    if (e instanceof SandboxError && e.status === 404) { location.replace(juryURL(location.href)); return; }   // песочница выключена → автономное демо
    throw e;
  }
}
export async function switchPersona(persona: PersonaId): Promise<void> {
  const r = await call<Issued>("POST", "/api/v1/demo/persona", { persona });
  enter(r.token, r.persona.role);
}
export async function endSandbox(): Promise<void> {
  try { await call("DELETE", "/api/v1/demo/session"); } catch { /* уже закончилась — данные удалит сервер по сроку */ }
  purgeSandboxStorage();             // personas' browser data go together with the server rows
  storeSandboxToken(null);
  invalidateIdentity();
  const u = new URL(location.href);
  u.search = ""; u.hash = "#tonight";
  location.assign(u.href);
}
/** Ссылка, по которой жюри открывает живую демонстрацию в обычной вкладке браузера. */
export function liveURL(href: string): string { const u = new URL(href); u.search = "?demo=live"; u.hash = "#teacher-today"; return u.href; }
export const isLive = () => LIVE;

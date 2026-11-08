import type { Role } from "./types";
import type { SandboxInfo } from "./sandbox";
/** ФИО и школа — только из доверенного источника на сервере (whoami.profile); клиент их не задаёт. */
export interface IdentityProfile {
  full_name: string | null; source: "demo_sandbox" | "school_directory" | "sgo" | "class_roster" | "max" | null;
  verified: boolean; synthetic: boolean; school: string | null; classes: string[]; note: string;
}
export interface Principal { auth: string; user: string; uid?:string; role?: string; account_role?: string; is_teacher?: boolean; role_source?: string; role_switch?: boolean; profile?: IdentityProfile; sandbox?: SandboxInfo;
  /** Фото профиля MAX из подписанного initData (whoami); только оформление, не личность. */
  avatar?: { url: string; source: "max" } | null }
export function rolePolicy(w: Principal): { role: Role; canSwitch: boolean } {
  return {role: w.role === "teacher" ? "teacher" : "student", canSwitch: w.role_switch === true && ((w.auth === "demo" && w.role_source === "demo") || (!!w.uid && w.account_role === "teacher"))};
}
let current = rolePolicy({auth:"max",user:""});
let verified: Principal | null = null;
export const roleContext = () => current;
/** Last server-verified principal (profile, sandbox persona). Null for the offline local demo. */
export const principal = () => verified;
/** v2.1: профиль и дневник v2.1 (/api/v1/profile, /diary/overview) есть только у проверенного аккаунта платформы —
 *  whoami.uid. У песочницы жюри (auth "demo"), локального демо и режима без платформенного входа их нет: запрос
 *  туда вернул бы 401 «нет сессии», а любой 401 сносит рабочую личность («Сессия изменилась»). */
export function isProfileAccount(p: Principal | null, demo: boolean, protocol: string): boolean {
  return !demo && protocol !== "file:" && !!p?.uid && p.auth !== "demo";
}
/** v2.2: после подключения/смены дневника сервер узнаёт ФИО из СГО — обновляем ТОЛЬКО профиль и фото того же
 *  аккаунта (uid и тип входа совпадают). Роль и личность здесь не меняются: для этого есть полный перезапуск. */
export function refreshProfile(w: Principal | null | undefined): boolean {
  if (!verified || !w || !verified.uid || w.uid !== verified.uid || w.auth !== verified.auth) return false;
  verified = { ...verified, profile: w.profile, avatar: w.avatar === undefined ? verified.avatar : w.avatar };
  return true;
}
export const configureRole = (w: Principal) => { current = rolePolicy(w); verified = w.auth === "demo" && w.user === "explicit-local-demo" ? null : w; };
export function preferredDemoRole(): Role { try { return sessionStorage.getItem("sf.demo.role") === "teacher" ? "teacher" : "student"; } catch { return "student"; } }
export function requestDemoRole(role: Role): boolean {
  if (!current.canSwitch || verified?.auth !== "demo") return false;
  try { sessionStorage.setItem("sf.demo.role", role);
    const u=new URL(location.href);if(["teacher","student"].includes(u.searchParams.get("startapp")??"")){u.searchParams.delete("startapp");history.replaceState(null,"",u);}
  } catch { return false; }
  return true;
}
export const roleScope = (auth: string, user: string, role: Role) => `${auth}:${user}${role === "teacher" ? ":teacher" : ""}`;

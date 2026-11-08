/** v3.2 · PERF-01: имя из проверенного профиля — без UI настроек (ProfileSettings грузится лениво). */
import { principal, type IdentityProfile } from "./roleContext";

export function shortName(p: IdentityProfile | null | undefined): string | null {
  const parts = p?.full_name?.trim().split(/\s+/) ?? [];
  if (!parts.length) return null;
  return p?.source === "max" || parts.length === 1 ? parts[0] : parts[1];
}
export const verifiedProfile = (): IdentityProfile | null => principal()?.profile ?? null;

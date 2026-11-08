/**
 * Master v2.0 · Feature 1 — аватар как вход в профиль.
 * Приоритет: своё фото (только на этом устройстве, по аккаунту) → фото MAX из ПОДПИСАННОГО initData
 * (whoami.avatar; поле user.photo_url документировано на dev.max.ru/docs/webapps/bridge) → нейтральная
 * монограмма. Аватар — оформление: права, роль и личность от него не зависят; демо-персонажи песочницы
 * фото MAX не получают (сервер отдаёт avatar=null).
 */
import { useEffect, useState } from "preact/hooks";
import { accountKey } from "./identity";
import { principal } from "./roleContext";
import { safeDataImage } from "./imageTools";

export const AVATAR_PX = 256;
export const AVATAR_BUDGET = 90_000;                    // символов data URL (~65 КБ): 256×256 WebP/JPEG
const KEY = "profile.avatar.v1";
const subs = new Set<() => void>();
let mem: { scope: string; url: string | null } | null = null;
let failedHost: string | null = null;                   // фото MAX не загрузилось — не мигаем повторно

export function ownAvatar(): string | null {
  const scope = accountKey("");
  if (mem?.scope === scope) return mem.url;
  let raw: string | null = null;
  try { raw = localStorage.getItem(accountKey(KEY)); } catch { /* приватный режим */ }
  mem = { scope, url: safeDataImage(raw, AVATAR_BUDGET) };
  return mem.url;
}
/** true — сохранено на устройстве; false — только до перезапуска (нет места/приватный режим). */
export function setOwnAvatar(url: string | null): boolean {
  const clean = url === null ? null : safeDataImage(url, AVATAR_BUDGET);
  if (url !== null && !clean) throw new Error("Неподдерживаемое изображение");
  mem = { scope: accountKey(""), url: clean };
  let ok = true;
  try { if (clean) localStorage.setItem(accountKey(KEY), clean); else localStorage.removeItem(accountKey(KEY)); } catch { ok = clean === null; }
  subs.forEach((f) => f());
  return ok;
}
/** https-фото MAX из whoami (сервер проверил подпись initData). */
export function hostAvatar(): string | null {
  const a = principal()?.avatar;
  const u = a && a.source === "max" && typeof a.url === "string" && /^https:\/\/[^\s"'<>\\]+$/.test(a.url) ? a.url : null;
  return u && u !== failedHost ? u : null;
}
export function hostAvatarFailed(url: string): void { if (failedHost !== url) { failedHost = url; subs.forEach((f) => f()); } }

export type AvatarKind = "own" | "max" | "none";
export interface AvatarView { kind: AvatarKind; url: string | null; initial: string; hue: number }
/** v2.2: инициалы — первые буквы двух первых слов имени в том порядке, в каком имя показано
 *  («Сидорова Мария» → «СМ», «Мария» → «М»); у слова берётся первая буква, слова без букв пропускаются.
 *  Нет имени — пустая строка: аватар рисует значок человека, а не «?». */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").normalize("NFC").split(/[\s\u00a0]+/).map((w) => w.match(/\p{L}/u)?.[0] ?? "").filter(Boolean);
  return words.slice(0, 2).join("").toLocaleUpperCase("ru-RU");
}
/** Монограмма: инициалы, оттенок — детерминированно из имени, без случайности. */
export function avatarView(name: string | null | undefined): AvatarView {
  const own = ownAvatar(), host = own ? null : hostAvatar();
  const n = (name ?? "").trim();
  let h = 0; for (const ch of n) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return { kind: own ? "own" : host ? "max" : "none", url: own ?? host, initial: initialsOf(n), hue: n ? 170 + (h % 60) : 186 };
}
export function useAvatar(name: string | null | undefined): AvatarView {
  const [, setV] = useState(0);
  useEffect(() => { const f = () => setV((v) => v + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return avatarView(name);
}

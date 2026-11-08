/**
 * Оформление: тёмная (по умолчанию) или светлая тема и режим «Повышенная различимость».
 * Выбор делает только пользователь — системная тема (prefers-color-scheme) намеренно не читается,
 * тема не переключается сама. Настройка относится к устройству, а не к аккаунту: ключи не содержат
 * личных данных и не привязаны к личности.
 */
import { useEffect, useState } from "preact/hooks";

export type Theme = "dark" | "light";
/** Размер текста (Excellence v3): m — как задумано, l ≈ 115 %, xl ≈ 130 %. Масштабируются все font-size
 *  бандла (сборка превращает `font-size:Npx` в `calc(Npx*var(--fs,1))`), раскладка остаётся гибкой. */
export type TextSize = "m" | "l" | "xl";
export const TEXT_SCALE: Record<TextSize, number> = { m: 1, l: 1.15, xl: 1.3 };
/** v2.1: имя масштаба в профиле сервера и в атрибуте <html data-font-scale>. */
export type FontScaleName = "normal" | "large" | "xlarge";
const SCALE_NAME: Record<TextSize, FontScaleName> = { m: "normal", l: "large", xl: "xlarge" };
export const fontScaleName = (z: TextSize = textSize()): FontScaleName => SCALE_NAME[z];
export const textSizeFromScale = (s: string | null | undefined): TextSize | null =>
  s === "large" ? "l" : s === "xlarge" ? "xl" : s === "normal" || s === "small" ? "m" : null;
/** Пользователь уже выбрал размер на этом устройстве (тогда серверный профиль его не перебивает). */
export const hasLocalTextSize = (): boolean => memText !== null || read(TEXT) !== null;
const THEME = "sf.ui.theme";
const A11Y = "sf.ui.a11y";
const TEXT = "sf.ui.text";
const subs = new Set<() => void>();
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* приватный режим: до перезагрузки */ } };
let memTheme: Theme | null = null;
let memA11y: boolean | null = null;
let memText: TextSize | null = null;

export const theme = (): Theme => memTheme ?? (read(THEME) === "dark" ? "dark" : "light");
export const highContrast = (): boolean => memA11y ?? read(A11Y) === "1";
export const textSize = (): TextSize => { const v = memText ?? read(TEXT); return v === "l" || v === "xl" ? v : "m"; };
export const THEME_COLOR: Record<Theme, string> = { dark: "#0C0C0E", light: "#F6F5F2" };   // v3.0: = --color-canvas (carbon)

export function applyAppearance(doc: Document = document): void {
  const root = doc.documentElement, t = theme();
  root.dataset.theme = t;
  root.classList.remove("theme-light", "theme-dark");
  root.classList.add(t === "dark" ? "theme-dark" : "theme-light");
  if (highContrast()) root.dataset.a11y = "1"; else delete root.dataset.a11y;
  const z = textSize();
  if (z === "m") { delete root.dataset.text; root.style.removeProperty("--fs"); }
  else { root.dataset.text = z; root.style.setProperty("--fs", String(TEXT_SCALE[z])); }
  // Реактивно и без перезагрузки: только атрибуты <html>; сессия и /auth/web-session не трогаются.
  root.dataset.fontScale = SCALE_NAME[z];
  root.style.colorScheme = t;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", t);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[t]);
}
export function setTheme(t: Theme): void { memTheme = t; write(THEME, t); applyAppearance(); subs.forEach((f) => f()); }
export function setTextSize(z: TextSize): void { memText = z; write(TEXT, z === "m" ? null : z); applyAppearance(); subs.forEach((f) => f()); }
export function setHighContrast(on: boolean): void { memA11y = on; write(A11Y, on ? "1" : null); applyAppearance(); subs.forEach((f) => f()); }

/** Компоненты перерисовываются при смене оформления (в т.ч. из другой части интерфейса). */
export function useAppearance(): { theme: Theme; highContrast: boolean; textSize: TextSize } {
  const [, setV] = useState(0);
  useEffect(() => { const f = () => setV((v) => v + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return { theme: theme(), highContrast: highContrast(), textSize: textSize() };
}

/**
 * Master v2.0 · Feature 4 — персонализация ученика: фон (готовый или своё фото), обложка профиля,
 * набор шрифтов и режим различения цветов. Применяется мгновенно (живой предпросмотр на самом приложении).
 *
 * Хранение — ПО АККАУНТУ (accountKey → sf.account.<sha256(аккаунт+роль)>.ui.*): другой аккаунт или демо-
 * персонаж на том же телефоне чужое оформление не видит; песочница стирает свои ключи вместе с собой.
 * Фото — только на этом устройстве (на сервер не уходят). Синхронизировать между устройствами безопасно
 * можно только мелкие выборы (шрифт/цвета/готовый фон) — пока не делаем: см. docs/EXCELLENCE/PERSONALIZATION.md.
 * Тема, размер текста и «Повышенная различимость» — настройки устройства (нужны до входа), lib/theme.ts.
 *
 * Защита читаемости: затемнение фото не ниже вычисленного minVeil для текущей темы; в режиме
 * «Повышенная различимость» пользовательский фон не показывается вовсе (сплошной фон темы).
 */
import { useEffect, useState } from "preact/hooks";
import { accountKey } from "./identity";
import { safeDataImage } from "./imageTools";
import { highContrast, theme } from "./theme";

export type FontSet = "system" | "readable" | "serif";
export type ColorVision = "standard" | "rg" | "by" | "mono";
export type Backdrop = "none" | "dusk" | "tide" | "paper" | "photo";
export type Slot = "app" | "cover";
export interface Personal { font: FontSet; cv: ColorVision; bg: Backdrop; dim: number }
export interface BgImage { url: string; veil: { dark: number; light: number }; w: number; h: number }

export const DEFAULT_PERSONAL: Personal = { font: "system", cv: "standard", bg: "none", dim: 30 };
export const FONTS: FontSet[] = ["system", "readable", "serif"];
export const VISION: ColorVision[] = ["standard", "rg", "by", "mono"];
export const BACKDROPS: Backdrop[] = ["none", "dusk", "tide", "paper", "photo"];
/** Бюджет хранилища на одно изображение (символы data URL ≈ 0,75 байта). */
export const BUDGET: Record<Slot, number> = { app: 380_000, cover: 160_000 };
export const OUT: Record<Slot, { w: number; h: number }> = { app: { w: 720, h: 1280 }, cover: { w: 1080, h: 360 } };

const KEY = "ui.personal.v1";
const IMG: Record<Slot, string> = { app: "ui.bg.app.v1", cover: "ui.bg.cover.v1" };
const subs = new Set<() => void>();
interface State { scope: string; p: Personal; img: Record<Slot, BgImage | null>; memoryOnly: Set<Slot> }
let st: State | null = null;
let undoSnap: { p: Personal; img: Record<Slot, BgImage | null> } | null = null;

const read = (k: string): string | null => { try { return localStorage.getItem(accountKey(k)); } catch { return null; } };
const write = (k: string, v: string | null): boolean => {
  try { if (v === null) localStorage.removeItem(accountKey(k)); else localStorage.setItem(accountKey(k), v); return true; }
  catch { return false; }                                   // квота/приватный режим: остаётся до перезапуска
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed as readonly unknown[]).includes(v) ? (v as T) : d;
const pct = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(90, Math.round(v))) : d);

export function parsePersonal(raw: string | null): Personal {
  try {
    const o = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return { font: pick(o.font, FONTS, "system"), cv: pick(o.cv, VISION, "standard"), bg: pick(o.bg, BACKDROPS, "none"), dim: pct(o.dim, DEFAULT_PERSONAL.dim) };
  } catch { return { ...DEFAULT_PERSONAL }; }
}
export function parseImage(raw: string | null, slot: Slot): BgImage | null {
  try {
    const o = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    const url = o ? safeDataImage(o.url, BUDGET[slot]) : null;
    if (!o || !url) return null;
    const v = (o.veil ?? {}) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.max(1, Math.min(4096, Math.round(x))) : 1);
    return { url, veil: { dark: pct(v.dark, 90), light: pct(v.light, 90) }, w: n(o.w), h: n(o.h) };
  } catch { return null; }
}

function state(): State {
  const scope = accountKey("");
  if (!st || st.scope !== scope) {
    st = { scope, p: parsePersonal(read(KEY)), img: { app: parseImage(read(IMG.app), "app"), cover: parseImage(read(IMG.cover), "cover") }, memoryOnly: new Set() };
    undoSnap = null;                                         // отмена не переносится между аккаунтами
  }
  return st;
}
const notify = () => { applyPersonal(); subs.forEach((f) => f()); };
const snap = () => { const s = state(); undoSnap = { p: { ...s.p }, img: { ...s.img } }; };

export const personal = (): Personal => ({ ...state().p });
export const bgImage = (slot: Slot): BgImage | null => state().img[slot];
/** Фото не поместилось в хранилище: держим до перезапуска и честно говорим об этом. */
export const memoryOnly = (slot: Slot): boolean => state().memoryOnly.has(slot);
export const canUndo = (): boolean => undoSnap !== null;
export const isDefault = (): boolean => { const s = state(); return JSON.stringify(s.p) === JSON.stringify(DEFAULT_PERSONAL) && !s.img.app && !s.img.cover; };

export function setPersonal(patch: Partial<Personal>): void {
  const s = state(); snap();
  s.p = parsePersonal(JSON.stringify({ ...s.p, ...patch }));
  write(KEY, JSON.stringify(s.p)); notify();
}
/** Сохранить/удалить фото слота. Возвращает false, если сохранить на устройстве не удалось (только до перезапуска). */
export function setBgImage(slot: Slot, img: BgImage | null): boolean {
  const s = state(); snap();
  const clean = img ? parseImage(JSON.stringify(img), slot) : null;
  s.img = { ...s.img, [slot]: clean };
  const ok = write(IMG[slot], clean ? JSON.stringify(clean) : null);
  if (ok || !clean) s.memoryOnly.delete(slot); else s.memoryOnly.add(slot);
  if (slot === "app") { s.p = { ...s.p, bg: clean ? "photo" : s.p.bg === "photo" ? "none" : s.p.bg }; write(KEY, JSON.stringify(s.p)); }
  notify();
  return ok || !clean;
}
export function undoPersonal(): boolean {
  if (!undoSnap) return false;
  const s = state(), u = undoSnap; undoSnap = null;
  s.p = u.p; s.img = u.img;
  write(KEY, JSON.stringify(s.p));
  (["app", "cover"] as Slot[]).forEach((k) => { if (!write(IMG[k], s.img[k] ? JSON.stringify(s.img[k]) : null) && s.img[k]) s.memoryOnly.add(k); });
  notify(); return true;
}
/** «Вернуть стандартный вид»: всё к исходному; сам сброс тоже можно отменить (до перезапуска). */
export function resetPersonal(): void {
  const s = state(); snap();
  s.p = { ...DEFAULT_PERSONAL }; s.img = { app: null, cover: null }; s.memoryOnly.clear();
  write(KEY, null); write(IMG.app, null); write(IMG.cover, null);
  notify();
}

/** Минимальное затемнение готовых фонов (они рисуются цветами темы, контраст проверен тестом). */
export const PRESET_VEIL: Record<Exclude<Backdrop, "none" | "photo">, number> = { dusk: 0, tide: 0, paper: 0 };
/** Итоговое затемнение (0…0.9) — не ниже порога читаемости для текущей темы. */
export function veilFor(p: Personal = personal(), t: "dark" | "light" = theme()): number {
  if (p.bg === "none") return 0;
  const floor = p.bg === "photo" ? bgImage("app")?.veil[t] ?? 90 : PRESET_VEIL[p.bg];
  return Math.max(p.dim, floor) / 100;
}
/** Что реально видно: в «Повышенной различимости» и без фото — сплошной фон темы. */
export function visibleBackdrop(p: Personal = personal()): Backdrop {
  if (highContrast()) return "none";
  if (p.bg === "photo" && !bgImage("app")) return "none";
  return p.bg;
}

export function applyPersonal(doc: Document = document): void {
  const root = doc.documentElement, p = personal();
  if (p.font === "system") delete root.dataset.font; else root.dataset.font = p.font;
  if (p.cv === "standard") delete root.dataset.cv; else root.dataset.cv = p.cv;
  const b = visibleBackdrop(p);
  if (b === "none") delete root.dataset.backdrop; else root.dataset.backdrop = b;
}

export function usePersonal(): Personal {
  const [, setV] = useState(0);
  useEffect(() => { const f = () => setV((v) => v + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return personal();
}

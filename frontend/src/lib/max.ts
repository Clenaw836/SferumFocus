/**
 * Тонкая обёртка над MAX Bridge (window.WebApp, https://dev.max.ru/docs/webapps/bridge).
 * Используются ТОЛЬКО задокументированные поля и методы. Вне MAX (обычный браузер,
 * демо на ноутбуке) каждый вызов безопасно превращается в no-op / web-фоллбек.
 */
import { guardOwnsReady, guardSendReady } from "./bootDiag";
type Impact = "soft" | "light" | "medium" | "heavy" | "rigid";
type Notice = "success" | "warning" | "error";

interface MaxWebApp {
  initData?: string;
  initDataUnsafe?: {
    user?: { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string };
    start_param?: string;
    chat?: { id: number; type: "DIALOG" | "CHAT" | "CHANNEL" };
  };
  platform?: "ios" | "android" | "desktop" | "web";
  version?: string;
  deviceName?: string;
  PermissionsManager?: {
    isInited: boolean;
    isCameraAppAccessGranted?: boolean; isCameraSystemAccessGranted?: boolean;
    isMicAppAccessGranted?: boolean; isMicSystemAccessGranted?: boolean;
    init(): Promise<unknown>;
    requestAccess(permissions: "camera" | "mic" | ("camera" | "mic")[], reason?: string): Promise<unknown>;
    openMaxSettings(): Promise<unknown>; openSystemSettings(): Promise<unknown>;
  };
  ready?: () => void;
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: Impact, disableVibrationFallback?: boolean): void;
    notificationOccurred(type: Notice, disableVibrationFallback?: boolean): void;
    selectionChanged(disableVibrationFallback?: boolean): void;
  };
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  openMaxLink?: (url: string) => void;
  openLink?: (url: string) => void;
  shareMaxContent?: (p: { text?: string; link?: string }) => unknown;
  shareContent?: (p: { text?: string; link?: string }) => unknown;
  /** Хранилище устройства, привязанное к пользователю MAX (не поддерживается web-версией MAX). */
  DeviceStorage?: { setItem(k: string, v: string): unknown; getItem(k: string): unknown; removeItem(k: string): unknown };
  /** v2.2 · сканер QR MAX: Promise со строкой из кода (fileSelect=true — ещё и выбор фото из галереи). */
  openCodeReader?: (fileSelect?: boolean) => Promise<string>;
  /** v2.2 · яркость экрана на максимум (MAX держит её ~30 с, потом возвращает сам). */
  requestScreenMaxBrightness?: () => Promise<unknown>;
  restoreScreenBrightness?: () => Promise<unknown>;
}

declare global { interface Window { WebApp?: MaxWebApp } }

const wa = (): MaxWebApp | undefined => (typeof window !== "undefined" ? window.WebApp : undefined);

/** Ждём async-скрипт max-web-app.js не дольше `ms`; вне MAX — сразу идём дальше. */
export function whenBridge(ms = 1200): Promise<MaxWebApp | undefined> {
  return new Promise((resolve) => {
    if (wa()) return resolve(wa());
    const t0 = Date.now();
    const id = setInterval(() => {
      if (wa() || Date.now() - t0 > ms) { clearInterval(id); resolve(wa()); }
    }, 60);
  });
}

/** Параметры платформы из URL-фрагмента (#WebAppData=…&WebAppPlatform=…) — по докам MAX
 *  они приходят при каждом запуске. Нужны, если max-web-app.js не загрузился (сеть/блок). */
const LAUNCH_KEYS = ["WebAppData", "WebAppPlatform", "WebAppVersion", "WebAppStartParam"] as const;
type LaunchKey = (typeof LAUNCH_KEYS)[number];
function liveFragment(): URLSearchParams {
  try { return new URLSearchParams((typeof location !== "undefined" ? location.hash : "").replace(/^#/, "")); } catch { return new URLSearchParams(); }
}
/** P0-01: снимок параметров запуска — при загрузке модуля, ДО любого роутинга, и при первом появлении позже.
 *  Только память (как у Telegram, lib/telegramLaunch.ts): смена вкладки (#tonight, #teacher-…) больше не стирает
 *  подписанные данные. Повтор ключа во фрагменте — неоднозначность: значение не угадывается (""). */
const pinned: Partial<Record<LaunchKey, string>> = {};
function capture(): void {
  const p = liveFragment();
  for (const k of LAUNCH_KEYS) {
    if (pinned[k] !== undefined) continue;
    const all = p.getAll(k);
    if (all.length === 1 && all[0]) pinned[k] = all[0];
    else if (all.length > 1) pinned[k] = "";
  }
}
capture();
const launchParam = (k: LaunchKey): string => { capture(); return pinned[k] || ""; };

/** Маршрут приложения во фрагменте — часть до первого «&» (дальше могут идти параметры запуска MAX). */
export function routeOf(hash: string): string {
  const head = (hash || "").replace(/^#/, "").split("&", 1)[0];
  return head.includes("=") ? "" : head;
}
/** Фрагмент для внутреннего маршрута: параметры запуска MAX, если они ещё в адресе, не стираются
 *  (перезагрузка страницы и поздно загрузившийся bridge их найдут). Вне MAX — ровно «#route». */
export function withLaunch(route: string): string {
  const cur = liveFragment(), keep = new URLSearchParams();
  for (const k of LAUNCH_KEYS) for (const v of cur.getAll(k)) keep.append(k, v);
  const tail = keep.toString();
  return `#${route.replace(/^#/, "")}${tail ? "&" + tail : ""}`;
}

/** Подписанная строка initData для проверки на сервере (заголовок X-Max-Init-Data). */
export const initData = (): string => wa()?.initData || launchParam("WebAppData") || "";

/** В MAX ли мы: есть подписанные стартовые данные (в обычном браузере их нет). */
export const inMax = (): boolean => !!initData();

type MaxUser = NonNullable<NonNullable<MaxWebApp["initDataUnsafe"]>["user"]>;
/** Пользователь MAX: из bridge, а если скрипт не загрузился — из подписанного WebAppData. */
export const maxUser = (): MaxUser | undefined => {
  const u = wa()?.initDataUnsafe?.user;
  if (u) return u;
  try { const raw = new URLSearchParams(initData()).get("user"); return raw ? (JSON.parse(raw) as MaxUser) : undefined; } catch { return undefined; }
};

/** start_param из диплинка https://max.ru/<bot>?startapp=<payload>; вне MAX — ?startapp= в URL. */
export function startParam(): string {
  const fromMax = wa()?.initDataUnsafe?.start_param;
  if (fromMax) return fromMax;
  const q = new URLSearchParams(location.search);
  return q.get("WebAppStartParam") || launchParam("WebAppStartParam") || q.get("startapp") || "";
}

/** Bridge только внутри MAX: вне клиента его методы отвечают rejected-промисами. */
const bw = (): MaxWebApp | undefined => (inMax() ? wa() : undefined);
/** Глушим rejected-промисы bridge (старые клиенты MAX не знают часть методов). */
const quiet = (r: unknown): void => { if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined); };

/** WebApp.ready() — ровно один раз и даже если async max-web-app.js пришёл позже бандла (P0: раньше вызов
 *  до появления bridge молча терялся, и клиент MAX не получал WebAppReady). Если на странице есть ES5-сторож
 *  (bootguard.js) — доставку ведёт он (он же шлёт ready() рано, ещё до проверки входа). */
let readySent = false;
let readyTimer: ReturnType<typeof setInterval> | null = null;
export const ready = (): void => {
  if (readySent || readyTimer) return;
  if (guardOwnsReady()) { readySent = guardSendReady(); if (readySent) return; }
  const attempt = (): boolean => {
    if (readySent) return true;
    if (guardOwnsReady()) { readySent = guardSendReady(); return readySent; }
    try { const w = bw(); if (w?.ready) { quiet(w.ready()); readySent = true; } } catch { /* вне MAX */ }
    return readySent;
  };
  if (attempt() || !inMax()) return;
  let n = 0;
  readyTimer = setInterval(() => { n++; if (attempt() || n > 600) { clearInterval(readyTimer!); readyTimer = null; } }, 50);
};

const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const haptic = {
  tap(style: Impact = "light") { try { quiet(bw()?.HapticFeedback?.impactOccurred(style)); } catch { /* no-op */ } },
  select() { try { quiet(bw()?.HapticFeedback?.selectionChanged()); } catch { /* no-op */ } },
  notify(type: Notice) {
    try {
      const h = bw()?.HapticFeedback;
      if (h) quiet(h.notificationOccurred(type));
      else if (!reduceMotion() && "vibrate" in navigator && type !== "warning" && (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive !== false) navigator.vibrate(type === "success" ? [12, 40, 18] : 30);
    } catch { /* no-op */ }
  },
};

/**
 * Нативная «Назад» MAX — ОДИН стек на всё приложение (иерархия навигации):
 * шторка поверх шторки, вопрос блица поверх арены. Кнопка видна, только пока стек
 * не пуст; нажатие закрывает верхний уровень. Корневые вкладки дока — не уровни стека:
 * «Назад» никогда не прыгает между вкладками и не закрывает мини-апп случайно.
 */
const backStack: { cb: () => void }[] = [];
let backBound = false;
let backShown = false;
const onBackPress = () => { const top = backStack[backStack.length - 1]; top?.cb(); };
function syncBack(): void {
  const b = bw()?.BackButton; if (!b) return;
  try {
    if (!backBound) { quiet(b.onClick(onBackPress)); backBound = true; }
    const want = backStack.length > 0;
    if (want !== backShown) { quiet(want ? b.show() : b.hide()); backShown = want; }
  } catch { /* старый клиент */ }
}
export function bindBack(cb: () => void): () => void {
  const entry = { cb };
  backStack.push(entry); syncBack();
  return () => { const i = backStack.lastIndexOf(entry); if (i >= 0) backStack.splice(i, 1); syncBack(); };
}
export const backDepth = () => backStack.length;

/** Подтверждение закрытия: включено, пока есть хоть одна причина (идёт таймер, раунд блица, дуэль). */
const guards = new Set<string>();
let guardOn = false;
export function closingGuard(on: boolean, reason = "game"): void {
  if (on) guards.add(reason); else guards.delete(reason);
  const want = guards.size > 0;
  if (want === guardOn) return;
  guardOn = want;
  try { quiet(want ? bw()?.enableClosingConfirmation?.() : bw()?.disableClosingConfirmation?.()); } catch { /* no-op */ }
}

/** Платформа запуска: из bridge, иначе из фрагмента #WebAppPlatform, иначе «браузер». */
export function launchInfo(): { inMax: boolean; platform: string; version: string | null; device: string | null; chat: string | null } {
  const w = wa();
  return {
    inMax: inMax(),
    platform: (inMax() && (w?.platform || launchParam("WebAppPlatform"))) || "browser",
    version: (inMax() && (w?.version || launchParam("WebAppVersion"))) || null,
    device: (inMax() && w?.deviceName) || null,
    chat: (inMax() && w?.initDataUnsafe?.chat?.type) || null,
  };
}

/** Платформа → data-атрибут, высота визуального вьюпорта → --vvh (клавиатура не перекрывает шторки). */
export function setupViewport(): void {
  const root = document.documentElement;
  const li = launchInfo();
  root.dataset.platform = li.platform;
  if (li.inMax) root.dataset.max = "1";
  const vv = window.visualViewport;
  // v3.2 · клавиатура в WebView MAX/Telegram: нижнее меню и фокус-док «всплывали» над клавиатурой и закрывали
  // поле ввода. Клавиатура открыта = фокус в поле ввода и видимая высота < 80 % обычной → data-kb, меню прячется.
  let tall = vv ? vv.height : innerHeight;
  const editable = (el: Element | null) => !!el && (el.matches("textarea,select,[contenteditable]:not([contenteditable=false])")
    || (el.matches("input") && !/^(button|checkbox|radio|range|submit|reset|file|color|image)$/.test((el as HTMLInputElement).type)));
  const set = () => {
    const h = Math.round(vv ? vv.height : innerHeight);
    root.style.setProperty("--vvh", `${h}px`);
    const typing = editable(document.activeElement);
    if (!typing) tall = Math.max(tall, h);
    // экранная клавиатура бывает только у сенсорных устройств: на компьютере сжатое окно — не клавиатура
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (touch && typing && h < tall * 0.8) root.dataset.kb = "1"; else delete root.dataset.kb;
  };
  set();
  (vv ?? window).addEventListener("resize", set, { passive: true });
  document.addEventListener("focusin", () => setTimeout(set, 300), { passive: true });
  document.addEventListener("focusout", () => setTimeout(set, 50), { passive: true });
  addEventListener("orientationchange", () => { tall = 0; setTimeout(set, 400); }, { passive: true });
}

/** Открыть ссылку: max.ru — внутри MAX (openMaxLink), внешнюю — системным браузером (openLink). Только https. */
export function openUrl(url: string): void {
  if (!/^https:\/\//.test(url)) return;
  const w = bw();
  try {
    if (/^https:\/\/max\.ru\//.test(url) && w?.openMaxLink) { quiet(w.openMaxLink(url)); return; }
    if (w?.openLink) { quiet(w.openLink(url)); return; }
  } catch { /* фоллбек ниже */ }
  window.open(url, "_blank", "noopener");
}

/** startapp-пейлоад: алфавит MAX (A-Z a-z 0-9 _ -), ≤512 символов. Каждый вид — реальный сценарий. */
export type Start =
  | { kind: "none" }
  | { kind: "plan" | "duel" | "blitz" | "practice" | "focus" | "progress" | "study" | "diary" | "tutor" | "teacher" | "student" | "add" | "demo" }
  | { kind: "challenge"; raw: string }
  | { kind: "task"; id: string }
  | { kind: "join"; code: string }
  | { kind: "quiz"; template: string }
  | { kind: "invalid"; raw: string };
const SIMPLE = ["plan", "duel", "blitz", "practice", "focus", "progress", "study", "diary", "tutor", "teacher", "student", "add", "demo"] as const;
export function parseStart(raw: string): Start {
  if (!raw) return { kind: "none" };
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { kind: "invalid", raw: raw.slice(0, 40) };
  if ((SIMPLE as readonly string[]).includes(raw)) return { kind: raw as (typeof SIMPLE)[number] };
  if (raw.startsWith("blitz_")) return { kind: "challenge", raw };
  const m = /^task_([a-z0-9]{1,12})$/.exec(raw);
  if (m) return { kind: "task", id: m[1] };
  const j = /^join_([A-Za-z0-9]{4,16})$/.exec(raw);
  if (j) return { kind: "join", code: j[1].toUpperCase() };
  const q = /^quiz_(tpl_[0-9a-f]{32})$/.exec(raw);   // v2.2 · QR «Показать классу»: опрос учителя (сервер проверит выдачу)
  if (q) return { kind: "quiz", template: q[1] };
  return { kind: "invalid", raw };
}

/** v2.2 · есть ли сканер QR MAX (WebApp.openCodeReader). Вне MAX — нет: ученик вводит код из 6 цифр. */
export const canScanCode = (): boolean => typeof bw()?.openCodeReader === "function";
/** Сканирует QR камерой MAX. null — отмена, нет сканера или ошибка (вызывающий показывает ввод кода). */
export async function scanCode(): Promise<string | null> {
  const w = bw();
  if (!w?.openCodeReader) return null;
  try { const v = await w.openCodeReader(true); return typeof v === "string" && v ? v.slice(0, 2048) : null; } catch { return null; }
}
/** startapp-пейлоад из отсканированной ссылки https://max.ru/<bot>?startapp=… (или ссылки веб-версии). */
export function startFromLink(text: string): string {
  try {
    const u = new URL(text.trim());
    if (u.protocol !== "https:") return "";
    return u.searchParams.get("startapp") ?? u.searchParams.get("start") ?? "";
  } catch { return ""; }
}
/** Яркость на максимум, пока на экране QR (best effort; MAX сам вернёт её через ~30 с). */
export function brightScreen(on: boolean): void {
  const w = bw();
  try { quiet(on ? w?.requestScreenMaxBrightness?.() : w?.restoreScreenBrightness?.()); } catch { /* нет метода — не важно */ }
}
/** Короткий стабильный id задания для диплинка task_<id>. */
export function taskId(title: string): string {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h << 5) + h + title.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Поделиться результатом: внутри MAX — нативный экран шеринга, в вебе — Web Share / буфер. */
export async function share(text: string, link?: string): Promise<"max" | "web" | "copied" | "none"> {
  const w = bw();
  const p = link ? { text, link } : { text };
  try {
    if (w?.shareMaxContent) { await w.shareMaxContent(p); return "max"; }
    if (w?.shareContent) { await w.shareContent(p); return "max"; }
    if (navigator.share) { await navigator.share(link ? { text, url: link } : { text }); return "web"; }
    const copy = navigator.clipboard?.writeText;
    if (!copy) return "none";
    await copy.call(navigator.clipboard, link ? `${text} ${link}` : text); return "copied";
  } catch { return "none"; }
}

/** Диплинк в мини-апп: в MAX — https://max.ru/<bot>?startapp=<payload> (payload: A-Z a-z 0-9 _ -, ≤512);
 *  вне MAX — тот же payload в адресе текущей страницы, чтобы ссылка работала и в браузере жюри. */
export function appLink(payload: string, botName?: string | null): string {
  const safe = payload.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 512);
  if (botName) return `https://max.ru/${botName}?startapp=${safe}`;
  return `${location.origin}${location.pathname}?startapp=${safe}`;
}

/** DeviceStorage MAX как зеркало localStorage: переживает очистку кэша WebView. Вне MAX — no-op. */
export const deviceStore = {
  set(k: string, v: string | null): void {
    const d = bw()?.DeviceStorage; if (!d) return;
    try { quiet(v === null ? d.removeItem(k) : d.setItem(k, v)); } catch { /* старый клиент */ }
  },
  async get(k: string): Promise<string | null> {
    const d = bw()?.DeviceStorage; if (!d) return null;
    try {
      const r = await Promise.race([Promise.resolve(d.getItem(k)), new Promise((res) => setTimeout(() => res(null), 800))]);
      if (typeof r === "string") return r;
      if (r && typeof r === "object") { const o = r as Record<string, unknown>; const v = o.value ?? o[k]; return typeof v === "string" ? v : null; }
      return null;
    } catch { return null; }
  },
};

/** Capability check for an explicit user-initiated external auth action. */
export function hasExternalLinkBridge(): boolean {
  return typeof bw()?.openLink === 'function';
}

/** Explicit user controls only; actual Bridge signature is requestAccess(kind, reason?). */
export async function requestMediaAccess(kind: "camera" | "mic", beforePrompt?: () => Promise<void>): Promise<void> {
  const w = bw(), p = w?.PermissionsManager;
  if (!p || !["android", "web"].includes(w?.platform || "")) return;
  await beforePrompt?.();
  if (!p.isInited) await p.init();
  await p.requestAccess(kind, kind === "camera" ? "Фото решения для репетитора" : "Голосовой вопрос помощнику");
  const app = kind === "camera" ? p.isCameraAppAccessGranted : p.isMicAppAccessGranted;
  const system = kind === "camera" ? p.isCameraSystemAccessGranted : p.isMicSystemAccessGranted;
  if (app === false || system === false) throw new Error("Доступ не выдан. Разреши его в настройках MAX или используй текст/готовый файл.");
}
export async function openMediaSettings(system = false): Promise<void> {
  const p = bw()?.PermissionsManager; if (!p) return;
  if (!p.isInited) await p.init();
  if (system) await p.openSystemSettings(); else await p.openMaxSettings();
}

/** v2.1 · Подгонка под экран WebView MAX / Telegram / браузера (320–430 px телефоны, планшеты, десктоп).
 *  Проблема из проверки в MAX (Android, 3-кнопочная навигация): WebView сообщает env(safe-area-inset-bottom)
 *  ≈ высоте системной панели, хотя сам не рисует под ней → под таб-баром пустая полоса, экран «стоит неровно».
 *  Решение: измеряем вставку пробником и на Android ограничиваем нижний отступ (жестовая навигация ≤ 16 px);
 *  iOS сохраняет полный отступ под индикатор «домой». Плюс класс ширины для точной подгонки сеток. */
export type InsetMode = "native" | "android-capped" | "none";
export const ANDROID_BOTTOM_CAP_PX = 16;

export function measureBottomInset(doc: Document = document): number {
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
  (doc.body ?? doc.documentElement).appendChild(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(h) ? Math.max(0, Math.round(h)) : 0;
}
export function insetMode(ua: string, inset: number): InsetMode {
  if (inset <= 0) return "none";
  if (/Android/i.test(ua)) return inset > ANDROID_BOTTOM_CAP_PX ? "android-capped" : "native";
  return "native";
}
/** Класс ширины: xs < 360 ≤ sm < 400 ≤ md < 600 ≤ tablet < 1024 ≤ desktop. */
export function widthClass(w: number): "xs" | "sm" | "md" | "tablet" | "desktop" {
  return w < 360 ? "xs" : w < 400 ? "sm" : w < 600 ? "md" : w < 1024 ? "tablet" : "desktop";
}
export function installViewportFit(win: Window = window): void {
  const doc = win.document, root = doc.documentElement;
  const apply = () => {
    const inset = measureBottomInset(doc);
    root.dataset.insetB = insetMode(win.navigator.userAgent, inset);
    root.dataset.vw = widthClass(win.innerWidth);
  };
  apply();
  let raf = 0;
  const later = () => { if (raf) return; raf = win.requestAnimationFrame(() => { raf = 0; apply(); }); };
  win.addEventListener("resize", later, { passive: true });
  win.addEventListener("orientationchange", later, { passive: true });
}

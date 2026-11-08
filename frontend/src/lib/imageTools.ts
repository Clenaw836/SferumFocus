/**
 * Master v2.0 · Features 1 и 4: обработка своих изображений (аватар, фон) на телефоне.
 * Чистые функции (геометрия обрезки, контраст, защита читаемости) тестируются в Node;
 * браузерная часть (decode → canvas → data URL) — в конце файла.
 *
 * Ограничения (контроль памяти и времени): файл ≤ 15 МБ, только JPEG/PNG/WebP (без SVG/HEIC),
 * исходник ≤ 50 Мп, результат — уменьшенная копия (аватар 256×256, фон ≤ 720×1280), исходник не хранится.
 */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 50_000_000;
export const ACCEPT = ["image/jpeg", "image/png", "image/webp"] as const;

export interface Crop { zoom: number; x: number; y: number }   // zoom ≥ 1; x,y ∈ [-1, 1] — сдвиг внутри запаса
export interface Rect { sx: number; sy: number; sw: number; sh: number }
export const CENTER: Crop = { zoom: 1, x: 0, y: 0 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Какая часть исходника (в пикселях исходника) попадёт в кадр outW×outH: «cover» + масштаб + сдвиг. */
export function cropRect(imgW: number, imgH: number, outW: number, outH: number, c: Crop): Rect {
  const r = outW / outH, z = clamp(c.zoom, 1, 8);
  let sw = imgW, sh = imgW / r;
  if (sh > imgH) { sh = imgH; sw = imgH * r; }
  sw /= z; sh /= z;
  const cx = imgW / 2 + clamp(c.x, -1, 1) * (imgW - sw) / 2;
  const cy = imgH / 2 + clamp(c.y, -1, 1) * (imgH - sh) / 2;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** Перетаскивание на dx,dy экранных пикселей в окне просмотра viewW×viewH: картинка «едет» за пальцем. */
export function panBy(c: Crop, dx: number, dy: number, viewW: number, viewH: number, imgW: number, imgH: number): Crop {
  const r = cropRect(imgW, imgH, viewW, viewH, c);
  const spareX = (imgW - r.sw) / 2, spareY = (imgH - r.sh) / 2;
  const nx = spareX > 0.5 ? c.x - (dx * r.sw / viewW) / spareX : 0;
  const ny = spareY > 0.5 ? c.y - (dy * r.sh / viewH) / spareY : 0;
  return { zoom: c.zoom, x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
}

export function fitSize(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// ---------- контраст (WCAG 2.x) и защита читаемости фона ----------
export type RGB = [number, number, number];
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: RGB): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGB, b: RGB): number => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export function hex(h: string): RGB { const m = /^#?([0-9a-f]{6})$/i.exec(h.trim()); if (!m) throw new Error("bad color " + h); const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

/** Цвета, с которыми текст лежит прямо на фоне (заголовки экранов), и подложка для затемнения — по теме. */
export const READ_ON: Record<"dark" | "light", { text: RGB; muted: RGB; veil: RGB }> = {
  dark: { text: hex("#f4f5f8"), muted: hex("#8a91a0"), veil: hex("#090a0d") },   // design-system-core.css: --color-text / --color-text-muted / --color-canvas
  light: { text: hex("#0b0d12"), muted: hex("#4f5663"), veil: hex("#f7f7f8") },  // design-system-core.css, слой @light-manual (светлая)
};

/**
 * Минимальное затемнение (0…90 %), при котором ≥ coverage пикселей фона дают контраст ≥ target
 * со вторичным текстом темы (он слабее основного — значит, и основной читается).
 * Смешивание как у браузера: в sRGB, подложка цвета фона темы с непрозрачностью a.
 * pixels — RGBA (как ImageData.data) уменьшенной копии.
 */
export function minVeil(pixels: ArrayLike<number>, theme: "dark" | "light", target = 4.5, coverage = 0.95): number {
  const { muted, veil } = READ_ON[theme];
  const n = Math.floor(pixels.length / 4);
  if (!n) return 0;
  const step = Math.max(1, Math.floor(n / 4096));            // не больше ~4 тыс. проб: быстро и на слабом телефоне
  const px: RGB[] = [];
  for (let i = 0; i < n; i += step) px.push([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]);
  const need = Math.ceil(px.length * coverage);
  for (let a = 0; a <= 90; a++) {
    const k = a / 100; let ok = 0;
    for (const p of px) {
      const q: RGB = [p[0] * (1 - k) + veil[0] * k, p[1] * (1 - k) + veil[1] * k, p[2] * (1 - k) + veil[2] * k];
      if (contrast(q, muted) >= target) ok++;
    }
    if (ok >= need) return a;
  }
  return 90;
}

// ---------- браузер: проверка файла, декодирование, обрезка, сжатие ----------
export class ImageInputError extends Error {}

export function checkFile(f: { type: string; size: number; name?: string }): void {
  if (!(ACCEPT as readonly string[]).includes(f.type)) {
    throw new ImageInputError(/heic|heif/i.test(f.type + (f.name ?? "")) ? "Формат HEIC не поддерживается браузером — выберите JPEG, PNG или WebP (на iPhone: «Настройки → Камера → Форматы → Наиболее совместимые»)." : "Подходят только JPEG, PNG или WebP.");
  }
  if (f.size > MAX_FILE_BYTES) throw new ImageInputError("Файл больше 15 МБ — выберите изображение поменьше.");
  if (f.size < 64) throw new ImageInputError("Файл пустой или повреждён.");
}

export interface Decoded { src: CanvasImageSource; w: number; h: number; release: () => void }

/** Декодирование без вставки в DOM; object URL освобождается сразу после загрузки. */
export async function decode(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new ImageInputError("Не удалось прочитать изображение — файл повреждён или формат не поддерживается.")); img.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new ImageInputError("Не удалось прочитать изображение.");
    if (w * h > MAX_SOURCE_PIXELS) throw new ImageInputError("Изображение слишком большое (больше 50 Мп) — уменьшите его.");
    if (Math.min(w, h) < 64) throw new ImageInputError("Изображение слишком маленькое (меньше 64 px).");
    return { src: img, w, h, release: () => { img.src = ""; } };
  } finally { URL.revokeObjectURL(url); }
}

export function render(d: Decoded, c: Crop, outW: number, outH: number): HTMLCanvasElement {
  const cv = document.createElement("canvas"); cv.width = outW; cv.height = outH;
  const g = cv.getContext("2d");
  if (!g) throw new ImageInputError("Браузер не дал нарисовать изображение.");
  const r = cropRect(d.w, d.h, outW, outH, c);
  g.imageSmoothingEnabled = true; (g as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  g.drawImage(d.src, r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH);
  return cv;
}

/** Сжатие под бюджет хранилища: WebP, если браузер умеет, иначе JPEG; качество снижается ступенями. */
export function toBudget(cv: HTMLCanvasElement, maxChars: number): string | null {
  const webp = cv.toDataURL("image/webp", 0.8).startsWith("data:image/webp");
  for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
    const url = cv.toDataURL(webp ? "image/webp" : "image/jpeg", q);
    if (url.length <= maxChars) return url;
  }
  return null;
}

/** Пиксели уменьшенной копии для minVeil (≈ 48×85). */
export function sample(cv: HTMLCanvasElement): Uint8ClampedArray {
  const s = document.createElement("canvas"); const k = Math.min(1, 96 / Math.max(cv.width, cv.height));
  s.width = Math.max(1, Math.round(cv.width * k)); s.height = Math.max(1, Math.round(cv.height * k));
  const g = s.getContext("2d"); if (!g) return new Uint8ClampedArray();
  g.drawImage(cv, 0, 0, s.width, s.height);
  return g.getImageData(0, 0, s.width, s.height).data;
}

/** Только data URL наших форматов — никакого javascript:/svg/внешних адресов из хранилища. */
export const safeDataImage = (v: unknown, maxChars: number): string | null =>
  typeof v === "string" && v.length <= maxChars && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v) ? v : null;

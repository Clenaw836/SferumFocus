/**
 * v2.2 · QR-код для «Показать классу» — свой кодировщик, без зависимостей и без сети.
 *
 * QR Code Model 2 (ISO/IEC 18004): байтовый режим (UTF-8), уровень коррекции M (~15 %), версии 1–20,
 * все 8 масок со штрафами стандарта — выбирается лучшая. Алгоритм повторяет открытый эталон
 * Nayuki «QR Code generator» (MIT). Проверка: tests/unit/qr_v22.test.mts (структура, BCH-поля,
 * Рида — Соломона) и scripts/check_qr.py (настоящий декодер OpenCV читает то, что мы нарисовали).
 *
 * Код ведёт только на страницу опроса; доступ к опросу по-прежнему проверяет сервер (выдача ученику).
 */

const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
export const QR_MAX_VERSION = 20;

export interface QrCode { version: number; size: number; mask: number; modules: boolean[][] }

/** Модулей под данные и коррекцию (без служебных узоров). */
export function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    r -= (25 * align - 10) * align - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
export const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - ECC_M[ver] * BLOCKS_M[ver];

/* ---------- GF(256), полином 0x11D ---------- */
function gmul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
export function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gmul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gmul(root, 0x02);
  }
  return out;
}
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((c, i) => { out[i] ^= gmul(c, factor); });
  }
  return out;
}

function eccInterleave(data: number[], ver: number): number[] {
  const blocks = BLOCKS_M[ver], eccLen = ECC_M[ver], raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks), shortLen = Math.floor(raw / blocks);
  const div = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < shortBlocks) dat.push(0);
    all.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(b[i]); });
  }
  return out;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** 15 бит формата: уровень M (00) + маска, BCH(15,5), XOR 0x5412. */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
/** 18 бит версии (≥7): BCH(18,6), полином 0x1F25. */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}
const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

class Grid {
  readonly size: number;
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) { this.m[y][x] = dark; this.fn[y][x] = true; }
  functionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = alignmentPositions(this.ver), n = al.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.format(0);
    if (this.ver >= 7) {
      const bits = versionBits(this.ver);
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3), b = Math.floor(i / 3), c = bit(bits, i);
        this.set(a, b, c); this.set(b, a, c);
      }
    }
  }
  format(mask: number) {
    const bits = formatBits(mask), s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6)); this.set(8, 8, bit(bits, 7)); this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(bits, i));
    this.set(8, s - 8, true);
  }
  codewords(data: number[]) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < s; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? s - 1 - v : v;
        if (!this.fn[y][x] && i < data.length * 8) { this.m[y][x] = bit(data[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
  }
  mask(k: number) {
    const s = this.size;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      let inv: boolean;
      switch (k) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      if (!this.fn[y][x] && inv) this.m[y][x] = !this.m[y][x];
    }
  }
  penalty(): number {
    const s = this.size, m = this.m;
    let total = 0;
    const addHist = (run: number, h: number[]) => { if (h[0] === 0) run += s; h.pop(); h.unshift(run); };
    const count = (h: number[]) => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    const line = (get: (i: number) => boolean) => {
      let color = false, run = 0, p = 0;
      const h = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < s; i++) {
        if (get(i) === color) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else { addHist(run, h); if (!color) p += count(h) * 40; color = get(i); run = 1; }
      }
      if (color) { addHist(run, h); run = 0; }
      run += s; addHist(run, h);
      return p + count(h) * 40;
    };
    for (let y = 0; y < s; y++) total += line((x) => m[y][x]);
    for (let x = 0; x < s; x++) total += line((y) => m[y][x]);
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) total += 3;
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const all = s * s;
    total += (Math.ceil(Math.abs(dark * 20 - all * 10) / all) - 1) * 10;
    return total;
  }
}

/** Кодирует текст (UTF-8). Бросает RangeError, если не помещается в версию 20 (≈ 660 байт). */
export function encodeQr(text: string, forceMask?: number): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= QR_MAX_VERSION; ver++) {
    const used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (used <= dataCodewords(ver) * 8) break;
  }
  if (ver > QR_MAX_VERSION) throw new RangeError("Слишком длинный текст для QR-кода");
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const g = new Grid(ver);
  g.functionPatterns();
  g.codewords(eccInterleave(data, ver));
  let best = forceMask ?? -1;
  if (best < 0) {
    let min = Infinity;
    for (let k = 0; k < 8; k++) {
      g.mask(k); g.format(k);
      const p = g.penalty();
      if (p < min) { min = p; best = k; }
      g.mask(k);
    }
  }
  g.mask(best); g.format(best);
  return { version: ver, size: g.size, mask: best, modules: g.m.map((r) => r.slice()) };
}

/** SVG-путь тёмных модулей (одна команда на горизонтальный отрезок) с тихой зоной `quiet` модулей. */
export function qrPath(code: QrCode, quiet = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    for (let x = 0; x < code.size; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < code.size && row[x + w]) w++;
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
      x += w - 1;
    }
  });
  return parts.join("");
}

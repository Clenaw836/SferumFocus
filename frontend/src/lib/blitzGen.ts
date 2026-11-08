/**
 * v3.2.1 · Генераторы блиц-вопросов: бесконечно новые задачи без сети (алгебра, геометрия, физика, химия).
 * Каждый вопрос — тот же контракт BankQ, что и в банке: первый вариант верный, `why` объясняет решение.
 * Дистракторы — типичные ошибки школьника (знак, забыл квадрат/корень, перепутал умножение и деление),
 * а не случайные числа: ошибка учит. rnd — детерминированный ГПСЧ для тестов.
 */
import type { BankQ, RoundQ, Topic } from "./blitzBank";

type Rnd = () => number;
const int = (rnd: Rnd, a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100).replace(".", ",")).replace(/^-/, "−");
const signed = (x: number) => (x < 0 ? `− ${fmt(-x)}` : `+ ${fmt(x)}`);
/** Член многочлена со знаком: (−1, "x") → "− x", (3, "x") → "+ 3x", (0, …) → "". */
const term = (c: number, v: string) => (c === 0 ? "" : `${c < 0 ? "−" : "+"} ${Math.abs(c) === 1 && v ? "" : fmt(Math.abs(c))}${v} `);

/** 4 уникальных варианта: верный первым, затем правдоподобные ошибки; добивает соседями, если ошибки совпали. */
function options(right: string, wrong: string[], filler: () => string): [string, string, string, string] {
  const out = [right];
  for (const w of [...wrong]) if (!out.includes(w)) out.push(w);
  for (let guard = 0; out.length < 4 && guard < 50; guard++) { const f = filler(); if (!out.includes(f)) out.push(f); }
  while (out.length < 4) out.push(`${right} ${"·".repeat(out.length)}`);
  return out.slice(0, 4) as [string, string, string, string];
}
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => String(n).split("").map((d) => SUP[Number(d)] ?? d).join("");
const near = (rnd: Rnd, x: number, unit = "") => () => `${fmt(x + pick(rnd, [-3, -2, -1, 1, 2, 3, 10, -10]))}${unit}`;

const alg: ((r: Rnd) => BankQ)[] = [
  (r) => { // x² − (x₁+x₂)x + x₁x₂ = 0 с целыми корнями
    let a = int(r, 1, 9), b = int(r, 1, 9); if (r() < 0.4) b = -b; if (a === b) b = a + 1;
    const s = a + b, p = a * b, lo = Math.min(a, b), hi = Math.max(a, b);
    const eq = `x² ${term(-s, "x")}${term(p, "")}= 0`;
    return { q: `Корни уравнения ${eq}`, a: options(`${fmt(lo)} и ${fmt(hi)}`, [`${fmt(-hi)} и ${fmt(-lo)}`, `1 и ${fmt(p)}`, `${fmt(lo)} и ${fmt(-hi)}`], () => `${fmt(lo)} и ${fmt(hi + int(r, 1, 3))}`),
      why: `По Виету: x₁ + x₂ = ${fmt(s)}, x₁ · x₂ = ${fmt(p)} → ${fmt(lo)} и ${fmt(hi)}.` };
  },
  (r) => { // дискриминант
    const a = int(r, 1, 3), b = int(r, -8, 8) || 5, c = int(r, -6, 6);
    const D = b * b - 4 * a * c;
    return { q: `Дискриминант уравнения ${a === 1 ? "" : a}x² ${term(b, "x")}${term(c, "")}= 0`, a: options(fmt(D), [fmt(b * b + 4 * a * c), fmt(b - 4 * a * c), fmt(-D)], near(r, D)),
      why: `D = b² − 4ac = ${b * b} − ${4 * a * c < 0 ? `(${fmt(4 * a * c)})` : 4 * a * c} = ${fmt(D)}.` };
  },
  (r) => { // линейное ax + b = c
    const x = int(r, -9, 12), a = int(r, 2, 9), b = int(r, -20, 20) || 7, c = a * x + b;
    return { q: `Реши уравнение ${a}x ${term(b, "")}= ${fmt(c)}`, a: options(`x = ${fmt(x)}`, [`x = ${fmt((c + b) / a)}`, `x = ${fmt(-x)}`, `x = ${fmt(c - b)}`], () => `x = ${fmt(x + int(r, 1, 4))}`),
      why: `${a}x = ${fmt(c)} ${signed(-b)} = ${fmt(c - b)}, x = ${fmt(c - b)} : ${a} = ${fmt(x)}.` };
  },
  (r) => { // проценты
    const base = pick(r, [40, 60, 80, 120, 150, 200, 250, 300, 360, 400]), pct = pick(r, [5, 10, 15, 20, 25, 30, 40, 50, 75]);
    const v = (base * pct) / 100;
    return { q: `${pct}% от ${base} — это…`, a: options(fmt(v), [fmt(base / pct), fmt(base - v), fmt(v * 10)], near(r, v)), why: `${base} · ${pct} / 100 = ${fmt(v)}.` };
  },
  (r) => { // степени
    const b = pick(r, ["a", "x", "2", "3"]), m = int(r, 2, 7), n = int(r, 2, 6), w = b === "2" ? "4" : b === "3" ? "9" : `2${b}`;
    return { q: `${b}${sup(m)} · ${b}${sup(n)} = …`, a: options(`${b}${sup(m + n)}`, [`${b}${sup(m * n)}`, `${b}${sup(Math.abs(m - n))}`, `${w}${sup(m + n)}`], () => `${b}${sup(m + n + int(r, 1, 3))}`),
      why: `При умножении степеней с одним основанием показатели складываются: ${m} + ${n} = ${m + n}.` };
  },
];

const TRIPLES: [number, number, number][] = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [6, 8, 10], [9, 12, 15], [20, 21, 29]];
const geom: ((r: Rnd) => BankQ)[] = [
  (r) => { const [a, b, c] = pick(r, TRIPLES), k = pick(r, [1, 1, 2, 3]);
    return { q: `Катеты ${a * k} и ${b * k}. Гипотенуза равна…`, a: options(fmt(c * k), [fmt((a + b) * k), fmt(c * k * c * k), fmt(Math.abs(b - a) * k)], near(r, c * k)),
      why: `c = √(${a * k}² + ${b * k}²) = √${(c * k) ** 2} = ${c * k}.` }; },
  (r) => { const [a, b, c] = pick(r, TRIPLES);
    return { q: `Гипотенуза ${c}, катет ${a}. Второй катет…`, a: options(fmt(b), [fmt(c - a), fmt(c + a), fmt(Math.round(Math.sqrt(c * c + a * a) * 10) / 10)], near(r, b)),
      why: `b = √(${c}² − ${a}²) = √${b * b} = ${b}.` }; },
  (r) => { const A = int(r, 25, 80), B = int(r, 25, 150 - A), C = 180 - A - B;
    return { q: `В треугольнике углы ${A}° и ${B}°. Третий угол…`, a: options(`${C}°`, [`${360 - A - B}°`, `${A + B}°`, `${Math.abs(90 - A - B) || 45}°`], near(r, C, "°")),
      why: `Сумма углов треугольника 180°: 180 − ${A} − ${B} = ${C}.` }; },
  (r) => { const a = int(r, 3, 15), b = int(r, 2, 12);
    return { q: `Прямоугольник ${a} × ${b}. Площадь и периметр…`, a: options(`S = ${a * b}, P = ${2 * (a + b)}`, [`S = ${2 * (a + b)}, P = ${a * b}`, `S = ${a * b}, P = ${a + b}`, `S = ${a + b}, P = ${a * b}`], () => `S = ${a * b + int(r, 1, 5)}, P = ${2 * (a + b)}`),
      why: `S = a · b = ${a * b}; P = 2(a + b) = ${2 * (a + b)}.` }; },
  (r) => { const a = int(r, 3, 12), b = a + int(r, 2, 10), h = int(r, 2, 10), S = ((a + b) * h) / 2;
    return { q: `Трапеция: основания ${a} и ${b}, высота ${h}. Площадь…`, a: options(fmt(S), [fmt((a + b) * h), fmt(a * b * h / 2), fmt(((b - a) * h) / 2)], near(r, S)),
      why: `S = ½(a + b)·h = ½ · ${a + b} · ${h} = ${fmt(S)}.` }; },
];

const phys: ((r: Rnd) => BankQ)[] = [
  (r) => { const v = pick(r, [18, 36, 54, 72, 90, 108, 126, 144]), ms = v / 3.6;
    return { q: `${v} км/ч — это…`, a: options(`${fmt(ms)} м/с`, [`${fmt(v * 3.6)} м/с`, `${v} м/с`, `${fmt(v / 60)} м/с`], near(r, ms, " м/с")), why: `${v} · 1000 / 3600 = ${fmt(ms)} м/с (делим на 3,6).` }; },
  (r) => { const t = int(r, 2, 9), v = int(r, 3, 25), s = v * t;
    return { q: `Путь ${s} м пройден за ${t} с. Скорость…`, a: options(`${v} м/с`, [`${s * t} м/с`, `${fmt(t / s)} м/с`, `${s - t} м/с`], near(r, v, " м/с")), why: `v = s / t = ${s} / ${t} = ${v} м/с.` }; },
  (r) => { const R = pick(r, [2, 4, 5, 10, 20, 25, 50]), I = pick(r, [0.5, 1, 2, 3, 4, 6]), U = R * I;
    return { q: `U = ${fmt(U)} В, R = ${R} Ом. Сила тока…`, a: options(`${fmt(I)} А`, [`${fmt(U * R)} А`, `${fmt(R / U)} А`, `${fmt(U + R)} А`], near(r, I, " А")), why: `Закон Ома: I = U / R = ${fmt(U)} / ${R} = ${fmt(I)} А.` }; },
  (r) => { const m = pick(r, [0.5, 1, 2, 3, 5, 10, 20, 50]), F = m * 10;
    return { q: `Масса тела ${fmt(m)} кг (g = 10 Н/кг). Сила тяжести…`, a: options(`${fmt(F)} Н`, [`${fmt(m / 10)} Н`, `${fmt(m)} Н`, `${fmt(F * 10)} Н`], near(r, F, " Н")), why: `F = m · g = ${fmt(m)} · 10 = ${fmt(F)} Н.` }; },
  (r) => { const V = pick(r, [2, 4, 5, 10, 20]), rho = pick(r, [800, 1000, 2700, 7800]), m = rho * V / 1000;
    return { q: `Объём ${V} дм³, плотность ${rho} кг/м³. Масса…`, a: options(`${fmt(m)} кг`, [`${fmt(rho * V)} кг`, `${fmt(rho / V)} кг`, `${fmt(m * 10)} кг`], near(r, m, " кг")), why: `${V} дм³ = ${fmt(V / 1000)} м³; m = ρV = ${rho} · ${fmt(V / 1000)} = ${fmt(m)} кг.` }; },
  (r) => { const F = pick(r, [10, 20, 50, 100, 200]), s = int(r, 2, 12), A = F * s;
    return { q: `Сила ${F} Н переместила тело на ${s} м. Работа…`, a: options(`${A} Дж`, [`${fmt(F / s)} Дж`, `${F + s} Дж`, `${A * 10} Дж`], near(r, A, " Дж")), why: `A = F · s = ${F} · ${s} = ${A} Дж.` }; },
];

const MOLAR: [string, number, string][] = [["H₂O", 18, "2·1 + 16"], ["CO₂", 44, "12 + 2·16"], ["O₂", 32, "2·16"], ["CH₄", 16, "12 + 4·1"],
  ["NH₃", 17, "14 + 3·1"], ["NaCl", 58.5, "23 + 35,5"], ["HCl", 36.5, "1 + 35,5"], ["H₂SO₄", 98, "2·1 + 32 + 4·16"], ["MgO", 40, "24 + 16"], ["CaCO₃", 100, "40 + 12 + 3·16"]];
const ELEM: [string, number, string][] = [["углерод (C)", 6, "C"], ["кислород (O)", 8, "O"], ["натрий (Na)", 11, "Na"], ["алюминий (Al)", 13, "Al"],
  ["сера (S)", 16, "S"], ["хлор (Cl)", 17, "Cl"], ["калий (K)", 19, "K"], ["кальций (Ca)", 20, "Ca"], ["железо (Fe)", 26, "Fe"], ["азот (N)", 7, "N"]];
const chem: ((r: Rnd) => BankQ)[] = [
  (r) => { const [f, M, how] = pick(r, MOLAR);
    return { q: `Молярная масса ${f}`, a: options(`${fmt(M)} г/моль`, [`${fmt(M + 16)} г/моль`, `${fmt(M - 1)} г/моль`, `${fmt(M * 2)} г/моль`], near(r, M, " г/моль")), why: `M(${f}) = ${how} = ${fmt(M)} г/моль.` }; },
  (r) => { const [name, z] = pick(r, ELEM);
    return { q: `Сколько протонов в ядре атома: ${name}?`, a: options(String(z), [String(z * 2), String(z + 1), String(Math.max(1, z - 2))], near(r, z)), why: `Число протонов = порядковый номер в таблице Менделеева = ${z}.` }; },
  (r) => { const [f, M] = pick(r, MOLAR.filter((x) => Number.isInteger(x[1]))), n = pick(r, [0.5, 2, 3, 0.25]), m = M * n;
    return { q: `Масса ${fmt(n)} моль ${f}`, a: options(`${fmt(m)} г`, [`${fmt(M / n)} г`, `${fmt(M + n)} г`, `${fmt(M)} г`], near(r, m, " г")), why: `m = n · M = ${fmt(n)} · ${M} = ${fmt(m)} г.` }; },
];

export const GENERATORS: Record<string, ((r: Rnd) => BankQ)[]> = { alg, geom, phys, chem };
export const hasGenerator = (key: string) => key in GENERATORS;

/** n сгенерированных вопросов темы без повторов формулировки (до 20 попыток на вопрос). */
export function generate(key: string, n: number, rnd: Rnd = Math.random): BankQ[] {
  const gens = GENERATORS[key]; if (!gens) return [];
  const out: BankQ[] = []; const seen = new Set<string>();
  for (let i = 0, guard = 0; out.length < n && guard < n * 20; guard++, i++) {
    const q = gens[(i + Math.floor(rnd() * gens.length)) % gens.length](rnd);
    if (seen.has(q.q) || new Set(q.a).size !== 4) continue;
    seen.add(q.q); out.push(q);
  }
  return out;
}

/**
 * Раунд v3.2.1: сначала до 2 вопросов «работы над ошибками», затем для тем с генератором — 3 новые задачи
 * (каждый раз другие числа), остальное — из банка. Порядок вопросов и вариантов перемешан.
 */
export function smartRound(topic: Topic, review: BankQ[] = [], n = 5, rnd: Rnd = Math.random): RoundQ[] {
  const shuffle = <T,>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const used = new Set<string>();
  const take = (xs: BankQ[], k: number, src: RoundQ["src"]) => {
    const out: { x: BankQ; src: RoundQ["src"] }[] = [];
    for (const x of xs) { if (out.length >= k) break; if (!used.has(x.q)) { used.add(x.q); out.push({ x, src }); } }
    return out;
  };
  const picked = take(shuffle(review), Math.min(2, n), "review");
  if (hasGenerator(topic.key)) picked.push(...take(generate(topic.key, 6, rnd), Math.min(3, n - picked.length), "gen"));
  picked.push(...take(shuffle(topic.qs), n - picked.length, "bank"));
  if (picked.length < n && hasGenerator(topic.key)) picked.push(...take(generate(topic.key, 12, rnd), n - picked.length, "gen"));
  return shuffle(picked).map(({ x, src }) => {
    const order = shuffle([0, 1, 2, 3]);
    return { q: x.q, options: order.map((k) => x.a[k]), answer: order.indexOf(0), why: x.why, src };
  });
}

/** v2.3.2 · «Умный поиск учебных материалов» (F9): быстрый офлайн-фильтр по тому, что уже есть на устройстве —
 *  сохранённые 60-секундные шпаргалки (dayStore «sf.cards»), памятки-алгоритмы по предметам (GUIDES, паритет с
 *  app/socratic_guide.py) и короткий справочник школьных формул. Без сети и без ИИ: чистые функции, покрыты unit-тестом. */
import { GUIDES } from "../engine/guide";
import type { MorningCard } from "./day";

export type MaterialKind = "card" | "formula" | "memo";
export interface Material { id: string; kind: MaterialKind; subject: string; title: string; lines: string[]; keywords?: string }
export const KIND_LABEL: Record<MaterialKind, string> = { card: "Шпаргалка", formula: "Формула", memo: "Памятка" };

/** Базовые формулы 7–9 классов (школьная программа). Только общеизвестные определения — без решений заданий. */
const F: readonly (readonly [subject: string, title: string, formula: string, keywords: string])[] = [
  ["Физика", "Скорость", "v = s / t", "путь время равномерное движение"],
  ["Физика", "Плотность вещества", "ρ = m / V", "масса объём ро"],
  ["Физика", "Сила тяжести", "F = m · g, g ≈ 9,8 Н/кг", "вес притяжение"],
  ["Физика", "Давление", "p = F / S", "площадь опоры паскаль"],
  ["Физика", "Закон Ома для участка цепи", "I = U / R", "сила тока напряжение сопротивление электричество"],
  ["Физика", "Механическая работа", "A = F · s", "джоуль путь сила"],
  ["Физика", "Мощность", "N = A / t", "ватт работа время"],
  ["Физика", "Кинетическая энергия", "Eк = m · v² / 2", "энергия движения скорость"],
  ["Физика", "Второй закон Ньютона", "F = m · a", "ускорение масса ньютон"],
  ["Физика", "Сила Архимеда", "Fа = ρж · g · Vт", "выталкивающая жидкость архимед"],
  ["Физика", "Количество теплоты", "Q = c · m · (t₂ − t₁)", "нагревание удельная теплоёмкость"],
  ["Математика", "Дискриминант", "D = b² − 4ac", "квадратное уравнение корни алгебра"],
  ["Математика", "Корни квадратного уравнения", "x = (−b ± √D) / 2a", "дискриминант квадратное уравнение алгебра"],
  ["Математика", "Теорема Пифагора", "c² = a² + b²", "прямоугольный треугольник гипотенуза катет геометрия"],
  ["Математика", "Площадь треугольника", "S = ½ · a · h", "высота основание геометрия"],
  ["Математика", "Площадь прямоугольника", "S = a · b", "стороны геометрия"],
  ["Математика", "Квадрат суммы", "(a + b)² = a² + 2ab + b²", "сокращённое умножение алгебра"],
  ["Математика", "Разность квадратов", "a² − b² = (a − b)(a + b)", "сокращённое умножение алгебра"],
  ["Математика", "Длина окружности", "C = 2πr", "радиус пи круг геометрия"],
  ["Математика", "Площадь круга", "S = πr²", "радиус пи окружность геометрия"],
  ["Химия", "Количество вещества", "n = m / M", "моль молярная масса"],
  ["Химия", "Массовая доля вещества в растворе", "ω = m(в-ва) / m(р-ра) · 100%", "раствор процент концентрация"],
  ["Информатика", "Информационный объём сообщения", "I = K · i", "бит байт символ кодирование"],
  ["Информатика", "Мощность алфавита", "N = 2^i", "бит кодирование двоичный"],
];

const FORMULA_LINE = /[=≈≤≥]|[²³√π]|\^\d/;

/** Все материалы: свои шпаргалки первыми (личное важнее справочника), затем формулы из шпаргалок, справочник, памятки. */
export function buildMaterials(cards: readonly MorningCard[] = []): Material[] {
  const own: Material[] = cards.map((c, i) => ({ id: `card:${i}:${c.title}`, kind: "card", subject: subjectOf(c.title), title: c.title,
    lines: [...c.card.points, ...(c.card.trap_question ? [`Проверь себя: ${c.card.trap_question}`] : [])] }));
  const fromCards: Material[] = cards.flatMap((c, i) => c.card.points.filter((p) => FORMULA_LINE.test(p))
    .map((p, j) => ({ id: `cf:${i}:${j}`, kind: "formula" as const, subject: subjectOf(c.title), title: `Из шпаргалки «${c.title}»`, lines: [p] })));
  const formulas: Material[] = F.map(([subject, title, formula, keywords], i) => ({ id: `f:${i}`, kind: "formula", subject, title, lines: [formula], keywords }));
  const memos: Material[] = Object.entries(GUIDES).map(([key, g]) => ({ id: `m:${key}`, kind: "memo", subject: g.subject, title: g.title, lines: [...g.steps] }));
  return [...own, ...fromCards, ...formulas, ...memos];
}

function subjectOf(title: string): string {
  const cut = title.indexOf(":");
  return cut > 0 ? title.slice(0, cut).trim() : "";
}

/** Нормализация для поиска: регистр, «ё», знаки препинания (символы формул оставляем). */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[«»"'“”„.,;:!?()[\]{}—–-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Грубая основа слова для русской морфологии: «формулы» ≈ «формула», «скорости» ≈ «скорость». */
function stem(token: string): string {
  return token.length > 5 ? token.slice(0, token.length - 2) : token.length > 3 ? token.slice(0, token.length - 1) : token;
}

export const MIN_QUERY = 2;

/** Каждое слово запроса должно найтись (по основе) в материале. Заголовок и предмет весят больше текста. */
export function searchMaterials(query: string, materials: readonly Material[], limit = 12): Material[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (normalize(query).length < MIN_QUERY || !tokens.length) return [];
  const scored: { m: Material; score: number; order: number }[] = [];
  materials.forEach((m, order) => {
    const head = ` ${normalize(`${m.subject} ${m.title}`)}`;
    const body = ` ${normalize(`${m.lines.join(" ")} ${m.keywords ?? ""}`)}`;
    let score = 0;
    for (const t of tokens) {
      const s = stem(t);
      // символ формулы ищем как подстроку, слово — с начала слова
      const word = /^[a-zа-я0-9]/.test(s) ? ` ${s}` : s;
      if (head.includes(word)) score += 3;
      else if (body.includes(word)) score += 1;
      else return;
    }
    scored.push({ m, score: score + (m.kind === "card" ? 1 : 0), order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map((x) => x.m);
}

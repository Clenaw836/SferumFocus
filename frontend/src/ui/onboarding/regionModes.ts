/** v2.4 · Все 89 субъектов РФ в мастере и автономный режим школы. Чистая логика без DOM и сети
 *  (тестируется в tests/unit/region_modes_v24.test.mts).
 *
 *  Режим подключения — свойство НАШЕГО каталога, а не обещание, что регион «подключён» к СГО:
 *  sgo_direct — школы есть в проверенном каталоге; esia_gateway — портал региона пускает только через
 *  Госуслуги; autonomous_bridge — школ в каталоге нет, продукт работает без дневника. */
import type { ConnectionMode, RegionItem } from "../../lib/api";

/** Старый сервер (до v2.4) не присылает connection_mode — выводим его так же, как сервер. */
export const modeOf = (r: Pick<RegionItem, "connection_mode" | "schools">): ConnectionMode =>
  r.connection_mode ?? (r.schools > 0 ? "sgo_direct" : "autonomous_bridge");

export const BADGE: Readonly<Record<ConnectionMode, string>> = {
  sgo_direct: "СГО каталог",
  esia_gateway: "Через Госуслуги",
  autonomous_bridge: "Автономный режим",
};

/** Группы для <select>: сначала субъекты с каталогом СГО (порядок сервера), затем все остальные. */
export function groupRegions<T extends RegionItem>(items: readonly T[]): { catalog: T[]; other: T[] } {
  const catalog: T[] = [];
  const other: T[] = [];
  for (const r of items) (modeOf(r) === "sgo_direct" ? catalog : other).push(r);
  return { catalog, other };
}

/** Подпись под выбранным регионом — честно, без «скоро» и процентов. */
export function modeNote(r: Pick<RegionItem, "connection_mode" | "schools" | "live_hosts">): string {
  const mode = modeOf(r);
  if (mode === "sgo_direct") return `В каталоге ${r.schools} ${plural(r.schools, "школа", "школы", "школ")} этого региона.`;
  const live = (r.live_hosts ?? 0) > 0 ? " Поиск спросит сервер региона." : "";
  if (mode === "esia_gateway") return "Дневник этого региона подключается через Госуслуги." + live;
  return "Школ этого региона пока нет в каталоге — войдите через Госуслуги (ЕСИА)." + live;
}

/** Нужно ли сразу показать карточку автономного режима (не дожидаясь пустого поиска). */
export const offerAutonomousUpfront = (r: Pick<RegionItem, "connection_mode" | "schools">): boolean => modeOf(r) !== "sgo_direct";

export const autonomousTitle = (region: string): string => `Выбрать школу в автономном режиме для региона ${region}`;

/** «121», «№ 121» → номер школы; остальное — название. Пустая строка → ничего (школа не указана). */
export function parseSchoolInput(text: string): { school_number: string | null; school_label: string | null } {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!t) return { school_number: null, school_label: null };
  const digits = t.replace(/^№\s*/, "");
  if (/^\d{1,6}$/.test(digits)) return { school_number: String(Number(digits)), school_label: null };
  return { school_number: null, school_label: t };
}

/** Похоже на адрес сайта — сервер такое не примет (адреса серверов вручную не вводятся).
 *  В JS `\b` знает только латиницу, поэтому для «.рф» граница слова — Unicode-просмотр вперёд (как `\b` в Python). */
export const looksLikeUrl = (text: string): boolean => /(?:https?:|:\/\/|www\.|\.(?:ru|рф|com|org)(?![\p{L}\p{N}_]))/iu.test(text);

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
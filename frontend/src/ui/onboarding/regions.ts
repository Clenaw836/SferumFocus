/** v2.1 · Автоподсказка региона по часовому поясу устройства (без геолокации и без запросов).
 *  Часовой пояс — слабый сигнал: он лишь поднимает подходящие регионы в начало списка чипов.
 *  Регион выбирается автоматически только если в справочнике ровно один кандидат этого пояса. */
export const TZ_REGIONS: Readonly<Record<string, readonly string[]>> = {
  "Europe/Kaliningrad": ["39"],
  "Europe/Moscow": ["77", "50", "78", "47", "16", "52", "61", "23", "36", "71", "76", "69", "40", "33", "37", "44", "62", "57", "48", "46", "31", "32", "67", "68", "58", "13", "21", "12", "43", "35", "29", "51", "10", "11", "53", "60", "92", "91", "01", "05", "06", "07", "08", "09", "15", "20", "26"],
  "Europe/Simferopol": ["91", "92"],
  "Europe/Kirov": ["43"],
  "Europe/Volgograd": ["34"],
  "Europe/Samara": ["63", "18"],
  "Europe/Ulyanovsk": ["73"],
  "Europe/Saratov": ["64"],
  "Europe/Astrakhan": ["30"],
  "Asia/Yekaterinburg": ["66", "86", "74", "72", "89", "02", "56", "59", "45"],
  "Asia/Omsk": ["55"],
  "Asia/Novosibirsk": ["54"],
  "Asia/Barnaul": ["22", "04"],
  "Asia/Tomsk": ["70"],
  "Asia/Novokuznetsk": ["42"],
  "Asia/Krasnoyarsk": ["24", "19", "17"],
  "Asia/Irkutsk": ["38", "03"],
  "Asia/Chita": ["75"],
  "Asia/Yakutsk": ["14", "28"],
  "Asia/Vladivostok": ["25", "27", "79"],
  "Asia/Magadan": ["49"],
  "Asia/Sakhalin": ["65"],
  "Asia/Kamchatka": ["41", "87"],
};
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}
export interface RegionLike { region_code: string | null; name: string; schools: number }
/** Регионы справочника, упорядоченные: сначала совпавшие с часовым поясом (в порядке TZ_REGIONS), затем по числу школ. */
export function orderRegions<T extends RegionLike>(items: readonly T[], tz: string = deviceTimeZone()): { ordered: T[]; nearby: Set<string>; auto: T | null } {
  const wanted = TZ_REGIONS[tz] ?? [];
  const nearby = new Set<string>();
  const first: T[] = [];
  for (const code of wanted) {
    const hit = items.find((r) => r.region_code === code);
    if (hit && hit.region_code) { first.push(hit); nearby.add(hit.region_code); }
  }
  const rest = items.filter((r) => !r.region_code || !nearby.has(r.region_code)).sort((a, b) => b.schools - a.schools);
  // Москва и большинство регионов делят один пояс — автоматический выбор только при единственном кандидате.
  return { ordered: [...first, ...rest], nearby, auto: first.length === 1 ? first[0] : null };
}
/* v2.3.2 (D6): parseSgoLink удалён — школа выбирается только из проверенного каталога, адрес/scid вручную не вводятся. */

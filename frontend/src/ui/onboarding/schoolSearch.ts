/** v2.3.2 (D1/D4/D7) · Конечный автомат поиска школы: регион → запрос → результаты → выбор.
 *
 *  Чистая логика без DOM и сети (тестируется в tests/unit/school_search_v232.test.mts). Компонент
 *  OnboardingWizard только отправляет события и выполняет запрос, когда статус loading/retrying.
 *  Гонки: каждый запрос получает seq; ответ применяется, только если seq и регион совпадают с текущими.
 *  Смена региона очищает запрос и результаты: школа из другого региона не может «прилипнуть». */
import type { SchoolHit, SearchQueryStatus } from "../../lib/api";

export type SearchStatus =
  | "initial" | "no_region" | "empty_query" | "too_short" | "loading" | "success" | "empty"
  | "validation_error" | "network_error" | "service_error" | "rate_limited" | "retrying"
  | "selected" | "school_removed" | "disabled" | "unavailable" | "cancelled";

export interface SearchState {
  status: SearchStatus;
  region: string | null;
  query: string;
  items: SchoolHit[];
  hasMore: boolean;
  /** Смещение текущего (или последнего) запроса; > 0 — «Показать ещё». */
  offset: number;
  /** Номер последнего запроса: ответы с другим seq — устаревшие и отбрасываются. */
  seq: number;
  retryAfter: number | null;
  selected: SchoolHit | null;
  /** Статус до выключения (disabled), чтобы вернуть экран как был. */
  resume: SearchStatus | null;
}

export interface SearchFailure { status: number; code?: string | null; retryAfter?: number | null; aborted?: boolean }

export type SearchEvent =
  | { type: "regions_loaded"; count: number }
  | { type: "regions_failed" }
  | { type: "region"; code: string | null }
  | { type: "query"; text: string }
  | { type: "more" }
  | { type: "retry" }
  | { type: "result"; seq: number; region: string; items: SchoolHit[]; hasMore: boolean; queryStatus?: SearchQueryStatus }
  | { type: "failed"; seq: number; region: string; error: SearchFailure }
  | { type: "cancel" }
  | { type: "select"; item: SchoolHit }
  | { type: "change_school" }
  | { type: "school_removed" }
  | { type: "disable" }
  | { type: "enable" };

export const PAGE = 15;
/** Одна буква — шум; одна цифра — номер школы (так же считает сервер: app/school_fuzzy.query_status). */
export const MIN_TEXT_QUERY = 2;

export const normalizeQuery = (text: string): string => text.replace(/\s+/g, " ").trim();

export function classifyQuery(text: string): "empty_query" | "too_short" | "ok" {
  const q = normalizeQuery(text);
  if (!q) return "empty_query";
  if (q.length < MIN_TEXT_QUERY && !/^\d+$/.test(q)) return "too_short";
  return "ok";
}

export const initialSearch = (): SearchState => ({
  status: "initial", region: null, query: "", items: [], hasMore: false, offset: 0, seq: 0, retryAfter: null, selected: null, resume: null,
});

/** Нужен ли сетевой запрос в этом состоянии (компонент делает его с задержкой и AbortController). */
export const needsFetch = (s: SearchState): boolean => s.status === "loading" || s.status === "retrying";

/** Можно ли вводить запрос (поле активно). */
export const canType = (s: SearchState): boolean => s.region !== null && !["initial", "unavailable", "disabled", "no_region"].includes(s.status);

function fromQuery(s: SearchState, query: string): SearchState {
  const kind = classifyQuery(query);
  const base = { ...s, query, items: [], hasMore: false, offset: 0, retryAfter: null };
  if (s.region === null) return { ...base, status: "no_region" };
  if (kind !== "ok") return { ...base, status: kind, seq: s.seq + 1 };   // seq++: незавершённый запрос устарел
  return { ...base, status: "loading", seq: s.seq + 1 };
}

export function classifyFailure(e: SearchFailure): SearchStatus {
  if (e.aborted) return "cancelled";
  if (e.status === 429 || e.code === "RATE_LIMITED") return "rate_limited";
  if (e.status === 422 || e.code === "REGION_REQUIRED" || e.code === "REGION_UNKNOWN") return "validation_error";
  if (e.status <= 0) return "network_error";
  return "service_error";
}

export function reduce(s: SearchState, e: SearchEvent): SearchState {
  switch (e.type) {
    case "regions_loaded":
      if (e.count <= 0) return { ...s, status: "unavailable" };
      return s.status === "initial" || s.status === "unavailable" ? { ...s, status: s.region ? "empty_query" : "no_region" } : s;
    case "regions_failed":
      return { ...s, status: "unavailable", items: [], hasMore: false };
    case "region": {
      if (e.code === s.region && s.status !== "no_region") return s;
      // Новый регион — новый поиск: запрос, результаты и выбор из прошлого региона сбрасываются.
      return { ...s, region: e.code, query: "", items: [], hasMore: false, offset: 0, retryAfter: null, selected: null,
        seq: s.seq + 1, status: e.code === null ? "no_region" : "empty_query" };
    }
    case "query":
      if (s.status === "disabled" || s.status === "initial" || s.status === "unavailable") return s;
      return fromQuery(s, e.text);
    case "more":
      if (s.status !== "success" || !s.hasMore || s.region === null) return s;
      return { ...s, status: "loading", offset: s.items.length, seq: s.seq + 1 };
    case "retry":
      if (s.region === null || classifyQuery(s.query) !== "ok") return s;
      if (!["network_error", "service_error", "rate_limited", "cancelled"].includes(s.status)) return s;
      return { ...s, status: "retrying", retryAfter: null, seq: s.seq + 1 };
    case "result": {
      if (e.seq !== s.seq || e.region !== s.region || !needsFetch(s)) return s;   // устаревший ответ
      const items = s.offset > 0 ? [...s.items, ...e.items.filter((x) => !s.items.some((y) => y.school_uid === x.school_uid))] : e.items;
      const status: SearchStatus = e.queryStatus === "too_short" ? "too_short" : e.queryStatus === "empty_query" ? "empty_query"
        : items.length ? "success" : "empty";
      return { ...s, items, hasMore: status === "success" && e.hasMore, status };
    }
    case "failed": {
      if (e.seq !== s.seq || e.region !== s.region || !needsFetch(s)) return s;
      const status = classifyFailure(e.error);
      const keep = s.offset > 0 && status !== "validation_error";      // «Показать ещё» упал — первая страница остаётся
      return { ...s, status, retryAfter: e.error.retryAfter ?? null, items: keep ? s.items : [], hasMore: keep ? s.hasMore : false };
    }
    case "cancel":
      return needsFetch(s) ? { ...s, status: "cancelled", seq: s.seq + 1 } : s;
    case "select":
      return { ...s, status: "selected", selected: e.item };
    case "change_school":
      return { ...s, selected: null, status: s.region === null ? "no_region" : s.items.length ? "success" : classifyQuery(s.query) === "ok" ? "empty" : "empty_query" };
    case "school_removed":
      return { ...s, status: "school_removed", selected: null };
    case "disable":
      return s.status === "disabled" ? s : { ...s, resume: s.status, status: "disabled", seq: needsFetch(s) ? s.seq + 1 : s.seq };
    case "enable":
      if (s.status !== "disabled") return s;
      return { ...s, status: s.resume && !needsFetch({ ...s, status: s.resume }) ? s.resume : s.region ? "empty_query" : "no_region", resume: null };
    default:
      return s;
  }
}

/** Подпись под полем поиска (role=status). Пустая строка — ничего не объявлять. */
export function statusText(s: SearchState): string {
  switch (s.status) {
    case "initial": return "Загружаем список регионов…";
    case "no_region": return "Сначала выбери свой регион";
    case "empty_query": return "Например: «15», «гимназия 4», «лицей Тестоград»";
    case "too_short": return "Добавь ещё хотя бы одну букву или номер школы";
    case "loading": return s.offset > 0 ? "Загружаем ещё…" : "Ищем…";
    case "retrying": return "Пробуем ещё раз…";
    case "success": return `Найдено: ${s.items.length}${s.hasMore ? "+" : ""}`;
    case "empty": return "В этом регионе ничего не нашли — проверь номер или название";
    case "validation_error": return "Выбери регион из списка ещё раз";
    case "network_error": return "Нет связи. Проверь интернет и повтори";
    case "service_error": return "Каталог школ временно недоступен. Повтори через полминуты";
    case "rate_limited": return s.retryAfter ? `Слишком часто. Повторим через ${s.retryAfter} с` : "Слишком часто. Подожди секунду";
    case "selected": return s.selected ? `Школа выбрана: ${s.selected.short_name || s.selected.name}` : "Школа выбрана";
    case "school_removed": return "Выбранная школа больше недоступна в каталоге. Выбери школу заново";
    case "disabled": return "";
    case "unavailable": return "Не удалось загрузить регионы. Повтори попытку";
    case "cancelled": return "Поиск остановлен";
    default: return "";
  }
}

/** Строка места школы: «Тестоград · Псковская область» (без пустых частей). */
export const locality = (h: Pick<SchoolHit, "city" | "region">): string => [h.city, h.region].filter(Boolean).join(" · ");

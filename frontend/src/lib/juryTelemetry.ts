/**
 * v2.1 · B3 «Демо для жюри»: типы ответа /api/v1/health/deep и учений /api/v1/health/swr-drill
 * и их перевод в строки «Инженерной телеметрии». Чистые функции — без DOM и сети (tests/unit/jury_v21.test.mts).
 * Ничего не досочиняем: нет поля — «нет данных», выключено — «выключено», сбой — красным.
 */
export type Health = "ok" | "degraded" | "fail" | "disabled";
export type Tone = "ok" | "warn" | "bad" | "off";

export interface GroqProbe { status: string; http?: number | null; ms?: number; checked_at?: string; cached?: boolean; reason?: string }
export interface GroqSection {
  status: Health; configured: boolean; route: "direct" | "proxy"; proxy_config_error: string | null;
  breaker: { state: "open" | "closed"; retry_in_s: number; consecutive_failures: number };
  calls: Record<string, number>; fallbacks: number; fallback_mode: string; probe: GroqProbe | null; live_verified: boolean;
}
export interface SearchProbe { kind: string; query: string; ms: number; results: number }
export interface SchoolSearchSection {
  status: Health; engine: string; reason?: string | null; indexed_schools?: number; probes?: SearchProbe[]; worst_ms?: number; budget_ms?: number;
}
export interface SwrSection {
  status: Health; engine: string; reason?: string | null; journal_mode?: string; entries?: number; fresh?: number; stale?: number;
  read_ms?: number; fresh_ttl_s: number; upstream_timeout_s: number; encrypted_payloads: boolean;
}
export interface MaxSection {
  status: Health; algorithm: string; self_test: Record<string, boolean>; verify_us: number;
  mode: "required" | "verified" | "demo" | "misconfigured"; production_ready: boolean; bot_token_configured: boolean;
  max_age_s: number; launches: { verified: number; rejected: number };
}
export interface DeepHealth {
  status: Exclude<Health, "disabled">; version: string; release?: string; checked_at: string; duration_ms: number; cached: boolean;
  sections: { groq: GroqSection; school_search: SchoolSearchSection; swr_cache: SwrSection; max_bridge: MaxSection };
}
export interface DrillStep {
  id: "fresh" | "outage" | "single_flight" | "privacy_over_stale" | string; title: string; expect: string; http_status: number;
  status: string | null; is_stale: boolean | null; cached_at: string | null; reason: string | null; grades_state: string | null;
  grades_shown: number; upstream_calls: number; ms: number; passed: boolean;
}
export interface SwrDrill { drill: string; passed: boolean; steps: DrillStep[]; total_ms?: number; checked_at?: string; error?: string }

export interface TelemetryRow { id: "groq" | "school_search" | "swr_cache" | "max_bridge"; title: string; value: string; detail: string; tone: Tone }

const ms = (n: number | undefined | null) => (typeof n === "number" && Number.isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)} мс` : "—");
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
const toneOf = (s: Health): Tone => (s === "ok" ? "ok" : s === "disabled" ? "off" : s === "degraded" ? "warn" : "bad");
const OFF_REASON: Record<string, string> = {
  platform_mode_off: "на этом сервере не включён мультиплатформенный режим (PLATFORM_AUTH_ENABLED)",
  store_not_configured: "хранилище платформы не настроено (SESSION_SIGNING_KEY)",
};
export const MAX_MODE: Record<MaxSection["mode"], string> = {
  required: "только подписанные запуски",
  verified: "подпись проверяется, но неподписанные пускаются как демо",
  demo: "демо: токен бота MAX не задан",
  misconfigured: "ошибка: подпись обязательна, а токена нет",
};
const PROBE_TEXT: Record<string, [string, string]> = {
  forbidden: ["403 — Groq отклоняет сеть сервера", "нужен GROQ_PROXY_URL (например, Privoxy)"],
  auth: ["401 — ключ не принят", "проверьте GROQ_API_KEY"],
  timeout: ["Таймаут", "Groq или прокси не ответили за 6 с"],
  network: ["Нет соединения", "прокси или сеть сервера недоступны"],
  rate_limited: ["429 — лимит Groq", "повторите позже"],
};

export function groqRow(g: GroqSection): TelemetryRow {
  const route = g.route === "proxy" ? "через прокси" : "напрямую";
  const ok = g.calls.ok ?? 0, failed = Object.entries(g.calls).reduce((n, [k, v]) => (k === "ok" ? n : n + v), 0);
  const traffic = `вызовов ИИ: ${ok} успешных, ${failed} со сбоем · ответов без ИИ: ${g.fallbacks}`;
  const base = { id: "groq" as const, title: "Groq · туннель прокси" };
  if (!g.configured) return { ...base, value: "ИИ выключен", detail: "ключ не задан — тьютор отвечает планом метода (degraded_gracefully)", tone: "warn" };
  if (g.breaker.state === "open") return { ...base, value: "Предохранитель открыт", detail: `повтор через ${Math.ceil(g.breaker.retry_in_s)} с — пока отвечает сократический план`, tone: "warn" };
  if (g.probe && g.probe.status === "ok") return { ...base, value: `Связь есть · ${ms(g.probe.ms)}`, detail: `${route} · GET /models · HTTP 200${g.probe.cached ? " (проверка до 60 с назад)" : ""}`, tone: "ok" };
  if (g.probe && g.probe.status !== "skipped") {
    const [value, hint] = PROBE_TEXT[g.probe.status] ?? [`Сбой: ${g.probe.status}`, g.probe.http ? `HTTP ${g.probe.http}` : "без ответа"];
    return { ...base, value, detail: `${route} · ${hint}`, tone: "bad" };
  }
  if (g.proxy_config_error) return { ...base, value: "Прокси отвергнут", detail: `GROQ_PROXY_URL: ${g.proxy_config_error} — запросы идут напрямую`, tone: "warn" };
  return { ...base, value: g.route === "proxy" ? "Через прокси" : "Напрямую", detail: `${traffic} · живая проверка — кнопкой ниже`, tone: toneOf(g.status) };
}

export function searchRow(s: SchoolSearchSection): TelemetryRow {
  const base = { id: "school_search" as const, title: `${s.engine === "rapidfuzz" ? "RapidFuzz" : s.engine} · поиск школ` };
  if (s.status === "disabled") return { ...base, value: "Выключено", detail: OFF_REASON[s.reason ?? ""] ?? "недоступно на этом сервере", tone: "off" };
  if (s.status === "fail") return { ...base, value: "Ошибка запроса", detail: "справочник школ не прочитался", tone: "bad" };
  const n = s.indexed_schools ?? 0;
  const runs = (s.probes ?? []).map((p) => `«${p.query}» ${ms(p.ms)}`).join(", ");
  const detail = s.reason === "directory_empty" ? "справочник школ пуст — загрузите реестр"
    : `${n.toLocaleString("ru-RU")} ${plural(n, "школа", "школы", "школ")} · ${runs}`;
  return { ...base, value: `до ${ms(s.worst_ms)}`, detail, tone: toneOf(s.status) };
}

export function swrRow(s: SwrSection): TelemetryRow {
  const base = { id: "swr_cache" as const, title: "SQLite · SWR-кэш дневника" };
  if (s.status === "disabled") return { ...base, value: "Выключено", detail: OFF_REASON[s.reason ?? ""] ?? "недоступно на этом сервере", tone: "off" };
  if (s.status === "fail") return { ...base, value: "Кэш не читается", detail: "SQLite вернул ошибку — данные дневника не выдумываются", tone: "bad" };
  const n = s.entries ?? 0;
  return { ...base, value: `${n} ${plural(n, "копия", "копии", "копий")}`,
    detail: `свежих ${s.fresh ?? 0}, устаревших ${s.stale ?? 0} · свежесть ${Math.round(s.fresh_ttl_s / 60)} мин · журнал ${s.journal_mode ?? "—"} · шифрование ✓ · ${ms(s.read_ms)}`,
    tone: toneOf(s.status) };
}

export function maxRow(m: MaxSection): TelemetryRow {
  const base = { id: "max_bridge" as const, title: "MAX Bridge · HMAC initData" };
  const checks = Object.values(m.self_test), passed = checks.filter(Boolean).length;
  if (m.status === "fail") return { ...base, value: `Самопроверка ${passed}/${checks.length}`, detail: "проверка подписи работает неверно — вход MAX небезопасен", tone: "bad" };
  return { ...base, value: `Подпись проверена · ${passed}/${checks.length}`,
    detail: `${MAX_MODE[m.mode] ?? m.mode} · реальных запусков: ${m.launches.verified} принято, ${m.launches.rejected} отклонено`,
    tone: m.mode === "misconfigured" ? "bad" : "ok" };
}

export function telemetryRows(h: DeepHealth): TelemetryRow[] {
  const s = h.sections;
  return [groqRow(s.groq), searchRow(s.school_search), swrRow(s.swr_cache), maxRow(s.max_bridge)];
}

const hhmm = (iso: string | null) => { if (!iso) return "—"; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; };

/** Шаг учений → одна строка для жюри: что сделали и что увидел бы ученик. */
export function drillLine(s: DrillStep): string {
  switch (s.id) {
    case "fresh": return `СГО отвечает → ${s.http_status}, свежие оценки (${s.grades_shown})`;
    case "outage": return `СГО вернул 503 → ${s.http_status} из копии от ${hhmm(s.cached_at)} · is_stale=${s.is_stale} · ${s.grades_state}`;
    case "single_flight": return `5 запросов одновременно → ${s.upstream_calls} ${plural(s.upstream_calls, "поход", "похода", "походов")} в СГО`;
    case "privacy_over_stale": return `Сбой + «Скрывать оценки» → ${s.grades_state}, показано оценок: ${s.grades_shown}`;
    default: return `${s.title} → ${s.expect}`;
  }
}

export function drillVerdict(d: SwrDrill): string {
  if (!d.steps.length) return d.error ? `Учения не выполнены: ${d.error}` : "Учения не выполнены";
  const ok = d.steps.filter((s) => s.passed).length;
  return d.passed ? `Все ${ok} ${plural(ok, "шаг", "шага", "шагов")} пройдены за ${ms(d.total_ms)} — ученик ни разу не увидел ошибку` : `Пройдено ${ok} из ${d.steps.length} — см. шаги с ✗`;
}

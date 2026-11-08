/**
 * HTTP-клиент Mini App. Принципы демо-надёжности:
 *  • таймаут на каждый запрос (ИИ-роуты дольше), никаких «вечных» спиннеров;
 *  • GET-запросы повторяются один раз при сетевом сбое;
 *  • последнее удачное состояние кэшируется — перезагрузка без сети не даёт пустой экран;
 *  • ошибки бэкенда приходят как человекочитаемый detail (422/429/503 — см. main.py);
 *  • НЕТ СЕРВЕРА (404, HTML вместо JSON, нет сети) → автономный движок engine/local.ts
 *    с теми же контрактами. Приложение никогда не упирается в «Сервер не отвечает».
 * SEC-01: API только same-origin; ?api= и sf-api не используются. Redirect запрещён.
 */
import type { BuilderOut, BuilderParams, CloseQuiz, CloseQuizResult, TaskDetails } from "./studentTypes";
import type { ActionBody, ActionResult, Catalog, Hub, LabState, QuizResult, QuizStart, SavedState, Session, SubjectsOverview, TutorHelp } from "./practicumTypes";
import type { OcrBox, OcrCheck, OcrDraft } from "./ocrTypes";
import type { SgoClass, SgoGradebook, SgoLesson, SgoSendResult, SgoStatus } from "./sgoMarks";
import type { SgoDays } from "./diaryDays";
import {roleContext} from "./roleContext";
/** v3.2 · PERF-01: демо-данные учителя (~540 КБ) — отдельный чанк, только для DEMO-учителя. */
const teacherDemo = () => import("../engine/teacherDemo");
import {launchCredential as initData,launchHeaders,csrfHeaders} from "./platform";
import { browserId, guardIdentity, identityChanged, invalidateIdentity } from "./identity";
import { trustedApiURL, apiRedirectRejected } from "./apiPolicy";
import { inSandbox, sandboxHeaders } from "./sandbox";
import { nowDate } from "./clock";
import * as local from "../engine/local";
import { socraticGuide, type SocraticGuide } from "../engine/guide";
import type { DeepHealth, SwrDrill } from "./juryTelemetry";
import type { TmConfirm, TmDay, TmDirectory, TmJournal, TmMaterial, TmMaterials, TmPlan, TmPrep, TmPreview, TmProposal, TmResults, TmStage } from "./teacherTypes";
import type { HwAction, HwEvent, HwIssueDetail, HwIssueResult, HwIssueRow, HwMember, HwMembership, HwNewTemplate, HwOverview, HwReason, HwReport, HwRoster, HwTemplate, HwTemplateDetail, HwTransitionResult, ManualHow, QuizAnswer, QuizBankTopics, QuizDraftRequest, QuizDraftResult, StudentQuiz, TeacherAssignment, TeacherQuiz } from "./hwTypes";
import { DEMO, nsKey } from "./demo";
import type { ScheduleChange, WeekResp } from "./schedule";
import { demoLessons, dayView, addDays } from "./schedule";
import type {
  BlitzResponse, BlitzTurn, CalculateResponse, Flashcard, Health, Heatmap, InitialState,
  MyWeek, PersonalActivity, Quarter, QuizQuestion, RestSlot, Rewards, Role, Task, TeacherDay, Triage, WhoAmI,
} from "./types";

export class ApiError extends Error {
  /** extra: other fields of a JSON error body (e.g. duplicate_of, invalid_roster_ids), never the detail text. */
  constructor(message: string, public status: number, public retryAfter?: number, public extra?: Record<string, unknown>) { super(message); }
  get offline() { return this.status === 0; }
}

const LS = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(nsKey(k)); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(nsKey(k), JSON.stringify(v)); } catch { /* квота/приватный режим */ } },
};

function userId(): string { return browserId(); }

// v3.2: main.tsx imports this module before configureRole/bindIdentity (prefetchInitial), so role and the
// demo teacher are read lazily — a module-load snapshot would freeze the pre-boot default.
let roleV: Role | null = null;
const curRole = (): Role => (roleV ??= roleContext().role);   // snapshot on first use (after configureRole), as before
export const getRole = curRole;
export const setRole = (r: Role) => { if (roleContext().canSwitch) { roleV = r; LS.set("sf.role", r); } };
/** v17: выбранный демо-учитель (только демо; в школьном режиме сервер заголовок игнорирует). */
// v3.2: читается лениво — модуль загружается до привязки личности, хранилище до неё не трогаем
let demoTeacherV: string | null = null;
export const getDemoTeacher = (): string => (demoTeacherV ??= LS.get<string>("sf.teacher.demo") ?? "");
export const setDemoTeacher = (id: string) => { demoTeacherV = id; LS.set("sf.teacher.demo", id); };

/** Режим данных: server — FastAPI; local — автономный движок в браузере. */
export type DataMode = "unknown" | "server" | "local";
let mode: DataMode = DEMO || location.protocol === "file:" ? "local" : "unknown";
const listeners = new Set<(m: DataMode) => void>();
export const dataMode = () => mode;
export const onDataMode = (fn: (m: DataMode) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const setMode = (m: DataMode) => { if (mode !== m) { mode = m; listeners.forEach((f) => f(m)); } };
/** Связь вернулась: снова пробуем сервер (автономный режим после обрыва — не навсегда). */
export const reconnect = () => { if (!DEMO && location.protocol !== "file:" && mode === "local") setMode("unknown"); };

/** Сервер «отсутствует» (а не «ответил ошибкой»): сеть, таймаут, 404/405, не-JSON. */
const serverMissing = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status === 405 || e.status === -1);

async function run<T>(server: () => Promise<T>, offline: () => T | Promise<T>): Promise<T> {
  if (identityChanged(initData())) { invalidateIdentity(); throw new ApiError("Сессия изменилась — открой приложение заново", -2); }
  const viaLocal = () => {
    try { return offline(); }
    catch (e) { throw e instanceof local.LocalError ? new ApiError(e.message, e.status) : e; }
  };
  if (mode === "local" && (DEMO || location.protocol === "file:")) return viaLocal();
  try { const r = await server(); setMode("server"); return r; }
  catch (e) { if (serverMissing(e) && (DEMO || location.protocol === "file:")) { setMode("local"); return viaLocal(); } throw e; }
}

/** v2.1 · Единственный 401, который НЕ означает потерю сессии приложения: POST /api/v1/sgo/connect отклонил
 *  логин/пароль ДНЕВНИКА. Строгий allowlist: путь подключения СГО + серверный заголовок X-Error-Domain: sgo +
 *  error_code INVALID_CREDENTIALS. Произвольный error_code в теле или другой путь — обычный 401 (вход сбрасывается). */
export const DIARY_CONNECT_PATH = "/api/v1/sgo/connect";
export async function isDiaryCredentialError(path: string, res: Pick<Response, "headers" | "clone">): Promise<boolean> {
  if (path.split("?")[0] !== DIARY_CONNECT_PATH || res.headers.get("X-Error-Domain") !== "sgo") return false;
  try {
    const j: unknown = await res.clone().json();
    return !!j && typeof j === "object" && (j as { error_code?: unknown }).error_code === "INVALID_CREDENTIALS";
  } catch { return false; }
}

/** Заголовки входа любого запроса API: песочница — только X-Demo-Session; иначе X-User-Id + подпись запуска + CSRF. */
function identityHeaders(signedData: string): Record<string, string> {
  // X-User-Id is only the server-signed demo token (omitted when absent). X-User-Role / X-Demo-Teacher are a
  // role *preference* read solely by the automated test-profile harness; demo/production servers ignore them.
  const device = userId();
  return inSandbox() ? sandboxHeaders() : { ...(device ? { "X-User-Id": device } : {}), "X-User-Role": curRole(), ...(getDemoTeacher() ? { "X-Demo-Teacher": getDemoTeacher() } : {}), ...launchHeaders(signedData), ...csrfHeaders() };
}

async function req<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs = 10000, retry = method === "GET", signal?: AbortSignal, operationId?: string, extraHeaders?: Record<string, string>): Promise<T> {
  const ctrl = new AbortController();
  const abort=()=>ctrl.abort();
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url: string;
    try { url = trustedApiURL(path, location.origin); }
    catch { throw new ApiError("Небезопасный адрес API заблокирован", -2); }
    const signedData = initData();
    guardIdentity(signedData);
    const res = await fetch(url, {
      redirect: "manual",
      method,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...identityHeaders(signedData), ...(extraHeaders ?? {}), ...(method!=="GET"?{"X-Idempotency-Key":operationId ?? crypto.randomUUID()}:{}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    guardIdentity(initData());
    // v2.1: «неверный пароль от дневника» (строгий allowlist) — не потеря сессии приложения; любой другой 401 сбрасывает вход.
    if (res.status === 401 && !(await isDiaryCredentialError(path, res))) invalidateIdentity();
    if (apiRedirectRejected(res.type, res.status)) throw new ApiError("Перенаправление API заблокировано", -2);
    if (!res.ok) {
      let detail = `Ошибка ${res.status}`;
      let extra: Record<string, unknown> | undefined;
      try {
        const j = await res.json();
        if (typeof j.detail === "string") detail = j.detail;
        else if (Array.isArray(j.detail)) detail = "Проверь введённые данные";
        if (j && typeof j === "object" && !Array.isArray(j)) { const rest: Record<string, unknown> = { ...(j as Record<string, unknown>) }; delete rest.detail; if (Object.keys(rest).length) extra = rest; }
      } catch { /* не JSON */ }
      const ra = Number(res.headers.get("Retry-After")) || undefined;
      throw new ApiError(detail, res.status, ra, extra);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) throw new ApiError("Сервер API не найден", -1); // статика/SPA-фоллбек вернули HTML
    const result = await res.json();
    guardIdentity(initData());
    return result as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (identityChanged(initData())) { invalidateIdentity(); throw new ApiError("Сессия изменилась — открой приложение заново", -2); }
    if (mode === "local") throw new ApiError("Нет связи с сервером", 0);
    if (retry && !signal?.aborted) return req<T>(method, path, body, timeoutMs, false, signal);
    const aborted = (e as Error)?.name === "AbortError";
    throw new ApiError(aborted ? "Сервер долго не отвечает — попробуй ещё раз" : "Нет связи с сервером", 0);
  } finally {
    clearTimeout(timer);signal?.removeEventListener("abort",abort);
  }
}

/** v2.1 · B3 «Инженерная телеметрия» жюри (/api/v1/health/*): тот же вход, что у остального API (обхода нет), но
 *  без локального фоллбека — ничего не выдумываем — и без сброса входа на 401/403: панель только наблюдает.
 *  Отчёт «fail» (503) и проваленные учения (500) — тоже данные: показываем их, а не «Ошибка 503». */
async function observe<T>(method: "GET" | "POST", path: string, timeoutMs: number): Promise<T> {
  let url: string;
  try { url = trustedApiURL(path, location.origin); }
  catch { throw new ApiError("Небезопасный адрес API заблокирован", -2); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "manual", method, signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...identityHeaders(initData()), ...(method !== "GET" ? { "X-Idempotency-Key": crypto.randomUUID() } : {}) } });
    if (apiRedirectRejected(res.type, res.status)) throw new ApiError("Перенаправление API заблокировано", -2);
    if (!(res.headers.get("content-type") || "").includes("json")) throw new ApiError("Сервер API не найден", -1);
    const body: unknown = await res.json().catch(() => null);
    const report = !!body && typeof body === "object" && ("sections" in body || "drill" in body);
    if (!res.ok && !(report && (res.status === 503 || res.status === 500))) {
      const detail = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string" ? (body as { detail: string }).detail : `Ошибка ${res.status}`;
      throw new ApiError(detail, res.status, Number(res.headers.get("Retry-After")) || undefined);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError((e as Error)?.name === "AbortError" ? "Сервер долго не отвечает" : "Нет связи с сервером", 0);
  } finally {
    clearTimeout(timer);
  }
}
export const telemetry = {
  deep: (probe = false) => observe<DeepHealth>("GET", `${V}/health/deep${probe ? "?probe=1" : ""}`, probe ? 12000 : 8000),
  drill: () => observe<SwrDrill>("POST", `${V}/health/swr-drill`, 15000),
};

/** v3.0 · «Практикумы»: только сервер (движок, проверка и карта навыков — app/practicum_engine.py). Локальной подделки нет:
 *  автономная DEMO-копия без сервера честно показывает «нужен сервер». В DEMO с сервером запросы идут как обычно (X-User-Id устройства). */
const PQ = (path: string) => `/api/v1${path}`;
/** v3.0 · DEMO-копия без подписанного профиля попадала бы в общий серверный «demo-user»: прогресс практикумов
 *  одного жюри был бы виден другому. Такой браузер получает случайный ключ (128 бит, только на этом телефоне);
 *  сервер принимает его ТОЛЬКО вместо общего «demo-user» и хранит под префиксом demo-practicum: — к данным
 *  настоящих учеников ключ доступа не даёт. */
function practicumDemoHeaders(): Record<string, string> | undefined {
  if (!DEMO || userId() || inSandbox()) return undefined;
  let key = LS.get<string>("sf.practicum.demo-key");
  if (!key || !/^[0-9a-f]{32}$/.test(key)) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    key = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    LS.set("sf.practicum.demo-key", key);
  }
  return { "X-Practicum-Demo": key };
}
const preq = <T,>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 10000) =>
  req<T>(method, PQ(path), body, timeoutMs, method === "GET", undefined, undefined, practicumDemoHeaders());
const penc = encodeURIComponent;
export const practicumApi = {
  subjects: (grade: number) => preq<SubjectsOverview>("GET", `/curriculum/subjects?grade=${grade}`),
  hub: (subject: string, grade: number, o: { topicId?: string | null; hw?: string | null } = {}) =>
    preq<Hub>("GET", `/subjects/${penc(subject)}/hub?grade=${grade}${o.topicId ? `&topic_id=${penc(o.topicId)}` : ""}${o.hw ? `&hw=${penc(o.hw.slice(0, 1900))}` : ""}`),
  catalog: (q: { subject?: string | null; grade?: number; topicId?: string | null; scope?: "all" | "current"; difficulty?: string | null; format?: string | null }) => {
    const u = new URLSearchParams();
    if (q.subject) u.set("subject", q.subject); if (q.grade) u.set("grade", String(q.grade)); if (q.topicId) u.set("topic_id", q.topicId);
    if (q.scope) u.set("scope", q.scope); if (q.difficulty) u.set("difficulty", q.difficulty); if (q.format) u.set("format_type", q.format);
    return preq<Catalog>("GET", `/practicums/catalog?${u}`);
  },
  session: (id: string) => preq<Session>("GET", `/practicums/${penc(id)}/session`),
  save: (id: string, stageIndex: number, labState: LabState, answers: Record<string, unknown> = {}) =>
    preq<SavedState>("POST", `/practicums/${penc(id)}/state`, { stage_index: stageIndex, lab_state: labState, answers }),
  action: (id: string, body: ActionBody) => preq<ActionResult>("POST", `/practicums/${penc(id)}/action`, body),
  tutor: (id: string, question: string, labState: LabState, answers: Record<string, unknown>) =>
    preq<TutorHelp>("POST", `/practicums/${penc(id)}/tutor-help`, { question, lab_state: labState, answers }, 60000),
  quiz: (topicId: string) => preq<QuizStart>("POST", `/topics/${penc(topicId)}/quiz`, {}),
  submitQuiz: (attemptId: string, answers: Record<string, unknown>) => preq<QuizResult>("POST", `/quiz/${penc(attemptId)}/submit`, { answers }),
  ocrDraft: (base64: string, mime: string, hint = "") => preq<OcrDraft>("POST", "/ocr/draft", { base64, mime, hint }, 45000),
  ocrCheck: (lines: string[], width?: number, height?: number, boxes?: (OcrBox | null)[]) => preq<OcrCheck>("POST", "/ocr/check", { lines, width, height, boxes }, 15000),
};

/** Connection operations NEVER fall back to synthetic/local success. */
export function connectionRequest<T=any>(path:string,body?:unknown,signal?:AbortSignal,method?:"GET"|"POST"|"PUT"|"DELETE"):Promise<T>{
  return req<T>(method??(body===undefined?"GET":"POST"),path,body,45000,false,signal);
}
const V = "/api/v1";
const AI = 330000; // ИИ-роуты: модель может думать дольше обычного запроса

const NO_STUDENT = () => { throw new local.LocalError("Нужна связь с сервером — попробуй, когда появится интернет.", 503); };
const NO_TEACHER = () => { throw new local.LocalError("Эта операция учителя требует сервера. Локальная DEMO-копия не изменяет школьные данные.", 503); };
/** Recovery 2: assignments live only on the server; the local DEMO copy never fakes them. */
const NO_HW = () => { throw new local.LocalError("Задания учителя хранятся на сервере. В локальной DEMO-копии их нет — откройте приложение с сервером.", 503); };
const enc = encodeURIComponent;
const HW_TIMEOUT = 8000;
const hwPost = <T,>(path: string, body: unknown, operationId: string) => run(() => req<T>("POST", `${V}${path}`, body, HW_TIMEOUT, false, undefined, operationId), NO_HW);
const hwGet = <T,>(path: string) => run(() => req<T>("GET", `${V}${path}`, undefined, HW_TIMEOUT), NO_HW);
const NO_GRADES = () => { throw new local.LocalError("Оценки по датам приходят из подключённого школьного дневника на сервере. В автономной DEMO-копии их нет.", 503); };
/** Master v2.0 · Feature 2: оценки из снимка подключённого дневника (у каждой — дата из источника). */
export interface DiaryGrade { grade_id?: string | null; subject: string; date: string; work_type?: string; topic?: string; value: string; weight?: number }
/** private — настройка push-уведомлений (НЕ скрытие оценок); скрытие — hide_grades / grades_state="privacy_hidden". */
export interface DiaryGrades { status: string; private?: boolean; hide_grades?: boolean; grades_state?: GradesState; average_score?: number | null; grades: DiaryGrade[]; snapshot_available?: boolean; is_stale?: boolean; last_synced_at?: string | null }
const NO_AUDIO = () => { throw new local.LocalError("Голос распознаёт ИИ на сервере. Сейчас он недоступен — напиши текстом.", 503); };
const NO_PHOTO = () => { throw new local.LocalError("Фото распознаёт ИИ на сервере. В автономном режиме пришли текстом — время посчитаем по нормативам.", 503); };

// v2.4 · версии вшивает frontend/build.mjs (define) из package.json; вне сборки (тестовые фикстуры) — "dev".
declare const __SF_VERSION__: string | undefined;
declare const __SF_RELEASE__: string | undefined;
export const FRONTEND_VERSION: string = typeof __SF_VERSION__ === "string" ? __SF_VERSION__ : "dev";
export const FRONTEND_RELEASE: string = typeof __SF_RELEASE__ === "string" ? __SF_RELEASE__ : "dev";

type InitialResult = { data: InitialState; cached: boolean; cachedAt?: number | null };
async function loadInitial(): Promise<InitialResult> {
  try {
    const data = await run(() => req<InitialState>("GET", `${V}/webapp/initial-state?date=${schoolDayISO()}`, undefined, 6000), local.initialState);
    LS.set("sf.initial", data);
    LS.set("sf.initial.at", Date.now());
    return { data, cached: false };
  } catch (e) {
    // Security/auth/readiness failures must not expose cached data or become demo success.
    if (e instanceof ApiError && [-2, 401, 403, 503].includes(e.status)) throw e;
    const cached = LS.get<InitialState>("sf.initial");
    if (cached) return { data: cached, cached: true, cachedAt: LS.get<number>("sf.initial.at") };
    if (DEMO || location.protocol === "file:") return { data: local.initialState(), cached: false };
    throw e; // No synthetic diary for an authenticated account without a cache.
  }
}
let preInitial: Promise<InitialResult> | null = null, preAt = 0;
/** Начать загрузку initial-state заранее (после проверки входа, до монтирования приложения). */
export function prefetchInitial(): void {
  if (preInitial) return;
  preAt = Date.now();
  preInitial = loadInitial();
  preInitial.catch(() => undefined);
}

export const api = {
  health: () => run<Health>(() => req<Health>("GET", `${V}/webapp/capabilities`, undefined, 3500, false), () => ({ ai: false, bot: false, version: `${FRONTEND_VERSION}-local`, release: FRONTEND_RELEASE })),

  /** v3.2 · PERF: первый вызов забирает запрос, начатый main.tsx сразу после проверки входа (prefetchInitial). */
  initial(): Promise<{ data: InitialState; cached: boolean; cachedAt?: number | null }> {
    const p = preInitial && Date.now() - preAt < 10000 ? preInitial : null; preInitial = null;
    return p ?? loadInitial();
  },

  calculate: (p: { tasks: Task[]; start_time: string; bedtime: string; rest_slots: RestSlot[]; personal_activities: PersonalActivity[]; survival: boolean; compact_breaks?: boolean; order?: "default" | "short_first" }) => {
    const tasks = p.tasks.map(({ source: _s, ...t }) => t);
    return run(() => req<CalculateResponse>("POST", `${V}/webapp/calculate`, { ...p, tasks }), () => local.calculate({ ...p, tasks })).catch(e => {
      if (serverMissing(e)) return local.calculate({ ...p, tasks }); // pure deterministic calculation, not synthetic account data
      throw e;
    });
  },

  parseText: (text: string) => run<{tasks:Task[];notice?:string|null}>(() => req<{ tasks: Task[]; notice?: string | null }>("POST", `${V}/webapp/process-media`, { media_type: "voice", text }, AI), () => local.parseText(text)).catch(e => {
    if (!serverMissing(e)) throw e;
    const grade = LS.get<InitialState>("sf.initial")?.grade ?? null;
    return {...local.parseText(text, grade), notice: grade ? "Без сети: локальная оценка по сохранённому классу. Проверь задание." : "Без сети, класс неизвестен: приблизительная оценка. Проверь минуты."};
  }),
  parsePhoto: (base64: string, mime: string, text = "", signal?: AbortSignal) => run(() => req<{ tasks: Task[]; notice?: string | null }>("POST", `${V}/webapp/process-media`, { media_type: "photo", base64, mime, text }, AI, false, signal), NO_PHOTO),

  parseAudio: (base64: string, mime: string) => run(() => req<{ tasks: Task[] }>("POST", `${V}/webapp/process-media`, { media_type: "audio", base64, mime }, AI), NO_AUDIO),

  /** Сократический репетитор: история — последние 12 реплик; фото решения — опционально. */
  hint: (task_context: string, student_query: string, history: { role: string; content: string }[], image_base64?: string) =>
    run(() => req<HintReply>("POST", `${V}/webapp/socratic-hint`, { task_context, student_query, history: history.slice(-12), ...(image_base64 ? { image_base64 } : {}) }, AI),
      (): HintReply => ({ ...local.hint(student_query, history.length), source: "fallback", status: "degraded_gracefully", guide: socraticGuide(task_context, student_query) })),

  blitzStart: (task_title: string) => run(() => req<BlitzResponse>("POST", `${V}/webapp/blitz`, { task_title, mode: "start" }, AI), () => local.blitzStart(task_title)),
  blitzAnswer: (task_title: string, text: string, history: BlitzTurn[], current_question: string) =>
    run(() => req<BlitzResponse>("POST", `${V}/webapp/blitz`, { task_title, mode: "answer", answer: { text }, history, current_question }, AI),
      () => local.blitzAnswer(task_title, text, history, current_question)),

  blitzVoice: (task_title: string, audio_base64: string, mime: string, history: BlitzTurn[], current_question: string) =>
    run(() => req<BlitzResponse>("POST", `${V}/webapp/blitz`, { task_title, mode: "answer", answer: { audio_base64, mime }, history, current_question }, AI), NO_AUDIO),

  quizManual: (topic: string, raw_text: string, question_count: number) =>
    run(() => req<{ questions: QuizQuestion[] }>("POST", `${V}/webapp/blitz-quiz-manual`, { topic, raw_text, question_count }, AI), () => local.quizManual(raw_text, question_count)),
  quizPhoto: (images: { base64: string; mime: string }[], question_count: number) =>
    run(() => req<{ questions: QuizQuestion[] }>("POST", `${V}/webapp/blitz-quiz`, { images, question_count }, AI), NO_PHOTO),

  flashcard: (task_title: string) => run(() => req<Flashcard>("POST", `${V}/webapp/flashcard`, { task_title }, AI), () => local.flashcard(task_title)),

  /** Бот MAX напомнит в чате, когда фокус-время выйдет (только подписанный пользователь MAX). */
  focusReminder: (body: { subject: string; ends_in_sec: number | null; cancel?: boolean }) =>
    run(() => req<{ scheduled: boolean }>("POST", `${V}/webapp/focus-reminder`, body, 5000), () => ({ scheduled: false })),
  event: (kind: "task_done" | "plan_built" | "duel_completed" | "flashcard_used", payload: Record<string, unknown> = {}, operationId?: string) =>
    run(() => req<Rewards>("POST", `${V}/webapp/progress/event`, { kind, payload }, 10000, false, undefined, operationId), () => local.event(kind, payload)),

  triage: (tasks: Task[], horizon_days = 2) =>
    run(() => req<Triage>("POST", `${V}/webapp/triage`, { tasks: tasks.map(({ source: _s, ...t }) => t), horizon_days }, AI), () => local.triage(tasks, horizon_days)),
  quarter: () => run(() => req<Quarter>("GET", `${V}/webapp/quarter-schedule?days=5`), () => local.quarter(5)),
  /** Серверная правда о входе: подпись MAX и роль (школьный режим) vs демо. */
  whoami: () => run(() => req<WhoAmI>("GET", `${V}/webapp/whoami`, undefined, 4000), () => local.whoami(curRole())),

  rewards: () => run(() => req<Rewards>("GET", `${V}/rewards/profile`), local.rewards),
  myWeek: (days = 7) => { const n = Math.max(1, Math.min(31, Math.trunc(days) || 7)); return run(() => req<MyWeek>("GET", `${V}/webapp/my-week?days=${n}`), () => local.myWeek(n)); },
  heatmap: () => run(() => req<Heatmap>("GET", `${V}/teacher/heatmap`), local.heatmap),

  diaryGrades: () => run(() => req<DiaryGrades>("GET", `${V}/diary/grades`, undefined, 8000), NO_GRADES),
  /** v3.2 · архив дневника СГО за ≤ 3 недели: уроки, ДЗ под уроком, отметки (в т. ч. прошлые дни). */
  diaryDays: (start: string, end: string) => run(() => req<SgoDays>("GET", `${V}/diary/days?start=${start}&end=${end}`, undefined, 16000),
    (): Promise<SgoDays> => Promise.resolve({ state: "sgo_unlinked", days: [] })),
  // ---------- расписание v13: провайдер + синхронизация изменений + чтение доказательств ----------
  scheduleWeek: (start: string, days = 14) => run(() => req<WeekResp>("GET", `${V}/schedule/week?start=${start}&days=${days}`, undefined, 6000),
    (): WeekResp => ({ provider: { kind: "demo", name: "Демо-расписание", is_demo: true, real_status: "not_configured" }, school_week_days: 5, bells: [],
      days: Array.from({ length: days }, (_, i) => dayView(addDays(start, i), demoLessons(addDays(start, i)), [])) })),
  scheduleSync: (changes: ScheduleChange[], school_week: number | null) =>
    // без локального «эха»: не дошло до сервера — ошибка, очередь остаётся на телефоне до возврата связи
    req<{ version: number; changes: ScheduleChange[]; school_week: number | null }>("PUT", `${V}/schedule/overrides`, { changes, school_week }, 8000),
  /** Фото/скриншот/документ → текст. Ничего не меняет: разбор и подтверждение — на телефоне. */
  readEvidence: (kind: "photo" | "file", base64: string, mime: string, hint: string) =>
    run(() => req<{ engine: string; text: string; lessons: { lesson_number: number | null; subject: string; start_time: string | null; end_time: string | null; room: string | null }[]; day_hint: string | null; legibility: number }>("POST", `${V}/schedule/evidence/read`, { kind, base64, mime, hint }, AI),
      () => { throw new local.LocalError("Фото читает сервер. Без связи вставь текст расписания или скажи голосом.", 503); }),
  transcribe: (base64: string, mime: string) => run(() => req<{ engine: string; text: string }>("POST", `${V}/speech/transcribe`, { base64, mime }, AI), NO_AUDIO),
  teacherDay: () => run(() => req<TeacherDay>("GET", `${V}/teacher/day-schedule`), local.teacherDay),

  // ---------- v17.1: инструменты ученика ----------
  st: {
    details: (title: string) => run(() => req<TaskDetails>("GET", `${V}/webapp/task-details?title=${encodeURIComponent(title)}`, undefined, 6000), NO_STUDENT),
    quiz: (task_title: string) => run(() => req<CloseQuiz>("POST", `${V}/webapp/close-quiz`, { task_title }, 6000), NO_STUDENT),
    check: (quiz_id: string, answers: number[]) => run(() => req<CloseQuizResult>("POST", `${V}/webapp/close-quiz/check`, { quiz_id, answers }, 6000), NO_STUDENT),
    build: (p: BuilderParams) => run(() => req<BuilderOut>("POST", `${V}/webapp/schedule-builder`, p, 6000), NO_STUDENT),
  },

  // ---------- v17: учительский режим (только сервер; офлайн → прежняя карта класса) ----------
  tm: {
    directory: () => run(() => req<TmDirectory>("GET", `${V}/teacher/directory`, undefined, 5000), () => DEMO ? teacherDemo().then(m => m.directory()) : NO_TEACHER()),
    /** v2.4 Step 1 · одноразовое приглашение учителя; без автоповтора (код одноразовый). */
    redeemInvite: (code: string) => run(() => req<{ status: "bound"; teacher_id: string; school_id: string; classes: string[] }>("POST", `${V}/teacher/invites/redeem`, { code }, 10000, false), NO_TEACHER),
    today: (date: string, now: string | null, scenario: string) =>
      run(() => req<TmDay>("GET", `${V}/teacher/today?date=${date}${now ? `&now=${now}` : ""}&scenario=${scenario}`), () => DEMO ? teacherDemo().then(m => m.today(getDemoTeacher(), date, now, scenario)) : NO_TEACHER()),
    results: (cls: string, subject: string, order: "best" | "alpha") =>
      run(() => req<TmResults>("GET", `${V}/teacher/results?class=${encodeURIComponent(cls)}&subject=${encodeURIComponent(subject)}&order=${order}`), () => DEMO ? teacherDemo().then(m => m.results(getDemoTeacher(), cls, subject, order)) : NO_TEACHER()),
    prep: (id: string) => run(() => req<TmPrep>("GET", `${V}/teacher/prep?lesson_id=${encodeURIComponent(id)}`), () => DEMO ? teacherDemo().then(m => m.prep(getDemoTeacher(), id)) : NO_TEACHER()),
    draft: (id: string) => run(() => req<TmPlan>("POST", `${V}/teacher/plan/draft?lesson_id=${encodeURIComponent(id)}`), NO_TEACHER),
    savePlan: (p: { lesson_id: string; topic: string | null; stages: TmStage[]; adaptation: string }) => run(() => req<TmPlan>("PUT", `${V}/teacher/plan`, p), NO_TEACHER),
    materials: (subject?: string, cls?: string) =>
      run(() => req<TmMaterials>("GET", `${V}/teacher/materials?${subject ? `subject=${encodeURIComponent(subject)}&` : ""}${cls ? `class=${encodeURIComponent(cls)}` : ""}`), () => DEMO ? teacherDemo().then(m => m.materials(getDemoTeacher())) : NO_TEACHER()),
    addMaterial: (m: Record<string, string>) => run(() => req<TmMaterial>("POST", `${V}/teacher/materials`, m), NO_TEACHER),
    preview: (date: string, payload: string, source_kind: string, legibility: number) =>
      run(() => req<TmPreview>("POST", `${V}/teacher/import/preview?date=${date}`, { payload, source_kind, legibility }), NO_TEACHER),
    confirm: (token: string, accept: string[]) => run(() => req<TmConfirm>("POST", `${V}/teacher/import/confirm`, { token, accept }), NO_TEACHER),
    journal: () => run(() => req<{ entries: TmJournal[] }>("GET", `${V}/teacher/import/journal`), NO_TEACHER),
    revert: (journal_id: string) => run(() => req<{ ok: boolean }>("POST", `${V}/teacher/import/revert`, { journal_id }), NO_TEACHER),
    proposals: () => run(() => req<{ items: TmProposal[]; can_approve: boolean }>("GET", `${V}/teacher/proposals`), NO_TEACHER),
    decide: (id: string, approve: boolean) => run(() => req<{ ok: boolean; status: string }>("POST", `${V}/teacher/proposals/${id}/decide`, { approve }), NO_TEACHER),
  },

  // ---------- v3.2 · журнал СГО учителя (/api/v1/teacher/sgo): чтение нагрузки, предпросмотр и выгрузка ----------
  teacherSgo: {
    status: () => run(() => req<SgoStatus>("GET", `${V}/teacher/sgo/status`), NO_TEACHER),
    classes: () => run(() => req<{ classes: SgoClass[] }>("GET", `${V}/teacher/sgo/classes`), NO_TEACHER),
    schedule: (days = 7) => run(() => req<{ lessons: SgoLesson[] }>("GET", `${V}/teacher/sgo/schedule?days=${days}`), NO_TEACHER),
    gradebook: (classId: number, subjectId: number) =>
      run(() => req<SgoGradebook>("GET", `${V}/teacher/sgo/gradebook?class_id=${classId}&subject_id=${subjectId}`), NO_TEACHER),
    publish: (body: { classmeeting_id: number; subject_id: number; title: string; description: string; due_date: string; confirm: boolean }) =>
      run(() => req<SgoSendResult>("POST", `${V}/teacher/sgo/assignments/publish`, body), NO_TEACHER),
    exportMarks: (body: { classmeeting_id: number; assignment_id: number; marks: { student_id: number; mark: number }[]; dry_run: boolean; confirm: boolean }) =>
      run(() => req<SgoSendResult>("POST", `${V}/teacher/sgo/gradebook/marks/export`, body), NO_TEACHER),
  },

  // ---------- Recovery 2: индивидуальные задания учителя (только сервер; каждое изменение — с ключом операции) ----------
  hw: {
    overview: () => hwGet<HwOverview>("/teacher/hw/overview"),
    roster: (cls: string) => hwGet<HwRoster>(`/teacher/hw/roster?class=${enc(cls)}`),
    report: (cls: string, from: string, to: string) => hwGet<HwReport>(`/teacher/hw/report?class=${enc(cls)}&from=${enc(from)}&to=${enc(to)}`),
    code: (cls: string, rotate: boolean, op: string) => hwPost<{ class: string; code: HwRoster["code"]; rotated: boolean }>("/teacher/hw/roster/code", { class: cls, rotate }, op),
    decide: (rosterId: string, approve: boolean, op: string) => hwPost<{ member: HwMember; revoked_issues: number }>(`/teacher/hw/roster/${enc(rosterId)}/decision`, { approve }, op),
    remove: (rosterId: string, op: string) => hwPost<{ member: HwMember; revoked_issues: number }>(`/teacher/hw/roster/${enc(rosterId)}/remove`, {}, op),
    templates: (cls: string | null, archived = false) => hwGet<{ templates: HwTemplate[]; archived: boolean }>(`/teacher/hw/templates?${cls ? `class=${enc(cls)}&` : ""}archived=${archived}`),
    create: (body: HwNewTemplate, op: string) => hwPost<HwIssueResult>("/teacher/hw/templates", body, op),
    template: (id: string) => hwGet<HwTemplateDetail>(`/teacher/hw/templates/${enc(id)}`),
    update: (id: string, body: Record<string, unknown> & { expected_revision: number }, op: string) => hwPost<{ template: HwTemplate; changed: string[]; updated_issues: number }>(`/teacher/hw/templates/${enc(id)}/update`, body, op),
    issue: (id: string, roster_ids: string[], op: string) => hwPost<HwIssueResult>(`/teacher/hw/templates/${enc(id)}/issue`, { roster_ids }, op),
    archive: (id: string, op: string) => hwPost<{ template: HwTemplate; revoked_issues: number }>(`/teacher/hw/templates/${enc(id)}/archive`, {}, op),
    issueDetail: (id: string) => hwGet<HwIssueDetail>(`/teacher/hw/issues/${enc(id)}`),
    revoke: (id: string, op: string) => hwPost<{ issue_id: string; status: string; changed: boolean }>(`/teacher/hw/issues/${enc(id)}/revoke`, {}, op),
    join: (code: string, display_name: string, op: string) => hwPost<{ membership: HwMembership }>("/student/classes/join", { code, display_name }, op),
    classes: () => hwGet<{ memberships: HwMembership[] }>("/student/classes"),
    leave: (id: string, op: string) => hwPost<{ membership: HwMembership; revoked_issues: number }>(`/student/classes/${enc(id)}/leave`, {}, op),
    mine: () => hwGet<{ assignments: Omit<TeacherAssignment, "task_title">[]; server_now: string; is_demo: boolean }>("/student/assignments"),
    mineOne: (id: string) => hwGet<{ issue: Omit<TeacherAssignment, "task_title">; events: HwEvent[] }>(`/student/assignments/${enc(id)}`),
    /** Transition: the timer outbox calls this with a durable operation id and both device timestamps. */
    act: (id: string, action: HwAction, body: { client_event_at: number; client_sent_at: number; reason?: HwReason; round?: number; study_day?: string; client_elapsed_sec?: number }, op: string) =>
      req<HwTransitionResult>("POST", `${V}/student/assignments/${enc(id)}/${action}`, body, HW_TIMEOUT, false, undefined, op),
    /** Presence signal (not an event, no operation key needed: the server de-duplicates by time). */
    heartbeat: (id: string) => req<{ issue: Omit<TeacherAssignment, "task_title">; credited_sec: number }>("POST", `${V}/student/assignments/${enc(id)}/heartbeat`, {}, 5000, false),
    // ---------- v2: «просмотрено», блиц-опросы, смешанный класс ----------
    /** The student opened an assignment: the «Новое» indicator goes off, the teacher sees «просмотрено». */
    seen: (id: string) => req<{ issue_id: string; seen_at: string | null; changed: boolean }>("POST", `${V}/student/assignments/${enc(id)}/seen`, {}, 5000, false),
    quiz: (id: string) => hwGet<StudentQuiz>(`/student/assignments/${enc(id)}/quiz`),
    quizStart: (id: string, op: string) => hwPost<StudentQuiz>(`/student/assignments/${enc(id)}/quiz/start`, {}, op),
    quizSubmit: (id: string, answers: QuizAnswer[], studyDay: string, op: string) => hwPost<StudentQuiz>(`/student/assignments/${enc(id)}/quiz/submit`, { answers, study_day: studyDay }, op),
    teacherQuiz: (templateId: string) => hwGet<TeacherQuiz>(`/teacher/hw/templates/${enc(templateId)}/quiz`),
    issueClass: (id: string, op: string) => hwPost<HwIssueResult>(`/teacher/hw/templates/${enc(id)}/issue`, { whole_class: true }, op),
    addOffline: (cls: string, displayName: string, op: string) => hwPost<{ member: HwMember }>("/teacher/hw/roster/offline", { class: cls, display_name: displayName }, op),
    manual: (issueId: string, body: { score: number | null; max_score: number | null; note: string; how?: ManualHow | null }, op: string) => hwPost<{ issue: HwIssueRow }>(`/teacher/hw/issues/${enc(issueId)}/manual`, body, op),
    /** v2.2 · «Снять отметку»: только отметку учителя; история сохраняет оба события. */
    manualClear: (issueId: string, op: string) => hwPost<{ issue: HwIssueRow }>(`/teacher/hw/issues/${enc(issueId)}/manual/clear`, {}, op),
    /** Draft for the teacher: AI (separate teacher policy) or `source: "bank"` — built-in templates without AI.
     *  Never stored or issued by itself. */
    quizDraft: (body: QuizDraftRequest, op: string) => run(() => req<QuizDraftResult>("POST", `${V}/teacher/hw/quiz/draft`, body, body.source === "bank" ? 15000 : 95000, false, undefined, op), NO_HW),
    quizBank: (subject: string) => hwGet<QuizBankTopics>(`/teacher/hw/quiz/bank?subject=${enc(subject)}`),
  },

  // ---------- v16: импорт расписания (PREVIEW → CONFIRM) и клиентские метрики ----------
  /** Ничего не сохраняет: «было → станет» по дням. Без сервера — честная ошибка (импорт хранится на сервере). */
  importPreview: (payload: string, format: "text" | "json") =>
    run(() => req<ImportPreview>("POST", `${V}/schedule/import/preview`, { payload, format }, 8000),
      () => { throw new local.LocalError("Импорт сохраняется на сервере. Сейчас связи нет — попробуй позже или сообщи об изменении голосом.", 503); }),
  importConfirm: (token: string) => req<{ ok: boolean; applied: boolean; dates: string[]; repeat: boolean }>("POST", `${V}/schedule/import/confirm`, { token }, 8000),
  importRevert: () => req<{ ok: boolean; reverted: boolean }>("DELETE", `${V}/schedule/import`, undefined, 8000),
  syncNow: () => req<WeekResp["provider"]>("POST", `${V}/schedule/sync`, {}, 30000),
  clientMetrics: (m: { ttuc_ms?: number; day_engine_ms?: number; day_engine_error?: boolean; scene?: "svg" | "static" | "reduced" | "error" }) =>
    mode === "server" ? req<{ ok: boolean }>("POST", `${V}/metrics/client`, m, 4000, false).catch(() => undefined) : Promise.resolve(undefined),
};
export interface ImportPreview { ok: boolean; token: string | null; errors: string[]; warnings: string[]; days: { date: string; before: string[]; after: string[]; changed: boolean }[]; quality?: string }

/* ------------------------------------------------------------------ v2.1: онбординг, профиль, единый дневник */
export type RoleName = "student" | "teacher";
export type FontScale = "small" | "normal" | "large" | "xlarge";
/** v2.3.2: school_uid (host_id:scid) — единственный идентификатор школы для сервера; scid/адрес только для показа. */
export interface SchoolHit { scid: string; name: string; short_name: string; region_code: string | null; region: string | null; city: string | null; sgo_base_url: string; school_uid: string; password_login?: boolean }
export type SearchQueryStatus = "ok" | "empty" | "empty_query" | "too_short";
/** v2.4 · Живой поиск у доверенных узлов (3,0 с). Ошибка портала — статус, не 503. */
export type LiveStatus = "disabled" | "skipped" | "no_trusted_host" | "cached" | "found" | "not_found" | "unavailable" | "timeout";
export interface LiveProbe { attempted: boolean; status: LiveStatus; hosts: number; resolved: number; timeout_s: number }
/** v2.4 · Карточка «Выбрать школу в автономном режиме для региона …» (школа не нашлась — не тупик). */
export interface AutonomousOffer { region_code: string | null; region: string; title: string; hint: string; school_label: string | null;
  institution_matches: { name: string; city: string | null }[] }
export interface SchoolSearchResult { items: SchoolHit[]; region_code: string | null; query_status?: SearchQueryStatus; offset?: number; limit?: number; has_more?: boolean;
  source?: "local" | "live"; live?: LiveProbe | null; autonomous?: AutonomousOffer | null }
export type AuthMethodName = "sgo_credentials" | "gosuslugi_esia" | "moya_shkola";
export type EsiaState = "disabled" | "misconfigured" | "awaiting_official_credentials" | "ready";
export interface SchoolAuth { available_auth_methods: AuthMethodName[]; primary_auth_method: AuthMethodName | null; auth_status: "available" | "unavailable";
  reason: "esia_disabled" | "esia_misconfigured" | "esia_not_configured" | "no_supported_method" | null; esia_state: EsiaState }
export interface SelectedSchool { school_uid: string; name: string; short_name: string; city: string | null; region: string | null; region_code: string | null }
/** v2.4 · Режим подключения субъекта — свойство НАШЕГО каталога, а не обещание подключения региона. */
export type ConnectionMode = "sgo_direct" | "esia_gateway" | "autonomous_bridge";
export interface AutonomousChoice { region_code: string; region: string; school_label: string | null; school_number: string | null; display_name: string;
  title: string; connection_mode: "autonomous_bridge"; region_connection_mode: ConnectionMode; diary_connected: boolean; features: string[] }
export interface SchoolSelection { status: "none" | "selected" | "school_removed" | "autonomous"; school: SelectedSchool | null; auth: SchoolAuth | null;
  autonomous?: AutonomousChoice }
export interface RegionItem { region_code: string | null; name: string; schools: number;
  /** v2.4: есть у всех 89 субъектов; поля опциональны для совместимости со старым сервером. */
  aliases?: string[]; connection_mode?: ConnectionMode; badge?: string; sgo_catalog?: boolean; live_hosts?: number; automatic_import_verified?: boolean }
export interface RegionSummary { total: number; sgo_direct: number; esia_gateway: number; autonomous_bridge: number }
export interface UserProfile { role: RoleName; scid: string | null; school_name: string | null; region_code: string | null; sgo_base_url: string | null; hide_grades: boolean; font_scale: FontScale; onboarding_completed: boolean; updated_at: number }
export type ProfilePatch = Partial<Pick<UserProfile, "hide_grades" | "font_scale" | "onboarding_completed">>;
/** v2.3.2 (D6): адрес сервера и код школы клиент больше не передаёт — сервер берёт их из каталога по school_uid. */
export interface ConnectPayload { role: RoleName; school_uid: string; login: string; password: string; student_id?: number }
/** v2.1: stale_cache — оценки из сохранённой копии (СГО не ответил); показываются с пометкой, не прячутся. */
/** v2.1: ответ репетитора. status=degraded_gracefully — ИИ недоступен (нет ключа, 403 региона, прокси, сбой):
 *  шаг метода + план по предмету (guide), а не ошибка. Готового решения нет ни в одном режиме. */
export interface HintReply { hint: string; notice?: string | null; source?: string | null; status?: "ok" | "degraded_gracefully" | null; guide?: SocraticGuide | null }
export type GradesState = "ok" | "empty" | "privacy_hidden" | "stale_cache" | "upstream_error" | "sgo_unlinked";
export type OverviewStatus = "ok" | "empty" | "privacy_hidden" | "sgo_unlinked" | "upstream_error";
export interface OvLesson { number: number | null; start: string | null; end: string | null; subject: string; room?: string | null; class_name?: string | null }
export interface OvDay { date: string; lessons: OvLesson[] }
export interface OvHomework { title: string; subject: string | null; deadline: string | null; type: string }
export interface OvGrade { subject: string; value: string; date: string; work_type: string; topic: string }
export interface StudentData { schedule: OvDay[]; homework: OvHomework[]; grades: OvGrade[]; grades_state: GradesState; average_score: number | null;
  /** v2.2: на текущей неделе уроков нет (каникулы) — показана ближайшая учебная неделя; текст для экрана. */
  school_week_note?: string | null }
export interface TeacherClass { id: string; name: string; students_count: number | null; subject: string | null }
export interface JournalEntry { class_name: string | null; subject: string | null; lessons_without_marks: number | null; marks_this_week: number | null; average_mark: number | null; last_lesson_date: string | null }
export interface IssuedAssignment { id: string; title: string; class_name: string | null; subject: string | null; due_date: string | null; submitted: number | null; total: number | null }
export interface TeacherData { classes: TeacherClass[]; schedule: OvDay[]; journal_summary: JournalEntry[]; assignments_issued: IssuedAssignment[]; source: "sgo" | "sgo_without_teacher_api" }
interface OverviewBase { status: OverviewStatus; is_stale: boolean; cached_at: string | null; school: { scid: string | null; name: string | null } | null; reason?: "not_connected" | "reauth_required" | "upstream_unavailable" | null }
export interface StudentOverview extends OverviewBase { role: "student"; student_data: StudentData | null; teacher_data?: null }
export interface TeacherOverview extends OverviewBase { role: "teacher"; teacher_data: TeacherData | null; student_data?: null }
export type DiaryOverview = StudentOverview | TeacherOverview;
export interface ConnectResult { status: "connected"; role: RoleName; school_name: string | null; scid: string; overview?: DiaryOverview }
/** Машиночитаемые коды POST /api/v1/sgo/connect (тело ошибки: {error_code, detail, ...}). */
export type ConnectErrorCode = "INVALID_CREDENTIALS" | "SCHOOL_NOT_FOUND" | "ROLE_MISMATCH" | "SGO_UNAVAILABLE" | "TOO_MANY_ATTEMPTS"
  | "LOGIN_METHOD_UNSUPPORTED" | "DIARY_ALREADY_CONNECTED" | "STUDENT_CHOICE_REQUIRED" | "CONNECT_IN_PROGRESS"
  | "SCHOOL_SELECTION_REQUIRED" | "HOST_NOT_TRUSTED" | "SCHOOL_REMOVED" | "RATE_LIMITED" | "AUTH_METHOD_DISABLED" | "ESIA_MISCONFIGURED";
/** Машиночитаемый код любой ошибки API v2.3.2 (тело {detail, code, error_code}). */
export const apiErrorCode = (e: unknown): string | null => {
  const extra = e instanceof ApiError ? e.extra : undefined;
  const code = extra?.code ?? extra?.error_code;
  return typeof code === "string" ? code : null;
};
const isAuth = (x: unknown): x is SchoolAuth => !!x && typeof x === "object" && Array.isArray((x as SchoolAuth).available_auth_methods);
/** 409 LOGIN_METHOD_UNSUPPORTED несёт актуальные способы входа школы. */
export const connectAuth = (e: unknown): SchoolAuth | null => { const a = e instanceof ApiError ? e.extra?.auth : undefined; return isAuth(a) ? a : null; };
export interface StudentChoice { id: number; name: string }
export const connectErrorCode = (e: unknown): ConnectErrorCode | null => {
  const code = e instanceof ApiError ? e.extra?.error_code : undefined;
  return typeof code === "string" ? code as ConnectErrorCode : null;
};
export const connectStudents = (e: unknown): StudentChoice[] => {
  const list = e instanceof ApiError ? e.extra?.students : undefined;
  return Array.isArray(list) ? list.filter((x): x is StudentChoice => !!x && typeof x === "object" && typeof (x as StudentChoice).id === "number" && typeof (x as StudentChoice).name === "string") : [];
};
const NEED_SERVER = () => { throw new local.LocalError("Нужна связь с сервером — попробуй, когда появится интернет.", 503); };
const qs = (params: Record<string, string | null | undefined>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") u.set(k, v);
  return u.toString();
};
export const onboarding = {
  /** Без автоповтора: устаревший запрос отменяется, ответ сверяется по seq и региону (ui/onboarding/schoolSearch). */
  searchSchools: (q: string, region: string, signal?: AbortSignal, limit = 15, offset = 0) =>
    run(() => req<SchoolSearchResult>("GET", `${V}/schools/search?${qs({ q, region, limit: String(limit), offset: offset ? String(offset) : null })}`, undefined, 8000, false, signal), NEED_SERVER),
  selectSchool: (school_uid: string) => run(() => req<SchoolSelection>("POST", `${V}/schools/select`, { school_uid }, 10000, false), NEED_SERVER),
  selection: (signal?: AbortSignal) => run(() => req<SchoolSelection>("GET", `${V}/schools/selection`, undefined, 8000, true, signal), NEED_SERVER),
  regions: () => run(() => req<{ items: RegionItem[]; summary?: RegionSummary }>("GET", `${V}/schools/regions`, undefined, 8000), NEED_SERVER),
  /** v2.4 · Автономный режим: регион + номер/название школы, без дневника (данные остаются приватными). */
  chooseAutonomous: (region: string, school_label?: string | null, school_number?: string | null) =>
    run(() => req<SchoolSelection>("POST", `${V}/schools/autonomous`, { region, school_label: school_label || null, school_number: school_number || null }, 10000, false), NEED_SERVER),
  setRole: (role: RoleName) => run(() => req<UserProfile>("POST", `${V}/auth/role`, { role }, 10000, false), NEED_SERVER),
  profile: () => run(() => req<UserProfile>("GET", `${V}/profile`, undefined, 8000), NEED_SERVER),
  updateProfile: (patch: ProfilePatch) => run(() => req<UserProfile>("POST", `${V}/profile`, patch, 10000, false), NEED_SERVER),
  /** 45 с: регион СГО может отвечать медленно; без автоповтора (пароль не отправляется дважды). */
  connect: (body: ConnectPayload, signal?: AbortSignal, operationId?: string) =>
    run(() => req<ConnectResult>("POST", `${V}/sgo/connect`, body, 45000, false, signal, operationId), NEED_SERVER),
  overview: (refresh = false) => run(() => req<DiaryOverview>("GET", `${V}/diary/overview${refresh ? "?refresh=true" : ""}`, undefined, 20000, false), NEED_SERVER),
  /** v2.2 · «Выйти / Сменить аккаунт СГО»: сервер удаляет связь дневника, сессию мастера, ФИО из СГО и кэш оценок
   *  и снова открывает мастер (onboarding_completed=false). Аккаунт приложения и оформление остаются. */
  logout: () => run(() => req<SgoLogoutResult>("POST", `${V}/sgo/logout`, {}, 20000, false), NEED_SERVER),
};
export interface SgoLogoutResult { status: "logged_out"; deleted: boolean; remote_logout: string }
export const cache = LS;
/** Учебный день телефона (граница 04:00) — тот же, что lib/day.schoolDay, без циклического импорта. */
function schoolDayISO(): string { const d = new Date(nowDate().getTime() - 4 * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

/** Фото → base64 c даунскейлом до 1600px: экономим трафик и укладываемся в лимиты. */
export async function fileToBase64(file: File, maxSide = 1600): Promise<{ base64: string; mime: string }> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { base64: btoa(s), mime: file.type || "image/jpeg" };
  }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.86);
  return { base64: url.slice(url.indexOf(",") + 1), mime: "image/jpeg" };
}

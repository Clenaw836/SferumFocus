/** v2.3.2 · «Подключить дневник» — пошаговый визард, одно решение на экран:
 *  1) роль → 2) регион, затем школа из проверенного каталога (выбор хранится на сервере) → 3) способ входа.
 *  Школа передаётся серверу только как school_uid: ни кода школы, ни адреса сервера клиент не вводит и не шлёт.
 *  Пароль живёт только в состоянии этого компонента до ответа сервера и не пишется в хранилища/логи. */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ApiError, apiErrorCode, connectAuth, connectErrorCode, connectStudents, onboarding,
  type AutonomousChoice, type AutonomousOffer, type ConnectErrorCode, type ConnectResult, type RegionItem, type RoleName,
  type SchoolAuth, type SchoolHit, type SelectedSchool, type StudentChoice,
} from "../../lib/api";
import { demoURL } from "../../lib/bootstrap";
import { Icon } from "../Icon";
import { CONSENT_ERROR, DiaryConsent } from "../DiaryConsent";
import { orderRegions } from "./regions";
import { EsiaLogin } from "./EsiaLogin";
import { enterJury } from "../../lib/jury";
import { autonomousTitle, BADGE, groupRegions, looksLikeUrl, modeNote, modeOf, offerAutonomousUpfront, parseSchoolInput } from "./regionModes";
import { canType, initialSearch, locality, needsFetch, normalizeQuery, PAGE, reduce, statusText, type SearchEvent, type SearchState } from "./schoolSearch";

/** Глифа ⌕ нет в системных шрифтах Android/iOS (рисовался «тофу»-квадрат) — значок поиска векторный. */
const SearchIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;

type Step = 0 | 1 | 2;
interface Chosen { school: SelectedSchool; auth: SchoolAuth | null }
interface Props {
  initialRole: RoleName | null;
  onDone: (result: ConnectResult) => void;
  /** Автономный режим (только вне обязательного экрана входа): домашка добавляется текстом, голосом или фото. */
  onSkip?: () => void;
  /** Показывать ссылку «Посмотреть демо без входа» (осознанный выбор, а не реакция на сбой). */
  showDemo?: boolean;
}
const ROLE_CARDS: readonly { role: RoleName; title: string; text: string; icon: string }[] = [
  { role: "student", title: "Я ученик", text: "Расписание, оценки, домашка и помощь ИИ-тьютора по предметам", icon: "cap" },
  { role: "teacher", title: "Я учитель", text: "Мои классы, быстрый журнал, проверка заданий и генерация материалов", icon: "users" },
];
const STEP_TITLES = ["Кто вы?", "Найдите свою школу", "Подключить дневник"] as const;
const PICK_AGAIN: ReadonlySet<string> = new Set(["SCHOOL_NOT_FOUND", "SCHOOL_SELECTION_REQUIRED", "HOST_NOT_TRUSTED", "SCHOOL_REMOVED"]);
const COPY: Partial<Record<ConnectErrorCode, string>> = {
  INVALID_CREDENTIALS: "Неверный логин или пароль от дневника",
  SCHOOL_NOT_FOUND: "Этой школы нет в каталоге. Найдите её в списке ещё раз.",
  SCHOOL_SELECTION_REQUIRED: "Сначала выберите школу из списка — без этого дневник не подключить.",
  HOST_NOT_TRUSTED: "Сервер этой школы не входит в проверенный каталог. Выберите школу из списка.",
  SCHOOL_REMOVED: "Выбранная школа больше недоступна в каталоге. Выберите школу заново.",
  ROLE_MISMATCH: "Учётная запись не соответствует выбранной роли",
  SGO_UNAVAILABLE: "Школьный сервер сейчас перегружен. Попробуйте через минуту",
  CONNECT_IN_PROGRESS: "Подключение уже идёт — подождите несколько секунд",
  DIARY_ALREADY_CONNECTED: "Сначала отключите текущий дневник в настройках, затем выберите другую школу.",
};
/** Почему нет входа по паролю: текст по причине сервера (school_selection.auth_info). */
const ESIA_REASON: Record<NonNullable<SchoolAuth["reason"]>, string> = {
  esia_disabled: "Официальный шлюз подготовлен и отключён в демо-среде.",
  esia_misconfigured: "Вход через Госуслуги временно отключён из-за настройки сервера.",
  esia_not_configured: "Официальный шлюз ждёт реквизитов оператора ЕСИА и пока не работает.",
  no_supported_method: "Для этой школы пока нет поддерживаемого способа входа.",
};

export function describeConnectError(err: unknown, code: ConnectErrorCode | null): string {
  const known = code ? COPY[code] : undefined;
  if (known) return known;
  if (err instanceof ApiError) {
    if (err.status === 0) return "Связь со школой заняла больше времени. Проверьте интернет и нажмите «Подключить дневник» ещё раз.";
    if (err.status === 429) return err.retryAfter ? `Слишком много попыток. Повторите через ${err.retryAfter} с.` : "Слишком много попыток. Подождите минуту.";
    if (err.message) return err.message;
  }
  return "Не удалось подключить дневник. Попробуйте ещё раз.";
}

const passwordLogin = (auth: SchoolAuth | null): boolean => !auth || auth.available_auth_methods.includes("sgo_credentials");

export function OnboardingWizard({ initialRole, onDone, onSkip, showDemo = true }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [consent, setConsent] = useState(false);              // V23: согласие на обработку данных дневника (152-ФЗ)
  const consentRef = useRef<HTMLInputElement>(null);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [role, setRole] = useState<RoleName | null>(initialRole);
  // шаг 2: регион → поиск (конечный автомат schoolSearch.ts)
  const [regions, setRegions] = useState<RegionItem[] | null>(null);
  const [regionsTry, setRegionsTry] = useState(0);
  const [suggested, setSuggested] = useState<RegionItem[]>([]);
  const [st, setSt] = useState<SearchState>(initialSearch);
  const send = (e: SearchEvent) => setSt((s) => reduce(s, e));
  const [picking, setPicking] = useState<string | null>(null);
  const [pickErr, setPickErr] = useState("");
  // шаг 3
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [pwMode, setPwMode] = useState(false), [regionQ, setRegionQ] = useState("");
  // v2.4 · автономный режим: предложение сервера после пустого поиска (привязано к seq/региону) и сохранённый выбор
  const [offer, setOffer] = useState<{ seq: number; region: string; data: AutonomousOffer } | null>(null);
  const [autoChoice, setAutoChoice] = useState<AutonomousChoice | null>(null);
  const [autoText, setAutoText] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<{ code: ConnectErrorCode | "CONSENT_REQUIRED" | null; text: string } | null>(null);
  const [students, setStudents] = useState<StudentChoice[]>([]);
  const [studentId, setStudentId] = useState<number | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const regionRef = useRef<HTMLSelectElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const loginRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const go = (next: Step) => { setDir(next > step ? "fwd" : "back"); setStep(next); setError(null); };
  // Фокус: заголовок шага (скринридер объявляет экран); на шаге школы — регион, если он ещё не выбран.
  useEffect(() => {
    const target = step === 1 ? (st.region ? searchRef.current : regionRef.current)
      : step === 2 ? (passwordLogin(chosen?.auth ?? null) && pwMode ? (login ? pwRef.current : loginRef.current) : headRef.current) : headRef.current;
    (target ?? headRef.current)?.focus({ preventScroll: true });
  }, [step, pwMode]);

  const chooseRole = (r: RoleName) => {
    setRole(r);
    try { localStorage.setItem("sf_role", r); } catch { /* storage disabled */ }
    void onboarding.setRole(r).catch(() => { /* роль повторно передаётся в /sgo/connect */ });
    window.setTimeout(() => go(1), 180);   // даём увидеть подсветку выбранной карточки
  };

  // Сохранённый выбор школы (переживает перезапуск мини-приложения): один запрос при открытии.
  useEffect(() => {
    const ctrl = new AbortController();
    onboarding.selection(ctrl.signal).then((sel) => {
      if (ctrl.signal.aborted) return;
      if (sel.status === "selected" && sel.school) {
        setChosen({ school: sel.school, auth: sel.auth });
        if (sel.school.region_code) send({ type: "region", code: sel.school.region_code });
      } else if (sel.status === "autonomous" && sel.autonomous) {
        setAutoChoice(sel.autonomous);
        send({ type: "region", code: sel.autonomous.region_code });
      } else if (sel.status === "school_removed") send({ type: "school_removed" });
    }).catch(() => { /* нет выбора — обычный путь */ });
    return () => ctrl.abort();
  }, []);

  // Регионы: запрос при первом показе шага 2 и по кнопке «Повторить».
  useEffect(() => {
    if (step !== 1 || regions) return;
    let live = true;
    onboarding.regions().then((r) => {
      if (!live) return;
      const items = r.items.filter((x) => x.region_code);
      const { ordered, nearby } = orderRegions(items);
      // v2.4: в списке — порядок сервера (сначала каталог СГО, затем по алфавиту); часовой пояс — только для чипов «рядом».
      setRegions(items);
      setSuggested(ordered.filter((x) => x.region_code && nearby.has(x.region_code)).slice(0, 3));
      send({ type: "regions_loaded", count: items.length });
    }).catch(() => { if (live) send({ type: "regions_failed" }); });
    return () => { live = false; };
  }, [step, regions, regionsTry]);

  // Регионы пришли позже показа шага: селект был выключен и не мог принять фокус — переводим фокус сейчас.
  useEffect(() => {
    if (step !== 1 || !regions || st.region) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === headRef.current) regionRef.current?.focus({ preventScroll: true });
  }, [regions]);

  // Поиск: только когда автомат просит (loading/retrying). Дебаунс 200 мс; устаревший запрос отменяется.
  const fetching = needsFetch(st);
  useEffect(() => {
    if (!fetching || !st.region) return;
    const ctrl = new AbortController();
    const { seq, region, offset } = st;
    const text = normalizeQuery(st.query);
    const timer = window.setTimeout(() => {
      onboarding.searchSchools(text, region, ctrl.signal, PAGE, offset)
        .then((r) => {
          setOffer(r.autonomous ? { seq, region, data: r.autonomous } : null);
          send({ type: "result", seq, region, items: r.items, hasMore: !!r.has_more, queryStatus: r.query_status });
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          send({ type: "failed", seq, region, error: { status: e instanceof ApiError ? e.status : 0, code: apiErrorCode(e),
            retryAfter: e instanceof ApiError ? e.retryAfter ?? null : null } });
        });
    }, offset > 0 || st.status === "retrying" ? 0 : 200);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [st.seq, fetching]);

  // 429: сервер сказал, когда можно снова (Retry-After) — повторяем сами, без ручного «долбления».
  useEffect(() => {
    if (st.status !== "rate_limited" || !st.retryAfter || st.retryAfter > 30) return;
    const timer = window.setTimeout(() => send({ type: "retry" }), st.retryAfter * 1000);
    return () => window.clearTimeout(timer);
  }, [st.status, st.seq]);

  const region = useMemo(() => regions?.find((r) => r.region_code === st.region) ?? null, [regions, st.region]);
  const regionName = region?.name ?? null;
  const groups = useMemo(() => groupRegions(regions ?? []), [regions]);
  const liveOffer = offer && offer.seq === st.seq && offer.region === st.region && st.status === "empty" ? offer.data : null;
  const showAuto = !!onSkip && !!st.region && !!region && !chosen && !autoChoice && (liveOffer !== null || offerAutonomousUpfront(region));
  useEffect(() => { if (liveOffer?.school_label && !autoText) setAutoText(liveOffer.school_label); }, [liveOffer]);
  const chooseAuto = () => {
    if (!st.region || autoBusy) return;
    if (looksLikeUrl(autoText)) { setAutoErr("Название школы — обычный текст, без адресов сайтов. Например: «Лицей № 9»."); return; }
    const { school_label, school_number } = parseSchoolInput(autoText);
    setAutoBusy(true); setAutoErr("");
    onboarding.chooseAutonomous(st.region, school_label, school_number).then((sel) => {
      if (sel.status === "autonomous" && sel.autonomous) {
        setAutoChoice(sel.autonomous); setChosen(null);
        if (onSkip) onSkip();
      }
    }).catch((e: unknown) => {
      setAutoErr(e instanceof ApiError && e.status === 429 ? "Слишком часто. Подождите секунду."
        : e instanceof ApiError && e.status === 422 ? "Проверьте номер или название школы."
        : "Не удалось сохранить выбор. Проверьте интернет и попробуйте ещё раз.");
    }).finally(() => setAutoBusy(false));
  };
  const pickRegion = (code: string | null) => {
    setPickErr("");
    send({ type: "region", code: code || null });
    if (code) window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };
  const clearQuery = () => { send({ type: "query", text: "" }); searchRef.current?.focus(); };

  const pick = (h: SchoolHit) => {
    if (picking || busyRef.current) return;                // защита от двойного нажатия
    setPicking(h.school_uid); setPickErr("");
    onboarding.selectSchool(h.school_uid).then((sel) => {
      if (sel.status !== "selected" || !sel.school) { send({ type: "school_removed" }); return; }
      send({ type: "select", item: h });
      setChosen({ school: sel.school, auth: sel.auth });
      setStudents([]); setStudentId(null); setPassword("");
      go(2);
    }).catch((e: unknown) => {
      const code = apiErrorCode(e);
      setPickErr(code && COPY[code as ConnectErrorCode] ? COPY[code as ConnectErrorCode]! : e instanceof ApiError && e.status === 429
        ? (e.retryAfter ? `Слишком часто. Повторите через ${e.retryAfter} с.` : "Слишком часто. Подождите секунду.")
        : "Не удалось сохранить выбор школы. Проверьте интернет и попробуйте ещё раз.");
    }).finally(() => setPicking(null));
  };
  const changeSchool = () => { send({ type: "change_school" }); setPassword(""); go(1); };

  const submit = async (e?: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e?.preventDefault();
    if (busyRef.current || !chosen || !role) return;   // защита от двойного нажатия
    if (!login) { setError({ code: null, text: "Введите логин от дневника" }); loginRef.current?.focus(); return; }
    if (!password) { setError({ code: null, text: "Введите пароль от дневника" }); pwRef.current?.focus(); return; }
    if (!consent) { setError({ code: "CONSENT_REQUIRED", text: CONSENT_ERROR }); consentRef.current?.focus(); return; }
    if (students.length && studentId === null) { setError({ code: "STUDENT_CHOICE_REQUIRED", text: "Выберите, чей дневник подключить" }); return; }
    busyRef.current = true; setBusy(true); setError(null); send({ type: "disable" });
    try {
      const result = await onboarding.connect({
        role, school_uid: chosen.school.school_uid, login, password,
        ...(studentId !== null ? { student_id: studentId } : {}),
      });
      setPassword("");
      onDone(result);
    } catch (err) {
      const code = connectErrorCode(err);
      if (code === "STUDENT_CHOICE_REQUIRED") {
        setStudents(connectStudents(err));
        setError({ code, text: "В учётной записи несколько детей — выберите, чей дневник подключить" });
      } else if (code === "LOGIN_METHOD_UNSUPPORTED") {
        setPassword("");                                 // пароль этой школе не нужен — не держим его в памяти
        setChosen((c) => c && { ...c, auth: connectAuth(err) ?? { available_auth_methods: [], primary_auth_method: null,
          auth_status: "unavailable", reason: "esia_disabled", esia_state: "disabled" } });
      } else {
        setError({ code, text: describeConnectError(err, code) });
        if (code === "INVALID_CREDENTIALS") window.requestAnimationFrame(() => pwRef.current?.select());
      }
    } finally { busyRef.current = false; setBusy(false); send({ type: "enable" }); }
  };

  const typing = canType(st);
  const hint = pickErr || statusText(st);
  const school = chosen?.school ?? null;
  return <section class="ob l-v l-g0 f-s b-box b-nob l-mx l-w100" aria-labelledby="ob-title" data-step={step}>
    <header class="ob-head l-a1a l-g0 l-mid b-tap mb-1">
      {step > 0 ? <button type="button" class="ob-back l-center l-g0 s-44 r-md" onClick={() => go((step - 1) as Step)} aria-label="Назад" disabled={busy}>
        <span class="ob-back-ico l-h l-inl l-g0" aria-hidden="true"><Icon name="chevron" /></span></button> : <span class="ob-back-gap s-44" aria-hidden="true" />}
      <ol class="ob-dots l-h l-jc l-g1" aria-label={`Шаг ${step + 1} из 3`}>{[0, 1, 2].map((i) => <li key={i} class={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined} />)}</ol>
      <span class="ob-back-gap s-44" aria-hidden="true" />
    </header>
    <div class={`ob-step l-v l-g3 l-grow ob-dir-${dir}`} key={step}>
      <h2 id="ob-title" class="ob-title f-xl mt-1" tabIndex={-1} ref={headRef}>{STEP_TITLES[step]}</h2>

      {step === 0 && <>
        <p class="ob-lead f-s f-2 mb-1">Выберите роль — от неё зависит, что откроется после подключения.</p>
        <div class="ob-roles l-v l-g3" role="group" aria-label="Роль">
          {ROLE_CARDS.map((c) => <button key={c.role} type="button" class={`ob-role l-a1a l-g3 l-mid b-card l-w100 l-rel${role === c.role ? " on" : ""}`} aria-pressed={role === c.role} onClick={() => chooseRole(c.role)}>
            <span class="ob-role-ico l-center l-g0 f-a b-box" aria-hidden="true"><Icon name={c.icon} /></span>
            <span class="ob-role-txt l-v l-g1"><b>{c.title}</b><span class="f-2">{c.text}</span></span>
            <span class="ob-role-check l-center l-g0 b-box" aria-hidden="true"><Icon name="check" /></span>
          </button>)}
        </div>
        {showDemo && <a class="ob-demo f-b f-2 as-c" href={demoURL(location.href)}>Посмотреть демо без входа</a>}
      </>}

      {step === 1 && <>
        {autoChoice && !school && <div class="ob-picked b-card ob-picked-auto" role="group" aria-label="Автономный режим">
          <span class="ob-picked-kicker l-h l-inl l-g1 f-b f-w6 f-a"><Icon name="check" /> Автономный режим</span>
          <b class="ob-picked-name f-s">{autoChoice.display_name}</b>
          <span class="ob-picked-place f-b f-2 f-num">{autoChoice.region} · дневник не подключён</span>
          {onSkip && <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-cta ob-picked-go mt-2" onClick={onSkip}>Продолжить</button>}
          <button type="button" class="ob-link f-b f-a mt-1" onClick={() => setAutoChoice(null)}>Найти школу в каталоге</button>
        </div>}
        {school && st.status !== "school_removed" && <div class="ob-picked b-card" role="group" aria-label="Выбранная школа">
          <span class="ob-picked-kicker l-h l-inl l-g1 f-b f-w6 f-a"><Icon name="check" /> Школа выбрана</span>
          <b class="ob-picked-name f-s">{school.short_name || school.name}</b>
          {locality(school) && <span class="ob-picked-place f-b f-2 f-num">{locality(school)}</span>}
          <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-cta ob-picked-go mt-2" onClick={() => go(2)}>Продолжить</button>
        </div>}
        {st.status === "school_removed" && <p class="ob-error l-v l-g1 f-b f-bad r-lg u-bad-s p-3" role="alert">Выбранная школа больше недоступна в каталоге. Выберите школу заново.</p>}
        {regions && !st.region && <label class="ob-field l-v l-g1 f-b f-2 l-rel ob-region-q">
          <span>Регион: название или код</span>
          <input class="input" type="search" value={regionQ} maxLength={60} autoComplete="off" placeholder="Например: 34 или Волгоград" onInput={(e) => setRegionQ(e.currentTarget.value)} />
        </label>}
        {regions && !st.region && regionQ.trim() && <div class="ob-regions l-h l-wrap" role="group" aria-label="Найденные регионы">
          {regionMatches(regions, regionQ).map((r) => <button key={r.region_code ?? r.name} type="button" class="ob-chip l-h l-inl l-g1 f-b f-2 b-pill l-rel mw-full" onClick={() => { setRegionQ(""); pickRegion(r.region_code); }}>
            {r.region_code && <span class="ob-code">{r.region_code}</span>}{r.name}</button>)}
          {regionMatches(regions, regionQ).length === 0 && <p class="ob-note f-b f-3">Регион не найден. Проверьте название или код субъекта (01–95).</p>}
        </div>}
        <label class="ob-field l-v l-g1 f-b f-2 l-rel ob-region">
          <span>Регион</span>
          <select class="input" ref={regionRef} value={st.region ?? ""} disabled={!regions || busy} aria-describedby={st.status === "unavailable" ? "ob-region-status" : undefined}
            onChange={(e) => pickRegion(e.currentTarget.value || null)}>
            <option value="" disabled>{regions ? "Выберите регион" : "Загружаем регионы…"}</option>
            {groups.catalog.length > 0 && <optgroup label={`${BADGE.sgo_direct} · школы можно найти`}>
              {groups.catalog.map((r) => <option key={r.region_code ?? r.name} value={r.region_code ?? ""}>{r.name}</option>)}
            </optgroup>}
            {groups.other.length > 0 && <optgroup label="Остальные регионы">
              {groups.other.map((r) => <option key={r.region_code ?? r.name} value={r.region_code ?? ""}>{r.name}{modeOf(r) === "esia_gateway" ? " · через Госуслуги" : ""}</option>)}
            </optgroup>}
          </select>
        </label>
        {region && <p class="ob-mode l-h l-base l-wrap l-g1 f-b f-2" data-mode={modeOf(region)}>
          <span class={`ob-mode-badge l-h l-inl l-g0 f-m f-w6 f-nw b-pill is-${modeOf(region)}`}>{BADGE[modeOf(region)]}</span>
          <span>{modeNote(region)}</span>
        </p>}
        {st.status === "unavailable" && <div class="ob-error l-v l-g1 f-b f-bad r-lg u-bad-s p-3" role="alert" id="ob-region-status">
          <p>Не удалось загрузить список регионов.</p>
          <button type="button" class="ob-link f-b f-a mt-1" onClick={() => { setRegions(null); setRegionsTry((n) => n + 1); }}>Повторить</button>
        </div>}
        {!st.region && suggested.length > 0 && <div class="ob-regions l-h l-wrap" role="group" aria-label="Регионы рядом с вами">
          {suggested.map((r) => <button key={r.region_code ?? r.name} type="button" class="ob-chip l-h l-inl l-g1 f-b f-2 b-pill l-rel mw-full" onClick={() => pickRegion(r.region_code)}>
            <span class="ob-near l-center l-g0 f-m f-a" role="img" aria-label="рядом с вами"><Icon name="pin" /></span>{r.name}</button>)}
        </div>}
        <label class={`ob-field l-v l-g1 f-b f-2 l-rel ob-search${typing ? "" : " is-off"}`}>
          <span class="ob-sr f-nw o-h p-abs">{st.region ? `Номер или название школы в регионе ${regionName ?? ""}` : "Сначала выбери свой регион"}</span>
          <span class="ob-search-ico l-center l-g0 f-3 p-abs" aria-hidden="true"><SearchIcon /></span>
          <input ref={searchRef} class="input" style={{ paddingInline: 44 }} type="search" inputMode="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" spellcheck={false}
            placeholder={st.region ? "Номер или название школы, город" : "Сначала выбери свой регион"} value={st.query} maxLength={120}
            disabled={!typing} aria-controls={st.items.length ? "ob-results" : undefined} aria-describedby="ob-search-status"
            onInput={(e) => send({ type: "query", text: e.currentTarget.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && st.items.length) { e.preventDefault(); pick(st.items[0]); } if (e.key === "Escape" && st.query) { e.preventDefault(); clearQuery(); } }} />
          {fetching && <span class="ob-spinner b-round l-fix ob-search-spin p-abs" aria-hidden="true" />}
          {st.query && typing && !fetching && <button type="button" class="ob-clear l-center l-g0 f-2 b-bare s-44 p-abs r-md" aria-label="Очистить поиск" onClick={clearQuery}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
        </label>
        <p id="ob-search-status" class={`ob-status f-b f-num${pickErr ? " is-error f-bad" : " f-3"}`} role="status" aria-live="polite">{hint}</p>
        {(st.status === "network_error" || st.status === "service_error" || st.status === "cancelled") &&
          <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-btn-secondary b-box b-nob" onClick={() => send({ type: "retry" })}>Повторить поиск</button>}
        {st.items.length > 0 && <ul id="ob-results" class="ob-results l-v" aria-label="Найденные школы">
          {st.items.map((h) => <li key={h.school_uid}>
            <button type="button" class="ob-school l-1a l-g1 l-mid b-card b-tap l-w100" onClick={() => pick(h)} disabled={!!picking} aria-busy={picking === h.school_uid}>
              <b>{h.short_name || h.name}</b>
              <span class="f-2">{locality(h) || h.name}</span>
              {h.password_login === false && <span class="ob-school-tag f-m f-2 b-pill mt-1">Вход только через Госуслуги</span>}
              <span class="ob-school-go l-h l-inl l-g0 f-3 f-2" aria-hidden="true">{picking === h.school_uid ? <span class="ob-spinner b-round l-fix f-2" /> : <Icon name="chevron" />}</span>
            </button></li>)}
        </ul>}
        {st.hasMore && st.status === "success" && <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-btn-secondary b-box b-nob" onClick={() => send({ type: "more" })}>Показать ещё</button>}
        {st.status === "success" && <p class="ob-note f-b f-3">Школы нет в списке — значит, её сервер ещё не проверен. Код школы и адрес сервера вручную не вводятся: так пароль не уйдёт на чужой сайт.</p>}
        {showAuto && regionName && <div class="ob-auto l-v b-card" role="region" aria-labelledby="ob-auto-title">
          <h3 id="ob-auto-title" class="ob-auto-title f-s">{liveOffer?.title ?? autonomousTitle(regionName)}</h3>
          <p class="ob-auto-hint f-b f-2">{liveOffer?.hint ?? "Задания учителя, свои задачи, фокус и тьютор работают без дневника — его можно подключить позже."}</p>
          {liveOffer && liveOffer.institution_matches.length > 0 && <p class="ob-auto-hint f-b f-2">Похожие организации из открытого реестра: {liveOffer.institution_matches.map((m) => m.name).join("; ")}</p>}
          <label class="ob-field l-v l-g1 f-b f-2 l-rel">
            <span>Номер или название школы <span class="ob-optional f-w4 f-3">(необязательно)</span></span>
            <input class="input" type="text" value={autoText} maxLength={120} autoComplete="off" placeholder="Например: 121 или «Лицей № 9»"
              aria-describedby={autoErr ? "ob-auto-err" : undefined} onInput={(e) => { setAutoText(e.currentTarget.value); setAutoErr(""); }} />
          </label>
          {autoErr && <p id="ob-auto-err" class="ob-error l-v l-g1 f-b f-bad r-lg u-bad-s p-3" role="alert">{autoErr}</p>}
          <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-cta" onClick={chooseAuto} disabled={autoBusy} aria-busy={autoBusy}>
            {autoBusy ? <span class="ob-spinner b-round l-fix" aria-hidden="true" /> : null}Продолжить в автономном режиме</button>
        </div>}
      </>}

      {step === 2 && school && <>
        <div class="ob-picked b-card ob-picked-compact" role="group" aria-label="Выбранная школа">
          <span class="ob-picked-kicker l-h l-inl l-g1 f-b f-w6 f-a"><Icon name="check" /> Школа выбрана</span>
          <b class="ob-picked-name f-s">{school.short_name || school.name}</b>
          {locality(school) && <span class="ob-picked-place f-b f-2 f-num">{locality(school)}</span>}
          <button type="button" class="ob-link f-b f-a mt-1 ob-picked-change b-tap as-c" onClick={changeSchool} disabled={busy}>Изменить школу</button>
        </div>
        {passwordLogin(chosen?.auth ?? null) && !pwMode && <EsiaLogin onConnected={() => onDone({ role: role ?? "student", school_name: school.short_name || school.name } as ConnectResult)} onSandboxDone={enterJury} onPassword={() => setPwMode(true)} />}
        {passwordLogin(chosen?.auth ?? null) ? pwMode && <form class="ob-form l-v l-g3 l-grow" onSubmit={(e) => void submit(e)} autoComplete="on" noValidate>
          <label class="ob-field l-v l-g1 f-b f-2 l-rel"><span>Логин от дневника</span>
            <input ref={loginRef} class="input" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellcheck={false} enterKeyHint="next"
              value={login} maxLength={200} aria-invalid={error?.code === "INVALID_CREDENTIALS"} disabled={busy}
              onInput={(e) => setLogin(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); pwRef.current?.focus(); } }} /></label>
          <label class="ob-field l-v l-g1 f-b f-2 l-rel"><span>Пароль</span>
            <span class="ob-pw l-blk l-rel">
              <input ref={pwRef} class="input" style={{ paddingRight: 56 }} name="password" type={showPw ? "text" : "password"} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellcheck={false}
                enterKeyHint="go" value={password} maxLength={300} aria-invalid={error?.code === "INVALID_CREDENTIALS"} disabled={busy}
                onInput={(e) => setPassword(e.currentTarget.value)} />
              <button type="button" class="ob-eye l-center l-g0 f-2 b-bare s-44 p-abs r-md" aria-pressed={showPw} aria-label={showPw ? "Скрыть пароль" : "Показать пароль"} onClick={() => setShowPw((v) => !v)} disabled={busy}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8" /><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />{showPw ? null : <path d="M4 20 20 4" stroke="currentColor" stroke-width="1.8" />}</svg>
              </button>
            </span></label>
          {students.length > 0 && <fieldset class="ob-kids l-v b-bare"><legend>Чей дневник подключить?</legend>
            {students.map((s) => <label key={s.id} class={`ob-kid l-h b-card b-tap${studentId === s.id ? " on" : ""}`}>
              <input type="radio" name="ob-student" value={s.id} checked={studentId === s.id} onChange={() => setStudentId(s.id)} /><span>{s.name}</span></label>)}
          </fieldset>}
          {error && <div class="ob-error l-v l-g1 f-b f-bad r-lg u-bad-s p-3" role="alert">
            <p>{error.text}</p>
            {error.code && PICK_AGAIN.has(error.code) && <button type="button" class="ob-link f-b f-a mt-1" onClick={changeSchool}>Выбрать другую школу</button>}
            {error.code === "ROLE_MISMATCH" && <button type="button" class="ob-link f-b f-a mt-1" onClick={() => go(0)}>Сменить роль</button>}
          </div>}
          {/* V23: ошибка входа стоит сразу под полями, согласие — перед кнопкой */}
          <DiaryConsent checked={consent} disabled={busy} inputRef={consentRef} invalid={error?.code === "CONSENT_REQUIRED"}
            onChange={(v) => { setConsent(v); if (v && error?.code === "CONSENT_REQUIRED") setError(null); }} />
          <div class="ob-footer l-v">
            <button type="submit" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-cta" disabled={busy} aria-busy={busy}>
              <span class="ob-cta-stack l-center l-g0">
                <span class={busy ? "ob-hide" : ""}>Подключить дневник</span>
                <span class={busy ? "" : "ob-hide"} aria-hidden={!busy}><span class="ob-spinner b-round l-fix" aria-hidden="true" />Проверяем доступ к школе...</span>
              </span>
            </button>
            <p class="ob-secure f-b f-2 f-tc"><Icon name="lock" /> Пароль нужен только для входа в дневник и не сохраняется</p>
            <button type="button" class="ob-link f-b f-a mt-1" onClick={() => setPwMode(false)} disabled={busy}>Войти через Госуслуги</button>
          </div>
        </form> : <div class="ob-esia l-v l-g3 b-card" role="region" aria-labelledby="ob-esia-title">
          <h3 id="ob-esia-title" class="ob-esia-title f-s">В этом регионе вход в дневник переведён на Госуслуги (ЕСИА)</h3>
          <p class="ob-esia-text f-b f-2">{ESIA_REASON[chosen?.auth?.reason ?? "esia_disabled"]} Пароль от дневника этой школе не отправляется.</p>
          <p class="ob-esia-state l-h l-inl f-b f-2"><span class="ob-esia-dot l-fix r-xs" aria-hidden="true" />Госуслуги: {chosen?.auth?.esia_state === "misconfigured" ? "ошибка настройки сервера" : "шлюз отключён"}</p>
          <div class="ob-esia-actions l-v">
            <EsiaLogin onConnected={() => onDone({ role: role ?? "student", school_name: school.short_name || school.name } as ConnectResult)} onSandboxDone={enterJury} />
            <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-btn-secondary b-box b-nob" onClick={changeSchool}>Выбрать другую школу</button>
            {/* F9: в ESIA-only панели ровно две кнопки; демо-ссылка остаётся только на шаге выбора роли */}
          </div>
        </div>}
      </>}
    </div>
  </section>;
}

/** v3.2 · мгновенный поиск субъекта по названию, синониму или коду («34» → Волгоградская область). */
export function regionMatches<T extends { region_code: string | null; name: string; aliases?: string[] }>(items: readonly T[], q: string): T[] {
  const n = q.trim().toLowerCase().replace(/ё/g, "е"); if (!n) return [];
  const code = /^\d{1,3}$/.test(n) ? n.padStart(2, "0") : null;
  return items.filter((r) => code ? r.region_code === code : [r.name, ...(r.aliases ?? [])].some((x) => x.toLowerCase().replace(/ё/g, "е").includes(n))).slice(0, 6);
}

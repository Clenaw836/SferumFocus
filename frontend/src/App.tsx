import {useInteractionMode} from './lib/useInteractionMode';
import {LoadingRows} from './ui/LoadingRows';
import {SandboxBar} from './ui/SandboxBar';
import {inSandbox} from './lib/sandbox';
import {liveURL, startSandbox, switchPersona} from './lib/demoSession';
import {shortName, verifiedProfile} from './lib/profileName';
import type {ProfileView} from './ui/ProfileHub';
import {UserBackground} from './ui/UserBackground';
import {MISSION_MINUTES} from './ui/GradeWhatIf';
import {diaryURL} from "./lib/bootstrap";
import { invalidateIdentity } from "./lib/identity";
import {refreshProfile, roleContext, rolePolicy, requestDemoRole} from "./lib/roleContext";
/**
 * СферумФокус — MAX Mini App. Поток демо:
 * бот в MAX → кнопка «Построить план дня» (диплинк startapp=plan) → мгновенная ориентация
 * (сколько задано, «Мои дела сегодня») → одно действие → план от ТЕКУЩЕГО времени и
 * «Уроки закончишь в 17:35» (WOW) → дуэль → награда.
 */
import { BrandBar } from "./ui/BrandBar";
import { createCompletionQueue } from "./lib/completionQueue";
import { cache } from "./lib/api";
import { setSyncPending } from "./lib/syncState";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, dataMode, getRole, onDataMode, reconnect, setRole as persistRole, type DataMode } from "./lib/api";
import { celebrate } from "./ui/Celebrate";
import { dayStore, schoolDay } from "./lib/day";
import { schoolDayMin } from "./lib/schoolDay";
import { closingGuard, haptic, launchInfo, maxUser, openUrl, parseStart, ready, routeOf, setupViewport, startParam, taskId, withLaunch } from "./lib/host";
import { dur, toHHMM, toMin } from "./lib/time";
import { clockNow, nowDate, nowMin, planWindow, setSchoolTz } from "./lib/clock";
import { nextUp } from "./lib/mission";
import { computeDay, type DayOut } from "./lib/dayEngine";
import { newId, seedFrom, toPersonal, type ActDraft } from "./lib/activities";
import type { CalculateResponse, DayActivity, InitialState, Rewards, Role, Task, Triage, WhoAmI } from "./lib/types";
import { Icon } from "./ui/Icon";
import { Sheet } from "./ui/Sheet";
import { Segmented } from "./ui/Segmented";
import { Toaster, toast } from "./ui/Toast";
import { Tonight } from "./screens/Tonight";
import { Study, type StudySeg } from "./screens/Study";
import type { SimRequest } from "./ui/GradeSim";
import { makeApplyWhatIf } from "./lib/whatifApply";
import { DEMO, resetDemo, nsKey } from "./lib/demo";
import { parseChallenge, type Challenge } from "./lib/blitzBank";
import { gradeNum, rememberedSeg, rememberSeg, type PracticeSeg } from "./lib/practiceSeg";
import type { PracticumView } from "./ui/practicum/PracticumSheet";
import { FocusDock } from "./ui/FocusDock";
import type { DoneInfo } from "./ui/StudyTimer";
import { focus, useFocusSession } from "./lib/focus";
import { applyHwSnapshot, completeHw, hwElapsed, hwNewCount, isTeacherTask, startHwSync, useHw } from "./lib/hwSync";
import { startHwNotify } from "./lib/hwNotify";
import { HwPill, HwPixelToast, showHwPixel } from "./ui/HwPixel";
import { findQuiz, NOT_FOUND_LINK, OFFLINE } from "./ui/QuizCode";
import { sched } from "./lib/schedStore";
import { events, type EventType } from "./lib/events";
import { activeLessons, morningBudget, morningPlan, schoolTimes } from "./lib/daycycle";
import { aheadStore, planHorizon, splitByHorizon } from "./lib/planHorizon";
import { rescue as computeRescue, type Rescue } from "./lib/survival";
import { bedFor, bedLogToday, driftNotice, logBed, prefs, setBedLogToday, snoozeDrift } from "./lib/bedtime";
import { activityReply, afterDone, answer, hint as mkHint, type Act, type ActDraftX, type Ctx, type Reply } from "./lib/assistant";
import { type ScheduleChange } from "./lib/schedule";
import { buildPlan } from "./engine/norms";
import { splitTitle } from "./lib/subjects";
import { Assistant, ReplyCard } from "./ui/Assistant";
import { saveBed as persistBed, saveWake as persistWake, sleepSpan, wakeFor, type SaveResult } from "./lib/sleep";

import { HOME_TAB, readHash, TAB_META, tabsFor, type Tab } from "./lib/nav";
import { AccountConnections, AccountSettings, ActivitySheet, AddTask, BedtimeSheet, Blitz, DiaryWelcome, Duel, EvidenceSheet, ExternalAiNotice, JuryDrawer, MyClass, Practice, PracticumSheet, ProfileHub, QuizCodeSheet, RescueCard, ScheduleBuilder, ScheduleImport, TaskSheet, Tutor, WakeSheet, WhatIf } from "./lazyScreens";
import { lazyIdle } from "./ui/lazy";
import { clampT, hhmm, savedAt, sigOf, skyFor, eveningTasks } from "./lib/appUtil";

export function App() {
  useInteractionMode();
  // v3.2 · PERF-01: остальные экраны догружаются фоном, когда первый уже на экране.
  useEffect(() => { lazyIdle(); }, []);
  const completionQueue = useMemo(() => createCompletionQueue<Rewards>(localStorage, () => nsKey("sf.completion-outbox.v1"),
    intent => api.event("task_done", intent.payload, intent.operationId)), []);
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootErr, setBootErr] = useState("");
  const [bootCode, setBootCode] = useState(0);
  const [initial, setInitial] = useState<InitialState | null>(null);
  const [offline, setOffline] = useState(false);
  const [aiOnline, setAiOnline] = useState<boolean | null>(null);
  const [extra, setExtra] = useState<Task[]>(dayStore.extra());
  const [hidden, setHidden] = useState<string[]>(dayStore.hidden());
  const [done, setDone] = useState<string[]>(dayStore.done());
  const [startOv, setStartOv] = useState<string | null>(dayStore.startToday());
  const [bedV, setBedV] = useState(0);
  const [survival, setSurvival] = useState(false);
  const [plan, setPlan] = useState<CalculateResponse | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [tab, setTabState] = useState<Tab>(() => readHash().tab);
  // v2.2: «Учёба» открывается на «Дневнике» (расписание и оценки дня — главное, ради чего её открывают).
  const [studySeg, setStudySeg] = useState<StudySeg>(() => readHash().seg ?? "diary");
  const [simRequest, setSimRequest] = useState<SimRequest | null>(() => (readHash().sim ? { subject: null, at: Date.now() } : null));   // v2.2: открыть «Симулятор оценок» (жюри, чип предмета, #grades)
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [logV, setLogV] = useState(0);
  const [cards, setCards] = useState(dayStore.cards());
  const [types, setTypes] = useState(dayStore.types());
  const [tri, setTri] = useState<Triage | null>(null);
  const [triBusy, setTriBusy] = useState(false);
  const [rebuild, setRebuild] = useState(0);
  const buildSeq = useRef(0);
  const buildingSig = useRef<string | null>(null);
  // «Мои дела сегодня»: null до загрузки initial (тогда засеваем из настроек один раз за день)
  const [acts, setActsState] = useState<DayActivity[]>(dayStore.acts() ?? []);
  const [actSheet, setActSheet] = useState<{ open: boolean; editing: DayActivity | null }>({ open: false, editing: null });
  const [planSig, setPlanSig] = useState<string | null>(null);
  const [nowM, setNowM] = useState(nowMin());
  /** v16: часы пересчитываются, когда пересчёт что-то меняет: на границе минуты (видимая вкладка),
   *  при возврате во вкладку/фокус/сеть/смене пояса школы. Скрытая вкладка — ни одного таймера (без опроса раз в 30 с). */
  const [clkV, setClkV] = useState(0);
  useEffect(() => {
    let t = 0;
    const arm = () => {
      clearTimeout(t);
      if (document.hidden) return;
      const ms = 60_000 - (Date.now() % 60_000) + 50;   // ровно к смене минуты (+50 мс запаса)
      t = window.setTimeout(() => { setNowM(nowMin()); setClkV((v) => v + 1); arm(); }, ms);
    };
    const wake = () => { setNowM(nowMin()); setClkV((v) => v + 1); arm(); };
    arm();
    document.addEventListener("visibilitychange", wake);
    addEventListener("focus", wake); addEventListener("online", wake);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", wake); removeEventListener("focus", wake); removeEventListener("online", wake); };
  }, []);
  const [role, setRoleState] = useState<Role>(getRole());
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [duel, setDuel] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addIntent, setAddIntent] = useState<"text" | "photo">("text");
  const [codeOpen, setCodeOpen] = useState(false);          // v2.2 · «Опрос по коду учителя»
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(!DEMO && new URLSearchParams(location.search).get("manage") === "diary");
  const [profileView, setProfileView] = useState<ProfileView>("home");
  const openProfile = (v: ProfileView = "home") => { setProfileView(v); setProfileOpen(true); haptic.select(); };
  const [joinCode, setJoinCode] = useState("");
  const [dm, setDm] = useState<DataMode>(dataMode());
  const [botName, setBotName] = useState<string | null>(null);
  const [blitzPreset, setBlitzPreset] = useState<{ key: string; n: number } | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [inGame, setInGame] = useState(false);
  const session = useFocusSession();
  const [juryOpen, setJuryOpen] = useState(false);
  const [recoveryContext,setRecoveryContext]=useState<string|null>(()=>{const q=new URLSearchParams(location.search);const s=q.get('tutor_subject');return s?(s.slice(0,160)+': '+(q.get('tutor_topic')||'Разобрать тему').slice(0,300)):null;});
  /** v2.1 · B2: «Что, если…» → 15-минутная Фокус-миссия по теме → сократический тьютор (готовых ответов нет).
   *  Чужой запущенный таймер не сбрасываем — как и у миссий плана дня. */
  const startRecoveryMission = (subject: string, topic: string) => {
    const title = `Фокус-миссия: ${subject}`.slice(0, 160);
    const current = focus.get();
    if (current && current.title !== title) { toast("Сначала заверши или останови текущий таймер", "info"); return; }
    focus.start(title, MISSION_MINUTES * 60);
    setRecoveryContext(`${subject}: ${topic || "Разобрать тему"}`.slice(0, 470));
    setTab("tutor");
    haptic.select();
    toast(`${MISSION_MINUTES} минут фокуса: тьютор спрашивает — ответ находишь ты`, "ok");
  };
  useEffect(() => onDataMode(setDm), []);
  // Идёт работа по таймеру (не пауза и не перерыв) → MAX спросит подтверждение перед закрытием мини-аппа.
  const working = !!session && session.pausedAt === null && !session.breakAt;
  useEffect(() => { closingGuard(working, "focus"); }, [working]);
  /** v3.0 · вкладка «Практика»: сегмент [Практикумы | Блиц]. Нажатие на вкладку — запомненный сегмент,
   *  «Тренировка»/вызов/«#blitz» — сразу блиц. Адрес: «#practice» или «#blitz». */
  const [pseg, setPsegState] = useState<PracticeSeg>(() => readHash().practice ?? rememberedSeg());
  const psegRef = useRef(pseg); psegRef.current = pseg;
  const [prView, setPrView] = useState<PracticumView | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  const [prRev, setPrRev] = useState(0);   // закрыли практикум → каталог перечитывает статусы с сервера
  const openPracticum = (v: PracticumView) => { setPrView(v); setPrOpen(true); haptic.select(); };
  const setTab = useCallback((t: Tab, ps?: PracticeSeg) => {
    setTabState(t);
    if (ps) { setPsegState(ps); psegRef.current = ps; }
    const route = t === "study" && studySeg === "progress" ? "progress" : t === "blitz" ? ((ps ?? psegRef.current) === "blitz" ? "blitz" : "practice") : t;
    try { history.replaceState(null, "", `${location.pathname}${location.search}${withLaunch(route)}`); } catch { /* sandbox */ }
  }, [studySeg]);
  const setPseg = (s: PracticeSeg) => { rememberSeg(s); setTab("blitz", s); };
  useEffect(() => {
    const h = () => { const r = readHash(); setTabState(r.tab); if (r.practice) setPsegState(r.practice); if (r.seg) setStudySeg(r.seg); if (r.sim) setSimRequest({ subject: null, at: Date.now() }); };
    addEventListener("hashchange", h);
    return () => removeEventListener("hashchange", h);
  }, []);
  useEffect(() => {
    // запоминаем точку последнего касания — из неё «вылетает» награда
    const h = (e: PointerEvent) => { (window as unknown as { __sfTap?: { x: number; y: number } }).__sfTap = { x: e.clientX, y: e.clientY }; };
    addEventListener("pointerdown", h, { passive: true });
    return () => removeEventListener("pointerdown", h);
  }, []);

  // v3.2.1 · горизонт плана (lib/planHorizon.ts): в день — ДЗ к ближайшему учебному дню; остальное — «Задано наперёд»
  const [aheadV, setAheadV] = useState(0);
  const { tasks, ahead, tails } = useMemo(() => {
    const base = (initial?.diary_tasks ?? []).filter((t) => !hidden.includes(t.title));
    const seen = new Set(base.map((t) => t.title));
    const all = [...base, ...extra.filter((t) => !seen.has(t.title))].map((t) => (types[t.title] && types[t.title] !== t.type ? { ...t, type: types[t.title] } : t));
    const td = schoolDay();
    const first = activeLessons(sched.day(td).lessons)[0]?.start_time;
    const h = planHorizon(td, (d) => sched.day(d).lessons.length > 0, !first || schoolDayMin(nowM) < toMin(first));
    const sp = splitByHorizon(all, h, td, aheadStore.pulled(td), aheadStore.doneAhead(td), new Set([...dayStore.doneFor(-1), ...dayStore.done()]));
    return { tasks: sp.now, ahead: sp.ahead, tails: sp.tails };
  }, [initial, extra, hidden, types, nowM, aheadV]);
  const pullAhead = (t: Task) => {
    if (!t.deadline) return;
    aheadStore.pull(t.title, t.deadline, schoolDay()); setAheadV((v) => v + 1);
    haptic.select(); toast(`«${splitTitle(t.title).subject || t.title}» — в плане на сегодня`, "ok");
  };
  // Recovery 2: teacher assignments — server record, device timer. Wired once; snapshots reconcile.
  useEffect(() => startHwSync({
    isDone: (title) => dayStore.done().includes(title),
    markDone: (title) => {
      const next = [...new Set([...dayStore.done(), title])]; dayStore.setDone(next); setDone(next);
      if (!dayStore.log()[title]) dayStore.setLog(title, { startedAt: null, finishedAt: Date.now(), workedSec: null, plannedMin: 0, actualMin: null, rounds: null, synced: true });
      setLogV((v) => v + 1);
    },
    retitle: (from, to) => {
      const swap = (xs: string[]) => xs.map((x) => (x === from ? to : x));
      const d = swap(dayStore.done()); dayStore.setDone(d); setDone(d);
      const h = swap(dayStore.hidden()); dayStore.setHidden(h); setHidden(h);
      const rec = dayStore.log()[from]; if (rec) { dayStore.setLog(to, rec); dayStore.setLog(from, null); setLogV((v) => v + 1); }
      setOpenTask((o) => (o && o.title === from ? { ...o, title: to } : o));
    },
    refresh: () => { api.initial().then(({ data }) => setInitial(data)).catch(() => undefined); },
    toast,
  }), []);
  useEffect(() => { if (initial) applyHwSnapshot(initial.teacher_assignments ?? []); }, [initial]);
  // v2: новое задание/опрос от учителя — тост один раз; «Новое» на строке и вкладке держится до открытия
  useHw();
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const openIssue = (id: string) => {
    const t = tasksRef.current.find((x) => x.provider_assignment_id === id);
    setTab("tonight");
    if (t) { setOpenTask(null); setTimeout(() => setOpenTask(t), 0); } else toast("Задание появится в списке после синхронизации", "info");
  };
  // v2.2 · QR/код опроса: выдача может быть свежее снимка на устройстве → один раз обновляем снимок и открываем
  const wantIssue = useRef<string | null>(null);
  const openHwIssue = (id: string) => {
    if (tasksRef.current.some((x) => x.provider_assignment_id === id)) { openIssue(id); return; }
    wantIssue.current = id;
    api.initial().then(({ data }) => {
      setInitial(data);
      setTimeout(() => { if (wantIssue.current === id) { wantIssue.current = null; toast("Опрос уже сдан или его нет в плане на сегодня", "info"); } }, 1500);
    }).catch(() => { wantIssue.current = null; toast(OFFLINE, "warn"); });
  };
  useEffect(() => { const id = wantIssue.current; if (id && tasks.some((x) => x.provider_assignment_id === id)) { wantIssue.current = null; openIssue(id); } }, [tasks]);
  // v2.2: «пиксельный» тост → через 4 с сворачивается в пилюлю наверху «Вечера» (ui/HwPixel.tsx)
  useEffect(() => (role === "teacher" ? undefined : startHwNotify({
    announce: (text, open, fresh) => showHwPixel(fresh, open, text),
    refresh: () => api.initial().then(({ data }) => setInitial(data)).catch(() => undefined),
    openIssue,
  })), [role]);

  // ---------- петля дня: расписание (с изменениями) → утро/школа/дорога/вечер → сон ----------
  const [schedV, setSchedV] = useState(0);
  useEffect(() => sched.on(() => setSchedV((v) => v + 1)), []);
  const [caps, setCaps] = useState({ ocr: false, stt: false });
  const [compact, setCompact] = useState(false);
  const [order, setOrder] = useState<"default" | "short_first">("default");
  const [reply, setReply] = useState<Reply | null>(null);
  const [hintOff, setHintOff] = useState<string | null>(null);
  const [evSheet, setEvSheet] = useState<{ open: boolean; prefill: string | null }>({ open: false, prefill: null });
  const [bedOpen, setBedOpen] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [wakeV, setWakeV] = useState(0);
  const [pick, setPick] = useState<{ for: "home" | "act"; draft?: ActDraftX } | null>(null);
  const [pickT, setPickT] = useState("16:00");
  const [voiceSig, setVoiceSig] = useState(0);
  const [hwPrefill, setHwPrefill] = useState<string | null>(null);
  const [actsTom, setActsTom] = useState<DayActivity[] | null>(dayStore.actsFor(1));
  const [importOpen, setImportOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const today = schoolDay(), tomorrow = schoolDay(nowDate(), 1);
  const S = initial?.settings;
  const travel = S?.travel_minutes ?? 45, serverWake = S?.wake_time ?? "06:45", prep = S?.prep_minutes ?? 15;
  // v16.1: подъём — отдельная настройка ученика (sf.prefs.wake) поверх настроек школы
  const wake = useMemo(() => wakeFor(serverWake), [serverWake, wakeV]);
  const rec = S?.recommended_bedtime ?? S?.bedtime ?? "22:00";
  const vToday = useMemo(() => sched.day(today), [today, schedV, dm, initial]);
  const vTom = useMemo(() => sched.day(tomorrow), [tomorrow, schedV, dm, initial]);
  const times = useMemo(() => schoolTimes(vToday.lessons, travel), [vToday, travel]);
  const timesT = useMemo(() => schoolTimes(vTom.lessons, travel), [vTom, travel]);
  const bedInfo = useMemo(() => bedFor(rec), [rec, bedV, today]);
  const bedtime = bedInfo.effective;
  const setBedtime = (v: string) => { dayStore.setBedToday(v); setBedV((x) => x + 1); };
  const recStart = S?.recommended_start ?? "15:30";
  // вечер начинается, когда ученик дома: последний звонок + дорога (но не раньше привычного старта)
  const autoStart = times.homeAt !== null && times.homeAt > toMin(recStart) ? toHHMM(times.homeAt) : recStart;
  const start = startOv ?? autoStart;
  const setStart = (v: string) => { setStartOv(v); dayStore.setStartToday(v); };
  // ---------- v16: ОДИН расчёт дня (движок = app/day_engine.py, паритет 47 случаев) ----------
  const clk = useMemo(() => clockNow(), [nowM, clkV]);
  const schedStatus = sched.status();
  const engineMs = useRef<number | null>(null);
  const day = useMemo<DayOut>(() => {
    const t0 = performance.now();
    const dv = (v: typeof vToday) => ({ available: v.available || v.lessons.length > 0, lessons: v.lessons });
    const pv = sched.provider();
    const out = computeDay({
      now_local: clk.now_local,
      days: { [today]: dv(vToday), [tomorrow]: dv(vTom) },
      settings: { travel_minutes: travel, bedtime, evening_start: recStart, start_override: startOv },
      schedule: { status: sched.baseStatus(), is_demo: !!pv?.is_demo, last_sync_at: pv?.last_sync_at ?? null },
      tasks: tasks.map((t) => ({ title: t.title, planned_minutes: t.planned_minutes, type: t.type })),
      done, clock_warning: clk.warning,
    });
    if (engineMs.current === null) engineMs.current = performance.now() - t0;
    return out;
  }, [clk, today, tomorrow, vToday, vTom, travel, bedtime, recStart, startOv, tasks, done, schedV]);
  const phase = day.phase;
  const left = tasks.filter((t) => !done.includes(t.title));
  const movedToday = dayStore.moved(0);
  const mp = morningPlan(left.filter((t) => t.source === "morning" || movedToday[t.title]), nowM, wake, times, prep);
  const morningNow = phase === "morning" ? mp.fit : [];
  // Общий состав вечернего расчёта: API, прогноз, rescue, сон и preview.
  const evening = eveningTasks(tasks, done, phase === "morning", movedToday);
  const inputSig = sigOf(evening, start, bedtime, acts, survival, compact, order, phase === "morning");

  const load = useCallback(async () => {
    setBoot("loading");
    // Entry gate has already awaited Bridge and confirmed identity.
    ready();
    setupViewport();
    // localStorage WebView мог очиститься — поднимаем учебный день из DeviceStorage MAX
    if (await dayStore.hydrate().catch(() => false)) {
      setDone(dayStore.done()); setExtra(dayStore.extra()); setHidden(dayStore.hidden()); setTypes(dayStore.types()); setCards(dayStore.cards()); setLogV((v) => v + 1);
      const a = dayStore.acts(); if (a) setActsState(a);
    }
    api.health().then((h) => { setAiOnline(h.ai ?? null); setBotName(h.bot_name ?? null); setCaps({ ocr: !!h.ocr, stt: !!h.stt }); if (setSchoolTz(h.school_tz)) { setNowM(nowMin()); setClkV((v) => v + 1); } }).catch(() => setAiOnline(null));
    await Promise.all([sched.hydrate(), events.hydrate()]).catch(() => undefined);
    sched.loadWeek(schoolDay()).then(() => sched.sync());
    focus.restore().catch(() => undefined);
    try {
      const { data, cached, cachedAt } = await api.initial();
      setInitial(data); setOffline(cached);
      if (dayStore.acts() === null) { const seeded = seedFrom(data.settings.personal_activities); dayStore.setActs(seeded); setActsState(seeded); }
      if (dayStore.actsFor(1) === null) { const seeded = seedFrom(data.settings.personal_activities); dayStore.setActsFor(1, seeded); setActsTom(seeded); }
      setBoot("ready");
      if (cached) toast(`Нет связи — показываю сохранённое${savedAt(cachedAt)}`, "warn");
      else if (DEMO) toast("Демо-режим: чистый день, всё считается на телефоне", "info");
      else if (dataMode() === "local") toast("Автономный режим: всё считается на телефоне", "info");
      api.rewards().then(setRewards).catch(() => undefined);
      // Сервер — источник правды о входе и роли. Школьный режим: роль фиксирована сервером.
      api.whoami().then((w) => {
        refreshProfile(w);
        setWho(w);
        if (rolePolicy(w).role !== roleContext().role || rolePolicy(w).canSwitch !== roleContext().canSwitch) { invalidateIdentity(); location.reload(); }
      }).catch(() => undefined);
    } catch (e) {
      setBootErr(e instanceof ApiError ? e.message : "Не удалось загрузиться");
      setBootCode(e instanceof ApiError ? e.status : 0);
      setBoot("error");
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // A successful provider connection/disconnect changes the authoritative source.
  // Refresh without remounting the app or discarding the student's draft.
  useEffect(() => {
    let stopped = false;
    const refreshDiary = async () => {
      await sched.loadWeek(schoolDay());
      try { const { data, cached } = await api.initial(); if (!stopped) { setInitial(data); setOffline(cached); } } catch { /* keep the explicitly stale cache offline */ }
    };
    // v2.2: подключение/смена дневника меняет ФИО из СГО — обновляем профиль того же аккаунта без перезапуска.
    const changed = () => { void refreshDiary(); api.whoami().then((w) => { if (!stopped && refreshProfile(w)) setWho(w); }).catch(() => undefined); };
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !DEMO) void refreshDiary(); }, 300000);
    document.addEventListener("sf-diary-change", changed);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("sf-diary-change", changed); };
  }, []);
  // связь вернулась → отправляем офлайн-очередь изменений расписания и обновляем неделю
  useEffect(() => {
    const on = () => { reconnect(); sched.sync().then(() => sched.loadWeek(schoolDay())); };
    addEventListener("online", on);
    return () => removeEventListener("online", on);
  }, []);

  const build = useCallback(async (opts?: { survival?: boolean; silent?: boolean; restore?: boolean }) => {
    if (!initial || planBusy) return;
    const left = evening;
    if (!left.length) { setPlan(null); setPlanSig(null); return; }
    if (toMin(start) >= toMin(bedtime)) { setPlanError("Старт должен быть раньше отбоя."); return; }
    // План — от ТЕКУЩЕГО времени: прошлое не планируем; позже отбоя — не строим вовсе
    const win = planWindow(start, bedtime, nowMin());
    setNowM(nowMin());
    if (win.state === "afterBed") { setPlan(null); setPlanError(null); return; }
    const surv = opts?.survival ?? survival;
    const sig = sigOf(evening, start, bedtime, acts, surv, compact, order, phase === "morning");
    buildingSig.current = sig;
    const seq = ++buildSeq.current;
    setPlanBusy(true); setPlanError(null);
    if (!opts?.silent) haptic.tap("medium");
    try {
      const r = await api.calculate({ tasks: left, start_time: win.start, bedtime, rest_slots: initial.settings.rest_slots, personal_activities: acts.map(toPersonal), survival: surv, compact_breaks: compact, order });
      if (seq !== buildSeq.current) return;   // входные данные поменялись, пока считали — устаревший план не показываем
      setPlan(r); setPlanSig(sig); dayStore.setBuilt(true);
      haptic.notify(r.plan.deficit_minutes > 0 ? "warning" : "success");
      if (!opts?.restore) api.event("plan_built").then(setRewards).catch(() => undefined);   // восстановление после refresh — не новый план
      if (!opts?.restore) window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (seq !== buildSeq.current) return;
      setPlanError(e instanceof ApiError ? e.message : "Попробуй ещё раз");
      haptic.notify("error");
    } finally { if (seq === buildSeq.current) setPlanBusy(false); }
  }, [initial, tasks, done, start, bedtime, survival, planBusy, acts, compact, order, inputSig]);
  // Изменились окно, список или дела — запрос в полёте устарел
  useEffect(() => { if (planBusy && buildingSig.current !== inputSig) { buildSeq.current++; setPlanBusy(false); } }, [inputSig]);
  // План устарел: после сборки поменялись задания, окно, дела или режим — снова показываем главную кнопку
  const stale = !!plan && planSig !== null && planSig !== inputSig;
  const win = planWindow(start, bedtime, nowM);
  const personal = useMemo(() => acts.map(toPersonal), [acts]);
  const tomorrowBudget = morningBudget(null, wake, timesT.leave, prep);
  const rescueR = useMemo<Rescue | null>(() => (initial && win.state === "ok" && evening.length && !survival
    ? computeRescue({ tasks: evening, start: win.start, bedtime, rest_slots: initial.settings.rest_slots, personal, morningBudget: tomorrowBudget, survival, compact, order })
    : null), [initial, win.state === "ok" ? win.start : win.state, left.map((t) => t.title + t.planned_minutes).join(), bedtime, personal, tomorrowBudget, survival, inputSig]);
  const ctx = (): Ctx => ({
    now: nowMin(), today, tomorrow, phase, times, timesTomorrow: timesT, travel, wake, prep,
    lessonsToday: vToday.lessons, lessonsTomorrow: vTom.lessons, tasks, done, left, morning: morningNow,
    tomorrowTasks: dayStore.extraFor(1), acts, actsTomorrow: actsTom ?? [], bed: bedInfo, start, plan: plan?.plan ?? null,
    rescue: rescueR, mode: rescueR?.mode ?? "normal", movedToday, movedTomorrow: dayStore.moved(1), doneYesterday: dayStore.doneFor(-1),
    events: events.forDay(today), unseen: sched.unseen(today), changes: sched.changes(), scheduleConf: 1, day,
  });
  const replyId = useRef<string | null>(null);   // v18.1 (D-11): чью реплику убирать при «Отменить»
  const showReply = (r: Reply | null) => { replyId.current = r?.id ?? null; setReply(r); if (r) requestAnimationFrame(() => document.querySelector(".assistant")?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  /** Сколько плана помещается при данном отбое — для честного «что это даёт» в листе сна. */
  const deficitAt = (bed: string, st = start) => {
    if (!initial || !evening.length) return null;
    const w = planWindow(st, bed, nowMin());
    if (w.state !== "ok") return null;
    const pl = buildPlan({ tasks: evening, start_time: w.start, bedtime: bed, rest_slots: initial.settings.rest_slots, personal_activities: personal, survival, compact_breaks: compact, order });
    const works = pl.plan.filter((e) => e.kind === "work");
    const end = works.length ? toMin(works[works.length - 1].end) : toMin(w.start);
    const b = toMin(bed) < 12 * 60 ? toMin(bed) + 1440 : toMin(bed);
    return { deficit: pl.deficit_minutes, free: Math.max(0, b - end) };
  };

  const saveActs = (n: DayActivity[]) => { setActsState(n); dayStore.setActs(n); };
  const saveAct = (d: ActDraft) => {
    const ed = actSheet.editing;
    const a: DayActivity = { id: ed?.id ?? newId(), type: d.type, title: d.title, startTime: d.fixed && d.startTime ? d.startTime : null, durationMinutes: d.durationMinutes, fixed: d.fixed, source: ed?.source ?? "user" };
    const known = !!ed && acts.some((x) => x.id === ed.id);
    saveActs(known ? acts.map((x) => (x.id === ed!.id ? a : x)) : [...acts, a]);
    events.emit(known ? "ACTIVITY_MOVED" : "ACTIVITY_ADDED", { title: a.title, time: a.startTime });
    setActSheet({ open: false, editing: null });
    haptic.notify("success");
    toast(known ? "Дело обновлено — перестрой расписание" : "Дело добавлено — план его учтёт", "ok");
  };
  const deleteAct = (a: DayActivity) => {
    const before = acts;
    saveActs(acts.filter((x) => x.id !== a.id));
    events.emit("ACTIVITY_CANCELLED", { title: a.title });
    setActSheet({ open: false, editing: null });
    haptic.tap("light");
    toast(`«${a.title}» удалено из плана`, "info", { label: "Отменить", run: () => saveActs(before) });
  };
  const carryAllToTomorrow = () => {
    const left = tasks.filter((t) => !done.includes(t.title));
    left.forEach((t) => dayStore.carryToTomorrow(t));
    const manual = new Set(extra.map((x) => x.title));
    const nExtra = extra.filter((x) => !left.some((m) => m.title === x.title));
    const nHidden = [...hidden, ...left.filter((m) => !manual.has(m.title)).map((m) => m.title)];
    setExtra(nExtra); dayStore.setExtra(nExtra); setHidden(nHidden); dayStore.setHidden(nHidden); setPlan(null);
    toast(`На завтра утром: ${left.length}. Спокойной ночи`, "ok");
  };
  useEffect(() => { if (rebuild) build({ silent: true }); }, [rebuild]);

  // Диплинк из бота/чата: https://max.ru/<bot>?startapp=<payload>. Один раз на запуск: refresh не повторяет переход.
  useEffect(() => {
    if (boot !== "ready") return;
    const raw = startParam();
    const sp = parseStart(raw);
    const once = nsKey(`sf.sp.${raw}`);
    let fresh = true;
    try { fresh = !sessionStorage.getItem(once); sessionStorage.setItem(once, "1"); } catch { /* приватный режим */ }
    if (sp.kind === "plan" && fresh || dayStore.built()) build({ silent: true, restore: !(sp.kind === "plan" && fresh) });   // план переживает refresh/переоткрытие
    if (!fresh || sp.kind === "none") return;
    const asStudent = () => { if (getRole() === "teacher" && (!who || who.role_source === "demo")) { persistRole("student"); setRoleState("student"); } };
    switch (sp.kind) {
      case "duel": { const t = tasks.find((x) => x.blitz_eligible); if (t) setDuel(t.title); else toast("Сегодня нет устных тем для дуэли", "info"); break; }
      case "plan": setTab("tonight"); break;   // v3.2: стартовая вкладка — «Учёба», диплинк плана ведёт в «План дня»
      case "progress": setStudySeg("progress"); setTab("study"); break;
      case "diary": case "study": setStudySeg("diary"); setTab("study"); break;
      case "tutor": setTab("tutor"); break;
      case "blitz": asStudent(); setTab("blitz", "blitz"); break;
      case "practice": asStudent(); setTab("blitz", "practicum"); break;
      case "challenge": { asStudent(); const c = parseChallenge(raw); setTab("blitz", "blitz"); if (c) setChallenge(c); else toast("Ссылка-вызов повреждена — выбери тему сам", "warn"); break; }
      case "focus": { const f = focus.get(); const t = f && tasks.find((x) => x.title === f.title); if (t) setOpenTask(t); else toast("Таймер не запущен — выбери задание", "info"); break; }
      case "teacher": case "student": {
        const want: Role = sp.kind;
        api.whoami().then((w) => {
          if (w.role_source === "school" && w.role !== want) { toast(w.role === "teacher" ? "Ты вошёл как учитель школы — роль ученика недоступна" : "Роль учителя подтверждает школа — открыт режим ученика", "warn"); return; }
          if (want !== roleContext().role) switchRole(want); else setTab(HOME_TAB);
          if (w.role_source === "demo" && want === "teacher") toast("Демо-роль учителя: в школе её подтверждает администратор", "info");
        }).catch(() => undefined);
        break;
      }
      case "add": setAddOpen(true); break;
      case "join": if (role !== "teacher") { setJoinCode(sp.code); setProfileOpen(true); } break;
      case "task": {
        const t = tasks.find((x) => taskId(x.title) === sp.id);
        if (t) setOpenTask(t); else { setTab("tonight"); toast("Этого задания у тебя сегодня нет — открыт план дня", "info"); }
        break;
      }
      case "quiz": {
        if (getRole() === "teacher") { toast("Это ссылка для учеников: опрос откроется у них в плане. Ваш опрос — в «Классы → Задания»", "info"); break; }
        void findQuiz((x) => x.template_id === sp.template).then((list) => {
          const live = (list ?? []).filter((x) => x.status !== "revoked");
          if (list === null) toast(OFFLINE, "warn");
          else if (live.length) openHwIssue(live[0].issue_id);
          else toast(list.length ? "Учитель отозвал этот опрос — его больше нет в плане" : NOT_FOUND_LINK, "info");
        });
        break;
      }
      case "invalid": setTab("tonight"); toast("Ссылка не распознана — открыт план дня", "warn"); break;
      default: break;
    }
  }, [boot]);

  const syncCompletions = useCallback(async () => {
    const acknowledgements = await completionQueue.flush(intent => intent.day === schoolDay());
    for (const {intent,result} of acknowledgements) {
      const k = `sf.log.${intent.day}`;
      const records = cache.get<Record<string, import("./lib/day").ExecRecord>>(k) ?? {};
      if (records[intent.title]) cache.set(k, {...records, [intent.title]: {...records[intent.title],synced:true}});
      if (intent.day === schoolDay() && !dayStore.reopened().includes(intent.title)) {
        const next = [...new Set([...dayStore.done(),intent.title])]; dayStore.setDone(next); setDone(next);
        if (!records[intent.title]) dayStore.setLog(intent.title,{startedAt:null,finishedAt:intent.createdAt,workedSec:null,plannedMin:Number(intent.payload.planned_minutes)||0,actualMin:null,rounds:null,synced:true});
      }
      setRewards(result); setLogV(v => v + 1);
    }
    const pending = completionQueue.pending();
    setSyncPending("completion",pending.length > 0);
    setCompletionNotice(pending.length ? pending.some(x => x.day !== schoolDay()) ? "Есть результаты другого учебного дня. Они сохранены; нужна сверка, автоматическое начисление приостановлено." : "Результат сохранён на устройстве и ожидает подтверждения сервера." : null);
    return acknowledgements;
  }, [completionQueue]);
  useEffect(() => {
    if (boot !== "ready") return;
    let stopped = false;
    const sync = () => { if (!stopped && !document.hidden) void syncCompletions().catch(() => undefined); };
    sync(); window.addEventListener("online", sync); window.addEventListener("focus", sync); document.addEventListener("visibilitychange", sync);
    return () => { stopped = true; window.removeEventListener("online", sync); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [boot, syncCompletions]);

  const markDone = async (t: Task, opts?: { fromTimer?: boolean; inlineCompletion?: boolean; inlineError?: boolean }): Promise<DoneInfo> => {
    const allDone = new Set([...done, t.title]).size >= tasks.length;
    if (dayStore.done().includes(t.title)) {
      await syncCompletions();
      return { gained: null, streak: rewards?.current_streak ?? null, allDone, synced: dayStore.log()[t.title]?.synced !== false };
    }
    const preview = focus.completion(t.title);
    const pendingPayload = { study_day: schoolDay(), occurred_at: new Date().toISOString(), offset_minutes: clockNow().device_offset_min, event_id: `task:${schoolDay()}:${t.title}`, day_total: tasks.length, day_done: new Set([...dayStore.done(),t.title]).size, planned_minutes: t.planned_minutes, actual_minutes: preview ? Math.max(1,Math.round(preview.workedSec / 60)) : undefined, type: t.type, oral_eligible: t.blitz_eligible };
    try { dayStore.setReopened(t.title,false); completionQueue.enqueue(t.title, schoolDay(), pendingPayload); setSyncPending("completion",true); setCompletionNotice("Результат сохранён на устройстве и ожидает подтверждения сервера."); }
    catch { if (!opts?.fromTimer && !opts?.inlineError) toast("Не удалось сохранить завершение. Освободи место и попробуй снова", "warn"); return {gained:null,streak:null,allDone:false,synced:false,saved:false}; }   // повторный «Готово» — без второй награды
    const next = [...new Set([...done, t.title])];
    setDone(next); dayStore.setDone(next);
    aheadStore.markDone(t.title, t.deadline, schoolDay());   // v3.2.1 · сделано наперёд не вернётся в день срока
    // Recovery 2: the teacher's record gets the completion with the device-measured result (durable outbox).
    completeHw(t, preview ? preview.workedSec : null, schoolDay());
    events.emit("HOMEWORK_COMPLETED", { title: t.title, minutes: t.planned_minutes });
    haptic.notify("success");
    // Был таймер — в прогресс идут фактические минуты, а не норматив
    const f = preview; focus.finish(t.title);
    const actual = f ? Math.max(1, Math.round(f.workedSec / 60)) : undefined;
    dayStore.setLog(t.title, { startedAt: f?.startedAt ?? null, finishedAt: f?.finishedAt ?? Date.now(), workedSec: f?.workedSec ?? null, plannedMin: t.planned_minutes, actualMin: actual ?? null, rounds: f?.rounds ?? null, synced: false });
    setLogV((v) => v + 1);
    // Устное сделано → утренняя шпаргалка «повтори до урока» (до завтрашнего учебного дня)
    if (t.type === "oral") api.flashcard(t.title).then((c) => { dayStore.addCard(t.title, c); setCards(dayStore.cards()); }).catch(() => undefined);
    try {
      const acknowledgements = await syncCompletions();
      const ack = acknowledgements.find(x => x.intent.title === t.title && x.intent.day === schoolDay());
      if (!ack) throw new Error("Completion not acknowledged");
      const r = ack.result;
      const gained = rewards ? r.total_points - rewards.total_points : 0;
      celebrate(gained, (window as unknown as { __sfTap?: { x: number; y: number } }).__sfTap, next.length >= tasks.length);
      setTimeout(() => setRewards(r), 650);
      const rec = dayStore.log()[t.title]; if (rec) { dayStore.setLog(t.title, { ...rec, synced: true }); setLogV((v) => v + 1); }
      // из таймера итог уже на экране «Задание завершено» — тост закрыл бы следующий шаг
      if (!opts?.fromTimer && !opts?.inlineCompletion) toast(next.length >= tasks.length ? "Все задания закрыты — вечер свободен!" : `Готово${gained > 0 ? ` · +${gained} очков` : ""}`, "ok");
      return { gained: gained > 0 ? gained : null, streak: r.current_streak || null, allDone, synced: true };
    } catch { if (!opts?.fromTimer) toast("Сохранено на этом устройстве. Сервер не подтвердил результат", "warn"); return { gained: null, streak: null, allDone, synced: false }; }
  };
  const undo = (t: Task) => { if (isTeacherTask(t)) { toast("Задание учителя уже отмечено выполненным, и учитель это видит. Если отметили по ошибке — напишите учителю.", "info"); return; } try { dayStore.setReopened(t.title,true); } catch { toast("Не удалось сохранить повторное открытие. Освободи место и попробуй снова", "warn"); return; } toast("Задание снова открыто на устройстве. Начисленные очки не отменяются; повторной награды не будет", "info"); const next = done.filter((x) => x !== t.title); setDone(next); dayStore.setDone(next); dayStore.setLog(t.title, null); setLogV((v) => v + 1); };
  const setType = (t: Task, type: Task["type"]) => { dayStore.setType(t.title, type); setTypes(dayStore.types()); setOpenTask({ ...t, type }); setPlan(null); haptic.select(); };
  const toTomorrow = (t: Task) => {
    dayStore.carryToTomorrow(t);
    if (focus.get()?.title === t.title) focus.drop();
    if (extra.some((x) => x.title === t.title)) { const n = extra.filter((x) => x.title !== t.title); setExtra(n); dayStore.setExtra(n); }
    else { const n = [...hidden, t.title]; setHidden(n); dayStore.setHidden(n); }
    setPlan(null); toast("Перенесено на завтра утром — появится в списке до уроков", "ok");
  };
  const runTriage = async () => {
    const left = tasks.filter((t) => !done.includes(t.title));
    if (!left.length || triBusy) return;
    setTriBusy(true);
    try { setTri(await api.triage(left, 2)); } catch (e) { toast(e instanceof ApiError ? e.message : "Не получилось распределить", "bad"); }
    finally { setTriBusy(false); }
  };
  const applyTriage = () => {
    if (!tri) return;
    const moved = tri.assignments.filter((a) => a.day > 0).map((a) => tasks.find((t) => t.title === a.title)).filter((t): t is Task => !!t);
    moved.forEach((t) => dayStore.carryToTomorrow(t));
    const manual = new Set(extra.map((x) => x.title));
    const nExtra = extra.filter((x) => !moved.some((m) => m.title === x.title));
    const nHidden = [...hidden, ...moved.filter((m) => !manual.has(m.title)).map((m) => m.title)];
    setExtra(nExtra); dayStore.setExtra(nExtra); setHidden(nHidden); dayStore.setHidden(nHidden);
    setTri(null); setSurvival(false); setPlan(null); setRebuild((v) => v + 1);
    toast(moved.length ? `На завтра: ${moved.length}. Сегодня — остальное` : "Всё остаётся на сегодня", "ok");
  };
  const shift = (which: "start" | "bed", d: number) => {
    if (which === "start") setStart(hhmm(clampT(toMin(start) + d, 6 * 60, 23 * 60)));
    else setBedtime(hhmm(clampT(toMin(bedtime) + d, 15 * 60, 23 * 60 + 55)));
    haptic.select();
  };
  const remove = (t: Task) => {
    if (focus.get()?.title === t.title) focus.drop();
    if (t.source === "manual") { const n = extra.filter((x) => x.title !== t.title); setExtra(n); dayStore.setExtra(n); }
    else { const n = [...hidden, t.title]; setHidden(n); dayStore.setHidden(n); }
    setPlan(null);
  };
  const added = (ts: Task[]) => {
    const n = [...extra, ...ts.filter((t) => !tasks.some((x) => x.title === t.title))];
    dayStore.commitExtra(n); setExtra(n); setPlan(null);
    toast(`Добавлено: ${ts.length}. Пересобери вечер`, "ok");
  };
  // ---------- действия помощника и режима спасения ----------
  const dropToday = (titles: Set<string>) => {
    const manual = new Set(extra.map((x) => x.title));
    const nExtra = extra.filter((x) => !titles.has(x.title));
    const nHidden = [...hidden, ...tasks.filter((m) => titles.has(m.title) && !manual.has(m.title)).map((m) => m.title)];
    setExtra(nExtra); dayStore.setExtra(nExtra); setHidden(nHidden); dayStore.setHidden(nHidden);
  };
  const applyRescue = (r: Rescue, o: { overflow?: boolean; keepSleep?: boolean } = {}) => {
    const ms = [...r.moves, ...(o.overflow ? r.overflow : [])];
    const titles = new Set(ms.map((m) => m.title));
    for (const m of ms) {
      const t = tasks.find((x) => x.title === m.title); if (!t) continue;
      dayStore.carryToTomorrow(t); dayStore.setMoved(1, t.title, m.reason);
      if (focus.get()?.title === t.title) focus.drop();
      events.emit("TASK_MOVED_TO_MORNING", { title: t.title, reason: m.reason, to: m.to });
    }
    dropToday(titles);
    if (r.trims.length) saveActs(acts.map((a) => { const tr = r.trims.find((x) => x.title === a.title); return tr && !a.fixed ? { ...a, durationMinutes: tr.to } : a; }));
    setCompact(r.compact); if (o.keepSleep) setSurvival(true);
    events.emit("PLAN_REBUILT", { mode: r.mode });
    setRebuild((v) => v + 1); haptic.notify("success");
    toast(`План применён · сон сохранён ${r.bedtime}${ms.length ? ` · на утро: ${ms.length}` : ""}`, "ok");
  };
  const saveBed = (t: string, scope: "today" | "usual", at?: string): SaveResult => {
    // at: старт, только что изменённый в том же действии (замыкание start ещё старое) — D-11
    const st = at ?? start, from = bedtime, cur = deficitAt(from, st), nxt = deficitAt(t, st);
    // v16.1: запись с проверкой; ошибка → лист остаётся открытым с введённым значением, план не трогаем
    const saved = persistBed(t, scope);
    if (!saved.ok) return saved;
    setBedV((v) => v + 1); setBedOpen(false); logBed(t);
    events.emit("BEDTIME_CHANGED", { from, to: t, scope });
    const lines = [from === t ? `Сон в ${t}${scope === "usual" ? " — теперь обычное время" : ""}.` : `Ты перенёс сон с ${from} на ${t}${scope === "today" ? " (только сегодня)" : ""}.`];
    const chips: Reply["chips"] = [];
    if (cur && nxt && from !== t) {
      const gain = (cur.deficit - nxt.deficit) + (nxt.free - cur.free);
      if (nxt.deficit > 0) {
        lines.push(`Даже до ${t} всё не помещается — не хватает ${dur(nxt.deficit)}.`);
        const r = computeRescue({ tasks: evening, start: planWindow(st, t, nowMin()).state === "ok" ? (planWindow(st, t, nowMin()) as { start: string }).start : st, bedtime: t, rest_slots: initial!.settings.rest_slots, personal, morningBudget: tomorrowBudget, survival, compact, order });
        if (r.moves[0]) { lines.push(`Могу оставить сон и перенести ${splitTitle(r.moves[0].title).subject.toLowerCase()} на утро.`); chips.push({ label: "Применить план спасения", act: { do: "rescue" }, primary: true }); }
      } else if (cur.deficit > 0) lines.push("Теперь всё помещается в план.");
      else if (gain > 0) lines.push(`Теперь помещается ещё ${dur(gain)}.`);
      else if (gain < 0) lines.push(`Свободного времени станет меньше на ${dur(-gain)}.`);
    }
    showReply({ id: `bed${Date.now()}`, icon: "moon", lines, chips });
    if (plan) setRebuild((v) => v + 1);
    return saved;
  };
  /** v16.1: подъём меняет только wakeTime; утро и спасение пересчитываются от него автоматически (morningBudget). */
  const morningTomorrow = useMemo(() => { const mv = dayStore.moved(1); return dayStore.extraFor(1).filter((x) => mv[x.title]).map((x) => ({ title: x.title, minutes: x.planned_minutes })); }, [wakeOpen, tasks.length]);
  const saveWakeT = (t: string): SaveResult => {
    const from = wake;
    const saved = persistWake(t);
    if (!saved.ok) return saved;
    setWakeV((v) => v + 1); setWakeOpen(false);
    events.emit("WAKE_TIME_CHANGED", { from, to: t });
    const lines = [from === t ? `Подъём в ${t}.` : `Подъём теперь в ${t} (было ${from}).`, `Сна: ${dur(sleepSpan(bedtime, t))} — отбой в ${bedtime} не менялся.`];
    showReply({ id: `wake${Date.now()}`, icon: "sun", lines });
    return saved;
  };
  const applySched = (cs: ScheduleChange[]) => {
    sched.apply(cs);
    sched.ack(cs.filter((c) => c.date === today).map((c) => c.id));   // своё изменение на сегодня — уже увидено
    setEvSheet({ open: false, prefill: null }); haptic.notify("success");
    toast(`Расписание обновлено · ${cs.length}`, "ok", { label: "Отменить", run: () => cs.forEach((c) => sched.revert(c.id)) });
    if (plan) setRebuild((v) => v + 1);
  };
  const addActDraft = (d: ActDraftX) => {
    const a: DayActivity = { id: newId(), type: d.type, title: d.title, startTime: d.fixed && d.startTime ? d.startTime : null, durationMinutes: d.duration, fixed: d.fixed && !!d.startTime, source: "assistant" };
    if (d.date === today) { saveActs([...acts, a]); if (plan) setRebuild((v) => v + 1); }
    else if (d.date === tomorrow) { const n = [...(actsTom ?? []), a]; setActsTom(n); dayStore.setActsFor(1, n); }
    events.emit("ACTIVITY_ADDED", { title: a.title, time: a.startTime, date: d.date });
    haptic.notify("success");
    const span = a.startTime ? `${a.startTime}–${toHHMM(toMin(a.startTime) + a.durationMinutes)}` : dur(a.durationMinutes);
    showReply({ id: `aa${Date.now()}`, icon: "check", tone: "ok", lines: [`Добавил: ${a.title} · ${d.date === today ? "сегодня" : d.date === tomorrow ? "завтра" : d.date} · ${span}.`, d.date === today ? (plan ? "Перестраиваю вечер." : "План дня это учтёт.") : "Утром покажу в брифинге."] });
  };
  const late = (startAt: string, minutes?: number) => {
    setStart(startAt); events.emit("USER_LATE", { start: startAt, minutes: minutes ?? null });
    showReply({ id: `l${Date.now()}`, icon: "timer", tone: "ok", lines: [`Вечер начнётся в ${startAt}.`, plan ? "Перестроил план." : "План построю от этого времени."] });
    setRebuild((v) => v + 1);
  };
  const act = async (a: Act) => {
    haptic.select();
    switch (a.do) {
      case "start": { const t = tasks.find((x) => x.title === a.title); if (phase === "morning") events.emit("MORNING_STARTED", {}, "morning"); if (t) setOpenTask(t); break; }
      case "openPlan": setTab("tonight"); setReply(null); if (!plan) build(); else window.scrollTo({ top: 0, behavior: "smooth" }); break;
      case "rescue": if (rescueR) applyRescue(rescueR); setReply(null); break;
      case "tired": setOrder("short_first"); events.emit("USER_TIRED", {}); setRebuild((v) => v + 1); showReply({ id: `t${Date.now()}`, icon: "pause", tone: "ok", lines: ["Перестроил: сначала короткие задания, сложное — после перерыва."] }); break;
      case "lateBy": late(toHHMM(Math.max(nowMin(), toMin(start)) + a.minutes), a.minutes); break;
      case "homeAt": late(a.time); break;
      case "pickTime": setPickT(a.for === "home" ? toHHMM(times.homeAt ?? toMin(start)) : a.draft?.startTime ?? "18:00"); setPick({ for: a.for, draft: a.draft }); break;
      case "markDone": { const t = tasks.find((x) => x.title === a.title); if (!t) break; await markDone(t); showReply(afterDone(ctx(), t.title, t.planned_minutes)); break; }
      case "keepMorning": showReply({ id: `k${Date.now()}`, icon: "sun", lines: [`Хорошо, ${splitTitle(a.title).subject.toLowerCase()} — утром.`] }); break;
      case "doNow": {
        const tt = dayStore.extraFor(1).find((x) => x.title === a.title); if (!tt) break;
        dayStore.setExtraFor(1, dayStore.extraFor(1).filter((x) => x.title !== a.title)); dayStore.setMoved(1, a.title, null);
        const back: Task = { ...tt, source: "manual" };
        const nh = hidden.filter((h) => h !== a.title); setHidden(nh); dayStore.setHidden(nh);
        if (!(initial?.diary_tasks ?? []).some((x) => x.title === a.title)) { const n = [...extra.filter((x) => x.title !== a.title), back]; setExtra(n); dayStore.setExtra(n); }
        setReply(null); setTimeout(() => setOpenTask(back), 50); break;
      }
      case "addAct": addActDraft(a.draft); break;
      case "actTime": showReply(activityReply(ctx(), { ...a.draft, startTime: a.time })); break;
      case "editAct": setReply(null); setActSheet({ open: true, editing: { id: newId(), type: a.draft.type, title: a.draft.title, startTime: a.draft.startTime, durationMinutes: a.draft.duration, fixed: a.draft.fixed, source: "assistant" } }); break;
      case "removeAct": {
        const x = acts.find((y) => y.id === a.id);
        if (x) deleteAct(x); else if (actsTom?.some((y) => y.id === a.id)) { const n = actsTom.filter((y) => y.id !== a.id); setActsTom(n); dayStore.setActsFor(1, n); events.emit("ACTIVITY_CANCELLED", { title: actsTom.find((y) => y.id === a.id)!.title }); }
        setReply(null); break;
      }
      case "bed": { const r = saveBed(a.time, a.scope); if (!r.ok) toast(r.error, "bad"); break; }   // v18.1: без молчаливого отказа
      case "openBed": setBedOpen(true); break;
      case "evidence": setReply(null); setEvSheet({ open: true, prefill: a.text }); break;
      case "homework": setReply(null); setHwPrefill(a.text); setAddOpen(true); break;
      case "say": say(a.text); break;
      case "voice": setVoiceSig((v) => v + 1); break;
      case "ack": sched.ack(a.ids); setHintOff(null); break;
      case "carryAll": carryAllToTomorrow(); setReply(null); break;
      case "dismiss": setReply(null); break;
      case "tutor": setTab("tutor"); break;
      case "bedDrift":
        if (a.yes) { prefs.set({ usualBed: rec }); dayStore.setBedToday(null); setBedV((v) => v + 1); events.emit("BEDTIME_CHANGED", { from: bedtime, to: rec, scope: "usual" }); toast(`Обычный сон снова в ${rec}`, "ok"); if (plan) setRebuild((v) => v + 1); }
        else snoozeDrift();
        setHintOff("drift"); break;
    }
  };
  const say = (text: string) => { showReply(answer(text, ctx())); };
  // события фаз дня — по одному разу за учебный день
  useEffect(() => {
    if (boot !== "ready") return;
    const map: Partial<Record<typeof phase, EventType[]>> = { school: ["SCHOOL_DAY_STARTED"], travel: ["LAST_LESSON_FINISHED", "TRAVEL_STARTED"], evening: ["TRAVEL_FINISHED"] };
    (map[phase] ?? []).forEach((e) => events.emit(e, {}, phase));
    if (phase === "evening" || phase === "night") logBed(bedtime);
  }, [phase, boot]);
  // переход учебного дня (граница 04:00): перечитываем день из хранилища — без дублей и без потери перенесённого
  const dayRef = useRef(today);
  useEffect(() => {
    if (dayRef.current === today) return;
    dayRef.current = today;
    setDone(dayStore.done()); setExtra(dayStore.extra()); setHidden(dayStore.hidden()); setTypes(dayStore.types()); setCards(dayStore.cards());
    setActsState(dayStore.acts() ?? seedFrom(initial?.settings.personal_activities ?? [])); setActsTom(dayStore.actsFor(1));
    setStartOv(dayStore.startToday()); setBedV((v) => v + 1); setPlan(null); setSurvival(false); setCompact(false); setOrder("default"); setReply(null);
    api.initial().then(({ data }) => setInitial(data)).catch(() => undefined);
    sched.loadWeek(today);
  }, [today]);

  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);
  const switchRole = (r: Role) => { if (requestDemoRole(r)) { invalidateIdentity(); location.hash = withLaunch(r === "teacher" ? "teacher-today" : "study"); location.reload(); } };
  // v2.1 · B3: сценарии панели «Демо для жюри» — ученик: Дневник → «Что, если…» → 15-минутная миссия; учитель — смена роли.
  const juryStudent = () => { setJuryOpen(false); setStudySeg("grades"); setTab("study"); setSimRequest({ subject: null, at: Date.now() }); };
  // v3.0 · «Сброс» в панели жюри: DEMO — чистый лист (только demo:-ключи), песочница — новая серверная песочница.
  const juryReset = () => {
    setJuryOpen(false);
    if (inSandbox()) { void startSandbox("teacher").catch(() => toast("Не удалось начать заново — попробуйте ещё раз", "warn")); return; }
    resetDemo(); try { sessionStorage.removeItem("demo:launched"); } catch { /* нет sessionStorage */ }
    location.reload();
  };
  const juryTeacher = () => {
    setJuryOpen(false);
    if (inSandbox()) void switchPersona("teacher").catch(() => toast("Не удалось открыть учителя — попробуйте ещё раз", "warn"));
    else switchRole("teacher");
  };

  useEffect(() => { document.documentElement.style.setProperty("--sky", skyFor(Math.floor(nowM / 60))); }, [Math.floor(nowM / 60)]);
  // v16: метрики без PII — один раз за запуск: время до полезного экрана, расчёт дня, режим сцены
  useEffect(() => {
    if (boot !== "ready") return;
    const id = requestAnimationFrame(() => api.clientMetrics({ ttuc_ms: Math.round(performance.now()), day_engine_ms: engineMs.current ?? undefined, scene: "static" }));
    return () => cancelAnimationFrame(id);
  }, [boot]);
  const syncSchedule = async () => {
    try { await api.syncNow(); } catch { /* офлайн/источник недоступен — статус покажет */ }
    await sched.loadWeek(today);
    try { const {data} = await api.initial(); setInitial(data); } catch { /* offline retains the last explicitly cached snapshot */ }
  };

  const openByTitle = (title: string) => {
    const t = tasks.find((x) => x.title === title);
    if (!t) { focus.drop(); toast("Это задание уже убрано из списка — таймер сброшен", "info"); return; }
    setOpenTask(null); setTimeout(() => setOpenTask(t), openTask ? 260 : 0);
  };
  const toBlitz = (key: string) => { setOpenTask(null); if (role === "teacher") return; setTab("blitz", "blitz"); setBlitzPreset((p) => ({ key, n: (p?.n ?? 0) + 1 })); haptic.select(); };
  // V23-N17: то же правило «что дальше», что у «Сейчас по плану» на главном экране (lib/mission.ts nextUp)
  const nextTask = openTask ? nextUp(tasks, [...done, openTask.title], day.date, plan && !stale ? plan.plan.plan.filter((e) => e.kind === "work") : null, nowM) : null;
  const tabs = tabsFor(role);
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]); }, [role]);
  const onTabKey = (e: KeyboardEvent) => {
    const i = tabs.indexOf(tab);
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const t = tabs[(n + tabs.length) % tabs.length];
    setTab(t); haptic.select();
    requestAnimationFrame(() => document.getElementById(`tab-${t}`)?.focus());
  };
  const li = launchInfo();

  if (boot === "loading") return <div key="boot-preview" class="boot"><div class="boot-preview"><p class="eyebrow">СферумФокус</p><h1 class="h-sec">Готовим твой день</h1><LoadingRows label="Загружаем вечер" rows={3}/></div></div>;
  if (boot === "error" || !initial) return (
    <div class="app radical-app"><div class="screen"><div class="empty" style="padding-top:30vh">{bootCode === 401
        ? <><Icon name="lock" /><h3>Открой приложение заново</h3><p class="f-2">MAX не подтвердил сессию — так бывает, если ссылка старая. Закрой мини-апп и открой из чата с ботом.</p><button class="btn btn-primary btn-sm" onClick={() => location.reload()}>Перезапустить</button></>
        : <><Icon name="wifiOff" /><h3>Сервер не отвечает</h3><p class="f-2">{bootErr}</p><button class="btn btn-primary btn-sm" onClick={load}>Повторить</button></>}</div></div></div>
  );

  const user = maxUser();
  // ---------- главная: СЕГОДНЯ → СЕЙЧАС → СЛЕДУЮЩЕЕ ДЕЙСТВИЕ → ПЛАН → ПОМОЩНИК ----------
  const h0 = mkHint(ctx());
  const changedHint = h0?.strong === "Расписание изменилось";
  const drift = phase === "evening" || phase === "free" ? driftNotice(rec) : null;
  const hintR: Reply | null = changedHint ? h0
    : drift ? { id: "drift", icon: "moon", lines: [`Последние ${drift.days} дня ты переносишь сон позже.`, `Хочешь попробовать вернуться к ${drift.recommended}?`], chips: [{ label: "Да", act: { do: "bedDrift", yes: true }, primary: true }, { label: "Не сейчас", act: { do: "bedDrift", yes: false } }] }
    : phase === "morning" || phase === "travel" || phase === "school" || h0?.chips?.[0]?.act.do === "rescue" ? null : h0;
  const hintKey = hintR ? (hintR.id === "drift" ? "drift" : hintR.lines.join("|")) : null;
  const morningStarted = events.forDay(today).some((e) => e.type === "MORNING_STARTED");
  const head = hintR && hintKey !== hintOff ? <ReplyCard r={hintR} onAct={act} onClose={() => setHintOff(hintKey)} /> : null;
  // v18 «Успею ли?»: тот же вход, что у режима спасения → прогноз совпадает с планом после «Применить»
  const whatIfBase = initial && win.state === "ok" && phase !== "night"
    ? { tasks: evening, start: win.start, bedtime, rest_slots: initial.settings.rest_slots, personal, morningBudget: tomorrowBudget,
        survival, compact, order } : null;   // v18.1 (D-02): те же флаги, что у build()
  const applyWhatIf = makeApplyWhatIf({ start, bedtime, late, saveBed, applyRescue, rebuild: () => setRebuild((v) => v + 1),
    // v18.1 (D-03/D-11): откат — к сырым значениям дня (null = override не было), включая журнал отбоя
    overrides: () => ({ start: dayStore.startToday(), bed: dayStore.bedToday(), log: bedLogToday() }),
    restore: (o) => { dayStore.setStartToday(o.start); setStartOv(o.start); dayStore.setBedToday(o.bed); setBedLogToday(o.log); setBedV((v) => v + 1); },
    lastReply: () => replyId.current,
    dropReply: (id) => { if (replyId.current === id) replyId.current = null; setReply((r) => (r?.id === id ? null : r)); } });
  const whatIfNode = whatIfBase ? <WhatIf key={JSON.stringify(whatIfBase)} base={whatIfBase} onApply={applyWhatIf} onAdd={() => setAddOpen(true)} onCustom={() => { setPickT(toHHMM(times.homeAt ?? toMin(start))); setPick({ for: "home" }); }} /> : null;
  const rescueNode = rescueR && rescueR.mode !== "normal" && phase !== "night" ? (
    <RescueCard r={rescueR} busy={planBusy} onApply={() => applyRescue(rescueR)} onMoreMorning={() => applyRescue(rescueR, { overflow: true })}
      onKeepSleep={() => applyRescue(rescueR, { keepSleep: true })} onPriorities={runTriage} />
  ) : null;
  const assistantNode = <Assistant reply={reply} onSay={say} onAct={act} onClose={() => setReply(null)} serverStt={caps.stt} voiceSignal={voiceSig} />;
  return (
    <div class={`app radical-app${inGame ? " in-game" : ""}${session && !inGame ? " has-focus" : ""}`}>
      <UserBackground fallback={<div class="sky" aria-hidden="true" />} />
      <BrandBar context={tab === "tonight" ? "План дня" : tab === "tutor" ? "Тьютор" : tab === "blitz" ? "Практика" : "Учёба"}
        title={tab === "tutor" ? "ИИ-тьютор" : tab === "blitz" ? "Практика" : tab === "study" ? "Дневник и учёба" : undefined}
        person={tab === "study" ? { name: verifiedProfile()?.full_name || shortName(verifiedProfile()) || maxUser()?.first_name || "Ученик", meta: [verifiedProfile()?.classes?.[0] ?? initial?.grade, verifiedProfile()?.school].filter(Boolean).join(", ") || null } : null}
        name={verifiedProfile()?.full_name ?? (user?.first_name ? `${user.first_name}${user.last_name ? " " + user.last_name : ""}` : null)} fallback="Ученик" onProfile={() => openProfile("home")}
        onCode={role !== "teacher" && !DEMO ? () => setCodeOpen(true) : undefined}
        jury={DEMO || inSandbox() ? { onOpen: () => setJuryOpen(true), demo: DEMO, who: DEMO ? `DEMO · ${role === "teacher" ? "Учитель" : "Ученик 8А"}` : null } : undefined} />
      <DiaryWelcome role="student" enabled={!DEMO && boot==="ready" && dm==="server" && role==="student" && !!who?.uid && who.auth!=="demo" && new URLSearchParams(location.search).get("manage")!=="diary"}/>
      <SandboxBar />
      {completionNotice && <div class="completion-status" role="status"><p>{completionNotice}</p><button class="btn btn-secondary btn-sm" onClick={() => void syncCompletions().catch(() => toast("Очередь сохранена. Не удалось синхронизировать; нужна повторная попытка или сверка", "warn"))}>Повторить синхронизацию</button></div>}
      <main><div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "tonight" && (
          <Tonight initial={initial} tasks={tasks} ahead={ahead} tails={tails} onPullAhead={pullAhead} done={done} start={start} bedtime={bedtime} survival={survival}
            eveningTasks={evening} compact={compact} order={order} win={win} nowMin={nowM} stale={stale} acts={acts} personal={personal}
            onAddAct={() => setActSheet({ open: true, editing: null })} onEditAct={(a) => setActSheet({ open: true, editing: a })}
            onCarryAll={carryAllToTomorrow} onPreset={addActDraft}
            plan={plan} planBusy={planBusy} planError={planError} offline={offline} aiOnline={aiOnline}
            onBuild={() => build()} onMission={(t,minutes)=>{const current=focus.get();if(current&&current.title!==t.title){openByTitle(current.title);toast('Сначала заверши или останови текущий таймер','info');return;}focus.start(t.title,minutes*60,{taskSec:t.planned_minutes*60,elapsedSec:hwElapsed(t.title)});setOpenTask(t);}} onOpenTask={setOpenTask} onAdd={() => setAddOpen(true)} onSettings={() => setSettingsOpen(true)}
            onSurvival={() => { setSurvival(true); build({ survival: true }); }} onProfile={() => setProfileOpen(true)}
            onConnectDiary={() => { if (DEMO || who?.auth === "demo") location.assign(diaryURL(location.href)); else setProfileOpen(true); }}
            onTutor={() => setTab("tutor")} onStudy={() => { setStudySeg("diary"); setTab("study"); }}
            onProgress={() => { setStudySeg("progress"); setTab("study"); haptic.select(); }} rewards={rewards} standalone={dm === "local"} demo={DEMO}
            userName={shortName(verifiedProfile()) || maxUser()?.first_name || "Ученик"} session={session} logV={logV} botName={botName}
            onTriage={runTriage} cards={cards} head={head} rescueNode={rescueNode} whatIfNode={whatIfNode} rescue={rescueNode ? rescueR : null} assistantNode={assistantNode} onBed={() => setBedOpen(true)} onWake={() => setWakeOpen(true)}
            phase={phase} view={vToday} viewNext={vTom} times={times} travel={travel} wake={wake} provider={sched.provider()} onReport={() => setEvSheet({ open: true, prefill: null })}
            day={day} schedStatus={schedStatus} syncedAt={sched.syncedAt()} onImport={() => setImportOpen(true)} onBuildSchedule={() => setBuilderOpen(true)} onSync={syncSchedule}
            onQuizDone={(ok, n) => { toast(`Мини-квиз: ${ok} из ${n}`, ok >= Math.ceil(n * 0.6) ? "ok" : "info"); }}
            mp={mp} morningStarted={morningStarted} moved={movedToday} rescueMode={rescueR?.mode}
            onMorningStart={() => { events.emit("MORNING_STARTED", {}, "morning"); if (mp.fit[0]) setOpenTask(mp.fit[0]); }}
            onCardSeen={(title) => { dayStore.dropCard(title); setCards(dayStore.cards()); api.event("flashcard_used", { event_id: `card:${schoolDay()}:${title}` }).then(setRewards).catch(() => undefined); toast("Повторено · +5", "ok"); }}
            onBlitz={role === "teacher" ? undefined : () => { setTab("blitz", "blitz"); haptic.select(); }}
            hwPill={role === "teacher" ? null : <HwPill onOpen={openIssue} />} />
        )}
        {tab === "blitz" && (
          <Practice seg={pseg} onSeg={setPseg} grade={gradeNum(initial.grade)} rev={prRev} onOpen={(id) => openPracticum({ kind: "run", id })}
            forHw={role === "teacher" ? [] : left} onHub={(subject, hw) => openPracticum({ kind: "hub", subject, hw })}
            blitz={(head) => <Blitz head={head} tasks={tasks} done={done} rewards={rewards} onRewards={setRewards} preset={blitzPreset} challenge={challenge} onCodeIssue={role !== "teacher" ? openHwIssue : undefined} codeDemo={DEMO}
              onChallengeUsed={() => setChallenge(null)} botName={botName} onPlaying={setInGame}
              onDeepDuel={(title) => setDuel(title)} />} />
        )}
        {tab === "tutor" && <Tutor recoveryContext={recoveryContext} tasks={tasks} done={done} initial={openTask?.title ?? session?.title ?? null} tomorrowTasks={dayStore.extraFor(1)} lessonsToday={vToday.lessons} lessonsTomorrow={vTom.lessons} />}
        {/* v2.2: «Спокойно исправим» больше не стоит над дневником — это свёрнутый «Симулятор оценок» внутри «Дневника». */}
        {tab === "study" && <Study role={role} seg={studySeg} onPlan={() => { setTab("tonight"); haptic.select(); }} onAddHw={(i, pre) => { setAddIntent(i); if (pre) setHwPrefill(pre); setAddOpen(true); }}
          done={role === "teacher" ? undefined : done} onHwDone={role === "teacher" ? undefined : (title, v) => { const t = [...tasks, ...ahead, ...tails].find((x) => x.title === title) ?? (initial?.diary_tasks ?? []).find((x) => x.title === title); if (!t) return; if (v) void markDone(t); else undo(t); haptic.select(); }}
          plan={{ count: left.length, minutes: left.reduce((a, t) => a + (t.planned_minutes || 0), 0) }} onSubject={role === "teacher" ? undefined : (subject, hw) => openPracticum({ kind: "hub", subject, hw: hw ?? null })} today={today} onStats={() => openProfile("stats")} onReport={() => setEvSheet({ open: true, prefill: null })} rewards={rewards} onRewards={setRewards} initial={initial} onSwitchRole={() => setProfileOpen(true)}
          sim={{ demo: DEMO || initial.diary_mode === "mock", request: simRequest, onConsumed: () => { setSimRequest(null); if (routeOf(location.hash) === "grades") { try { history.replaceState(null, "", `${location.pathname}${location.search}${withLaunch("diary")}`); } catch { /* sandbox */ } } },
            onTutor: (subject, topic) => { setRecoveryContext(subject + ": " + (topic || "Разобрать тему")); setTab("tutor"); }, onMission: startRecoveryMission }}
          onSeg={(v) => { setStudySeg(v); try { history.replaceState(null, "", `${location.pathname}${location.search}${withLaunch(v === "progress" ? "progress" : v === "grades" ? "grades" : "study")}`); } catch { /* */ } haptic.select(); }} />}
      </div></main>

      {/* Док навигации: паттерн 21st.dev «Animated Tabs» (pill-индикатор скользит под активной вкладкой).
          Адаптация: без framer-motion — индикатор двигается CSS-переменной --k, только transform. */}
      <FocusDock hidden={inGame || (!!openTask && openTask.title === session?.title)} onOpen={openByTitle} />
      <nav class="tabbar" aria-label="Разделы" data-n={tabs.length} inert={inGame || undefined} style={{ "--n": tabs.length, "--k": Math.max(0, tabs.indexOf(tab)) }}>
        <div class="tab-list" role="tablist" aria-label="Разделы" onKeyDown={onTabKey}>
          <span class="tab-ind" aria-hidden="true" />
          {tabs.map((t) => (
            <button key={t} id={`tab-${t}`} class="tab" role="tab" aria-selected={tab === t ? "true" : "false"} aria-controls="panel" tabIndex={tab === t ? 0 : -1}
              aria-label={t === "tonight" && role !== "teacher" && hwNewCount() > 0 ? undefined : TAB_META[t].aria} onClick={() => { setTab(t); haptic.select(); }}>
              <span class="nav-icon l-center l-g0 b-bare"><Icon name={TAB_META[t].icon} /></span><span class="nav-label">{TAB_META[t].label}</span>
              {t === "study" && role !== "teacher" && rewards && rewards.current_streak > 0 && <span class="tab-badge num" aria-label={`серия ${rewards.current_streak}`}>{rewards.current_streak}</span>}
              {t === "tonight" && role !== "teacher" && hwNewCount() > 0 && <><span class="tab-badge tab-badge-new num" aria-hidden="true">{hwNewCount()}</span><span class="sr"> — новых заданий от учителя: {hwNewCount()}</span></>}
            </button>
          ))}
        </div>
      </nav>

      <TaskSheet task={openTask} done={!!openTask && done.includes(openTask.title)} onClose={() => setOpenTask(null)}
        onDone={markDone} onUndo={undo} onRemove={remove} onDuel={(t) => { setOpenTask(null); setTimeout(() => setDuel(t.title), 280); }}
        nextTask={nextTask} onOpenTask={openByTitle} onBlitz={toBlitz} aiOnline={!!aiOnline}
        onSetType={setType} onTomorrow={toTomorrow} botName={botName} />
      <ActivitySheet open={actSheet.open} editing={actSheet.editing} nowMin={nowM} onClose={() => setActSheet({ open: false, editing: null })} onSave={saveAct} onDelete={deleteAct} />
      <AddTask open={addOpen} intent={addIntent} onClose={() => { setAddOpen(false); setHwPrefill(null); setAddIntent("text"); }} onAdded={added} aiOnline={aiOnline} prefill={hwPrefill} />
      <ScheduleImport open={importOpen} onClose={() => setImportOpen(false)} hasImport={!!sched.provider()?.has_import}
        onApplied={() => { setImportOpen(false); sched.loadWeek(today); }} />
      <ScheduleBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} today={today} tomorrow={tomorrow}
        subjectsFor={(d) => sched.day(d).lessons.filter((l) => l.status !== "cancelled").map((l) => l.subject)}
        defaults={{ travel, bedtime, hwToday: left.reduce((a, t) => a + t.planned_minutes, 0) }}
        onApplied={(date, extras) => {
          setBuilderOpen(false); sched.loadWeek(today);
          extras.forEach((e) => addActDraft({ type: "club", title: e.title, date, startTime: e.start, duration: e.minutes, fixed: !!e.start }));
          if (plan && date === today) setRebuild((v) => v + 1);
        }} />
      <EvidenceSheet open={evSheet.open} prefill={evSheet.prefill} onClose={() => setEvSheet({ open: false, prefill: null })} today={today} nowMin={nowM}
        lastBell={times.last} schoolWeek={sched.schoolWeek(S?.school_week_days ?? 5)} ocr={caps.ocr} stt={caps.stt} view={(d) => sched.day(d)} onApply={applySched} />
      <BedtimeSheet open={bedOpen} onClose={() => setBedOpen(false)} bed={bedInfo} wake={wake} deficitAt={deficitAt} onSave={saveBed} />
      <WakeSheet open={wakeOpen} onClose={() => setWakeOpen(false)} wake={wake} serverWake={serverWake} bed={bedtime} leave={timesT.leave} prep={prep} morning={morningTomorrow} onSave={saveWakeT} />
      <Sheet open={!!pick} onClose={() => setPick(null)} eyebrow="Помощник" title={pick?.for === "home" ? "Во сколько будешь дома?" : `Во сколько ${pick?.draft?.title.toLowerCase() ?? "дело"}?`}
        footer={<button class="btn btn-primary btn-block" onClick={() => { const pk = pick; setPick(null); if (!pk) return; if (pk.for === "home") late(pickT); else if (pk.draft) showReply(activityReply(ctx(), { ...pk.draft, startTime: pickT })); }}>Готово</button>}>
        <label class="field"><span class="field-label">Время</span><input class="input" type="time" step={300} value={pickT} onInput={(e) => setPickT((e.target as HTMLInputElement).value)} /></label>
      </Sheet>
      <Duel title={duel} aiOnline={aiOnline} prevPoints={rewards?.total_points ?? 0} onClose={() => setDuel(null)}
        onWin={(r) => {
          if (r) setRewards(r);
          const t = tasks.find((x) => x.title === duel);
          if (t && !done.includes(t.title)) { const next = [...done, t.title]; setDone(next); dayStore.setDone(next); }
        }} />

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} eyebrow="План дня" title="Окно для уроков"
        footer={<button class="btn btn-primary btn-block" onClick={() => { setSettingsOpen(false); if (plan) build(); }}>{plan ? "Пересобрать" : "Готово"}</button>}>
        <div class="time-grid">
          <label class="field"><span class="field-label">Начну в</span><input class="input" type="time" min="06:00" max="23:00" step={300} value={start} onInput={(e) => setStart((e.target as HTMLInputElement).value)} aria-invalid={toMin(start) >= toMin(bedtime)} /></label>
          <label class="field"><span class="field-label">Сон в</span><input class="input" type="time" min="15:00" max="23:55" step={300} value={bedtime} onInput={(e) => setBedtime((e.target as HTMLInputElement).value)} aria-invalid={toMin(start) >= toMin(bedtime)} /></label>
        </div>
        <div class="time-grid" style="margin-top:8px">
          <div class="steps l-h l-wrap l-g1" role="group" aria-label="Сдвинуть старт"><button class="btn btn-secondary btn-sm" onClick={() => shift("start", -30)}>−30 мин</button><button class="btn btn-secondary btn-sm" onClick={() => shift("start", 30)}>+30 мин</button></div>
          <div class="steps l-h l-wrap l-g1" role="group" aria-label="Сдвинуть сон"><button class="btn btn-secondary btn-sm" onClick={() => shift("bed", -15)}>−15</button><button class="btn btn-secondary btn-sm" onClick={() => shift("bed", 15)}>+15</button><button class="btn btn-secondary btn-sm" onClick={() => shift("bed", 30)}>+30</button></div>
        </div>
        {toMin(start) >= toMin(bedtime) && <p class="hint-text" style="color:var(--bad)">Старт должен быть раньше сна.</p>}
        <p class="hint-text">Сон в {bedtime}{bedInfo.today ? " — только сегодня" : ""} · рекомендуемый {bedInfo.recommended}. <button class="link" onClick={() => { setSettingsOpen(false); setTimeout(() => setBedOpen(true), 260); }}>Изменить сон</button></p>
        <label class="switch" style="margin-top:12px">
          <span><b style="font-weight:600">Режим выживания</b><br /><span class="muted" style="font-size:calc(13px*var(--fs,1))">Когда всё не влезает: оставить главное, остальное — на завтра</span></span>
          <input type="checkbox" checked={survival} onChange={(e) => setSurvival((e.target as HTMLInputElement).checked)} />
        </label>
        <div class="sec-head" style="margin-top:20px"><h3 class="h-sec" style="font-size:calc(15px*var(--fs,1))">Уже в расписании</h3></div>
        <ul class="list">
          {initial.settings.rest_slots.map((r) => <li class="row py-3 l-a1a l-g3 l-mid b-sep" key={r.label} style={{ "--c": "var(--rest-c, rgba(255,255,255,.3))" }}><span class="row-bar r-xs" /><span class="row-main"><span class="row-title f-s f-trunc" style="display:block">{r.label}</span></span><span class="row-side l-v l-g1 f-b f-2 num">{r.start}–{r.end}</span></li>)}
        </ul>
        <p class="hint-text">Репетитор, тренировка, игры и другие дела — в блоке «Мои дела сегодня» на экране «План дня».</p>
      </Sheet>

      <ProfileHub open={profileOpen} view={profileView} onView={setProfileView} onClose={() => setProfileOpen(false)} eyebrow={initial.school_name ?? "Профиль"}
        roleLabel={role === 'teacher' ? 'Учитель' : 'Ученик · личный учебный маршрут'} name={verifiedProfile()?.full_name ?? (user?.first_name ? `${user.first_name}${user.last_name ? " " + user.last_name : ""}` : null)}
        stats={role !== "teacher"}>
        {rewards && <dl class="profile-stats py-4 l-c3 f-tc mb-6"><div><dd>{rewards.total_points}</dd><dt>Очки</dt></div><div><dd>{rewards.current_streak}</dd><dt>Серия, дней</dt></div><div><dd>{rewards.achievements.filter(a => a.unlocked).length}</dd><dt>Достижения</dt></div></dl>}
        <span class="field-label">Роль</span>
        {!roleContext().canSwitch ? (
          <div class="role-fixed l-h f-b f-2 b-card b-tap"><Icon name="lock" /><span><b>{role === "teacher" ? "Учитель" : "Ученик"}</b> · роль назначена сервером</span></div>
        ) : (
          <>
            <Segmented label="Роль" value={role} onChange={switchRole} options={[{ value: "student", label: "Ученик" }, { value: "teacher", label: "Учитель" }]} />
            <p class="hint-text">Демо-роль: переключается здесь, чтобы показать обе стороны. В школе роль учителя подтверждает сервер по списку школы — переключателя нет.</p>
          </>
        )}
        {role !== "teacher" && <MyClass server={dm === "server"} initialCode={joinCode} onChanged={() => { api.initial().then(({ data }) => setInitial(data)).catch(() => undefined); }} />}
        {!DEMO && <AccountSettings />}
        <ExternalAiNotice />
        {who?.uid&&who.auth!=="demo"&&<AccountConnections />}
        {who?.auth==="demo"&&<section aria-label="Подключение настоящего дневника">
          <h3>Школьный дневник</h3>
          <p class="hint-text">Сейчас открыта автономная демонстрация. Вход в СГО доступен в серверном режиме; демонстрационные данные туда не переносятся.</p>
          <a class="btn btn-secondary btn-block" href={diaryURL(location.href)}>Подключить реальный дневник СГО</a>
        </section>}
        <dl class="diag l-v l-g0 f-b b-card mt-6">
          <div><dt>Вход</dt><dd class="f-2">{who?.auth === "telegram" ? "Telegram · подпись проверена сервером" : who?.auth === "web" ? "Браузер · защищённая сессия" : who?.auth === "max" ? "MAX · подпись проверена сервером" : li.inMax ? "MAX · проверка подписи…" : "Браузер · демо"}</dd></div>
          <div><dt>Платформа</dt><dd class="f-2">{li.platform}{li.version ? ` · ${li.version}` : ""}</dd></div>
          <div><dt>Данные</dt><dd class="f-2">{dm === "server" ? "сервер" : dm === "local" ? "на телефоне (автономно)" : "…"}{offline ? " · офлайн-кэш" : ""}</dd></div>
        </dl>
        <div class="note" style="margin-top:24px"><Icon name="bot" /><div><b>Как это работает в MAX.</b> Перешли боту домашку из чата класса — текстом, фото или голосом. Он разберёт задания и пришлёт кнопку «Построить план дня».</div></div>
        {botName && <button class="btn btn-secondary btn-block" style="margin-top:12px" onClick={() => openUrl(`https://max.ru/${botName}`)}><Icon name="bot" />Открыть чат с ботом</button>}
        <button class="btn btn-ghost btn-block" style="margin-top:16px" onClick={() => {
          dayStore.setDone([]); dayStore.setExtra([]); dayStore.setHidden([]); dayStore.setBuilt(false); focus.drop();
          dayStore.setStartToday(null); setStartOv(null); dayStore.setBedToday(null); setBedV((v) => v + 1); setCompact(false); setOrder("default"); setReply(null);
          { const seeded = seedFrom(initial.settings.personal_activities); saveActs(seeded); }
          Object.keys(dayStore.log()).forEach((k) => dayStore.setLog(k, null)); setLogV((v) => v + 1);
          setDone([]); setExtra([]); setHidden([]); setPlan(null); setProfileOpen(false); setTab(HOME_TAB); toast("День сброшен", "ok");
        }}>Сбросить сегодняшний день</button>
        {DEMO && <button class="btn btn-secondary btn-block" style="margin-top:8px" onClick={() => { resetDemo(); location.reload(); }}>Начать демо заново</button>}
      </ProfileHub>

      <Sheet open={!!tri} onClose={() => setTri(null)} eyebrow="Не влезает в вечер" title="Распределить на 2 дня"
        footer={<button class="btn btn-primary btn-block" onClick={applyTriage}><Icon name="calendar" />Принять и пересобрать</button>}>
        {tri && (
          <>
            <p class="muted" style="margin:0 0 12px">{tri.explanation}</p>
            {[0, 1].map((d) => (
              <div key={d} class="tri-day mt-4">
                <h3 class="h-sec" style="font-size:calc(15px*var(--fs,1))">{d === 0 ? "Сегодня" : "Завтра утром / вечером"}</h3>
                <ul class="list">
                  {tri.assignments.filter((a) => a.day === d).map((a) => <li class="row py-3 l-a1a l-g3 l-mid b-sep" key={a.title}><span class="row-main"><span class="row-title f-s f-trunc" style="display:block">{a.title}</span><span class="row-sub f-b f-2 f-trunc" style="display:block">{a.reason}</span></span></li>)}
                  {!tri.assignments.some((a) => a.day === d) && <li class="faint">—</li>}
                </ul>
              </div>
            ))}
          </>
        )}
      </Sheet>
      {triBusy && <div class="sr" role="status">Распределяем задания…</div>}
      {role !== "teacher" && <HwPixelToast />}
      {role !== "teacher" && !DEMO && <QuizCodeSheet open={codeOpen} onClose={() => setCodeOpen(false)} onOpenIssue={openHwIssue} />}
      {role !== "teacher" && <PracticumSheet open={prOpen} start={prView} grade={gradeNum(initial.grade)} onClose={() => { setPrOpen(false); setPrRev((n) => n + 1); }} />}
      {(DEMO || inSandbox()) && <JuryDrawer open={juryOpen} onClose={() => setJuryOpen(false)} onStudent={juryStudent} onTeacher={juryTeacher}
        current={role === "teacher" ? "teacher" : "student"} sgoHref={DEMO ? diaryURL(location.href) : undefined} onReset={juryReset}
        teacherNote={DEMO ? "Автономная копия: день учителя, подготовка и аналитика класса. Выдача заданий со статусами — в живой демонстрации на сервере" : "Выдача классу, статусы учеников, дубль · отзыв · архив без перезагрузки"}
        onLive={DEMO && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname)) ? () => location.assign(liveURL(location.href)) : undefined} />}

      <Toaster />
    </div>
  );
}



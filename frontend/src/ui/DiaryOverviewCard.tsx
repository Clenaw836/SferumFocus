/** v2.1 · Карточка единого дневника (GET /api/v1/diary/overview) для рабочего места учителя:
 *  классы, уроки на сегодня, заполнение журнала по классам, выданные задания. Честные состояния SWR:
 *  сохранённая копия (is_stale), сервер школы недоступен (upstream_error), журнал не подключён (sgo_unlinked). */
import { useEffect, useState } from "preact/hooks";
import { ApiError, onboarding, type DiaryOverview, type TeacherData } from "../lib/api";
import { DEMO } from "../lib/demo";
import { GRADE_COPY } from "../lib/gradeState";
import { openOnboarding } from "../lib/onboardingEvent";
import { Icon } from "./Icon";
import { roomLabel } from "../lib/room";

const today = (): string => new Date().toLocaleDateString("sv-SE");
/** Демо-режим жюри: вымышленные данные с явной пометкой «демо», запросов к СГО нет. */
export function demoTeacherOverview(): DiaryOverview {
  const d = today();
  return { role: "teacher", status: "ok", is_stale: false, cached_at: null, school: { scid: null, name: "Демо-школа" }, reason: null, student_data: null,
    teacher_data: { source: "sgo",
      classes: [{ id: "8a", name: "8А", students_count: 27, subject: "Алгебра" }, { id: "9b", name: "9Б", students_count: 25, subject: "Геометрия" }],
      schedule: [{ date: d, lessons: [
        { number: 1, start: "08:30", end: "09:15", subject: "Алгебра", room: "204", class_name: "8А" },
        { number: 2, start: "09:25", end: "10:10", subject: "Геометрия", room: "204", class_name: "9Б" }] }],
      journal_summary: [
        { class_name: "8А", subject: "Алгебра", lessons_without_marks: 1, marks_this_week: 23, average_mark: 4.05, last_lesson_date: d },
        { class_name: "9Б", subject: "Геометрия", lessons_without_marks: 0, marks_this_week: 18, average_mark: 4.21, last_lesson_date: d }],
      assignments_issued: [{ id: "501", title: "§ 13, упр. 2", class_name: "8А", subject: "Алгебра", due_date: d, submitted: 12, total: 27 }] } };
}
const time = (iso: string | null): string => {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function DiaryOverviewCard({ enabled }: { enabled: boolean }) {
  const [ov, setOv] = useState<DiaryOverview | null>(DEMO ? demoTeacherOverview() : null);
  const [busy, setBusy] = useState(!DEMO);
  const [failed, setFailed] = useState(false);
  const load = (refresh: boolean) => {
    if (DEMO || !enabled) return;
    setBusy(true);
    onboarding.overview(refresh)
      .then((o) => { setOv(o); setFailed(false); })
      .catch((e: unknown) => { setFailed(!(e instanceof ApiError && (e.status === 401 || e.status === 403))); })
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    load(false);
    const again = () => load(false);
    document.addEventListener("sf-diary-change", again);
    return () => document.removeEventListener("sf-diary-change", again);
  }, [enabled]);
  if (!enabled && !DEMO) return null;
  if (busy && !ov) return <section class="ovc l-v l-g3 b-card mt-3 mb-4" aria-busy="true" aria-label="Журнал СГО"><div class="sk ovc-sk r-md" role="status" aria-label="Загружаем журнал" /></section>;
  if (!ov) return failed ? <section class="ovc l-v l-g3 b-card mt-3 mb-4"><div class="ovc-state l-h l-btw l-wrap"><p class="f-2">{GRADE_COPY.upstream_error}</p>
    <button type="button" class="btn btn-secondary btn-sm" onClick={() => load(true)}>Обновить</button></div></section> : null;
  if (ov.status === "sgo_unlinked") return <section class="ovc l-v l-g3 b-card mt-3 mb-4 ovc-cta" aria-labelledby="ovc-h">
    <div class="ovc-h l-h"><Icon name="book" /><h3 id="ovc-h">Подключите журнал</h3></div>
    <p class="muted">{ov.reason === "reauth_required" ? "Школьный вход устарел — войдите ещё раз, чтобы классы и расписание снова обновлялись." : "Классы, уроки на сегодня и заполнение журнала появятся здесь — без ручного ввода кода школы."}</p>
    <button type="button" class="btn btn-primary btn-sm" onClick={openOnboarding}>{ov.reason === "reauth_required" ? "Войти снова" : "Подключить дневник"}</button>
  </section>;
  if (ov.status === "upstream_error" || !ov.teacher_data) return <section class="ovc l-v l-g3 b-card mt-3 mb-4"><div class="ovc-state l-h l-btw l-wrap"><p class="f-2">{GRADE_COPY.upstream_error}</p>
    <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={() => load(true)}>{busy ? "Обновляем…" : "Обновить"}</button></div></section>;
  return <TeacherBody data={ov.teacher_data} school={ov.school?.name ?? null} stale={ov.is_stale} cachedAt={ov.cached_at} busy={busy} onRefresh={() => load(true)} />;
}

/** Тело журнала учителя. Экспортируется для DiaryWelcome (TeacherPending): там нет кнопки обновления. */
export function TeacherBody({ data, school, stale, cachedAt, busy = false, onRefresh }: { data: TeacherData; school: string | null; stale: boolean; cachedAt: string | null; busy?: boolean; onRefresh?: () => void }) {
  const day = data.schedule.find((d) => d.date === today()) ?? data.schedule[0] ?? null;
  const gaps = data.journal_summary.filter((j) => (j.lessons_without_marks ?? 0) > 0);
  return <section class="ovc l-v l-g3 b-card mt-3 mb-4" aria-labelledby="ovc-h">
    <div class="ovc-h l-h"><Icon name="book" /><h3 id="ovc-h">Журнал{school ? ` · ${school}` : ""}</h3>
      {DEMO && <span class="src-badge sm">демо</span>}
      {!DEMO && onRefresh && <button type="button" class="icon-btn ovc-refresh" aria-label="Обновить журнал" disabled={busy} onClick={onRefresh}><Icon name="refresh" /></button>}
    </div>
    {stale && <p class="ovc-stale p-23 f-b u-warn r-md" role="status">{GRADE_COPY.stale}{cachedAt ? ` (${time(cachedAt)})` : ""}</p>}
    {data.source === "sgo_without_teacher_api" && <p class="muted ovc-note f-b">Сервер вашего региона пока не отдаёт учительский журнал через API — показываем то, что доступно.</p>}
    {data.classes.length > 0 && <ul class="ovc-classes l-h l-wrap" aria-label="Мои классы">{data.classes.map((c) => <li key={c.id}><b>{c.name}</b>{c.students_count !== null && <span class="num f-2">{c.students_count} уч.</span>}</li>)}</ul>}
    {day && day.lessons.length > 0 && <div class="ovc-block"><h4 class="f-2">Уроки{day.date === today() ? " сегодня" : ` ${day.date.split("-").reverse().join(".")}`}</h4>
      <ol class="ovc-lessons l-v l-g1">{day.lessons.map((l, i) => <li key={`${l.number}-${i}`}><span class="num ovc-t f-b f-2">{l.start ?? (l.number !== null ? `${l.number} ур.` : "")}</span>
        <span class="ovc-s l-v l-g0"><b>{l.subject}</b><small>{[l.class_name, l.room ? roomLabel(l.room) : null].filter(Boolean).join(" · ")}</small></span></li>)}</ol></div>}
    {data.journal_summary.length > 0 && <div class="ovc-block"><h4 class="f-2">Заполнение журнала</h4>
      <ul class="ovc-journal l-v l-g1">{data.journal_summary.map((j, i) => <li key={`${j.class_name}-${i}`} class={(j.lessons_without_marks ?? 0) > 0 ? "warn" : "ok"}>
        <span><b>{j.class_name ?? "Все классы"}</b>{j.subject && <small>{j.subject}</small>}</span>
        <span class="num">{(j.lessons_without_marks ?? 0) > 0 ? `без отметок: ${j.lessons_without_marks}` : "заполнен"}{j.average_mark !== null ? ` · ср. ${j.average_mark.toFixed(2)}` : ""}</span></li>)}</ul>
      {gaps.length === 0 && <p class="muted ovc-note f-b">Все уроки недели с отметками.</p>}</div>}
    {data.assignments_issued.length > 0 && <div class="ovc-block"><h4 class="f-2">Выданные задания</h4>
      <ul class="ovc-hw l-v l-g1">{data.assignments_issued.slice(0, 4).map((a) => { const pct = a.total ? Math.round(((a.submitted ?? 0) / a.total) * 100) : null;
        return <li key={a.id}><span><b>{a.title}</b><small>{[a.class_name, a.subject].filter(Boolean).join(" · ")}</small></span>
          {pct !== null && <span class="ovc-bar l-blk b-box b-nob l-rel o-h" role="img" aria-label={`Сдали ${a.submitted} из ${a.total}`}><i style={`width:${pct}%`} /><em class="num">{a.submitted}/{a.total}</em></span>}</li>; })}</ul></div>}
  </section>;
}

/**
 * Recovery 2 · «Классы → Задания»: the teacher assigns work to concrete students.
 *  class code → approve requests → new assignment (subject, title, minutes, due date, students) →
 *  per-student status, timer time, history → revoke / issue again / edit (expected revision) / archive.
 * Assignments exist only on the server. Every command carries an operation id; a retry after an
 * unknown outcome replays the stored answer (no duplicate issue, no double revoke).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { revealList, reward } from "../lib/motion";
import { createPortal } from "preact/compat";
import { api, ApiError } from "../lib/api";
import { createOnce } from "../lib/assignmentSync";
import { schoolDay } from "../lib/day";
import { HW_STATUS, HW_TYPE, countsLine, dueText, fmtDur, validateAssignment, when } from "../lib/hwFormat";
import type { HwClass, HwCounts, HwEvent, HwIssueRow, HwMember, HwOverview, HwRoster, HwTemplate, HwTemplateDetail, ManualHow, QuizDraft, TeacherQuiz } from "../lib/hwTypes";
import { HOW_LABEL, HOW_SHORT } from "../lib/quizCode";
import { blankQuiz, quizMinutes, quizPayload, validateQuiz } from "../lib/quizForm";
import { appLink, share } from "../lib/host";
import { ManualEntry, PaperCopy, QuizBuilder, QuizStatsPanel } from "./TeacherQuiz";
import { JournalCopy, ProjectorSheet } from "./TeacherClassroom";
import { plural } from "../lib/time";
import { ClassReport } from "../ui/ClassReport";
import { SgoJournal } from "../ui/SgoJournal";
import { HwTimeline } from "../ui/HwTimeline";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";

/** Live refresh, action reloads and class/assignment switches overlap: only the newest response of one
 * loader may touch its state (a slow older answer must not paint version 1 over version 2). */
function useLatest() {
  const n = useRef(0);
  return () => { const my = ++n.current; return () => my === n.current; };
}

const once = createOnce();
type Err = { m: string; s: number };
const toErr = (e: unknown): Err => (e instanceof ApiError ? { m: e.message, s: e.status } : { m: "Не загрузилось", s: 0 });
const fp = (...xs: unknown[]) => JSON.stringify(xs);
const OPEN = new Set(["assigned", "in_progress", "paused"]);
const students = (n: number) => `${n} ${plural(n, "ученик", "ученика", "учеников")}`;

function copy(text: string) {
  const fallback = () => toast(`Скопировать не удалось. Код: ${text}`, "info");
  if (!navigator.clipboard) { fallback(); return; }
  navigator.clipboard.writeText(text).then(() => toast("Код скопирован", "ok"), fallback);
}

function Problem({ err, onRetry }: { err: Err; onRetry: () => void }) {
  const local = err.s === 503 && /DEMO/.test(err.m);
  return <div class="empty hw-problem" role="status">
    <Icon name={err.s === 403 ? "lock" : local ? "info" : "wifiOff"} />
    <h3>{err.s === 403 ? "Нет права выдавать задания" : local ? "Задания учителя — только с сервером" : "Не загрузилось"}</h3>
    <p class="f-2">{local ? "В автономной DEMO-копии нет хранилища заданий, поэтому здесь ничего не имитируется. Откройте приложение с сервера — выдача, статусы и история появятся." : err.m}</p>
    {!local && err.s !== 403 && <button type="button" class="btn btn-secondary btn-sm" onClick={onRetry}>Повторить</button>}
  </div>;
}

/** Inline two-step confirmation: the destructive action sits next to its consequence. */
function Confirm({ text, yes, busy, onYes, onNo }: { text: string; yes: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label={yes}>
    <p class="f-2">{text}</p>
    <div class="hw-row-actions l-h l-wrap"><button ref={ref} type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={onYes}>{yes}</button><button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={onNo}>Отмена</button></div>
  </div>;
}

function Bar({ c }: { c: HwCounts }) {
  const open = c.total - c.revoked;
  if (!open) return <span class="hw-bar is-empty" aria-hidden="true" />;
  const w = (n: number) => `${(100 * n) / open}%`;
  return <span class="hw-bar" aria-hidden="true"><i class="s-completed" style={{ width: w(c.completed) }} /><i class="s-in_progress" style={{ width: w(c.in_progress) }} /><i class="s-paused" style={{ width: w(c.paused) }} /></span>;
}

/** Share of open issues already handed in — drawn from the real counts, never estimated. */
function Ring({ c }: { c: HwCounts }) {
  const open = c.total - c.revoked;
  const pct = open ? Math.round((100 * c.completed) / open) : 0;
  return <span class={`hw-ring pt-4 l-h l-base l-jc l-g0 f-num b-round l-fix l-rel${open && c.completed === open ? " is-full" : ""}`} style={{ "--p": pct }} aria-hidden="true"><b class="num">{c.completed}</b><small class="num">/{open}</small></span>;
}

export function TeacherAssignments({ isDemo }: { isDemo: boolean }) {
  const [ov, setOv] = useState<HwOverview | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [cls, setCls] = useState<string | null>(null);
  const [rk, setRk] = useState(0);
  const [creating, setCreating] = useState<"task" | "quiz" | null>(null);
  /** v2.1 · «Дублировать»: копия задания открывается в форме выдачи (срок сброшен), оригинал и его история не меняются. */
  const [copyFrom, setCopyFrom] = useState<Form | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [caps, setCaps] = useState<{ ai: boolean; bot: string | null }>({ ai: false, bot: null });
  useEffect(() => { api.health().then((h) => setCaps({ ai: !!(h.teacher_ai ?? h.ai), bot: h.bot_name ?? null })).catch(() => undefined); }, []);
  const latestOv = useLatest();
  const loadOv = () => { const current = latestOv(); return api.hw.overview().then((o) => {
    if (!current()) return;
    setOv(o); setErr(null);
    setCls((c) => (c && o.classes.some((x) => x.class === c) ? c : o.classes[0]?.class ?? null));
  }).catch((e) => { if (current()) setErr(toErr(e)); }); };
  useEffect(() => { void loadOv(); }, []);
  useEffect(() => {                                    // new requests and fresh counts without a reload (30 s, only while visible)
    const wake = () => { if (!document.hidden) { void loadOv(); setRk((k) => k + 1); } };
    const t = window.setInterval(wake, 30_000);
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", wake); };
  }, []);
  const changed = () => { setRk((k) => k + 1); void loadOv(); };

  if (err) return <Problem err={err} onRetry={() => { setErr(null); void loadOv(); }} />;
  if (!ov) return <div class="hw l-v l-g4" aria-busy="true"><div class="sk" style="height:48px" /><div class="sk" style="height:160px;margin-top:12px" /><div class="sk" style="height:120px;margin-top:12px" /></div>;
  if (!ov.classes.length) return <div class="empty hw-problem"><Icon name="lock" /><h3>Нет классов для выдачи заданий</h3><p class="f-2">Выдавать задания можно классам, где у вас в справочнике школы есть право «выдавать домашние задания».</p></div>;
  const current = ov.classes.find((c) => c.class === cls) ?? ov.classes[0];
  return <div class="hw l-v l-g4">
    <div class="hw-intro l-h l-top l-btw l-g3">
      <p class="f-2">Задание получает каждый выбранный ученик — в свой план дня. Вы видите статус, время по таймеру и историю.</p>
      {(isDemo || ov.is_demo) && <span class="tm-badge l-h l-inl l-g0 f-m f-w6 f-nw b-pill l-fix l-self-s" title="Демо-режим сервера: синтетический учитель, данные отдельно от школьных">DEMO</span>}
    </div>
    <div class="hw-classes l-h" role="group" aria-label="Класс">
      {ov.classes.map((c) => <button key={c.class} type="button" class="hw-class-chip l-h l-base l-inl f-b f-2 b-card b-tap l-fix l-rel" aria-pressed={c.class === current.class} onClick={() => setCls(c.class)}>
        <b>{c.class}</b><span class="f-3">{students(c.active)}</span>{c.pending > 0 && <i class="hw-dot l-center l-g0 f-c f-w6 u-acc p-abs" aria-label={`заявок: ${c.pending}`}>{c.pending}</i>}
      </button>)}
    </div>
    <div class="hw-grid l-v l-g4">
      <ClassPanel cls={current} reloadKey={rk} onChanged={changed} botName={caps.bot} />
      <TemplateList cls={current} reloadKey={rk} onCreate={setCreating} onOpen={setOpenId} />
    </div>
    <ClassReport cls={current.class} />
    <SgoJournal cls={current.class} />
    <p class="hw-truth l-h l-top f-m f-3"><Icon name="info" /><span><b class="f-2">Что значат минуты.</b> «По таймеру» — сколько шёл таймер ученика, паузы не считаются. «Подтверждено» — часть этого времени, когда приложение было открыто и на связи с сервером. Это факт работы таймера, а не доказательство внимания или самостоятельности.</span></p>
    {createPortal(<NewAssignment open={creating !== null} initialKind={creating ?? "task"} prefill={copyFrom} cls={current} aiAvailable={caps.ai} onClose={() => { setCreating(null); setCopyFrom(null); }}
      onCreated={(id) => { setCreating(null); setCopyFrom(null); changed(); setOpenId(id); }} onOpenExisting={(id) => { setCreating(null); setCopyFrom(null); setOpenId(id); }} />, document.body)}
    {createPortal(<TemplateSheet id={openId} botName={caps.bot} onClose={() => setOpenId(null)} onChanged={changed}
      onDuplicate={(form, from) => { if (ov.classes.some((c) => c.class === from)) setCls(from); setOpenId(null); setCopyFrom(form); setCreating("task"); }} />, document.body)}
  </div>;
}

function ClassPanel({ cls, reloadKey, onChanged, botName }: { cls: HwClass; reloadKey: number; onChanged: () => void; botName: string | null }) {
  const [offline, setOffline] = useState("");
  const [r, setR] = useState<HwRoster | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const latestR = useLatest();
  const load = () => { const current = latestR(); return api.hw.roster(cls.class).then((x) => { if (current()) { setR(x); setErr(null); } }).catch((e) => { if (current()) setErr(toErr(e)); }); };
  useEffect(() => { setR(null); setAsk(null); void load(); }, [cls.class]);
  useEffect(() => { if (reloadKey) void load(); }, [reloadKey]);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try { await f(); toast(ok, "ok"); setAsk(null); await load(); onChanged(); }
    catch (e) { toast(toErr(e).m, "warn"); await load(); }
    finally { setBusy(false); }
  };
  const pending = r?.members.filter((m) => m.status === "pending") ?? [];
  const active = r?.members.filter((m) => m.status === "active") ?? [];
  const code = r?.code ?? null;
  return <section class="hw-card b-card hw-class" aria-labelledby={`hw-class-${cls.class}`} aria-busy={busy}>
    <header class="hw-card-head l-h l-top l-btw l-wrap l-g3 mb-3"><div><p class="eyebrow">Класс {cls.class}</p><h2 id={`hw-class-${cls.class}`}>Ученики и код</h2></div><span class="hw-count f-m f-2 b-pill l-fix num">{students(active.length)}</span></header>
    {err ? <p class="field-err" role="alert">{err.m}</p> : !r ? <div class="sk" style="height:96px" /> : <>
      <div class="hw-code l-h l-btw l-wrap l-g3 b-card">
        {code ? <>
          <div class="hw-code-value l-v l-g1"><span class="hw-code-label f-m f-3">Код для учеников</span><b class="num" aria-label={`Код класса: ${code.code.split("").join(" ")}`}>{code.code}</b><small>действует до {when(code.expires_at)}</small></div>
          {ask === "rotate"
            ? <Confirm text="Старый код перестанет работать. Уже вступившие ученики останутся в классе." yes="Да, новый код" busy={busy}
                onYes={() => void act(() => once.run(fp("code", cls.class, true, code.code), (op) => api.hw.code(cls.class, true, op)), "Новый код создан")} onNo={() => setAsk(null)} />
            : <div class="hw-row-actions l-h l-wrap"><button type="button" class="btn btn-secondary btn-sm" onClick={() => copy(code.code)}><Icon name="share" />Скопировать</button>
                <button type="button" class="btn btn-secondary btn-sm" onClick={() => { const link = appLink(`join_${code.code.replace(/[^A-Za-z0-9]/g, "")}`, botName); void share(`Вступайте в класс ${cls.class} в СферумФокус. Код класса: ${code.code}`, link).then((r) => toast(r === "copied" ? "Ссылка-приглашение скопирована" : r === "none" ? `Ссылка: ${link}` : "Приглашение отправлено", r === "none" ? "info" : "ok")); }}><Icon name="send" />Пригласить ссылкой</button>
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => setAsk("rotate")}><Icon name="refresh" />Новый код</button></div>}
        </> : <>
          <p class="hw-code-hint f-b f-2">Ученик вводит код в «Профиль → Мой класс», вы подтверждаете заявку. Код действует 7 дней.</p>
          <button type="button" class="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => once.run(fp("code", cls.class, false), (op) => api.hw.code(cls.class, false, op)), "Код класса создан")}>Создать код класса</button>
        </>}
      </div>
      {pending.length > 0 && <div class="hw-requests"><h3>Заявки · {pending.length}</h3><ul>
        {pending.map((m) => <li key={m.roster_id} class="hw-person l-h l-btw l-wrap b-sep">
          <span class="hw-name l-v l-g1"><b>{m.display_name}</b><small>заявка {when(m.requested_at)}</small></span>
          <span class="hw-row-actions l-h l-wrap">
            <button type="button" class="btn btn-ok btn-sm" disabled={busy} aria-label={`Принять ${m.display_name}`} onClick={() => void act(() => once.run(fp("decide", m.roster_id, true), (op) => api.hw.decide(m.roster_id, true, op)), `${m.display_name} — в классе`)}>Принять</button>
            <button type="button" class="btn btn-ghost btn-sm" disabled={busy} aria-label={`Отклонить ${m.display_name}`} onClick={() => void act(() => once.run(fp("decide", m.roster_id, false), (op) => api.hw.decide(m.roster_id, false, op)), "Заявка отклонена")}>Отклонить</button>
          </span>
        </li>)}
      </ul></div>}
      <details class="hw-roster mt-3">
        <summary class="f-2"><span>Ученики класса · {active.length}</span><Icon name="chevron" /></summary>
        {active.length === 0 ? <p class="muted hw-pad f-b mt-1 mb-2">Пока никого. Покажите ученикам код класса.</p> : <ul>
          {active.map((m) => <li key={m.roster_id} class={`hw-person${m.access === "offline" ? " is-offline" : ""}`}>
            <span class="hw-name l-v l-g1"><b>{m.display_name}</b><small>{m.access === "offline" ? "без приложения · результаты вносит учитель" : `в приложении · в классе с ${when(m.decided_at, false)}`}</small></span>
            <span class={`hw-access l-h l-inl l-g1 f-m f-w6 f-2 b-pill l-fix a-${m.access ?? "app"}`}><Icon name={m.access === "offline" ? "book" : "user"} />{m.access === "offline" ? "Бумага" : "Приложение"}</span>
            {ask === `rm:${m.roster_id}`
              ? <Confirm text="Открытые задания ученика будут отозваны. История и выполненное сохранятся." yes={`Убрать ${m.display_name}`} busy={busy}
                  onYes={() => void act(() => once.run(fp("remove", m.roster_id), (op) => api.hw.remove(m.roster_id, op)), `${m.display_name} — убран(а) из класса`)} onNo={() => setAsk(null)} />
              : <button type="button" class="btn btn-ghost btn-sm" aria-label={`Убрать ${m.display_name} из класса`} onClick={() => setAsk(`rm:${m.roster_id}`)}>Убрать</button>}
          </li>)}
        </ul>}
        <form class="hw-offline l-1a mt-2 mb-1 r-lg u-warn-s p-3" onSubmit={(e) => { e.preventDefault(); const name = offline.trim().replace(/\s+/g, " "); if (name.length < 2 || busy) return;
            void act(() => once.run(fp("offline", cls.class, name), (op) => api.hw.addOffline(cls.class, name, op)), `${name} — в списке, без приложения`).then(() => setOffline("")); }}>
          <label class="field"><span class="field-label">Ученик без приложения</span>
            <input class="input" maxLength={60} value={offline} placeholder="Фамилия Имя" onInput={(e) => setOffline((e.currentTarget as HTMLInputElement).value)} /></label>
          <button type="submit" class="btn btn-secondary btn-sm" disabled={busy || offline.trim().length < 2}><Icon name="plus" />Добавить</button>
          <p class="hint-text">Такой ученик получает задания на бумаге; вы вносите результат вручную. Войти под ним нельзя.</p>
        </form>
      </details>
    </>}
  </section>;
}

function TemplateList({ cls, reloadKey, onCreate, onOpen }: { cls: HwClass; reloadKey: number; onCreate: (kind: "task" | "quiz") => void; onOpen: (id: string) => void }) {
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<HwTemplate[] | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const latestL = useLatest();
  const load = () => { const current = latestL(); return api.hw.templates(cls.class, archived).then((r) => { if (current()) { setList(r.templates); setErr(null); } }).catch((e) => { if (current()) setErr(toErr(e)); }); };
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useRef("");
  useEffect(() => { setList(null); void load(); }, [cls.class, archived]);
  useEffect(() => {                                    // first paint of a list: a short stagger; refreshes do not re-animate
    const key = `${cls.class}|${archived}`;
    if (!list?.length || shown.current === key || !listRef.current) return;
    shown.current = key;
    void revealList(listRef.current.querySelectorAll(":scope > li"), 45);
  }, [list, cls.class, archived]);
  useEffect(() => { if (reloadKey) void load(); }, [reloadKey]);
  return <section class="hw-card b-card hw-list" aria-labelledby={`hw-list-${cls.class}`}>
    <header class="hw-card-head l-h l-top l-btw l-wrap l-g3 mb-3">
      <div><p class="eyebrow">{cls.subjects.join(" · ") || "Предмет не указан"}</p><h2 id={`hw-list-${cls.class}`}>Задания · {cls.class}</h2></div>
      <div class="hw-new-actions l-h l-wrap mw-full">
        <button type="button" class="btn btn-primary btn-sm hw-new l-fix" onClick={() => onCreate("task")} disabled={!cls.subjects.length}><Icon name="plus" />Новое задание</button>
        <button type="button" class="btn btn-secondary btn-sm hw-new l-fix" onClick={() => onCreate("quiz")} disabled={!cls.subjects.length}><Icon name="bolt" />Блиц-опрос</button>
      </div>
    </header>
    <div class="seg-mini hw-filter mb-3" role="radiogroup" aria-label="Какие задания показать">
      <button type="button" role="radio" aria-checked={!archived} onClick={() => setArchived(false)}>Активные</button>
      <button type="button" role="radio" aria-checked={archived} onClick={() => setArchived(true)}>Архив</button>
    </div>
    {err ? <p class="field-err" role="alert">{err.m}</p> : !list ? <div class="sk" style="height:84px;margin-top:12px" /> : list.length === 0
      ? <div class="hw-empty l-h l-top l-g3 f-b f-2 b-card b-nob"><Icon name={archived ? "book" : "pen"} /><p>{archived ? "В архиве пусто. Архивированные задания и их история хранятся здесь." : "Заданий пока нет. Создайте первое — оно сразу появится у выбранных учеников в плане дня."}</p></div>
      : <ul class="hw-tpls l-v" ref={listRef}>{list.map((t) => <li key={t.template_id}>
          <button type="button" class="hw-tpl l-1a l-g3 l-mid b-card l-w100 l-rel" onClick={() => onOpen(t.template_id)}>
            <span class="hw-tpl-main l-v l-g1">
              <b class="hw-tpl-title f-s">{t.kind === "quiz" && <span class="hw-kind l-h l-inl l-g1 f-c f-w6 f-warn b-pill u-warn"><Icon name="bolt" />Блиц-опрос</span>}{t.title}</b>
              <span class="hw-tpl-sub f-m f-3">{t.subject} · {t.kind === "quiz" && t.quiz ? `${t.quiz.count} вопр. · ${t.quiz.time_limit_min ? `${t.quiz.time_limit_min} мин` : "без лимита"}` : `${HW_TYPE[t.type]} · ${t.planned_minutes} мин`} · {dueText(t.due_date)}</span>
              <span class="hw-tpl-counts f-b f-2">{countsLine(t.counts)}</span>
              <Bar c={t.counts} />
            </span>
            <Ring c={t.counts} />
          </button>
        </li>)}</ul>}
  </section>;
}

/** Editing a field clears its own error (the rest stay until the next submit). */
const clearErrs = (e: Record<string, string>, p: object) => { const keys = Object.keys(p); if (!keys.some((k) => k in e)) return e; const n = { ...e }; keys.forEach((k) => delete n[k]); return n; };

type Form = { subject: string; title: string; instructions: string; type: "written" | "oral"; planned_minutes: number; due_date: string };
const blank = (subject: string): Form => ({ subject, title: "", instructions: "", type: "written", planned_minutes: 30, due_date: "" });

function Fields({ f, set, errs, subjects, quiz = false }: { f: Form; set: (p: Partial<Form>) => void; errs: Record<string, string>; subjects: string[] | null; quiz?: boolean }) {
  return <>
    {subjects && (subjects.length > 1
      ? <label class="field"><span class="field-label">Предмет</span><select class="input" value={f.subject} onChange={(e) => set({ subject: (e.currentTarget as HTMLSelectElement).value })}>{subjects.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      : <p class="hw-fixed"><span class="field-label">Предмет</span><b>{f.subject}</b></p>)}
    <label class="field"><span class="field-label">Название <small class="hw-counter f-m f-3 num">{f.title.length}/120</small></span>
      <input class="input" name="hw-title" maxLength={120} value={f.title} aria-invalid={!!errs.title} aria-describedby={errs.title ? "hw-e-title" : undefined}
        placeholder={quiz ? "Например: Блиц-опрос · квадратные корни" : "Например: № 214–217, стр. 58"} onInput={(e) => set({ title: (e.currentTarget as HTMLInputElement).value })} />
      {errs.title && <span id="hw-e-title" class="field-err">{errs.title}</span>}</label>
    <label class="field"><span class="field-label">Что сделать <small class="hw-counter f-m f-3 num">{f.instructions.length}/2000</small></span>
      <textarea class="textarea" name="hw-instructions" maxLength={2000} rows={4} value={f.instructions} aria-invalid={!!errs.instructions}
        placeholder="Короткая инструкция: что решить, как оформить, что прислать" onInput={(e) => set({ instructions: (e.currentTarget as HTMLTextAreaElement).value })} />
      {errs.instructions && <span class="field-err">{errs.instructions}</span>}</label>
    {!quiz && <div class="hw-two l-c2 l-g3">
      <div class="field"><span class="field-label" id="hw-type-l">Тип</span>
        <div class="seg-mini" role="radiogroup" aria-labelledby="hw-type-l">
          {(["written", "oral"] as const).map((t) => <button key={t} type="button" role="radio" aria-checked={f.type === t} onClick={() => set({ type: t })}>{HW_TYPE[t]}</button>)}
        </div></div>
      <label class="field"><span class="field-label">Минут на задание</span>
        <input class="input num" name="hw-minutes" type="number" inputMode="numeric" min={5} max={240} step={5} value={f.planned_minutes} aria-invalid={!!errs.planned_minutes}
          onInput={(e) => set({ planned_minutes: Math.round(Number((e.currentTarget as HTMLInputElement).value)) })} />
        {errs.planned_minutes && <span class="field-err">{errs.planned_minutes}</span>}</label>
    </div>}
    <label class="field"><span class="field-label">Срок <small class="faint">— необязательно</small></span>
      <input class="input" name="hw-due" type="date" min={schoolDay()} value={f.due_date} aria-invalid={!!errs.due_date} onInput={(e) => set({ due_date: (e.currentTarget as HTMLInputElement).value })} />
      {errs.due_date && <span class="field-err">{errs.due_date}</span>}</label>
  </>;
}

function Picker({ members, picked, setPicked, legend }: { members: HwMember[]; picked: Set<string>; setPicked: (s: Set<string>) => void; legend: string }) {
  const all = members.length > 0 && members.every((m) => picked.has(m.roster_id));
  const some = !all && members.some((m) => picked.has(m.roster_id));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = some; }, [some]);
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  return <fieldset class="hw-picker b-card"><legend>{legend}</legend>
    <label class="hw-check l-h f-b b-tap hw-check-all f-w6 b-sep mb-1"><input ref={allRef} type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(members.map((m) => m.roster_id)))} /><span>Все · {members.length}</span></label>
    <div class="hw-checks l-fit l-g1">{members.map((m) => <label key={m.roster_id} class="hw-check l-h f-b b-tap"><input type="checkbox" checked={picked.has(m.roster_id)} onChange={() => toggle(m.roster_id)} /><span>{m.display_name}{m.access === "offline" && <small class="hw-paper-tag f-m f-warn"> · на бумаге</small>}</span></label>)}</div>
  </fieldset>;
}

function NewAssignment({ open, initialKind = "task", prefill = null, cls, aiAvailable, onClose, onCreated, onOpenExisting }: { open: boolean; initialKind?: "task" | "quiz"; prefill?: Form | null; cls: HwClass; aiAvailable: boolean; onClose: () => void; onCreated: (id: string) => void; onOpenExisting: (id: string) => void }) {
  const [f, setF] = useState<Form>(blank(cls.subjects[0] ?? ""));
  const [kind, setKind] = useState<"task" | "quiz">("task");
  const [quiz, setQuizState] = useState<QuizDraft>(blankQuiz());
  const [edited, setEdited] = useState(false);
  const [qErrs, setQErrs] = useState<Record<string, string>>({});
  const [whole, setWhole] = useState(false);
  const setQuiz = (q: QuizDraft, ed?: boolean) => { setQuizState(q); if (ed !== undefined) setEdited(ed); setQErrs({}); setDup(null); };
  const pickKind = (k: "task" | "quiz") => { setKind(k); setDup(null); if (k === "quiz") setWhole(true); };
  const [roster, setRoster] = useState<HwMember[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [fail, setFail] = useState("");
  const latestP = useLatest();
  const loadRoster = () => { const current = latestP(); return api.hw.roster(cls.class).then((r) => {
    if (!current()) return;
    const act = r.members.filter((m) => m.status === "active");
    setRoster(act); setPicked(new Set(act.map((m) => m.roster_id)));
  }).catch((e) => { if (current()) { setRoster([]); setFail(toErr(e).m); } }); };
  useEffect(() => {
    if (!open) return;
    setDup(null); setFail(""); setErrs({}); setRoster(null);
    setKind(initialKind); setWhole(initialKind === "quiz");      // кнопка «Блиц-опрос» открывает лист сразу в режиме опроса для всего класса
    if (prefill) setF({ ...prefill, due_date: "", subject: cls.subjects.includes(prefill.subject) ? prefill.subject : cls.subjects[0] ?? "" });
    else setF((x) => (x.subject && cls.subjects.includes(x.subject) ? x : { ...x, subject: cls.subjects[0] ?? "" }));
    void loadRoster();
  }, [open, cls.class]);
  const set = (p: Partial<Form>) => { setF((x) => ({ ...x, ...p })); setDup(null); setErrs((e) => clearErrs(e, p)); };
  const dupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {                                    // the choice must be seen: bring it into view and onto the keyboard
    if (!dup) return;
    dupRef.current?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    dupRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [dup]);
  const submit = async (allowDuplicate = false) => {
    const isQuiz = kind === "quiz";
    const title = f.title.trim() || (isQuiz && quiz.topic.trim() ? `Блиц-опрос: ${quiz.topic.trim()}`.slice(0, 120) : "");
    const body = { class: cls.class, subject: f.subject, title, instructions: f.instructions.trim(), type: isQuiz ? "written" as const : f.type,
      planned_minutes: isQuiz ? quizMinutes(quiz) : f.planned_minutes, due_date: f.due_date || null, roster_ids: whole ? [] : [...picked].sort(),
      ...(whole ? { whole_class: true } : {}), ...(isQuiz ? { kind: "quiz" as const, quiz: quizPayload(quiz, edited) } : {}), ...(allowDuplicate ? { allow_duplicate: true } : {}) };
    const e = validateAssignment(body, schoolDay());
    const qe = isQuiz ? validateQuiz(quiz) : {};
    setErrs(e); setQErrs(qe);
    if (Object.keys(e).length || Object.keys(qe).length) { requestAnimationFrame(() => document.querySelector<HTMLElement>(".hw-form [aria-invalid=true]")?.focus()); return; }
    if (busy) return;
    setBusy(true); setFail(""); setDup(null);
    try {
      const r = await once.run(fp("create", body), (op) => api.hw.create(body, op));
      toast(r.created.length ? `${isQuiz ? "Опрос выдан" : "Выдано"}: ${students(r.created.length)}` : "Задание сохранено. Выдать можно в его карточке", "ok");
      setF(blank(f.subject)); setQuizState(blankQuiz()); setEdited(false); setKind("task"); setWhole(false); onCreated(r.template.template_id);
    } catch (x) {
      if (x instanceof ApiError && x.status === 409 && typeof x.extra?.duplicate_of === "string") setDup(x.extra.duplicate_of);
      else if (x instanceof ApiError && x.status === 422 && Array.isArray(x.extra?.invalid_roster_ids)) { setFail(`${x.message}. Список учеников обновлён — проверьте выбор.`); void loadRoster(); }
      else setFail(toErr(x).m);
    } finally { setBusy(false); }
  };
  const count = whole ? roster?.length ?? 0 : picked.size;
  const copying = !!prefill && kind === "task";
  return <Sheet open={open} onClose={onClose} eyebrow={`Класс ${cls.class}`} title={kind === "quiz" ? "Новый блиц-опрос" : copying ? "Копия задания" : "Новое задание"}
    footer={<button type="button" class="btn btn-primary btn-block" disabled={busy || !f.subject || roster === null} onClick={() => void submit()}>{busy ? "Выдаём…" : count ? `${whole ? "Выдать всему классу" : "Выдать"} · ${count}` : "Сохранить без выдачи"}</button>}>
    <form class="hw-form l-v l-g3" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <div class="seg-mini hw-kind-pick" role="radiogroup" aria-label="Что выдать">
        <button class="f-2" type="button" role="radio" aria-checked={kind === "task"} onClick={() => pickKind("task")}><Icon name="book" />Обычное ДЗ</button>
        <button class="f-2" type="button" role="radio" aria-checked={kind === "quiz"} onClick={() => pickKind("quiz")}><Icon name="bolt" />Обязательный блиц-опрос</button>
      </div>
      <p class="hint-text hw-kind-hint">{kind === "quiz"
        ? "Всему классу, с лимитом времени: ответы проверяет сервер, вы видите, кто открыл и сдал. Ученикам без приложения — бумажная версия и ручная отметка."
        : "Задание с планом по времени: ученик отмечает начало и сдачу, вы видите статусы."}</p>
      {copying && <p class="note hw-copy-note" role="status"><Icon name="info" /><span>Копия «{prefill.title}»: срок сброшен — выберите новый. Оригинал и его история не меняются.</span></p>}
      <Fields f={f} set={set} errs={errs} subjects={cls.subjects} quiz={kind === "quiz"} />
      {kind === "quiz" && <QuizBuilder quiz={quiz} setQuiz={setQuiz} errs={qErrs} cls={cls.class} subject={f.subject} aiAvailable={aiAvailable} edited={edited} />}
      {roster === null ? <div class="sk" style="height:96px" /> : roster.length === 0
        ? <div class="note"><Icon name="users" /><div><b>В классе пока нет подтверждённых учеников.</b> Задание можно сохранить сейчас и выдать позже — в его карточке.</div></div>
        : <>
          <div class="hw-whole l-v l-g1">
            <div class="seg-mini hw-target" role="radiogroup" aria-label="Кому выдать">
              <button type="button" role="radio" aria-checked={whole} onClick={() => setWhole(true)}><Icon name="users" />Всему классу · <span class="num">{roster.length}</span></button>
              <button type="button" role="radio" aria-checked={!whole} onClick={() => setWhole(false)}><Icon name="user" />Выбранным</button>
            </div>
            <p class="hint-text">{whole ? (roster.some((m) => m.access === "offline") ? "Все подтверждённые ученики, включая учеников без приложения — им на бумаге." : "Все подтверждённые ученики на момент выдачи.") : "Отметьте учеников ниже."}</p>
          </div>
          {!whole && <Picker members={roster} picked={picked} setPicked={setPicked} legend="Кому выдать" />}
        </>}
      {dup && <div class="note warn hw-dup" role="alert" ref={dupRef}><Icon name="alert" /><div><b>Такое же задание уже выдано несколько минут назад.</b> Скорее всего, это повторное нажатие.
        <div class="hw-row-actions l-h l-wrap"><button type="button" class="btn btn-secondary btn-sm" onClick={() => onOpenExisting(dup)}>Открыть выданное</button><button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => void submit(true)}>Всё равно создать</button></div></div></div>}
      {fail && <p class="field-err" role="alert">{fail}</p>}
      <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
    </form>
  </Sheet>;
}

function StudentRow({ s, archived, latest, busy, ask, setAsk, onRevoke, onReissue, hist, onHist, quizMax, onManualSaved, onMark, onClearMark }: {
  s: HwIssueRow; archived: boolean; latest: number; busy: boolean; ask: string | null; setAsk: (k: string | null) => void;
  onRevoke: () => void; onReissue: () => void; hist: { events: HwEvent[] | null; err?: string } | null; onHist: () => void;
  quizMax: number | null; onManualSaved: () => void; onMark: (how: ManualHow) => void; onClearMark: () => void;
}) {
  const away = s.member_status && s.member_status !== "active";
  const quiz = s.kind === "quiz";
  const submitted = s.quiz?.state === "submitted";
  const canManual = !archived && s.status !== "revoked" && !submitted && (s.status !== "completed" || !!s.manual);
  // v2.2 · офлайн-сдача в одно касание: ученик без приложения, ещё ничего не отмечено
  const quick = canManual && !s.manual && s.status !== "completed" && s.access === "offline";
  const how = s.manual?.how ?? null;
  return <li class={`hw-st l-v b-card is-${s.status}`} data-issue={s.issue_id}>
    <div class="hw-st-head l-h l-top l-btw l-wrap">
      <span class="hw-name l-v l-g1"><b>{s.display_name}</b>{away && <small>{s.member_status === "left" ? "вышел(ла) из класса" : "не в классе"}</small>}</span>
      <span class={`hw-badge b-pill s-${s.status}`}>{s.running && <i class="hw-live b-round" aria-hidden="true" />}{HW_STATUS[s.status]}</span>
    </div>
    <p class="hw-st-meta l-h l-wrap l-g1 f-m">
      {s.access === "offline" ? <span class="hw-access l-h l-inl l-g1 f-m f-w6 f-2 b-pill l-fix a-offline"><Icon name="book" />Без приложения</span>
        : s.seen_at ? <span class="hw-seen l-h l-inl l-g1 f-2 b-pill is-seen"><Icon name="check" />Открыл(а) {when(s.seen_at)}</span> : <span class="hw-seen l-h l-inl l-g1 f-2 b-pill"><Icon name="clock" />Ещё не открывал(а)</span>}
      {quiz && submitted && <span class="hw-score l-h l-inl l-g1 b-pill"><b class="num f-a">{s.quiz!.score}/{s.quiz!.max_score}</b> {plural(s.quiz!.max_score, "балл", "балла", "баллов")}{s.quiz!.late ? " · после срока" : ""}{s.quiz!.overtime ? " · дольше лимита" : ""}</span>}
      {quiz && s.quiz?.state === "started" && <span class="hw-score l-h l-inl l-g1 b-pill"><Icon name="play" />Проходит опрос</span>}
      {s.manual && <span class="hw-score l-h l-inl l-g1 b-pill is-manual"><Icon name={how === "oral" ? "hand" : how === "paper" ? "pen" : "book"} />{how ? HOW_LABEL[how] : "Отмечено"}{s.manual.score != null ? ` · ${s.manual.score}/${s.manual.max_score}` : ""} · внесено учителем{s.manual.note ? ` · ${s.manual.note}` : ""}</span>}
    </p>
    {!quiz && <dl class="hw-st-time l-c3 l-g1">
      <div><dt>По таймеру</dt><dd class="num f-w6">{fmtDur(s.timer_sec)}</dd></div>
      <div><dt>Подтверждено</dt><dd class="num f-w6">{fmtDur(s.confirmed_sec)}</dd></div>
      <div><dt>{s.wall_sec != null ? "От старта до сдачи" : "Подходов"}</dt><dd class="num f-w6">{s.wall_sec != null ? fmtDur(s.wall_sec) : s.segments}</dd></div>
    </dl>}
    {quiz && s.wall_sec != null && <p class="hint-text">От старта до сдачи: <span class="num">{fmtDur(s.wall_sec)}</span></p>}
    {(s.delayed_events > 0 || (s.status === "completed" && s.snapshot_revision < latest)) && <p class="hw-st-note f-m">
      {s.delayed_events > 0 && `${s.delayed_events} ${plural(s.delayed_events, "событие пришло", "события пришли", "событий пришли")} с задержкой (не было связи). `}
      {s.status === "completed" && s.snapshot_revision < latest && `Сдано по версии ${s.snapshot_revision} — до вашего изменения.`}
    </p>}
    {ask === `mr:${s.issue_id}` ? <ManualEntry row={s} quizMax={quizMax} onSaved={() => { setAsk(null); onManualSaved(); }} onCancel={() => setAsk(null)} />
      : ask === `rv:${s.issue_id}`
      ? <Confirm text="Задание пропадёт из плана ученика. Уже отработанное время и история сохранятся." yes={`Отозвать у ${s.display_name}`} busy={busy} onYes={onRevoke} onNo={() => setAsk(null)} />
      : <div class="hw-row-actions l-h l-wrap">
          {quick && <>
            <button type="button" class="btn btn-secondary btn-sm hw-mark b-tap" disabled={busy} aria-label={`Сдал устно — ${s.display_name}`} onClick={() => onMark("oral")}><Icon name="hand" />Сдал устно</button>
            <button type="button" class="btn btn-secondary btn-sm hw-mark b-tap" disabled={busy} aria-label={`На листочке — ${s.display_name}`} onClick={() => onMark("paper")}><Icon name="pen" />На листочке</button>
          </>}
          {canManual && (s.access === "offline" || s.manual || s.status !== "completed") && <button type="button" class="btn btn-ghost btn-sm" disabled={busy}
            aria-label={`${s.manual ? (s.manual.score == null ? "Добавить баллы" : "Изменить результат") : quick ? "Баллы" : "Внести результат"}: ${s.display_name}`} onClick={() => setAsk(`mr:${s.issue_id}`)}>
            <Icon name="book" />{s.manual ? (s.manual.score == null ? "Добавить баллы" : "Изменить результат") : quick ? "Баллы" : "Внести результат"}</button>}
          {!archived && s.manual && !submitted && <button type="button" class="btn btn-ghost btn-sm" disabled={busy} aria-label={`Снять отметку: ${s.display_name}`} onClick={onClearMark}>Снять отметку</button>}
          <button type="button" class="btn btn-ghost btn-sm" aria-expanded={!!hist} onClick={onHist}><Icon name="clock" />История</button>
          {!archived && OPEN.has(s.status) && <button type="button" class="btn btn-ghost btn-sm" disabled={busy} aria-label={`Отозвать задание у ${s.display_name}`} onClick={() => setAsk(`rv:${s.issue_id}`)}>Отозвать</button>}
          {!archived && s.status === "revoked" && s.member_status === "active" && <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={onReissue}>Выдать снова</button>}
        </div>}
    {hist && (hist.err ? <p class="field-err">{hist.err}</p> : !hist.events ? <div class="sk" style="height:56px" /> : <HwTimeline events={hist.events} viewer="teacher" />)}
  </li>;
}

function TemplateSheet({ id, botName, onClose, onChanged, onDuplicate }: { id: string | null; botName: string | null; onClose: () => void; onChanged: () => void; onDuplicate: (form: Form, cls: string) => void }) {
  const [d, setD] = useState<HwTemplateDetail | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [hist, setHist] = useState<Record<string, { events: HwEvent[] | null; err?: string }>>({});
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [tq, setTq] = useState<TeacherQuiz | null>(null);
  const [projecting, setProjecting] = useState(false);     // v2.2 · «Показать классу»
  const seen = useRef<Record<string, string>>({});
  const latestD = useLatest();
  const load = (tid = id) => { const current = latestD(); return tid ? api.hw.template(tid).then((x) => {
    if (!current()) return;
    if (x.template.kind === "quiz") void api.hw.teacherQuiz(x.template.template_id).then((q) => { if (current()) setTq(q); }).catch(() => undefined);
    const before = seen.current, fresh = x.students.filter((s) => s.status === "completed" && before[s.issue_id] && before[s.issue_id] !== "completed").map((s) => s.issue_id);
    seen.current = Object.fromEntries(x.students.map((s) => [s.issue_id, s.status]));
    setD(x); setErr(null);
    if (fresh.length) requestAnimationFrame(() => fresh.forEach((i) => { const el = document.querySelector(`[data-issue="${i}"] .hw-badge`); if (el) void reward(el); }));
  }).catch((e) => { if (current()) setErr(toErr(e)); }) : Promise.resolve(); };
  const loadHist = (issue: string) => api.hw.issueDetail(issue).then((x) => setHist((h) => (h[issue] ? { ...h, [issue]: { events: x.events } } : h)))
    .catch((e) => setHist((h) => (h[issue] ? { ...h, [issue]: { events: null, err: toErr(e).m } } : h)));
  useEffect(() => { seen.current = {}; setD(null); setTq(null); setErr(null); setAsk(null); setEdit(null); setNote(""); setHist({}); setPick(new Set()); setProjecting(false); if (id) void load(id); }, [id]);
  useEffect(() => {                                    // live view: students start/pause/finish while the teacher watches
    if (!id) return;
    const t = window.setInterval(() => { if (!document.hidden && !edit && !(ask ?? "").startsWith("mr:")) { void load(id); Object.keys(hist).forEach((k) => void loadHist(k)); } }, projecting ? 5_000 : 15_000);
    return () => clearInterval(t);
  }, [id, !!edit, ask, Object.keys(hist).join(), projecting]);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true); setNote("");
    try { await f(); toast(ok, "ok"); setAsk(null); await load(); Object.keys(hist).forEach((k) => void loadHist(k)); onChanged(); }
    catch (e) { const x = toErr(e); setNote(x.m); await load(); }
    finally { setBusy(false); }
  };
  // v2.2 · отметка в одно касание: сразу на сервер, в тосте — «Отменить» (снимает отметку, история хранит оба шага)
  const clearMark = async (s: HwIssueRow, undo = false) => {
    try {
      await once.run(fp("manualClear", s.issue_id), (op) => api.hw.manualClear(s.issue_id, op));
      toast(undo ? `Отменено: ${s.display_name}` : `Отметка снята: ${s.display_name}`, "ok");
    } catch (e) { toast(toErr(e).m, "warn"); }
    await load(); onChanged();
  };
  const mark = async (s: HwIssueRow, how: ManualHow) => {
    if (busy) return;
    setBusy(true); setNote("");
    try {
      await once.run(fp("manual", s.issue_id, null, null, "", how), (op) => api.hw.manual(s.issue_id, { score: null, max_score: null, note: "", how }, op));
      toast(`${s.display_name}: ${HOW_SHORT[how]} — отмечено`, "ok", { label: "Отменить", run: () => void clearMark(s, true) });
      await load(); onChanged();
    } catch (e) { setNote(toErr(e).m); await load(); }
    finally { setBusy(false); }
  };
  const t = d?.template;
  const archived = !!t?.archived_at;
  const toggleHist = (issue: string) => setHist((h) => { if (h[issue]) { const n = { ...h }; delete n[issue]; return n; } void loadHist(issue); return { ...h, [issue]: { events: null } }; });
  const save = async () => {
    if (!t || !edit) return;
    const e = validateAssignment({ title: edit.title, instructions: edit.instructions, planned_minutes: edit.planned_minutes, due_date: edit.due_date || null }, schoolDay());
    if (e.due_date && edit.due_date === (t.due_date ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(edit.due_date)) delete e.due_date;   // an unchanged past due date stays allowed
    setErrs(e);
    if (Object.keys(e).length) return;
    const next = { title: edit.title.trim(), instructions: edit.instructions.trim(), type: edit.type, planned_minutes: edit.planned_minutes, due_date: edit.due_date || null };
    const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => (t as unknown as Record<string, unknown>)[k] !== v));
    if (!Object.keys(diff).length) { setEdit(null); toast("Ничего не изменилось", "info"); return; }
    if (busy) return;
    setBusy(true); setNote("");
    try {
      const body = { expected_revision: t.revision, ...diff };
      const r = await once.run(fp("update", t.template_id, body), (op) => api.hw.update(t.template_id, body, op));
      toast(r.updated_issues ? `Изменено. Обновлено у ${students(r.updated_issues)}; сданные работы не меняются` : "Изменено", "ok");
      await load(); setEdit(null); onChanged();             // the form closes onto the saved version, never onto the old one
    } catch (x) {
      if (x instanceof ApiError && x.status === 409) { setNote("Задание уже изменили в другой вкладке или на другом устройстве. Показана актуальная версия — проверьте и сохраните ещё раз."); setEdit(null); await load(); }
      else setNote(toErr(x).m);
    } finally { setBusy(false); }
  };
  const freeIds = d ? d.not_issued.map((m) => m.roster_id) : [];
  // Опрос копируется вместе с вопросами — это отдельный сценарий; дублируем обычные задания (в т.ч. из архива).
  const duplicate = t && t.kind !== "quiz" ? <button type="button" class="btn btn-secondary" disabled={busy} aria-label={`Дублировать задание «${t.title}»`}
    onClick={() => onDuplicate({ subject: t.subject, title: t.title, instructions: t.instructions, type: t.type, planned_minutes: t.planned_minutes, due_date: "" }, t.class)}><Icon name="plus" />Дублировать</button> : null;
  return <Sheet open={!!id} onClose={onClose} eyebrow={t ? `${t.class} · ${t.subject}${archived ? " · архив" : ""}` : "Задание"} title={t?.title ?? "Задание"}
    footer={t && !archived && !edit ? (ask === "archive"
      ? <Confirm text={`Открытые выдачи (${t.counts.assigned + t.counts.in_progress + t.counts.paused}) будут отозваны. Сданные работы и вся история сохранятся.`} yes="Перенести в архив" busy={busy}
          onYes={() => void act(() => once.run(fp("archive", t.template_id), (op) => api.hw.archive(t.template_id, op)), "Задание в архиве. История сохранена")} onNo={() => setAsk(null)} />
      : <div class="hw-row-actions l-h l-wrap hw-sheet-actions l-w100"><button type="button" class="btn btn-secondary" disabled={busy} onClick={() => { setErrs({}); setEdit({ subject: t.subject, title: t.title, instructions: t.instructions, type: t.type, planned_minutes: t.planned_minutes, due_date: t.due_date ?? "" }); }}>Изменить</button>{duplicate}<button type="button" class="btn btn-ghost" disabled={busy} onClick={() => setAsk("archive")}>В архив</button></div>)
      : edit ? <div class="hw-row-actions l-h l-wrap hw-sheet-actions l-w100"><button type="button" class="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Сохраняем…" : "Сохранить"}</button><button type="button" class="btn btn-ghost" disabled={busy} onClick={() => { setEdit(null); setErrs({}); }}>Отмена</button></div>
      : archived && duplicate ? <div class="hw-row-actions l-h l-wrap hw-sheet-actions l-w100">{duplicate}</div> : undefined}>
    {err ? <Problem err={err} onRetry={() => void load()} /> : !d || !t ? <div class="hw-detail l-v"><div class="sk" style="height:72px" /><div class="sk" style="height:140px;margin-top:12px" /></div> : <div class="hw-detail l-v">
      {note && <div class="note warn" role="alert"><Icon name="alert" /><div>{note}</div></div>}
      {edit ? <form class="hw-form l-v l-g3" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <Fields f={edit} set={(p) => { setEdit((x) => (x ? { ...x, ...p } : x)); setErrs((e) => clearErrs(e, p)); }} errs={errs} subjects={null} quiz={t.kind === "quiz"} />
          <p class="hint-text">Изменение получат ученики, которые ещё не сдали работу. У сданных остаётся та версия, по которой они работали.</p>
        </form>
        : <>
          {t.kind === "quiz" && t.quiz ? <dl class="hw-facts l-fit">
            <div><dt>Вопросов</dt><dd class="num f-w6">{t.quiz.count}</dd></div>
            <div><dt>Максимум</dt><dd class="num f-w6">{t.quiz.max_score} б.</dd></div>
            <div><dt>Время</dt><dd class="num f-w6">{t.quiz.time_limit_min ? `${t.quiz.time_limit_min} мин` : "без лимита"}</dd></div>
            <div><dt>Составлен</dt><dd class="f-w6">{t.quiz.origin === "ai" ? "ИИ, проверен учителем" : t.quiz.origin === "ai_edited" ? "ИИ + правки учителя" : t.quiz.origin === "bank" ? "встроенный банк, проверен учителем" : "вручную"}</dd></div>
          </dl> : <dl class="hw-facts l-fit">
            <div><dt>Тип</dt><dd class="f-w6">{HW_TYPE[t.type]}</dd></div>
            <div><dt>План</dt><dd class="num f-w6">{t.planned_minutes} мин</dd></div>
            <div><dt>Срок</dt><dd class="f-w6">{dueText(t.due_date)}</dd></div>
            <div><dt>Версия</dt><dd class="num f-w6">{t.revision}</dd></div>
          </dl>}
          {t.instructions && <p class="hw-instructions f-b f-2 u-acc-s p-3">{t.instructions}</p>}
          <p class="hw-summary l-v l-g1 f-b mt-1"><b>{countsLine(t.counts)}</b><Bar c={t.counts} /></p>
          {t.kind === "quiz" && !archived && d.students.length > 0 && <div class="hw-row-actions l-h l-wrap qz-class-actions mt-3 mb-1">
            <button type="button" class="btn btn-primary btn-sm" onClick={() => setProjecting(true)}><Icon name="screen" />Показать классу</button>
            <span class="hint-text">QR-код и код из 6 цифр на весь экран — для проектора или доски.</span>
          </div>}
          {tq && <QuizStatsPanel d={tq} />}
          <PaperCopy t={t} quiz={tq?.quiz ?? null} />
        </>}
      {(() => {
        const row = (s: HwIssueRow) => <StudentRow key={s.issue_id} s={s} archived={archived} latest={t.revision} busy={busy} ask={ask} setAsk={setAsk}
          onRevoke={() => void act(() => once.run(fp("revoke", s.issue_id), (op) => api.hw.revoke(s.issue_id, op)), `Отозвано у ${s.display_name}`)}
          onReissue={() => void act(() => once.run(fp("issue", t.template_id, [s.roster_id]), (op) => api.hw.issue(t.template_id, [s.roster_id], op)), `Выдано снова: ${s.display_name}`)}
          hist={hist[s.issue_id] ?? null} onHist={() => toggleHist(s.issue_id)}
          quizMax={t.kind === "quiz" ? t.quiz?.max_score ?? null : null} onManualSaved={() => { void load(); onChanged(); }}
          onMark={(how) => void mark(s, how)} onClearMark={() => void clearMark(s)} />;
        const inApp = d.students.filter((s) => s.access !== "offline"), offline = d.students.filter((s) => s.access === "offline");
        if (d.students.length === 0) return <><h3 class="hw-h3 f-b f-w6 mt-4 mb-2">Ученики · 0</h3><p class="muted">Это задание ещё никому не выдано.</p></>;
        return <>
          <div class="hw-students-head l-h l-btw l-wrap mt-4">
            <h3 class="hw-h3 f-b f-w6 mt-4 mb-2">{offline.length ? `В СферумФокус · ${inApp.length}` : `Ученики · ${d.students.length}`}</h3>
            <JournalCopy rows={d.students} />
          </div>
          {inApp.length > 0 ? <ul class="hw-students l-v">{inApp.map(row)}</ul> : <p class="muted">Ученики с приложением этот опрос не получали.</p>}
          {offline.length > 0 && <>
            <h3 class="hw-h3 f-b f-w6 mt-4 mb-2 hw-h3-offline">Офлайн-сдача · {offline.length}</h3>
            <p class="hint-text">Ученики без приложения. Отметьте одним касанием, как сдана работа; баллы можно добавить позже. Ошиблись — «Отменить» во всплывающем сообщении или «Снять отметку».</p>
            <ul class="hw-students l-v is-offline">{offline.map(row)}</ul>
          </>}
        </>;
      })()}
      {!archived && d.not_issued.length > 0 && <div class="hw-more l-v mt-2">
        <Picker members={d.not_issued} picked={pick} setPicked={setPick} legend={`Ещё не выдано · ${d.not_issued.length}`} />
        <button type="button" class="btn btn-secondary btn-sm" disabled={busy || !freeIds.some((x) => pick.has(x))}
          onClick={() => { const ids = freeIds.filter((x) => pick.has(x)).sort(); void act(() => once.run(fp("issue", t.template_id, ids), (op) => api.hw.issue(t.template_id, ids, op)), `Выдано: ${students(ids.length)}`).then(() => setPick(new Set())); }}>
          Выдать · {freeIds.filter((x) => pick.has(x)).length}</button>
        <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => once.run(fp("issueClass", t.template_id, freeIds.slice().sort()), (op) => api.hw.issueClass(t.template_id, op)), `Выдано всему классу: ${students(freeIds.length)}`)}>
          <Icon name="users" />Выдать всем остальным · {freeIds.length}</button>
      </div>}
      <p class="faint tm-small f-m hw-updated mt-2">Обновлено {when(d.server_now)} · обновляется само каждые {projecting ? 5 : 15} секунд, пока карточка открыта.</p>
      {t.kind === "quiz" && createPortal(<ProjectorSheet open={projecting} onClose={() => setProjecting(false)} t={t} tq={tq} rows={d.students} botName={botName} />, document.body)}
    </div>}
  </Sheet>;
}

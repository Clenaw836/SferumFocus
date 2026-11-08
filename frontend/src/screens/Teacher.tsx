/**
 * v17 Teacher Intelligence — режим учителя.
 *  • кто я: профиль из справочника школы (боевой) или выбранный DEMO-учитель (демо-панель);
 *  • «Сегодня»: ближайший урок + «Подготовиться», честные состояния источника, импорт изменений
 *    (Загрузка → Распознавание → Проверка → Подтверждение → Применение), предложения для чужих уроков;
 *  • «Классы»: только назначения с правом view_stats; мини-проверка, сортировка «Сначала лучшие | По алфавиту»;
 *    «Карта ДЗ» — прежняя тепловая карта (данные приложения ученика);
 *  • «Материалы»: свои + официальные источники (с условиями использования).
 * Факты, статистика и рекомендации разделены; у каждой рекомендации — основание. ИИ здесь не вызывается.
 * В явном offline DEMO — read-only адаптер того же контракта; в school сбой не подменяется синтетикой.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ComponentChildren } from "preact";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";
import { api, ApiError, fileToBase64, getDemoTeacher, setDemoTeacher } from "../lib/api";
import { nowDate } from "../lib/clock";
import { schoolDay } from "../lib/day";
import { getPerformanceSeverity } from "../lib/performance";
import { errorPct, nextWorkday, planBalance, RES_ORDER_LABEL, sortResults, wasText, type ResOrder } from "../lib/teacherSort";
import type { TmDay, TmDirectory, TmJournal, TmLesson, TmMaterials, TmPlan, TmPrep, TmPreview, TmProfile, TmProposal, TmResults, TmRow, TmStage } from "../lib/teacherTypes";
import { plural } from "../lib/time";
import { roleContext } from "../lib/roleContext";
import { classesSection, teacherHash, teacherTab, type ClassesSection, type TeacherTab } from "../lib/classAnalytics";
import { routeOf, withLaunch } from "../lib/max";
import { TeacherAssignments } from "./TeacherAssignments";
import { inSandbox } from "../lib/sandbox";
import { AccountSettings, ExternalAiNotice } from "../ui/ProfileSettings";
import { ProfileHub, type ProfileView } from "../ui/ProfileHub";
import { ClassAnalytics } from "./ClassAnalytics";
import { transition } from "../lib/motion";
import { LegacyTeacher } from "./TeacherLegacy";
import { TeacherInvite } from "./TeacherInvite";
type Err = {
    m: string;
    s: number;
};
const toErr = (e: unknown): Err => (e instanceof ApiError ? { m: e.message, s: e.status } : { m: "Не загрузилось", s: 0 });
const hhmm = () => { const d = nowDate(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const SCENARIOS: {
    v: string;
    l: string;
}[] = [
    { v: "normal", l: "Обычный день" }, { v: "not_loaded", l: "Расписание не загружено" },
    { v: "stale", l: "Данные устарели" }, { v: "unavailable", l: "Источник недоступен" },
];
const SOURCE_LABEL: Record<string, string> = { demo: "демо", import: "импорт", personal: "моё изменение", shared: "утверждено школой", school: "школа" };
const CONF_LABEL: Record<string, string> = { demo: "демо", confirmed: "подтверждено", unconfirmed: "не подтверждено", pending: "ждёт подтверждения" };
function ErrBox({ err, onRetry }: {
    err: Err;
    onRetry: () => void;
}) {
    return <div class="empty"><Icon name={err.s === 403 ? "lock" : "wifiOff"}/><h3>{err.s === 403 ? "Нет доступа" : "Не загрузилось"}</h3><p class="f-2">{err.m}</p>
    <button class="btn btn-secondary btn-sm" onClick={onRetry}>Повторить</button></div>;
}
// ------------------------------------------------------------------ демо-панель
function DemoPanel({ dir, teacher, onTeacher, date, onDate, scenario, onScenario, fixed = false }: {
    fixed?: boolean;
    dir: TmDirectory;
    teacher: string;
    onTeacher: (id: string) => void;
    date: string;
    onDate: (d: string) => void;
    scenario: string;
    onScenario: (s: string) => void;
}) {
    const cur = dir.teachers.find((t) => t.id === teacher);
    const [school, setSchool] = useState(cur?.school_id ?? dir.schools[0]?.id ?? "");
    const list = dir.teachers.filter((t) => t.school_id === school);
    return (<details class="tm-demo b-card mb-4">
      <summary><Icon name="user"/><span class="tm-demo-s f-b f-2">Демо-панель · {cur ? cur.full_name : "Выберите учителя"} · <span class="num">{date}</span></span><Icon name="chevron"/></summary>
      <p class="faint tm-small f-m">Синтетические школы и учителя. Реальные данные сюда не попадают и хранятся отдельно.</p>
      <div class="tm-grid2 l-fit l-g3 mt-3">
        {!fixed && <><label class="field"><span class="field-label">Школа</span>
          <select class="input" value={school} onChange={(e) => { const s = (e.target as HTMLSelectElement).value; setSchool(s); const f = dir.teachers.find((t) => t.school_id === s); if (f)
        onTeacher(f.id); }}>
            {dir.schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <label class="field"><span class="field-label">Учитель</span>
          <select class="input" value={teacher} onChange={(e) => onTeacher((e.target as HTMLSelectElement).value)}>
            {list.map((t) => <option key={t.id} value={t.id}>{t.full_name}{t.role_note ? ` (${t.role_note})` : ""}</option>)}
          </select></label></>}
        <label class="field"><span class="field-label">Дата</span><input class="input" type="date" value={date} onChange={(e) => onDate((e.target as HTMLInputElement).value)}/></label>
        <label class="field"><span class="field-label">Сценарий</span>
          <select class="input" value={scenario} onChange={(e) => onScenario((e.target as HTMLSelectElement).value)}>
            {SCENARIOS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
          </select></label>
      </div>
    </details>);
}
// ------------------------------------------------------------------ «Сегодня»
function LessonRow({ l, onPrep, onClass, next }: {
    next: boolean;
    l: TmLesson;
    onPrep: (l: TmLesson) => void;
    onClass: (l: TmLesson) => void;
}) {
    const off = l.status === "cancelled";
    return (<li class={`tm-lesson p-4 l-a1 l-g3 b-sep${off ? " off" : ""}${next ? " is-next" : ""}`}>
      <span class="tm-l-time l-v l-g1 f-m f-a f-num num"><b>{l.start || "Нет данных"}</b><span>{l.end || "Нет данных"}</span></span>
      <div class="tm-l-body">
        <div class="tm-l-title l-h l-wrap l-g1 f-s"><span class="tm-l-subject f-s">{l.subject || "Нет данных о предмете"}</span> {l.class && l.subject ? <button class="teacher-class-link l-h l-inl l-jc l-g0 f-m b-tile mw-44" onClick={() => onClass(l)} aria-haspopup="dialog" aria-label={`Аналитика ${l.class}, ${l.subject}`}>{l.class}</button> : "Нет данных о классе"}{l.group ? ` · ${l.group}` : ""}</div>
        <div class="tm-l-meta f-c f-3 mt-1">{next && <span class="teacher-next-label f-a">Ближайший · </span>}{l.n}-й · {l.room ?? "кабинет не указан"} · {SOURCE_LABEL[l.source] ?? l.source} · {CONF_LABEL[l.confirmation] ?? l.confirmation}</div>
        {l.topic && <div class="tm-l-meta f-c f-3 mt-1">Тема: {l.topic}</div>}
        {off && <div class="tm-l-meta f-c f-3 mt-1 c-bad">Отменён</div>}
        {wasText(l.was, l as never) && <div class="tm-l-meta f-c f-3 mt-1 c-warn">Было: {wasText(l.was, l as never)}</div>}
        {l.notes.map((n) => <div key={n} class="tm-l-meta f-c f-3 mt-1">{n}</div>)}
      </div>
      {!off && <button class="btn btn-secondary btn-sm tm-l-btn f-m b-tap mt-2 as-c" title={`Подготовиться: ${l.subject || "предмет неизвестен"}, ${l.class || "класс неизвестен"}`} disabled={!l.subject || !l.class} onClick={() => onPrep(l)} aria-label={`Подготовиться: ${l.n}-й урок, ${l.subject || "предмет неизвестен"}, ${l.class || "класс неизвестен"}`}><Icon name="book"/><span>Подготовиться</span></button>}
    </li>);
}
const STATE_NOTE: Record<string, {
    tone: "warn" | "bad" | "";
    icon: string;
    title: string;
    text: string;
}> = {
    not_loaded: { tone: "warn", icon: "calendar", title: "Расписание не загружено", text: "Загрузите его текстом или фото — перед применением покажем, что изменится." },
    stale: { tone: "warn", icon: "clock", title: "Данные могли устареть", text: "Последняя синхронизация давно. Проверьте изменения или загрузите свежие." },
    unavailable: { tone: "bad", icon: "wifiOff", title: "Источник расписания недоступен", text: "Ничего не выдумываем: уроков не показываем. Повторите позже или загрузите изменения вручную." },
    partial: { tone: "warn", icon: "info", title: "Расписание неполное", text: "Часть уроков без времени или кабинета — проверьте импорт." },
    pending_import: { tone: "warn", icon: "info", title: "Есть изменения на подтверждении", text: "Изменения для уроков других учителей ждут решения завуча." },
    conflict: { tone: "bad", icon: "alert", title: "Пересечение уроков", text: "Два урока в одно время. Проверьте импорт и при необходимости откатите его." },
};
function TodayView({ date, scenario, profile, onClass, onPrep, onImport, onDate, reloadKey, names }: {
    names: Record<string, string>;
    onClass: (l: TmLesson) => void;
    date: string;
    scenario: string;
    profile: TmProfile;
    onPrep: (l: TmLesson) => void;
    onImport: () => void;
    onDate: (d: string) => void;
    reloadKey: number;
}) {
    const [day, setDay] = useState<TmDay | null>(null);
    const [err, setErr] = useState<Err | null>(null);
    const [props, setProps] = useState<TmProposal[]>([]);
    const generation = useRef(0);
    const load = () => {
        const token = ++generation.current;
        setErr(null);
        setDay(null);
        api.tm.today(date, date === schoolDay() ? hhmm() : null, scenario).then(d => { if (token === generation.current)
            setDay(d); }).catch((e) => { if (token === generation.current)
            setErr(toErr(e)); });
        if (profile.can_approve)
            api.tm.proposals().then((p) => token === generation.current && setProps(p.items.filter((x) => x.status === "pending"))).catch(() => { if (token === generation.current)
                setProps([]); });
    };
    useEffect(() => { load(); return () => { generation.current++; }; }, [date, scenario, profile.id, reloadKey]);
    const decide = (id: string, approve: boolean) => api.tm.decide(id, approve)
        .then(() => { toast(approve ? "Изменение утверждено — видно всем затронутым" : "Предложение отклонено", approve ? "ok" : "info"); load(); })
        .catch((e) => toast(toErr(e).m, "bad"));
    if (err)
        return <ErrBox err={err} onRetry={load}/>;
    if (!day || day.date !== date)
        return <div class="tm-sk">{[0, 1, 2].map((i) => <div key={i} class="sk" style="height:64px;margin-top:12px"/>)}</div>;
    const note = STATE_NOTE[day.state];
    const active = day.lessons.filter((l) => l.status === "active");
    return (<div class="tm-today">
      {day.next && (<div class="tm-next b-card mb-6"><div class="teacher-next-content">
          <div class="eyebrow">Ближайший урок</div>
          <div class="tm-next-time f-xl mt-3 mb-3 num">{day.next.start || "Нет данных"}<span class="f-2">–{day.next.end || "Нет данных"}</span></div>
          <div class="tm-next-t l-h l-wrap f-h mt-1 mb-2">{day.next.subject || "Нет данных о предмете"}<span class="tm-next-class l-h l-inl l-g0 f-s b-tile">{day.next.class || "Нет данных о классе"}</span></div>
          <div class="tm-next-m f-b f-2 mt-1 num">{day.next.n}-й урок · {day.next.room ?? "кабинет не указан"} · {day.next.duration_min} мин</div>
          </div><div class="teacher-next-actions l-h l-wrap mt-4"><p class="f-2">Подготовка к ближайшему уроку</p><button class="btn btn-primary tm-next-b mt-4 l-w100" onClick={() => onPrep(day.next!)}><Icon name="book"/>Подготовиться</button>
          {day.next.class && day.next.subject && <button class="btn btn-quiet teacher-analytics-link l-h l-jc mt-2 l-w100" onClick={() => onClass(day.next!)} aria-haspopup="dialog"><Icon name="chart"/><span>Результаты · {day.next.class}</span><Icon name="chevron"/></button>}
        </div></div>)}
      {note && (<div class={`note ${note.tone}`} role="status"><Icon name={note.icon as never}/><div><b>{note.title}.</b> {note.text}
          {day.meta.last_sync_at && <div class="faint tm-small f-m">Последняя синхронизация: {day.meta.last_sync_at.replace("T", " ")}</div>}
          {day.conflicts.map((c) => <div key={c.join()} class="tm-small f-m">Пересекаются: {c.join(" и ")}</div>)}
          <div class="tm-actions l-h l-wrap mt-3"><button class="btn btn-secondary btn-sm" onClick={onImport}>Загрузить расписание</button><button class="btn btn-ghost btn-sm" onClick={load}>Обновить</button></div>
        </div></div>)}
      {day.state === "no_lessons" && <div class="empty"><Icon name="sun"/><h3>Уроков нет</h3><p class="f-2">На {day.date} в расписании нет ваших уроков.</p>
        <button class="btn btn-secondary btn-sm" onClick={() => onDate(nextWorkday(day.date))}>Следующий учебный день</button></div>}
      {day.changes.length > 0 && <div class="note"><Icon name="info"/><div><b>Изменения:</b> {day.changes.join("; ")}</div></div>}
      {day.lessons.length > 0 && (<>
          <h2 class="tm-h f-s mt-4 mb-2 teacher-schedule-heading l-h mt-6"><Icon name="calendar"/>Мои уроки · <span class="num">{active.length}</span></h2>
          <ol class="tm-lessons b-box" aria-label={`Уроки на ${day.date}`}>{day.lessons.map((l) => <LessonRow key={l.id} l={l} next={l.id === day.next?.id} onPrep={onPrep} onClass={onClass}/>)}</ol>
        </>)}
      <p class="faint tm-small f-m">Источник: {day.meta.source_label}{day.is_demo ? " · данные синтетические" : ""}</p>
      {!note && <button class="btn btn-ghost btn-sm" onClick={onImport}><Icon name="plus"/>Импорт изменений</button>}

      {profile.can_approve && (<section class="tm-props" aria-labelledby="tm-props-h">
          <h2 class="tm-h f-s mt-4 mb-2" id="tm-props-h">На утверждение · <span class="num">{props.length}</span></h2>
          {props.length === 0 ? <p class="faint tm-small f-m">Предложений нет.</p> : props.map((p) => (<div class="tm-prop b-card mt-3" key={p.id}>
              <div class="tm-small f-m faint">От {names[p.by] ?? p.by} · {p.at.replace("T", " ").slice(0, 16)} · {p.official ? "официальный документ" : "неофициальный источник"}</div>
              <ul>{p.changes.map((c, i) => <li key={i}>{c.kind_label}: {c.date} {c.n}-й {c.start}–{c.end} {c.class} {c.subject}{c.room ? ` · ${c.room}` : ""}</li>)}</ul>
              <div class="tm-small f-m">Затронуты: классы {p.affected_classes.join(", ")}</div>
              <div class="tm-actions l-h l-wrap mt-3"><button class="btn btn-primary btn-sm" onClick={() => decide(p.id, true)}>Утвердить</button><button class="btn btn-secondary btn-sm" onClick={() => decide(p.id, false)}>Отклонить</button></div>
            </div>))}
        </section>)}
    </div>);
}
// ------------------------------------------------------------------ импорт
const EFFECT: Record<string, string> = { new: "Новый урок", changed: "Изменение", cancelled: "Отмена", same: "Без изменений", nothing_to_cancel: "Нечего отменять" };
const OWNER: Record<string, string> = { me: "мой урок", other: "урок другого учителя → предложение завучу", ambiguous: "учитель неоднозначен", unknown_teacher: "учитель не найден", unconfirmed: "учитель не указан" };
function ImportSheet({ open, date, onClose, onApplied }: {
    open: boolean;
    date: string;
    onClose: () => void;
    onApplied: () => void;
}) {
    const [text, setText] = useState("");
    const [kind, setKind] = useState<"text" | "image">("text");
    const [leg, setLeg] = useState(1);
    const [pv, setPv] = useState<TmPreview | null>(null);
    const [acc, setAcc] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [jr, setJr] = useState<TmJournal[]>([]);
    const loadJ = () => api.tm.journal().then((j) => setJr(j.entries)).catch(() => setJr([]));
    useEffect(() => { if (open) {
        setPv(null);
        loadJ();
    } }, [open]);
    const photo = async (f: File | undefined) => {
        if (!f)
            return;
        setBusy(true);
        try {
            const { base64, mime } = await fileToBase64(f);
            const r = await api.readEvidence("photo", base64, mime, "расписание учителя");
            setText(r.text);
            setKind("image");
            setLeg(r.legibility);
            toast("Текст распознан — проверьте его перед разбором", "info");
        }
        catch (e) {
            toast(toErr(e).m, "bad");
        }
        finally {
            setBusy(false);
        }
    };
    const preview = () => {
        setBusy(true);
        api.tm.preview(date, text, kind, leg)
            .then((p) => { setPv(p); setAcc(new Set(p.rows.filter((r) => r.applicable && r.confidence >= 0.6).map((r) => r.id))); })
            .catch((e) => toast(toErr(e).m, "bad")).finally(() => setBusy(false));
    };
    const confirm = () => {
        if (!pv)
            return;
        setBusy(true);
        api.tm.confirm(pv.token, [...acc])
            .then((r) => {
            if (!r.ok) {
                toast(r.error ?? "Не применилось", "bad");
                return;
            }
            const a = r.applied?.length ?? 0, p = r.proposed?.length ?? 0;
            toast(r.repeat ? "Этот импорт уже применён" : `Применено: ${a}${p ? ` · отправлено на утверждение: ${p}` : ""}`, "ok");
            setPv(null);
            setText("");
            loadJ();
            onApplied();
        }).catch((e) => toast(toErr(e).m, "bad")).finally(() => setBusy(false));
    };
    const revert = (id: string) => api.tm.revert(id).then(() => { toast("Импорт откатан", "ok"); loadJ(); onApplied(); }).catch((e) => toast(toErr(e).m, "bad"));
    const toggle = (id: string) => setAcc((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    return (<Sheet open={open} onClose={onClose} eyebrow="Импорт · ничего не меняется до подтверждения" title="Изменения расписания" full>
      <ol class="tm-steps l-h l-wrap l-g1 f-m f-3 mb-4" aria-label="Шаги импорта">
        {["Загрузка", "Распознавание", "Проверка", "Подтверждение", "Применение"].map((s, i) => <li key={s} class={(pv ? 3 : text ? 2 : 1) > i ? "on" : ""}>{s}</li>)}
      </ol>
      {!pv ? (<>
          <label class="field"><span class="field-label">Текст расписания или изменений</span>
            <textarea class="textarea" rows={6} value={text} onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); if (kind === "image")
            setKind("image"); }} placeholder={`${date} 3 10:25-11:10 8А Алгебра каб. 21 Орлова Е.В.\n${date} 5 12:20-13:05 9А Физика отмена`}/></label>
          <p class="faint tm-small f-m">Одна строка — один урок: дата, номер, время, класс, предмет, кабинет, учитель, «замена»/«отмена». Нераспознанное покажем отдельно — угадывать не будем.</p>
          <div class="tm-actions l-h l-wrap mt-3">
            <label class="btn btn-secondary btn-sm"><Icon name="camera"/>Фото<input type="file" accept="image/*" class="sr" onChange={(e) => photo((e.target as HTMLInputElement).files?.[0])}/></label>
            <button class="btn btn-primary btn-sm" disabled={!text.trim() || busy} onClick={preview}>Проверить</button>
          </div>
          {kind === "image" && <p class="tm-small f-m c-warn">Распознано с фото (читаемость {Math.round(leg * 100)} %) — неофициальный источник: чужие уроки уйдут на утверждение.</p>}
        </>) : (<div class="tm-pv">
          {pv.duplicate_of && <div class="note warn"><Icon name="info"/><div>Такой же файл уже применялся {pv.duplicate_of.at.replace("T", " ").slice(0, 16)}. Повторное применение ничего не изменит.</div></div>}
          {pv.conflicts.length > 0 && <div class="note bad"><Icon name="alert"/><div>{pv.conflicts.join("; ")}</div></div>}
          {pv.unrecognized.length > 0 && <div class="note"><Icon name="info"/><div><b>Не распознано:</b> {pv.unrecognized.map((id) => pv.rows.find((r) => r.id === id)?.raw ?? id).join(" · ")}</div></div>}
          <p class="tm-small f-m faint">{pv.note}</p>
          <ul class="tm-pv-rows mt-3">
            {pv.rows.map((r) => {
                const low = r.confidence < 0.6;
                return (<li key={r.id} class={`tm-pv-row py-3 f-b b-sep e-${r.effect}${r.applicable ? "" : " blocked"}`}>
                  <label>
                    <input type="checkbox" checked={acc.has(r.id)} disabled={!r.applicable} onChange={() => toggle(r.id)}/>
                    <span>
                      <b>{EFFECT[r.effect] ?? r.effect}</b> · {r.date ?? "дата?"} {r.n ?? "?"}-й {r.start ?? "?"}–{r.end ?? "?"} · {r.class ?? "класс?"} {r.subject ?? "предмет?"}{r.room ? ` · ${r.room}` : ""}
                      <span class="tm-small f-m faint"> · {OWNER[r.owner] ?? r.owner}{r.owner_teacher ? ` (${r.owner_teacher.full_name})` : ""}</span>
                      {wasText(r.was, r as never) && <span class="tm-small f-m c-warn"> · было: {wasText(r.was, r as never)}</span>}
                      <span class={`tm-conf l-blk f-m f-3 mt-1 num${low ? " low" : ""}`}>уверенность {Math.round(r.confidence * 100)} %{low ? " — проверьте" : ""}</span>
                      {r.conflict && <span class="tm-small f-m c-bad"> · {r.conflict}</span>}
                      {r.blocked.map((b) => <span key={b} class="tm-small f-m c-bad"> · {b}</span>)}
                      {r.owner_candidates && <span class="tm-small f-m"> · кандидаты: {r.owner_candidates.map((c) => c.full_name).join(", ")}</span>}
                    </span>
                  </label>
                </li>);
            })}
          </ul>
          <div class="tm-actions l-h l-wrap mt-3">
            <button class="btn btn-primary btn-sm" disabled={busy || acc.size === 0} onClick={confirm}>Применить выбранное · {acc.size}</button>
            <button class="btn btn-ghost btn-sm" onClick={() => setPv(null)}>Назад</button>
          </div>
        </div>)}
      <h3 class="tm-h f-s mt-4 mb-2">Журнал импорта</h3>
      {jr.length === 0 ? <p class="faint tm-small f-m">Пока пусто.</p> : (<ul class="tm-journal f-b">{jr.slice(0, 8).map((j) => (<li key={j.id}><span class="num">{j.at.replace("T", " ").slice(0, 16)}</span> · применено {j.applied.length}{j.proposed.length ? ` · на утверждении ${j.proposed.length}` : ""}
            {j.reverted ? <span class="faint"> · откатан</span> : <button class="btn btn-ghost btn-sm" onClick={() => revert(j.id)}>Откатить</button>}</li>))}</ul>)}
    </Sheet>);
}
// ------------------------------------------------------------------ подготовка к уроку
const REC_KIND: Record<string, string> = { data: "по данным класса", general: "общая рекомендация", missing: "не хватает данных" };
function PlanEditor({ lesson, initial }: {
    lesson: TmLesson;
    initial: TmPlan | null;
}) {
    const [plan, setPlan] = useState<TmPlan | null>(initial);
    const [busy, setBusy] = useState(false);
    useEffect(() => setPlan(initial), [initial, lesson.id]);
    const draft = () => { setBusy(true); api.tm.draft(lesson.id).then(setPlan).catch((e) => toast(toErr(e).m, "bad")).finally(() => setBusy(false)); };
    if (!plan)
        return <button class="btn btn-secondary btn-sm" disabled={busy} onClick={draft}>Составить черновик на {lesson.duration_min} мин</button>;
    const bal = planBalance(plan.stages, plan.duration_min);
    const set = (i: number, patch: Partial<TmStage>) => setPlan({ ...plan, status: "draft", stages: plan.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    const save = () => {
        setBusy(true);
        api.tm.savePlan({ lesson_id: lesson.id, topic: plan.topic, stages: plan.stages, adaptation: plan.adaptation })
            .then((p) => { setPlan(p); toast("План сохранён", "ok"); }).catch((e) => toast(toErr(e).m, "bad")).finally(() => setBusy(false));
    };
    return (<div class="tm-plan" data-state={plan.status}>
      <p class="tm-plan-status l-h f-b" role="status"><Icon name={plan.status === "saved" ? "check" : "book"}/>{plan.status === "saved" ? `Сохранён ${plan.saved_at?.replace("T", " ").slice(0, 16) ?? ""}` : "Черновик — проверьте и поправьте."} {plan.note ?? ""}</p>
      <p class="tm-small f-m faint">Измените минуты этапов. Для сохранения сумма должна совпасть с длительностью урока.</p>
      <ol>{plan.stages.map((s, i) => (<li key={i} class="tm-stage py-2 l-a1 l-g3 b-sep">
          <input class="input tm-min p-2 f-tc b-tap num" type="number" min={1} max={plan.duration_min} value={s.minutes} aria-label={`Минут на этап «${s.title}»`} onInput={(e) => set(i, { minutes: Math.max(0, parseInt((e.target as HTMLInputElement).value || "0", 10)) })}/>
          <div><b>{s.title}</b><div class="tm-small f-m">{s.text}</div></div>
        </li>))}</ol>
      <progress class="teacher-plan-progress f-a b-box b-nob o-h p-abs bd-0" max={plan.duration_min} value={Math.max(0, Math.min(bal.total, plan.duration_min))} aria-label={`Распределено ${bal.total} из ${plan.duration_min} минут`}/>
      <div class="teacher-plan-track b-box b-nob mt-4" aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, bal.total / plan.duration_min))})` }}/></div>
      <p class={`tm-small f-m num ${bal.ok ? "c-ok" : "c-warn"}`} role="status">Итого {bal.total} из {plan.duration_min} мин{bal.ok ? "" : bal.diff > 0 ? ` — не распределено ${bal.diff}` : ` — лишние ${-bal.diff}`}</p>
      {plan.adaptation && <p class="tm-small f-m">Адаптация: {plan.adaptation}</p>}
      <div class="tm-actions l-h l-wrap mt-3"><button class="btn btn-primary btn-sm" disabled={!bal.ok || busy} onClick={save}>Сохранить план</button><button class="btn btn-ghost btn-sm" disabled={busy} onClick={draft}>Новый черновик</button></div>
    </div>);
}
function PrepSheet({ lesson, onClose }: {
    lesson: TmLesson | null;
    onClose: () => void;
}) {
    const [last, setLast] = useState<TmLesson | null>(lesson);
    const [p, setP] = useState<TmPrep | null>(null);
    const [err, setErr] = useState<Err | null>(null);
    useEffect(() => { if (lesson) {
        setLast(lesson);
        setP(null);
        setErr(null);
        api.tm.prep(lesson.id).then(setP).catch((e) => setErr(toErr(e)));
    } }, [lesson?.id]);
    const l = lesson ?? last;
    return (<Sheet open={!!lesson} onClose={onClose} eyebrow={p?.is_demo ? "Подготовка · демо-данные" : "Подготовка к уроку"} title={l ? `${l.subject} · ${l.class}` : ""} full>
      {err && <p class="c-bad">{err.m}</p>}
      {!p && !err && <div class="sk" style="height:160px"/>}
      {p && l && (<div class="tm-prep">
          <div class="teacher-prep-context l-h f-b f-2 mt-1 mb-4"><Icon name="clock"/><span class="num">{p.lesson.start}–{p.lesson.end} · {p.lesson.duration_min} мин</span></div>
          <section class="teacher-plan-section b-card mb-6" aria-label="План урока"><div class="eyebrow">Подготовка</div><h3 class="h-title">План одного урока</h3><p class="faint tm-small f-m">Этапы, время и материалы — проверьте черновик перед сохранением.</p><PlanEditor lesson={p.lesson} initial={p.plan}/></section>
          <h3 class="tm-h f-s mt-4 mb-2">Факты</h3>
          <dl class="tm-facts l-v l-g1">{p.facts.map((f) => <div key={f.k}><dt>{f.k}</dt><dd>{f.v} <span class="faint tm-small f-m">· {f.source}</span></dd></div>)}</dl>

          <h3 class="tm-h f-s mt-4 mb-2">Статистика класса</h3>
          {p.stats ? (<div>
              <p class="tm-small f-m">{p.stats.check.title}, {p.stats.check.period} · ответили <b class="num">{p.stats.responded} из {p.stats.class_size}</b></p>
              {p.stats.insufficient ? <p class="tm-small f-m c-warn">Ответов мало — выводы о классе делать рано.</p> : (<ul class="tm-qs">{p.stats.hardest.map((q) => <li key={q.id}><span>{q.text}{q.topic ? ` · ${q.topic}` : ""}{q.topic_link_confirmed ? "" : " (связь с темой не подтверждена)"}</span><b class="num">{q.correct_pct} % верно</b></li>)}</ul>)}
              <p class="tm-small f-m faint">{p.stats.caveat}</p>
            </div>) : <p class="tm-small f-m faint">{p.stats_note ?? "Результатов нет."}</p>}

          <h3 class="tm-h f-s mt-4 mb-2">Рекомендации</h3>
          <ul class="tm-recs">{p.recommendations.map((r, i) => (<li key={i} class={`k-${r.kind}`}><span class={`tm-kind f-m f-w6 f-2 b-pill mb-1 k-${r.kind}`}>{REC_KIND[r.kind]}</span><div>{r.text}</div><div class="tm-small f-m faint">Основание: {r.basis}</div></li>))}</ul>

          {p.check_questions.length > 0 && <>
            <h3 class="tm-h f-s mt-4 mb-2">Вопросы для быстрой проверки</h3>
            <ul class="tm-plain">{p.check_questions.map((q) => <li key={q.text}>{q.text}</li>)}</ul>
          </>}

          <h3 class="tm-h f-s mt-4 mb-2">Материалы</h3>
          <Materials m={p.materials} compact/>


          <p class="tm-small f-m faint" style="margin-top:16px">{p.ai_used ? "Часть текста сгенерирована ИИ — проверьте." : "ИИ не использовался: факты из расписания, статистика из проверки, общие советы — из шаблонов по предмету."}</p>
        </div>)}
    </Sheet>);
}
// ------------------------------------------------------------------ материалы
function Materials({ m, compact }: {
    m: TmMaterials;
    compact?: boolean;
}) {
    const item = (x: TmMaterials["official"][number], own: boolean) => (<li key={x.id ?? x.title} class="resource-card l-v l-g3 l-as b-card"><div class="resource-card-heading l-h"><Icon name={own?"book":"share"}/><span class="eyebrow">{own?"МОЙ МАТЕРИАЛ":"ОФИЦИАЛЬНЫЙ ИСТОЧНИК"}</span></div><h3>{x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer">{x.title}<Icon name="chevron"/></a> : x.title}</h3><p class="tm-small f-m faint">{x.org ?? x.author}</p><details><summary>Условия и сведения</summary><p class="tm-small f-m faint">{[x.topic,x.license,x.checked_at?`проверено ${x.checked_at}`:null].filter(Boolean).join(" · ")}</p></details></li>);
    return (<div class="resource-library l-v l-g4">{m.teacher.length>0&&<section><h2 class="tm-h f-s mt-4 mb-2">Мои материалы</h2><ul class="resource-grid l-v l-g3">{m.teacher.map(x=>item(x,true))}</ul></section>}<section><h2 class="tm-h f-s mt-4 mb-2">Проверенные источники</h2><ul class="resource-grid l-v l-g3">{(compact?m.official.slice(0,3):m.official).map(x=>item(x,false))}</ul></section><p class="resource-note tm-small f-m faint">{m.note}</p></div>);
}

function MaterialsView({ profile }: {
    profile: TmProfile;
}) {
    const [m, setM] = useState<TmMaterials | null>(null);
    const [err, setErr] = useState<Err | null>(null);
    const [f, setF] = useState({ title: "", url: "", subject: profile.subjects[0] ?? "", topic: "" });
    const load = () => { setErr(null); api.tm.materials().then(setM).catch((e) => setErr(toErr(e))); };
    useEffect(load, [profile.id]);
    const add = (e: Event) => {
        e.preventDefault();
        api.tm.addMaterial(f).then(() => { toast("Материал добавлен", "ok"); setF({ ...f, title: "", url: "", topic: "" }); load(); }).catch((x) => toast(toErr(x).m, "bad"));
    };
    if (err)
        return <ErrBox err={err} onRetry={load}/>;
    if (!m)
        return <div class="sk" style="height:160px;margin-top:12px"/>;
    return (<div>
      <Materials m={m}/>
      <form class="tm-add l-v l-g3 mt-4 resource-add" onSubmit={add}>
        <h2 class="tm-h f-s mt-4 mb-2">Добавить свой материал</h2>
        <label class="field"><span class="field-label">Название</span><input class="input" required maxLength={300} value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })}/></label>
        <label class="field"><span class="field-label">Ссылка (необязательно)</span><input class="input" type="url" inputMode="url" placeholder="https://" value={f.url} onInput={(e) => setF({ ...f, url: (e.target as HTMLInputElement).value })}/></label>
        <div class="tm-grid2 l-fit l-g3 mt-3">
          <label class="field"><span class="field-label">Предмет</span><select class="input" value={f.subject} onChange={(e) => setF({ ...f, subject: (e.target as HTMLSelectElement).value })}>{profile.subjects.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label class="field"><span class="field-label">Тема</span><input class="input" value={f.topic} onInput={(e) => setF({ ...f, topic: (e.target as HTMLInputElement).value })}/></label>
        </div>
        <button class="btn btn-secondary btn-sm" type="submit" disabled={!f.title.trim()}>Добавить</button>
      </form>
    </div>);
}
// ------------------------------------------------------------------ «Классы»
function StudentQuiz({ row, res, onClose }: {
    row: TmRow | null;
    res: TmResults | null;
    onClose: () => void;
}) {
    const [last, setLast] = useState<TmRow | null>(row);
    useEffect(() => { if (row)
        setLast(row); }, [row]);
    const r = row ?? last;
    return (<Sheet open={!!row} onClose={onClose} eyebrow={res?.is_demo ? "Ученик · демо-данные" : "Ученик"} title={r?.student ?? ""}>
      {r && res && (<div class="insight">
          <p class="tm-small f-m">{res.check.title}, {res.check.period} · {res.subject}, {res.class}</p>
          <p><b class="num">{r.correct} из {r.answered}</b> верно{r.answered < res.check.questions ? ` · ответил на ${r.answered} из ${res.check.questions}` : ""}</p>
          <ul class="tm-qs">{res.questions.map((q, i) => {
                const a = r.answers[i];
                return <li key={q.id}><span>{q.text}{q.topic ? ` · ${q.topic}` : ""}</span><b class={a == null ? "faint" : a ? "c-ok" : "c-bad"}>{a == null ? "нет ответа" : a ? "верно" : "неверно"}</b></li>;
            })}</ul>
          <p class="tm-small f-m faint">{res.caveat} Это не оценка и не попадает в журнал.</p>
        </div>)}
    </Sheet>);
}
function ResultsView({ profile, onSwitchRole }: {
    profile: TmProfile;
    onSwitchRole: () => void;
}) {
    const allowed = profile.assignments.filter((a) => a.perms.view_stats);
    const denied = profile.assignments.filter((a) => !a.perms.view_stats);
    const [sel, setSel] = useState(allowed[0] ? `${allowed[0].class}|${allowed[0].subject}` : "hw");
    const [order, setOrder] = useState<ResOrder>("best");
    const [result, setRes] = useState<TmResults | null>(null);
    const [loadedFor, setLoadedFor] = useState("");
    const res = loadedFor === sel ? result : null;
    const [err, setErr] = useState<Err | null>(null);
    const [open, setOpen] = useState<TmRow | null>(null);
    const resultGeneration = useRef(0);
    const load = () => {
        const token = ++resultGeneration.current;
        if (sel === "hw")
            return;
        const [c, s] = sel.split("|");
        setErr(null);
        setRes(null);
        setOpen(null);
        api.tm.results(c, s, order).then(r => { if (token === resultGeneration.current) {
            setRes(r);
            setLoadedFor(sel);
        } }).catch((e) => { if (token === resultGeneration.current)
            setErr(toErr(e)); });
    };
    useEffect(() => { load(); return () => { resultGeneration.current++; }; }, [sel, profile.id]);
    const rows = useMemo(() => (res?.available ? sortResults(res.rows, order) : []), [res, order]);
    return (<div>
      <div class="tm-chips l-h l-wrap mb-3" role="group" aria-label="Класс и предмет">
        {allowed.map((a) => { const v = `${a.class}|${a.subject}`; return <button key={v} class={`chip${sel === v ? " on" : ""}`} aria-pressed={sel === v} onClick={() => setSel(v)}>{a.class} · {a.subject}</button>; })}
        {profile.is_demo && <button class={`chip${sel === "hw" ? " on" : ""}`} aria-pressed={sel === "hw"} onClick={() => setSel("hw")}>DEMO · Карта ДЗ</button>}
      </div>
      {denied.length > 0 && <p class="tm-small f-m faint">Без права просмотра результатов: {denied.map((a) => `${a.class} · ${a.subject}`).join(", ")}.</p>}
      {sel === "hw" ? profile.is_demo ? <LegacyTeacher onSwitchRole={onSwitchRole} embedded/> : <p>Нет доступных классов с правом просмотра результатов.</p> : err ? <ErrBox err={err} onRetry={load}/> : !res ? <div class="sk" style="height:200px;margin-top:12px"/> : !res.available ? (<div class="empty"><Icon name="chart"/><h3>Результатов нет</h3><p class="f-2">{res.reason ?? "Проверок по этому классу и предмету ещё не было."}</p></div>) : (<>
          <ClassAnalytics key={`${profile.id}|${sel}`} cls={res.class} subject={res.subject} supplied={res}/>
          <details class="roster-workbench b-card mt-4 mb-4"><summary><Icon name="users"/><span>Ответы учеников · {res.responded} из {res.class_size}</span><Icon name="chevron"/></summary><div class="tm-res-h mt-2 mb-2">
            <div><b>{res.check.title}</b><div class="tm-small f-m faint">{res.check.period} · {res.check.questions} {plural(res.check.questions, "вопрос", "вопроса", "вопросов")} · ответили <span class="num">{res.responded} из {res.class_size}</span></div></div>
          </div>
          {res.insufficient && <div class="note warn"><Icon name="info"/><div>Ответили слишком мало учеников — порядок строк ничего не говорит о классе.</div></div>}
          <div class="tm-sort mt-3 mb-3"><Segmented label="Порядок учеников" value={order} onChange={setOrder} options={[{ value: "best", label: "Сначала лучшие" }, { value: "alpha", label: "По алфавиту" }]}/></div>
          <p class="sr" role="status" aria-live="polite">Порядок: {RES_ORDER_LABEL[order]}</p>
          <div class="roster-head py-2 f-m f-w6 f-3 b-sep" aria-hidden="true"><span>Ученик</span><span>Ответы</span><span>Верно</span></div>
          <ul class="roster" aria-label={`Результаты ${res.class}, ${res.subject}`}>
            {rows.map((r, i) => {
                const e = errorPct(r), s = getPerformanceSeverity(e);
                return (<li key={r.student} style={{ "--i": i }}>
                  <button class={`roster-row b-sep t-${s.tone}`} onClick={() => setOpen(r)} aria-haspopup="dialog">
                    <span class="rr-main l-v l-g1"><span class="rr-name f-w6 f-trunc">{r.student}</span><span class="tm-dots l-h l-inl l-g1 mt-1" aria-hidden="true">{r.answers.map((a, j) => <i key={j} class={a == null ? "n b-box" : a ? "y" : "x"}/>)}</span></span>
                    <span class="frac f-b f-2 num" aria-hidden="true">{r.correct}/{r.answered}</span>
                    <span class={`sev-pill f-b f-w6 f-2 f-tc b-pill t-${s.tone} num`} aria-hidden="true">{r.correct_pct == null ? "—" : `${r.correct_pct} %`}</span>
                    <span class="sr">. Верно {r.correct} из {r.answered}. {s.label}.</span>
                    <Icon name="chevron"/>
                  </button>
                </li>);
            })}
          </ul>
          <h2 class="tm-h f-s mt-4 mb-2">По вопросам</h2>
          <ul class="tm-qs">{res.questions.map((q) => <li key={q.id}><span>{q.text}{q.topic ? ` · ${q.topic}` : ""}{q.topic && !q.topic_link_confirmed ? " (связь не подтверждена)" : ""}</span><b class="num">{q.correct_pct == null ? "—" : `${q.correct_pct} %`}</b></li>)}</ul>
          <p class="tm-small f-m faint">{res.caveat} Цвет строки — по доле ошибок, та же шкала, что в карте ДЗ.</p></details>
        </>)}
      {createPortal(<StudentQuiz row={open} res={res} onClose={() => setOpen(null)}/>, document.body)}
    </div>);
}
// ------------------------------------------------------------------ экран
export function Teacher({ onSwitchRole, workspace = false, profileOpen, onProfileOpen, onName, journal }: {
    onSwitchRole: () => void;
    workspace?: boolean;
    /** v2.1: сводка журнала СГО (DiaryOverviewCard) — на вкладке «Сегодня» после уроков: ближайший урок остаётся
     *  на первом экране, а сводка не повторяется на «Классах» и «Материалах». */
    journal?: ComponentChildren;
    /** Master v2.0 · Phase 3: профиль открывает аватар в верхней панели (RoleRoot). */
    profileOpen?: boolean;
    onProfileOpen?: (open: boolean) => void;
    onName?: (name: string | null) => void;
}) {
    const [dir, setDir] = useState<TmDirectory | null>(null);
    const [fatal, setFatal] = useState<Err | null>(null);
    const [teacher, setTeacher] = useState(getDemoTeacher());
    const [profile, setProfile] = useState<TmProfile | null>(null);
    const [pErr, setPErr] = useState<Err | null>(null);
    const [date, setDate] = useState(schoolDay());
    const [scenario, setScenario] = useState("normal");
    const [tab, setTab] = useState<TeacherTab>(workspace ? teacherTab(location.hash) : "today");
    const [section, setSection] = useState<ClassesSection>(workspace ? classesSection(location.hash) : "results");
    const sectionRef = useRef(section);
    sectionRef.current = section;
    const [prep, setPrep] = useState<TmLesson | null>(null);
    const [imp, setImp] = useState(false);
    const [rk, setRk] = useState(0);
    const [analytics, setAnalytics] = useState<TmLesson | null>(null);
    const [meLocal, setMeLocal] = useState(false);
    const me = profileOpen ?? meLocal;
    const setMe = onProfileOpen ?? setMeLocal;
    const [meView, setMeView] = useState<ProfileView>("home");
    useEffect(() => { if (profile?.full_name) onName?.(profile.full_name); }, [profile?.full_name]);
    const navigate = (t: TeacherTab) => { setTab(t); if (workspace)
        location.hash = withLaunch(teacherHash(t, sectionRef.current)); };
    const pickSection = (s: ClassesSection) => { setSection(s); if (workspace)
        location.hash = withLaunch(teacherHash("classes", s)); };
    useEffect(() => { if (!workspace)
        return; const change = () => { const t = teacherTab(location.hash); setTab(t); if (t === "classes")
        setSection(classesSection(location.hash)); const want = teacherHash(t, t === "classes" ? classesSection(location.hash) : sectionRef.current); if ("#" + routeOf(location.hash) !== want)
        history.replaceState(null, "", withLaunch(want)); }; change(); addEventListener("hashchange", change); return () => removeEventListener("hashchange", change); }, [workspace]);
    useEffect(() => {
        let active = true;
        api.tm.directory().then((d) => {
            if (!active)
                return;
            setDir(d);
            if (d.is_demo && !d.teachers.some((t) => t.id === getDemoTeacher()) && d.teachers[0]) {
                setDemoTeacher(d.teachers[0].id);
                setTeacher(d.teachers[0].id);
            }
        }).catch((e) => { if (active)
            setFatal(toErr(e)); });
        return () => { active = false; };
    }, [rk]);
    useEffect(() => {
        if (!dir)
            return;
        setProfile(null);
        setPErr(null);
        let active = true;
        api.tm.today(date, null, "normal").then((d) => { if (active)
            setProfile(d.profile); }).catch((e) => { if (active)
            setPErr(toErr(e)); });
        return () => { active = false; };
    }, [dir, teacher, rk]);
    const pick = (id: string) => { if (id === teacher)
        return; setDemoTeacher(id); setTeacher(id); setProfile(null); setPrep(null); setImp(false); setAnalytics(null); navigate("today"); };
    const viewRef = useRef<HTMLDivElement>(null);
    const navigationRef = useRef<HTMLElement>(null);
    // A larger-text dock can be taller than the nominal bottom padding. Keep
    // the final material/plan action scrollable above its actual measured box.
    useEffect(() => {
        const nav = navigationRef.current;
        const app = viewRef.current?.closest<HTMLElement>(".app");
        if (!workspace || !nav || !app) return;
        const previous = app.style.getPropertyValue("--teacher-dock-height");
        const measure = () => {
            const label = nav.querySelector<HTMLElement>(".teacher-tab > span:last-child");
            const largeText = !!label && parseFloat(getComputedStyle(label).fontSize) >= 20;
            nav.classList.toggle("teacher-nav-large-text", largeText && innerWidth < 768);
            app.style.setProperty("--teacher-dock-height", `${Math.ceil(nav.getBoundingClientRect().height)}px`);
        };
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
        observer?.observe(nav);
        addEventListener("resize", measure);
        measure();
        return () => {
            observer?.disconnect();
            removeEventListener("resize", measure);
            nav.classList.remove("teacher-nav-large-text");
            if (previous) app.style.setProperty("--teacher-dock-height", previous);
            else app.style.removeProperty("--teacher-dock-height");
        };
    }, [workspace, profile?.id, !!pErr, !!fatal]);
    useEffect(() => { if (viewRef.current)
        void transition(viewRef.current, { opacity: [0, 1], y: [6, 0] }, "mid"); }, [tab, profile?.id]);
    const teacherTabs: {
        value: TeacherTab;
        label: string;
        icon: string;
    }[] = [{ value: "today", label: "Сегодня", icon: "calendar" }, { value: "classes", label: "Классы", icon: "chart" }];
    // v2.4 · две секции вместо трёх: «Сегодня» = уроки дня + материалы к ним, «Классы» = результаты + задания.
    // Адреса #teacher-today / #teacher-materials / #teacher-classes / #teacher-assignments сохранены.
    const navTab: TeacherTab = tab === "classes" ? "classes" : "today";
    const navigation = <nav ref={navigationRef} class={workspace ? "tm-tabs tabbar teacher-nav" : "tm-tabs"} aria-label="Навигация учителя"><div class="teacher-tab-list" role="tablist" aria-label="Раздел учителя" onKeyDown={e => { const i = teacherTabs.findIndex(t => t.value === navTab); const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? teacherTabs.length - 1 : null; if (n === null)
        return; e.preventDefault(); const next = teacherTabs[(n + teacherTabs.length) % teacherTabs.length]; navigate(next.value); (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus(); }}>{teacherTabs.map(t => <button type="button" class="teacher-tab" data-value={t.value} role="tab" aria-selected={navTab === t.value} tabIndex={navTab === t.value ? 0 : -1} onClick={() => navigate(t.value)}><span class="nav-icon l-center l-g0 b-bare"><Icon name={t.icon}/></span><span>{t.label}</span></button>)}</div></nav>;
    if (fatal)
        return <section class="screen"><h1>Учитель</h1><ErrBox err={fatal} onRetry={() => { setFatal(null); setRk(k => k + 1); }}/>{roleContext().canSwitch && <button class="btn btn-secondary" onClick={onSwitchRole}>DEMO · перейти к ученику</button>}</section>;
    if (!dir)
        return <section class="screen"><div class="sk" style="height:96px;margin-top:64px"/><div class="sk" style="height:64px;margin-top:12px"/></section>;
    return (<>
      <section class="screen tm" aria-labelledby="tm-h">
        <header class="teacher-identity l-h l-wrap l-g3 mb-6"><span class="icon-disc l-center l-g0 f-a b-box"><Icon name="user"/></span><div><p class="eyebrow">УЧИТЕЛЬСКАЯ{dir.is_demo && <>{" "}<span class="tm-badge l-h l-inl l-g0 f-m f-w6 f-nw b-pill l-fix l-self-s" title="Демо-режим: синтетические данные">DEMO</span></>}</p><p>{profile ? profile.full_name : "Учитель"}</p></div></header><div class="workspace-title teacher-title mb-4"><h1 id="tm-h">{tab === "today" ? "Уроки сегодня" : tab === "classes" ? (section === "assignments" ? "Задания ученикам" : "Результаты мини-проверок") : "Материалы к урокам"}</h1><p class="sr f-2">{tab === "today" ? "Подготовка, расписание и изменения — в одном месте." : tab === "classes" ? (section === "assignments" ? "Выдача конкретным ученикам, статусы и история." : "Только доступные классы и подтверждённые результаты.") : "Ваши материалы, черновики и планы."}</p></div>
        {profile && <div class="teacher-subject-strip py-4 l-h l-wrap f-b mb-3" aria-label="Предметы и классы учителя"><span><Icon name="book"/>{profile.subjects.join(' · ') || 'Предмет не указан'}</span><span><Icon name="users"/>{profile.classes.join(' · ') || 'Классы не указаны'}</span></div>}
        {workspace && roleContext().canSwitch && <button class="btn btn-secondary btn-sm teacher-switch f-c f-w6 f-2 b-bare mb-3" onClick={onSwitchRole}>DEMO · перейти к ученику</button>}
        <details class="teacher-context f-b f-2 b-card mt-3 mb-4">
          <summary><Icon name="info"/><span>Профиль и источник{dir.is_demo ? " · DEMO" : ""}</span><Icon name="chevron"/></summary>
        {workspace && <p class="faint tm-small f-m">MAX/Сферум: интеграция не подключена. Время уроков — как в источнике; часовой пояс в контракте расписания не указан.</p>}
        {profile && <p class="faint tm-small f-m tm-who mt-1 mb-3">{profile.school.name}{profile.role_note ? ` · ${profile.role_note}` : ""} · {profile.subjects.join(", ")} · классы {profile.classes.join(", ")}</p>}
        {dir.is_demo && <DemoPanel dir={dir} teacher={teacher} onTeacher={pick} date={date} onDate={setDate} scenario={scenario} onScenario={setScenario} fixed={inSandbox()}/>}
        </details>
        {pErr ? (pErr.s === 403
            ? <div class="empty"><Icon name="lock"/><h3>Вас нет в справочнике школы</h3><p class="f-2">{pErr.m}</p>{!dir.is_demo && !inSandbox() && <TeacherInvite onBound={() => setRk(rk + 1)}/>}{roleContext().canSwitch && <button class="btn btn-secondary btn-sm" onClick={onSwitchRole}>DEMO · сменить роль</button>}</div>
            : <ErrBox err={pErr} onRetry={() => setRk(rk + 1)}/>) : !profile ? <div class="sk" style="height:120px;margin-top:12px"/> : (<>
            {workspace ? createPortal(navigation, document.body) : navigation}
            {/* переключатель вне анимируемого блока: при смене «Уроки ↔ Материалы» бегунок едет, фокус остаётся */}
            {tab !== "classes" && <div class="tm-classes-switch mt-1 mb-4 tm-lessons-switch"><Segmented label="Раздел дня" value={tab === "materials" ? "materials" : "today"} onChange={(v) => navigate(v)} options={[{ value: "today", label: "Уроки" }, { value: "materials", label: "Материалы" }]}/></div>}
            <div ref={viewRef} class="teacher-view" key={`${profile.id}|${tab}`}>
            {tab === "today" && <TodayView key={profile.id} onClass={setAnalytics} date={date} scenario={scenario} profile={profile} onPrep={setPrep} onImport={() => setImp(true)} onDate={setDate} reloadKey={rk} names={Object.fromEntries(dir.teachers.map((t) => [t.id, t.full_name]))}/>}
            {tab === "today" && journal && <div class="tm-overview">{journal}</div>}
            {tab === "classes" && <div class="tm-classes-switch mt-1 mb-4"><Segmented label="Раздел классов" value={section} onChange={pickSection} options={[{ value: "results", label: "Результаты" }, { value: "assignments", label: "Задания" }]}/></div>}
            {tab === "classes" && section === "results" && <ResultsView key={profile.id} profile={profile} onSwitchRole={onSwitchRole}/>}
            {tab === "classes" && section === "assignments" && <TeacherAssignments key={profile.id} isDemo={dir.is_demo}/>}
            {tab === "materials" && <MaterialsView key={profile.id} profile={profile}/>}
            </div>
            <p class="tm-small f-m faint tm-grade mt-6">{profile.grade_note}</p>
          </>)}
      </section>
      {/* листы — порталом в body: фон (#panel, таб-бар) при открытом листе становится inert */}
      {createPortal(<Sheet open={!!analytics} title={analytics ? `Класс ${analytics.class} · ${analytics.subject}` : "Аналитика класса"} eyebrow={profile?.is_demo ? "DEMO · аналитика класса" : "Аналитика класса"} onClose={() => setAnalytics(null)}>{analytics && <ClassAnalytics key={`${teacher}|${analytics.class}|${analytics.subject}`} cls={analytics.class} subject={analytics.subject} allowed={!!profile?.assignments.some(a => a.class === analytics.class && a.subject === analytics.subject && a.perms.view_stats)}/>}</Sheet>, document.body)}
      {createPortal(<PrepSheet lesson={prep} onClose={() => setPrep(null)}/>, document.body)}
      {workspace && createPortal(<ProfileHub open={me} view={meView} onView={setMeView} onClose={() => setMe(false)} eyebrow="Учитель"
        roleLabel={profile ? `Учитель${profile.subjects.length ? " · " + profile.subjects.join(", ") : ""}` : "Учитель"} name={profile?.full_name ?? null}
        stats={false} backgrounds={false}>
        <AccountSettings/>
        <ExternalAiNotice/>
        {roleContext().canSwitch && <button type="button" class="btn btn-secondary btn-block" onClick={() => { setMe(false); onSwitchRole(); }}>DEMO · перейти к ученику</button>}
      </ProfileHub>, document.body)}
      {createPortal(<ImportSheet open={imp} date={date} onClose={() => setImp(false)} onApplied={() => setRk((k) => k + 1)}/>, document.body)}
    </>);
}

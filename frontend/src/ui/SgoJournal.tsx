/**
 * v3.2 · «Журнал СГО» в экране учителя: нагрузка из «Сетевого Города» (классы, уроки на неделю),
 * публикация ДЗ к уроку и выгрузка отметок по результатам заданий Фокуса.
 *
 * Честность: всё, что уходит в официальный журнал, сначала показывается предпросмотром; живая запись —
 * только если сервер разрешил (SGO_TEACHER_WRITE=1) И учитель отметил «Проверил(а)». Отметки — лишь
 * предложение по проценту выполнения, учитель меняет любую или пропускает ученика.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";
import { schoolDay } from "../lib/day";
import {
  buildMarkRows, classKey, marksPayload, type MarkRow, type SgoClass, type SgoLesson, type SgoMark, type SgoSendResult, type SgoStatus,
} from "../lib/sgoMarks";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const ruDate = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : d);

function SendNote({ r }: { r: SgoSendResult | null }) {
  if (!r) return null;
  const live = r.dry_run === false || (r.ok && r.sgo_assignment_id != null) || (r.exported_count ?? 0) > 0;
  return <p class={live ? "hw-empty-line f-3 mt-2" : "hint-text mt-2"} role="status">
    {live ? "Отправлено в журнал СГО." : "Предпросмотр — в СГО ничего не отправлено."}
    {r.checked_count != null && ` Проверено отметок: ${r.checked_count}.`}
    {r.note ? ` ${r.note}` : ""}
  </p>;
}

export function SgoJournal({ cls }: { cls: string }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<SgoStatus | null>(null);
  const [classes, setClasses] = useState<SgoClass[]>([]);
  const [lessons, setLessons] = useState<SgoLesson[]>([]);
  const [classId, setClassId] = useState<number | null>(null);
  const [lessonId, setLessonId] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [fail, setFail] = useState("");
  const [title, setTitle] = useState("");
  const [descr, setDescr] = useState("");
  const [due, setDue] = useState(() => schoolDay(undefined, 1));
  const [pub, setPub] = useState<SgoSendResult | null>(null);
  const [rows, setRows] = useState<MarkRow[] | null>(null);
  const [assignmentId, setAssignmentId] = useState("");
  const [exp, setExp] = useState<SgoSendResult | null>(null);
  const [sure, setSure] = useState(false);

  const load = async () => {
    if (busy) return;
    setBusy("load"); setFail("");
    try {
      const s = await api.teacherSgo.status();
      setSt(s);
      if (s.linked) {
        const [c, l] = await Promise.all([api.teacherSgo.classes(), api.teacherSgo.schedule(7)]);
        setClasses(c.classes || []); setLessons(l.lessons || []);
        const hit = (c.classes || []).find((x) => classKey(x.class_name) === classKey(cls));
        setClassId(hit ? hit.class_id : null);
      }
    } catch (e) { setFail(msg(e, "СГО не ответил — попробуйте позже")); }
    finally { setBusy(""); }
  };
  useEffect(() => { setSt(null); setRows(null); setPub(null); setExp(null); setLessonId(null); if (open) void load(); }, [cls]);

  const sgoClass = classes.find((c) => c.class_id === classId) || null;
  const myLessons = useMemo(() => lessons.filter((l) =>
    classId != null && (l.class_id === classId || (l.class_id == null && classKey(l.class_name) === classKey(sgoClass?.class_name)))), [lessons, classId]);
  const lesson = myLessons.find((l) => l.classmeeting_id === lessonId) || null;
  const canLive = !!st?.write_enabled && sure;

  const publish = async (confirm: boolean) => {
    if (!lesson || lesson.subject_id == null) { setFail("Выберите урок из расписания СГО"); return; }
    if (title.trim().length < 3) { setFail("Название задания — хотя бы 3 символа"); return; }
    setBusy("pub"); setFail("");
    try {
      const r = await api.teacherSgo.publish({ classmeeting_id: lesson.classmeeting_id, subject_id: lesson.subject_id,
        title: title.trim(), description: descr.trim(), due_date: due, confirm });
      setPub(r);
      if (r.sgo_assignment_id) setAssignmentId(String(r.sgo_assignment_id));
      if (confirm && r.ok && r.dry_run === false) toast("ДЗ опубликовано в СГО", "ok");
    } catch (e) { setFail(msg(e, "Не удалось отправить ДЗ в СГО")); }
    finally { setBusy(""); }
  };

  const prepareMarks = async () => {
    if (!lesson || classId == null || lesson.subject_id == null) { setFail("Выберите урок — отметки ставятся за конкретный урок"); return; }
    setBusy("marks"); setFail(""); setExp(null);
    try {
      const [gb, rep] = await Promise.all([
        api.teacherSgo.gradebook(classId, lesson.subject_id),
        api.hw.report(cls, schoolDay(undefined, -13), schoolDay()),
      ]);
      setRows(buildMarkRows(gb.students || [], rep.students || []));
    } catch (e) { setFail(msg(e, "Журнал СГО не загрузился")); }
    finally { setBusy(""); }
  };

  const setMark = (i: number, v: string) => setRows((rs) => rs && rs.map((r, k) => (k === i ? { ...r, mark: v ? (Number(v) as SgoMark) : null } : r)));

  const exportMarks = async (dryRun: boolean) => {
    if (!rows || !lesson) return;
    const body = marksPayload(rows, lesson.classmeeting_id, assignmentId, dryRun);
    if (!body.assignment_id) { setFail("Укажите номер работы в СГО (появится после публикации ДЗ)"); return; }
    if (!body.marks.length) { setFail("Нет ни одной отметки для выгрузки"); return; }
    setBusy("exp"); setFail("");
    try {
      const r = await api.teacherSgo.exportMarks(body);
      setExp(r);
      if (!dryRun && (r.exported_count ?? 0) > 0) toast(`Выставлено отметок: ${r.exported_count}`, "ok");
    } catch (e) { setFail(msg(e, "Выгрузка отметок не прошла")); }
    finally { setBusy(""); }
  };

  const matched = rows ? rows.filter((r) => r.matched).length : 0;
  return <details class="hw-card b-card sgo-journal mt-3" open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (o && !st && !busy) void load(); }}>
    <summary><Icon name="chart" /><span><b>Журнал СГО · {cls}</b><small>ДЗ к уроку и отметки — с предпросмотром</small></span><Icon name="chevron" /></summary>
    {busy === "load" && <p class="hint-text mt-2" role="status">Загружаем данные СГО…</p>}
    {fail && <p class="field-err mt-2" role="alert">{fail}</p>}
    {st && !st.linked && <p class="hw-empty-line f-3 mt-2 mb-2" role="status">{st.note || "Войдите в СГО как учитель, чтобы видеть классы и журнал."}</p>}
    {st?.linked && <div class="mt-2">
      <p class="hint-text">{st.write_enabled ? "Запись в журнал включена на сервере: перед отправкой — предпросмотр и ваше подтверждение." : "Режим предпросмотра: в журнал СГО ничего не записывается, видно, что ушло бы."}</p>
      <div class="l-h l-wrap l-end mt-2">
        <label class="field"><span class="field-label">Класс в СГО</span>
          <select class="input" value={classId ?? ""} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; setClassId(v ? Number(v) : null); setLessonId(null); setRows(null); }}>
            <option value="">— выберите —</option>
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}{c.students_count != null ? ` · ${c.students_count} уч.` : ""}</option>)}
          </select></label>
        <label class="field"><span class="field-label">Урок</span>
          <select class="input" value={lessonId ?? ""} disabled={!myLessons.length} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; setLessonId(v ? Number(v) : null); setRows(null); setPub(null); setExp(null); }}>
            <option value="">{myLessons.length ? "— выберите урок —" : "Нет уроков на 7 дней"}</option>
            {myLessons.map((l) => <option key={l.classmeeting_id} value={l.classmeeting_id}>{ruDate(l.date)}{l.number != null ? ` · ${l.number} урок` : ""} · {l.subject || "предмет"}{l.topic ? ` · ${l.topic}` : ""}</option>)}
          </select></label>
      </div>
      {classId == null && classes.length > 0 && <p class="hint-text mt-2">Класс «{cls}» не найден в СГО по названию — выберите вручную.</p>}

      {lesson && <form class="mt-3" onSubmit={(e) => { e.preventDefault(); void publish(false); }}>
        <h3 class="f-b f-w6">Домашнее задание к уроку</h3>
        <label class="field mt-2"><span class="field-label">Название</span><input class="input" value={title} maxLength={250} placeholder="Например: № 214–216, параграф 12" onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} /></label>
        <label class="field mt-2"><span class="field-label">Подробности (необязательно)</span><textarea class="input" rows={2} maxLength={2000} value={descr} onInput={(e) => setDescr((e.currentTarget as HTMLTextAreaElement).value)} /></label>
        <label class="field mt-2"><span class="field-label">Сдать до</span><input class="input" type="date" value={due} min={lesson.date} onInput={(e) => setDue((e.currentTarget as HTMLInputElement).value)} /></label>
        <div class="hw-row-actions l-h l-wrap mt-2">
          <button type="submit" class="btn btn-secondary btn-sm" disabled={!!busy}>{busy === "pub" ? "Проверяем…" : "Предпросмотр"}</button>
          {st.write_enabled && <button type="button" class="btn btn-primary btn-sm" disabled={!!busy || !canLive} onClick={() => void publish(true)}>Опубликовать в СГО</button>}
        </div>
        <SendNote r={pub} />
      </form>}

      {lesson && <section class="mt-3" aria-label="Отметки в журнал СГО">
        <h3 class="f-b f-w6">Отметки за урок</h3>
        <p class="hint-text">Предложение по среднему проценту заданий Фокуса за 2 недели: ≥85% — 5, ≥65% — 4, ≥45% — 3, ниже — 2. Меняйте любую.</p>
        <button type="button" class="btn btn-secondary btn-sm mt-2" disabled={!!busy} onClick={() => void prepareMarks()}>{busy === "marks" ? "Загружаем журнал…" : rows ? "Обновить список" : "Подготовить отметки"}</button>
        {rows && (rows.length === 0
          ? <p class="hw-empty-line f-3 mt-2" role="status">СГО не вернул список учеников для этого урока.</p>
          : <div class="mt-2">
            <p class="hint-text">Сопоставлено с Фокусом: {matched} из {rows.length}. Без пары — отметка не предлагается.</p>
            <table class="hw-report-table f-b l-w100 mt-2">
              <caption class="sr">Ученик, процент в Фокусе, отметка в СГО</caption>
              <thead><tr><th scope="col">Ученик</th><th scope="col">В Фокусе</th><th scope="col">Отметка</th></tr></thead>
              <tbody>{rows.map((r, i) => <tr key={String(r.student_id)}>
                <th scope="row">{r.student_name}</th>
                <td class="num">{r.percent != null ? `${Math.round(r.percent)}%` : "—"}</td>
                <td><select class="input" aria-label={`Отметка: ${r.student_name}`} value={r.mark ?? ""} onChange={(e) => setMark(i, (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">не ставить</option>{[5, 4, 3, 2].map((m) => <option key={m} value={m}>{m}</option>)}
                </select></td>
              </tr>)}</tbody>
            </table>
            <label class="field mt-2"><span class="field-label">Номер работы в СГО</span><input class="input" inputMode="numeric" value={assignmentId} placeholder="Появится после публикации ДЗ" onInput={(e) => setAssignmentId((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ""))} /></label>
            <div class="hw-row-actions l-h l-wrap mt-2">
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void exportMarks(true)}>{busy === "exp" ? "Проверяем…" : "Проверить выгрузку"}</button>
              {st.write_enabled && <button type="button" class="btn btn-primary btn-sm" disabled={!!busy || !canLive} onClick={() => void exportMarks(false)}>Выставить в СГО</button>}
            </div>
            <SendNote r={exp} />
          </div>)}
      </section>}

      {lesson && st.write_enabled && <label class="l-h mt-3"><input type="checkbox" checked={sure} onChange={(e) => setSure((e.currentTarget as HTMLInputElement).checked)} /><span>Проверил(а) предпросмотр — можно писать в официальный журнал</span></label>}
    </div>}
  </details>;
}

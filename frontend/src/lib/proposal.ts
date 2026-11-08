/**
 * EVIDENCE → (OCR/STT) → РАЗБОР (nlu.ts) → ДАТА → УРОК → ИЗМЕНЕНИЯ → УВЕРЕННОСТЬ → КОНФЛИКТЫ → ПРЕДПРОСМОТР.
 * Здесь ничего не применяется: результат — предложение, которое ученик подтверждает.
 * Не угадываем: нет дня → needDay; урок не найден → вопрос с вариантами; перенос на занятый
 * урок → «Что произошло?»; разные источники спорят → конфликт [Заменить] [Оставить] [Сравнить].
 */
import { applyChanges, change, SOURCE_LABEL, WD_ACC, WD_NAME, weekdayOf, type DayView, type EvidenceKind, type Lesson, type LessonSource, type ScheduleChange } from "./schedule";
import { sameSubject, type Draft, type ParsedSchedule } from "./nlu";

export interface Choice { label: string; value: string }
export interface Question { id: string; kind: "lesson" | "move"; text: string; sub?: string; options: Choice[] }
export interface Item {
  key: string; change: ScheduleChange;
  /** null — конфликт ещё не решён (кнопка «Применить» заблокирована) */
  include: boolean | null;
  conflict: { existing: Lesson; text: string } | null;
  low: boolean; why: string | null;
}
export interface Proposal {
  date: string | null; dayConf: number; needDay: boolean; dayGuess: string | null;
  items: Item[]; questions: Question[]; unknown: string[];
  preview: Lesson[]; base: Lesson[]; firstNote: string | null;
  low: boolean; sourceConf: number; source: LessonSource; evidence: EvidenceKind[]; evidenceNote: string | null;
}
export interface Answers { lesson?: Record<string, number>; move?: Record<string, "shift" | "cancel"> }

const active = (ls: Lesson[]) => ls.filter((l) => l.status === "active");
const at = (ls: Lesson[], n: number | null | undefined) => (n ? ls.find((l) => l.lesson_number === n && l.status === "active") : undefined);
const isBase = (l: Lesson) => l.source === "real" || l.source === "demo";
const gen = (s: string) => {
  const map: Record<string, string> = { "Математика": "математики", "Алгебра": "алгебры", "Геометрия": "геометрии", "Русский язык": "русского", "Литература": "литературы", "Английский язык": "английского", "Физика": "физики", "Химия": "химии", "Биология": "биологии", "География": "географии", "История": "истории", "Обществознание": "обществознания", "Информатика": "информатики", "Физкультура": "физкультуры", "Технология": "технологии", "Музыка": "музыки" };
  return map[s] ?? s.toLowerCase();
};
export const lowerSubj = (s: string) => (s === "ИЗО" || s === "ОБЖ" ? s : s.replace(" язык", "").toLowerCase());

export function buildProposal(parsed: ParsedSchedule, o: {
  date: string | null; dayConf?: number; view: (date: string) => DayView; source: LessonSource; evidence: EvidenceKind[];
  evidenceNote: string | null; sourceConf: number; answers?: Answers; table?: boolean;
}): Proposal {
  const pd = parsed.day;
  const guess = pd.kind === "date" ? pd.date : null;
  const dayConf = o.date ? (o.dayConf ?? 1) : pd.kind === "date" ? pd.confidence : 0;
  const date = o.date ?? (pd.kind === "date" && pd.confidence >= 0.8 ? pd.date : null);
  const base: Proposal = {
    date, dayConf, needDay: !date, dayGuess: guess, items: [], questions: [], unknown: parsed.unknown,
    preview: [], base: [], firstNote: null, low: false, sourceConf: o.sourceConf, source: o.source, evidence: o.evidence, evidenceNote: o.evidenceNote,
  };
  if (!date) return base;
  const view = o.view(date);
  const ls = view.lessons;
  const acc = WD_ACC[weekdayOf(date)];
  const items: Item[] = [], questions: Question[] = [];
  const mk = (key: string, d: Partial<ScheduleChange> & { change_type: ScheduleChange["change_type"] }, conf: number, why: string | null = null, conflict: Item["conflict"] = null, include: boolean | null = true) => {
    const c = change({ ...d, date, source: o.source, evidence: o.evidence, evidence_note: o.evidenceNote, confidence: Math.round(conf * o.sourceConf * 100) / 100 });
    const low = c.confidence < 0.7;
    items.push({ key, change: c, include: conflict ? null : low ? false : include, conflict, low, why });
  };
  const findBy = (key: string, d: Draft, verb: string): number | null => {
    if (d.lesson_number) return d.lesson_number;
    if (!d.before) return null;
    const cands = active(ls).filter((l) => sameSubject(l.subject, d.before!));
    if (cands.length === 1) return cands[0].lesson_number;
    const pick = o.answers?.lesson?.[key];
    if (pick) return pick;
    questions.push({
      id: key, kind: "lesson",
      text: cands.length ? `В ${acc} ${cands.length} урока ${gen(d.before)}. Какой ${verb}?` : `В ${acc} нет ${gen(d.before)}. На каком уроке ${verb}?`,
      options: (cands.length ? cands : active(ls)).map((l) => ({ label: `${l.lesson_number} · ${l.subject}`, value: String(l.lesson_number) })),
    });
    return null;
  };

  parsed.drafts.forEach((d, i) => {
    const key = `d${i}`;
    if (d.change_type === "REPLACE") {
      const n = findBy(key, d, `будет ${lowerSubj(d.subject ?? "")}`); if (!n) return;
      const cur = at(ls, n);
      const mismatch = !!(cur && d.before && !sameSubject(cur.subject, d.before));
      mk(key, { change_type: cur ? "REPLACE" : "ADD", lesson_number: n, subject: d.subject, before: cur?.subject ?? null }, mismatch ? 0.6 : d.confidence,
        mismatch ? `На ${n}-м уроке стоит ${cur!.subject}, а не ${d.before}` : null);
    } else if (d.change_type === "CANCEL") {
      const n = findBy(key, d, "отменили"); if (!n) return;
      const cur = at(ls, n);
      if (!cur) { parsed.unknown.push(`${n}-го урока в ${acc} и так нет`); return; }
      mk(key, { change_type: "CANCEL", lesson_number: n, before: cur.subject }, d.confidence);
    } else if (d.change_type === "MOVE") {
      const n = findBy(key, d, "перенесли"); if (!n || !d.to_lesson_number) return;
      const cur = at(ls, n), tgt = at(ls, d.to_lesson_number);
      if (!cur) { parsed.unknown.push(`${n}-го урока в ${acc} нет — переносить нечего`); return; }
      if (tgt && tgt.lesson_number !== n) {
        const ans = o.answers?.move?.[key];
        if (!ans) {
          questions.push({ id: key, kind: "move", text: `На ${tgt.lesson_number}-м уроке уже стоит ${lowerSubj(tgt.subject)}.`, sub: "Что произошло?",
            options: [{ label: `${tgt.subject} тоже перенесена`, value: "shift" }, { label: `Урок ${n} просто отменили`, value: "cancel" }, { label: "Показать расписание", value: "show" }] });
          return;
        }
        if (ans === "cancel") { mk(key, { change_type: "CANCEL", lesson_number: n, before: cur.subject, reason: "перенос оказался отменой" }, d.confidence); return; }
        mk(key, { change_type: "MOVE", lesson_number: n, to_lesson_number: d.to_lesson_number, shift: true, before: cur.subject }, d.confidence, `${tgt.subject} и следующие уроки сдвигаются`);
        return;
      }
      mk(key, { change_type: "MOVE", lesson_number: n, to_lesson_number: d.to_lesson_number, before: cur.subject }, d.confidence);
    } else if (d.change_type === "ADD") {
      const n = d.lesson_number ?? (Math.max(0, ...active(ls).map((l) => l.lesson_number)) + 1);
      const cur = at(ls, n);
      mk(key, { change_type: cur ? "REPLACE" : "ADD", lesson_number: n, subject: d.subject, before: cur?.subject ?? null }, d.confidence);
    } else if (["TIME_CHANGE", "ROOM_CHANGE", "TEACHER_CHANGE", "NOTE"].includes(d.change_type)) {
      const n = findBy(key, d, "меняется"); if (!n) return;
      const cur = at(ls, n);
      if (!cur) { parsed.unknown.push(`${n}-го урока в ${acc} нет`); return; }
      mk(key, { change_type: d.change_type, lesson_number: n, before: cur.subject, start_time: d.start_time ?? null, end_time: d.end_time ?? null, room: d.room ?? null, teacher: d.teacher ?? null, note: d.note ?? null }, d.confidence);
    }
  });

  // Перечисление / таблица с фото: сравнение по слотам
  const listNums = new Set(parsed.list.map((x) => x.n));
  parsed.list.forEach((it, i) => {
    const key = `l${i}`;
    const cur = ls.find((l) => l.lesson_number === it.n);
    if (!cur || cur.status !== "active") { mk(key, { change_type: "ADD", lesson_number: it.n, subject: it.subject, start_time: it.start_time, end_time: it.end_time, room: it.room }, 0.95); return; }
    if (!sameSubject(cur.subject, it.subject)) {
      const conflict = !isBase(cur) ? { existing: cur, text: `В ${acc} на ${it.n}-м уроке уже стоит ${lowerSubj(cur.subject)} (${SOURCE_LABEL[cur.source].toLowerCase()}).` } : null;
      mk(key, { change_type: "REPLACE", lesson_number: it.n, subject: it.subject, before: cur.subject, room: it.room }, 0.95, null, conflict);
      return;
    }
    if (it.start_time && cur.start_time && it.start_time !== cur.start_time)
      mk(key, { change_type: "TIME_CHANGE", lesson_number: it.n, before: cur.subject, start_time: it.start_time, end_time: it.end_time }, 0.85);
    if (it.room && cur.room !== it.room) mk(`${key}r`, { change_type: "ROOM_CHANGE", lesson_number: it.n, before: cur.subject, room: it.room }, 0.85);
  });
  if (parsed.endsAfter) {
    active(ls).filter((l) => l.lesson_number > parsed.endsAfter!).forEach((l) =>
      mk(`e${l.lesson_number}`, { change_type: "CANCEL", lesson_number: l.lesson_number, before: l.subject, reason: `после ${parsed.endsAfter}-го урока — домой` }, 0.92));
  }
  if (o.table && parsed.list.length >= 3) {
    const max = Math.max(...listNums);
    active(ls).filter((l) => l.lesson_number > max).forEach((l) =>
      mk(`t${l.lesson_number}`, { change_type: "CANCEL", lesson_number: l.lesson_number, before: l.subject, reason: `на фото нет ${l.lesson_number}-го урока` }, 0.65, `На фото нет ${l.lesson_number}-го урока — проверь`, null, false));
  }
  if (parsed.cancelAll) active(ls).forEach((l) => mk(`a${l.lesson_number}`, { change_type: "CANCEL", lesson_number: l.lesson_number, before: l.subject, reason: "уроков не будет" }, 0.85));

  const chosen = items.filter((x) => x.include).map((x) => x.change);
  const preview = applyChanges(ls, chosen, date);
  const b1 = active(ls)[0], p1 = active(preview)[0];
  const firstNote = b1 && p1 && b1.lesson_number !== p1.lesson_number ? `Тогда первым будет ${p1.lesson_number}-й урок — ${lowerSubj(p1.subject)} в ${p1.start_time}.` : !p1 && b1 ? "Уроков в этот день не останется." : null;
  return { ...base, items, questions, preview, base: ls, firstNote, low: items.some((x) => x.low) || dayConf < 0.8 };
}

export const dayLabel = (date: string, today: string): string => {
  const d = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 864e5);
  const name = WD_NAME[weekdayOf(date)];
  return d === 0 ? `Сегодня, ${name.toLowerCase()}` : d === 1 ? `Завтра, ${name.toLowerCase()}` : `${name}, ${date.slice(8, 10)}.${date.slice(5, 7)}`;
};

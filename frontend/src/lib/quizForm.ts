/** v2 · блиц-опросы учителя: черновик, проверка (зеркало серверной normalize_quiz) и текст для печати. */
import type { HwTemplate, QuizDraft, QuizKind, QuizQuestionDraft } from "./hwTypes";

export const QUIZ_MAX = 20;
export const KIND_LABEL: Record<QuizKind, string> = { single: "Один ответ", multi: "Несколько ответов", short: "Короткий ответ" };
export const blankQuestion = (kind: QuizKind = "single"): QuizQuestionDraft =>
  ({ kind, text: "", options: kind === "short" ? [] : ["", ""], correct: [], answers: kind === "short" ? [""] : [], points: 1, explain: "" });
export const blankQuiz = (): QuizDraft => ({ topic: "", origin: "manual", questions: [blankQuestion()], time_limit_min: 10, show_answers: true });

const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

/** Errors keyed «q<N>.<field>» (N from 1) plus «quiz» for the whole quiz; empty object = valid. */
export function validateQuiz(q: QuizDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (q.origin !== "manual" && q.reviewed !== true) e.review = "Подтвердите, что проверили каждый вопрос и верные ответы";
  if (!q.questions.length) e.quiz = "Добавьте хотя бы один вопрос";
  if (q.questions.length > QUIZ_MAX) e.quiz = `Не больше ${QUIZ_MAX} вопросов`;
  if (q.time_limit_min !== null && (!Number.isInteger(q.time_limit_min) || q.time_limit_min < 1 || q.time_limit_min > 90)) e.time = "Время — от 1 до 90 минут";
  q.questions.forEach((x, i) => {
    const k = `q${i + 1}`;
    if (!x.text.trim()) e[`${k}.text`] = "Напишите текст вопроса";
    else if (x.text.length > 500) e[`${k}.text`] = "Не длиннее 500 символов";
    if (!Number.isInteger(x.points) || x.points < 1 || x.points > 5) e[`${k}.points`] = "Баллы — от 1 до 5";
    if (x.kind === "short") {
      if (!x.answers.some((a) => a.trim())) e[`${k}.answers`] = "Укажите хотя бы один верный ответ";
    } else {
      const opts = x.options.map((o) => o.trim());
      if (opts.length < 2 || opts.length > 6) e[`${k}.options`] = "Нужно от 2 до 6 вариантов";
      else if (opts.some((o) => !o)) e[`${k}.options`] = "Заполните все варианты или удалите пустой";
      else if (new Set(opts.map(norm)).size !== opts.length) e[`${k}.options`] = "Варианты повторяются";
      const ok = x.correct.filter((c) => c >= 0 && c < opts.length);
      if (!ok.length) e[`${k}.correct`] = "Отметьте верный вариант";
      else if (x.kind === "single" && ok.length !== 1) e[`${k}.correct`] = "Отметьте ровно один верный вариант";
    }
  });
  return e;
}

/** Payload for the server: trimmed, answers de-duplicated, «ai» → «ai_edited» once the teacher changed it;
 *  an AI draft carries the explicit teacher confirmation `reviewed` (the server refuses it without one). */
export function quizPayload(q: QuizDraft, edited: boolean): QuizDraft {
  return {
    topic: q.topic.trim().slice(0, 120), origin: q.origin === "ai" && edited ? "ai_edited" : q.origin,
    time_limit_min: q.time_limit_min, show_answers: q.show_answers,
    ...(q.origin !== "manual" ? { reviewed: q.reviewed === true } : {}),
    questions: q.questions.map((x) => ({
      kind: x.kind, text: x.text.trim(), points: x.points, explain: x.explain.trim(),
      options: x.kind === "short" ? [] : x.options.map((o) => o.trim()),
      correct: x.kind === "short" ? [] : [...new Set(x.correct)].sort((a, b) => a - b),
      answers: x.kind === "short" ? [...new Set(x.answers.map((a) => a.trim()).filter(Boolean))].slice(0, 5) : [],
    })),
  };
}
export const maxScore = (q: Pick<QuizDraft, "questions">) => q.questions.reduce((s, x) => s + (x.points || 0), 0);
/** Planned minutes of a quiz assignment (the template contract needs 5…240). */
export const quizMinutes = (q: QuizDraft) => Math.min(240, Math.max(5, q.time_limit_min ?? q.questions.length * 2));

const LETTERS = "АБВГДЕ";
/** Plain text for copy / paper: students without the app get the same questions; keys only for the teacher. */
export function quizText(t: Pick<HwTemplate, "title" | "class" | "subject" | "due_date" | "instructions">, q: Pick<QuizDraft, "questions" | "time_limit_min"> | null, withKeys: boolean): string {
  const head = [`${t.title}`, `Класс ${t.class} · ${t.subject}${t.due_date ? ` · срок ${t.due_date.split("-").reverse().join(".")}` : ""}`];
  if (q?.time_limit_min) head.push(`Время: ${q.time_limit_min} мин`);
  if (t.instructions) head.push("", t.instructions);
  if (!q) return head.join("\n");
  head.push("", "Фамилия, имя: ____________________", "");
  q.questions.forEach((x, i) => {
    head.push(`${i + 1}. ${x.text}${x.points > 1 ? ` (${x.points} б.)` : ""}${x.kind === "multi" ? " — отметьте все верные" : ""}`);
    if (x.kind === "short") head.push("   Ответ: ____________________");
    else x.options.forEach((o, j) => head.push(`   ${LETTERS[j]}) ${o}`));
    if (withKeys) head.push(`   Ключ: ${x.kind === "short" ? x.answers.join(" / ") : x.correct.map((c) => LETTERS[c]).join(", ")}${x.explain ? ` — ${x.explain}` : ""}`);
    head.push("");
  });
  return head.join("\n").trimEnd();
}

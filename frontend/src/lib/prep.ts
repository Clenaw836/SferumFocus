/**
 * v16.1 «Подготовка к уроку»: ОДНО реалистичное короткое действие под время до звонка.
 * Чистая функция (тестируется в tests/unit/v161.test.mts). Правила:
 *  • тему урока не выдумываем: известна только из расписания (topic) или из задания по предмету;
 *    иначе честно «тему не знаю», а вопросы банка помечаются как общая практика по предмету;
 *  • квиз предлагаем, только если он успевает закончиться до урока (questionsThatFit: 3–5 вопросов);
 *  • меньше 3 вопросов не влезает → сохранённая шпаргалка по предмету → домашнее задание → «открой тетрадь».
 */
import { questionsThatFit, QUIZ_CONFIG, clampSeconds } from "./quizClock";

export interface PrepIn {
  subject: string;
  topic: string | null;
  topicSource: "schedule" | "task" | "unknown";
  /** минут до начала урока; null — урок завтра (время не ограничено звонком) */
  startsIn: number | null;
  /** есть ли вопросы по предмету в локальном банке */
  hasBank: boolean;
  /** заголовок сохранённой шпаргалки по предмету (если есть) */
  card: string | null;
  relatedTasks: string[];
}
export type PrepKind = "quiz" | "card" | "homework" | "notebook";
export interface PrepOffer {
  kind: PrepKind;
  /** вопросов в мини-квизе (0 — квиз не предлагаем) */
  questions: number;
  /** оценка длительности, минут */
  minutes: number;
  /** строка о теме — честное происхождение */
  topicLine: string;
  /** пометка, что вопросы не по теме урока (если тема неизвестна или банк шире темы) */
  practiceNote: string | null;
  /** короткий совет, когда квиза нет */
  advice: string | null;
  /** вторичное действие — шпаргалка рядом с квизом */
  alsoCard: boolean;
  /** почему именно так (одна причина — продуктовое правило №2) */
  why: string;
}

const lower = (s: string) => s.toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function prepOffer(p: PrepIn): PrepOffer {
  const known = !!p.topic && p.topicSource !== "unknown";
  const topicLine = known
    ? `Тема: ${p.topic} · ${p.topicSource === "schedule" ? "из расписания" : "из задания"}`
    : "Тему урока я не знаю — в расписании её нет.";
  const n = p.hasBank ? questionsThatFit(p.startsIn) : 0;
  const per = clampSeconds(QUIZ_CONFIG.questionSeconds) + QUIZ_CONFIG.overheadSeconds;
  const timeWhy = p.startsIn === null ? "до урока целый вечер" : `до урока ${p.startsIn} мин`;
  if (n > 0) {
    return {
      kind: "quiz", questions: n, minutes: Math.max(1, Math.ceil((n * per) / 60)), topicLine,
      practiceNote: known ? `Вопросы — по предмету в целом, не только по этой теме.` : "Вопросы — общая практика по предмету, не по теме урока.",
      advice: null, alsoCard: !!p.card,
      why: p.startsIn === null ? `${n} ${questionsWord(n)} по ${QUIZ_CONFIG.questionSeconds} с — на вечер или утро.` : `${cap(timeWhy)} — ${n} ${questionsWord(n)} по ${QUIZ_CONFIG.questionSeconds} с успеешь.`,
    };
  }
  const short = p.startsIn !== null && p.hasBank;
  const why = short ? `${cap(timeWhy)} — квиз не успеть, вот что займёт минуту.` : !p.hasBank ? `Вопросов по предмету «${lower(p.subject)}» в банке нет.` : cap(timeWhy) + ".";
  if (p.card) return { kind: "card", questions: 0, minutes: 1, topicLine, practiceNote: null, advice: `Пролистай шпаргалку «${p.card}».`, alsoCard: false, why };
  if (p.relatedTasks[0]) return { kind: "homework", questions: 0, minutes: 2, topicLine, practiceNote: null, advice: `Перечитай домашнее: ${p.relatedTasks[0]}.`, alsoCard: false, why };
  return { kind: "notebook", questions: 0, minutes: 1, topicLine, practiceNote: null,
    advice: known ? `Открой тетрадь на теме «${p.topic}» и вспомни главное.` : "Открой тетрадь на последней записи по предмету и вспомни главное.", alsoCard: false, why };
}

export const questionsWord = (n: number) => (n === 1 ? "вопрос" : n >= 2 && n <= 4 ? "вопроса" : "вопросов");

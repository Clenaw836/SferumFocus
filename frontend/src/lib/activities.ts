/**
 * «Мои дела сегодня»: типы дел, контекстные значения по умолчанию, валидация и
 * перевод в контракт планировщика (PersonalActivity). Хранение — dayStore.acts().
 */
import type { ActivityType, DayActivity, PersonalActivity } from "./types";

export interface ActivityKind {
  type: ActivityType; label: string; icon: string;
  /** подпись поля названия и пример */
  titleLabel: string; placeholder: string;
  defTitle: string; defMinutes: number; defFixed: boolean;
  /** обязательно ли название/время (Прочее — всё обязательно) */
  needTitle: boolean; needTime: boolean;
  durations: number[];
}
export const KINDS: ActivityKind[] = [
  { type: "tutor", label: "Репетитор", icon: "user", titleLabel: "Предмет или имя", placeholder: "Например, английский…", defTitle: "Репетитор", defMinutes: 60, defFixed: true, needTitle: false, needTime: false, durations: [45, 60, 90] },
  { type: "sport", label: "Тренировка", icon: "dumbbell", titleLabel: "Секция", placeholder: "Например, плавание…", defTitle: "Тренировка", defMinutes: 90, defFixed: true, needTitle: false, needTime: false, durations: [60, 90, 120] },
  { type: "games", label: "ПК/игры", icon: "gamepad", titleLabel: "Название", placeholder: "Например, Minecraft с друзьями…", defTitle: "Игры на ПК", defMinutes: 60, defFixed: false, needTitle: false, needTime: false, durations: [30, 60, 90, 120] },
  { type: "club", label: "Кружок", icon: "palette", titleLabel: "Кружок", placeholder: "Например, робототехника…", defTitle: "Кружок", defMinutes: 60, defFixed: true, needTitle: false, needTime: false, durations: [45, 60, 90] },
  { type: "meet", label: "Встреча", icon: "users", titleLabel: "С кем или где", placeholder: "Например, с друзьями во дворе…", defTitle: "Встреча", defMinutes: 60, defFixed: true, needTitle: false, needTime: false, durations: [30, 60, 90] },
  { type: "road", label: "Дорога", icon: "route", titleLabel: "Куда", placeholder: "Например, до секции…", defTitle: "Дорога", defMinutes: 30, defFixed: true, needTitle: false, needTime: false, durations: [15, 30, 45] },
  { type: "other", label: "Другое", icon: "dots", titleLabel: "Что за дело", placeholder: "Например, помочь по дому…", defTitle: "", defMinutes: 30, defFixed: false, needTitle: true, needTime: false, durations: [15, 30, 60] },
  { type: "misc", label: "Прочее", icon: "pin", titleLabel: "Что за дело", placeholder: "Например, врач…", defTitle: "", defMinutes: 0, defFixed: true, needTitle: true, needTime: true, durations: [15, 30, 60, 90] },
];
export const kindOf = (t: ActivityType): ActivityKind => KINDS.find((k) => k.type === t) ?? KINDS[6];

export const MIN_DUR = 5, MAX_DUR = 600;

export interface ActDraft { type: ActivityType; title: string; startTime: string; durationMinutes: number; fixed: boolean }
export type ActErrors = Partial<Record<"title" | "startTime" | "durationMinutes", string>>;

export function draftFor(type: ActivityType, a?: DayActivity): ActDraft {
  const k = kindOf(type);
  if (a) return { type: a.type, title: a.title, startTime: a.startTime ?? "", durationMinutes: a.durationMinutes, fixed: a.fixed };
  return { type, title: k.defTitle, startTime: "", durationMinutes: k.defMinutes, fixed: k.defFixed };
}

export function validate(d: ActDraft): ActErrors {
  const k = kindOf(d.type), e: ActErrors = {};
  if (!d.title.trim()) e.title = k.needTitle ? "Напиши, что это за дело" : "Название не может быть пустым";
  if (d.title.trim().length > 60) e.title = "Не длиннее 60 символов";
  if ((d.fixed || k.needTime) && !/^\d{2}:\d{2}$/.test(d.startTime)) e.startTime = d.fixed ? "Во сколько начинается? Без времени дело не встанет в план" : "Укажи время";
  if (!Number.isFinite(d.durationMinutes) || d.durationMinutes < MIN_DUR) e.durationMinutes = "Сколько длится? Минимум 5 минут";
  else if (d.durationMinutes > MAX_DUR) e.durationMinutes = "Не больше 10 часов";
  return e;
}

/** В контракт планировщика: обязательное с временем → стена; иначе — гибкое. */
export const toPersonal = (a: DayActivity): PersonalActivity => ({
  title: a.title, duration_minutes: a.durationMinutes,
  is_fixed: a.fixed && !!a.startTime, start_time: a.fixed && a.startTime ? a.startTime : null,
});

/** Дела из настроек/дневника → стартовый список дня (единожды за день). */
export function seedFrom(list: PersonalActivity[]): DayActivity[] {
  return list.filter((p) => p.duration_minutes > 0).map((p, i) => ({
    id: `s${i}-${p.title}`,
    type: /игр|пк|комп/i.test(p.title) ? "games" : /трен|секци/i.test(p.title) ? "sport" : /репет/i.test(p.title) ? "tutor" : "other",
    title: p.title, startTime: p.start_time ?? null, durationMinutes: p.duration_minutes,
    fixed: !!p.is_fixed && !!p.start_time, source: "settings",
  }));
}

export const newId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

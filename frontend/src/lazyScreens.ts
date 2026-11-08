/** v3.2 · PERF-01: экраны и шторки ученика, которые не нужны для первого кадра, — отдельные чанки.
 *  Шторки грузятся при первом открытии (when), остальное догружает lazyIdle() после первого экрана. */
import { lazy } from "./ui/lazy";

const open = (p: { open: boolean }) => p.open;
export const Tutor = lazy(() => import("./lazy/tabs").then((m) => m.Tutor));
export const Practice = lazy(() => import("./lazy/tabs").then((m) => m.Practice));
export const Blitz = lazy(() => import("./lazy/tabs").then((m) => m.Blitz));
export const WhatIf = lazy(() => import("./lazy/sheets").then((m) => m.WhatIf));
export const RescueCard = lazy(() => import("./lazy/sheets").then((m) => m.RescueCard));
export const TaskSheet = lazy(() => import("./lazy/sheets").then((m) => m.TaskSheet), { when: (p) => !!p.task });
export const Duel = lazy(() => import("./lazy/sheets").then((m) => m.Duel), { when: (p) => !!p.title });
export const ActivitySheet = lazy(() => import("./lazy/sheets").then((m) => m.ActivitySheet), { when: open });
export const AddTask = lazy(() => import("./lazy/sheets").then((m) => m.AddTask), { when: open });
export const ScheduleImport = lazy(() => import("./lazy/sheets").then((m) => m.ScheduleImport), { when: open });
export const ScheduleBuilder = lazy(() => import("./lazy/sheets").then((m) => m.ScheduleBuilder), { when: open });
export const EvidenceSheet = lazy(() => import("./lazy/sheets").then((m) => m.EvidenceSheet), { when: open });
export const BedtimeSheet = lazy(() => import("./lazy/sheets").then((m) => m.BedtimeSheet), { when: open });
export const WakeSheet = lazy(() => import("./lazy/sheets").then((m) => m.WakeSheet), { when: open });
export const QuizCodeSheet = lazy(() => import("./lazy/sheets").then((m) => m.QuizCodeSheet), { when: open });
export const PracticumSheet = lazy(() => import("./lazy/sheets").then((m) => m.PracticumSheet), { when: open });
export const JuryDrawer = lazy(() => import("./lazy/account").then((m) => m.JuryDrawer), { when: open });
export const ProfileHub = lazy(() => import("./lazy/account").then((m) => m.ProfileHub), { when: open });
export const MyClass = lazy(() => import("./lazy/account").then((m) => m.MyClass));
export const AccountSettings = lazy(() => import("./lazy/account").then((m) => m.AccountSettings));
export const ExternalAiNotice = lazy(() => import("./lazy/account").then((m) => m.ExternalAiNotice));
export const AccountConnections = lazy(() => import("./lazy/account").then((m) => m.AccountConnections));
export const DiaryWelcome = lazy(() => import("./lazy/account").then((m) => m.DiaryWelcome));

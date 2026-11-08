/**
 * Master v2.0 · Phase 3 — профиль как персональный центр: вход — аватар в верхней панели
 * (нижняя навигация остаётся из 4 разделов). Внутри: «Профиль» → «Статистика» / «Персонализация».
 * Назад: кнопка «‹ Профиль», системная «Назад» MAX/Telegram (bindBack) и Esc закрывает лист.
 */
import {RoleModeSwitch} from "./RoleModeSwitch";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { bindBack } from "../lib/host";
import { bgImage, usePersonal } from "../lib/personal";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";
import { Avatar, AvatarEditor } from "./Avatar";
import { IdentityCard } from "./ProfileSettings";
import { StatsScreen } from "./StatsScreen";
import { PersonalizationScreen } from "./PersonalizationScreen";

export type ProfileView = "home" | "stats" | "personal";
const TITLE: Record<ProfileView, string> = { home: "Профиль", stats: "Статистика", personal: "Персонализация" };

export function ProfileHub({ open, view, onView, onClose, eyebrow, roleLabel, name, stats, backgrounds = true, children }: {
  open: boolean; view: ProfileView; onView: (v: ProfileView) => void; onClose: () => void;
  eyebrow: string; roleLabel: string; name: string | null; stats: boolean; backgrounds?: boolean; children: ComponentChildren;
}) {
  usePersonal();
  const head = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!open || view === "home") return;
    return bindBack(() => onView("home"));                    // «Назад» MAX/Telegram: сначала в профиль, потом закрыть
  }, [open, view]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (open) requestAnimationFrame(() => head.current?.focus());   // смена экрана внутри листа — фокус на заголовок
  }, [view]);
  const cover = bgImage("cover");
  return <Sheet open={open} onClose={onClose} onAfterClose={() => onView("home")} eyebrow={view === "home" ? eyebrow : "Профиль"} title={TITLE[view]}>
    {view !== "home" && <div class="profile-subhead l-h l-g0 mb-3">
      <button type="button" class="btn btn-ghost btn-sm profile-back" onClick={() => onView("home")}><Icon name="chevron" />Профиль</button>
      <h2 ref={head} tabIndex={-1} class="sr">{TITLE[view]}</h2>
    </div>}
    {view === "home" && <>
      {cover && <div class="profile-cover b-box mb-3 has-photo" style={{ backgroundImage: `url("${cover.url}")` }} aria-hidden="true" />}
      <IdentityCard roleLabel={roleLabel} fallback={name} avatar={<Avatar name={name} size={72} />} />
      <RoleModeSwitch/>
      <AvatarEditor name={name} />
      <nav class="profile-nav l-v mb-6" aria-label="Разделы профиля">
        {stats && <button type="button" class="profile-row l-h l-g3 b-card l-w100" onClick={() => onView("stats")}>
          <span class="profile-row-ico l-center l-g0 f-a l-fix s-40 r-md u-acc-s"><Icon name="chart" /></span><span class="profile-row-text l-v l-g1 l-grow"><b>Статистика</b><small>Время учёбы, задания и блиц по дням</small></span><Icon name="chevron" />
        </button>}
        <button type="button" class="profile-row l-h l-g3 b-card l-w100" onClick={() => onView("personal")}>
          <span class="profile-row-ico l-center l-g0 f-a l-fix s-40 r-md u-acc-s"><Icon name="palette" /></span><span class="profile-row-text l-v l-g1 l-grow"><b>Персонализация</b><small>Тема, размер текста, шрифт, цвета{backgrounds ? ", фон" : ""}</small></span><Icon name="chevron" />
        </button>
      </nav>
      {children}
    </>}
    {view === "stats" && <StatsScreen />}
    {view === "personal" && <PersonalizationScreen backgrounds={backgrounds} />}
  </Sheet>;
}

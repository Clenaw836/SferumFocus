/** v2.1 · Реактивная синхронизация настроек профиля (размер шрифта, приватность оценок).
 *  Смена размера шрифта меняет только <html data-font-scale> и localStorage (lib/theme.ts) — без reload и без
 *  повторного /api/v1/auth/web-session. Сервер получает значение одним отложенным POST /api/v1/profile;
 *  сбой сети не откатывает выбор на устройстве и не затрагивает сессию. */
import { onboarding, type FontScale, type ProfilePatch, type UserProfile } from "./api";
import { DEMO } from "./demo";
import { isProfileAccount, principal } from "./roleContext";
import { hasLocalTextSize, setTextSize, textSizeFromScale } from "./theme";

const DEBOUNCE_MS = 600;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: ProfilePatch = {};
/** Есть ли у текущего входа серверный профиль v2.1 (см. isProfileAccount). Без него настройки живут только на устройстве. */
export const profileAccount = (): boolean => isProfileAccount(principal(), DEMO, location.protocol);

function flush(): void {
  timer = null;
  const patch = pending; pending = {};
  if (!Object.keys(patch).length || !profileAccount()) return;
  void onboarding.updateProfile(patch).catch(() => { /* оффлайн или сервер занят: выбор уже сохранён на устройстве */ });
}
/** Отложенная отправка: несколько быстрых переключений = один запрос. */
export function queueProfilePatch(patch: ProfilePatch): void {
  pending = { ...pending, ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}
export const syncFontScale = (scale: FontScale): void => queueProfilePatch({ font_scale: scale });
/** Новый телефон: если на устройстве размер ещё не выбирали — берём сохранённый в профиле. */
export function adoptProfileAppearance(profile: Pick<UserProfile, "font_scale">): void {
  if (hasLocalTextSize()) return;
  const z = textSizeFromScale(profile.font_scale);
  if (z && z !== "m") setTextSize(z);
}

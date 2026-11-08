/** Открыть визард подключения дневника из любого места приложения (карточка «Подключить дневник», профиль, пустые состояния).
 *  v3.2 · PERF-01: вынесено из ui/DiaryWelcome.tsx, чтобы шторка входа грузилась отдельным чанком. */
export const OPEN_ONBOARDING_EVENT = "sf-open-onboarding";
export const openOnboarding = (): void => { document.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT)); };

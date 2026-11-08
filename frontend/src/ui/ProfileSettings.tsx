/**
 * Профиль и настройки (одинаково у ученика и учителя, не в таб-баре):
 *  • ФИО и школа — только из доверенного источника сервера (whoami.profile) с подписью источника;
 *  • смена аккаунта — честно по типу входа (песочница, браузерная сессия, MAX, старое демо);
 *  • оформление — тёмная/светлая тема и «Повышенная различимость», выбор вручную.
 */
import { ThemeAndA11yController } from "./ThemeAndA11yController";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { principal, type IdentityProfile } from "../lib/roleContext";
import { initialsOf } from "../lib/avatar";
import { accountKey, forgetDevice, invalidateIdentity } from "../lib/identity";
import { ApiError, connectionRequest, onboarding } from "../lib/api";
import { fontScaleName, setHighContrast, setTextSize, useAppearance, type TextSize } from "../lib/theme";
import { profileAccount, queueProfilePatch, syncFontScale } from "../lib/profileSync";
import { PersonaSwitch } from "./SandboxBar";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { Segmented } from "./Segmented";

const SOURCE: Record<NonNullable<IdentityProfile["source"]>, string> = {
  demo_sandbox: "Вымышленный персонаж демо",
  school_directory: "Справочник школы",
  sgo: "Сетевой город · школьный дневник",
  class_roster: "Подтверждено учителем",
  max: "Профиль MAX · подпись проверена",
};

/** Имя для приветствия: в школьных списках порядок «Фамилия Имя», в MAX — «Имя Фамилия». */
import { verifiedProfile } from "../lib/profileName";
export { shortName, verifiedProfile } from "../lib/profileName";

export function IdentityCard({ roleLabel, fallback, avatar }: { roleLabel: string; fallback?: string | null; avatar?: ComponentChildren }) {
  const p = verifiedProfile();
  const name = p?.full_name ?? fallback ?? null;
  return <section class="profile-identity l-h l-g4 profile-verified" aria-label="Профиль">
    {avatar ?? <span class="profile-monogram l-center l-g0 f-xl b-box" aria-hidden="true">{initialsOf(name) || <Icon name="user" />}</span>}
    <div>
      <h2>{name ?? "Имя не подтверждено"}</h2>
      <p class="f-2">{roleLabel}{p?.school ? ` · ${p.school}` : ""}{p?.classes?.length ? ` · ${p.classes.length > 1 ? "классы" : "класс"} ${p.classes.join(", ")}` : ""}</p>
      <p class={`profile-source l-h l-top l-g1 f-m f-3 mt-1${p?.verified ? " is-verified" : ""}${p?.synthetic ? " is-synthetic" : ""}`}>
        <Icon name={p?.verified ? "check" : "info"} />
        <span>{p?.source ? SOURCE[p.source] : "Источник не подтверждён"}{p?.note ? ` — ${p.note}` : !p && fallback ? " — имя из приложения-хоста, сервер его не подтверждал" : ""}</span>
      </p>
    </div>
  </section>;
}

export function AppearanceSettings() {
  const ap = useAppearance();
  return <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="appearance-h">
    <h3 id="appearance-h">Оформление и доступность</h3>
    <ThemeAndA11yController />
    <Segmented<TextSize> label="Размер текста" value={ap.textSize} onChange={(z: TextSize) => { setTextSize(z); syncFontScale(fontScaleName(z)); }} options={[{ value: "m", label: "Обычный" }, { value: "l", label: "Крупнее" }, { value: "xl", label: "Крупный" }]} />
    <label class="switch-row">
      <input type="checkbox" role="switch" checked={ap.highContrast} onChange={(e) => setHighContrast((e.currentTarget as HTMLInputElement).checked)} />
      <span class="switch-track" aria-hidden="true"><i /></span>
      <span class="switch-text"><b>Повышенная различимость</b><small>Контрастнее текст и рамки, крупнее кнопки и фокус. Статусы подписаны значками, цвета различимы при нарушениях цветовосприятия, анимации выключены.</small></span>
    </label>
    <GradesPrivacy />
    <p class="hint-text">Тема и размер текста меняются мгновенно, без перезагрузки, и сохраняются на этом устройстве и в профиле.</p>
  </section>;
}
/** v2.1: скрытие оценок — только явный выбор пользователя (profile.hide_grades), не настройка уведомлений. */
function GradesPrivacy() {
  const account = profileAccount();
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    if (!account) return;
    let live = true;
    void onboarding.profile().then((p) => { if (live) setHidden(p.hide_grades); }).catch(() => { /* оффлайн: переключатель скрыт */ });
    return () => { live = false; };
  }, [account]);
  if (!account || hidden === null) return null;
  return <label class="switch-row">
    <input type="checkbox" role="switch" checked={hidden} onChange={(e) => { const v = (e.currentTarget as HTMLInputElement).checked; setHidden(v); queueProfilePatch({ hide_grades: v }); }} />
    <span class="switch-track" aria-hidden="true"><i /></span>
    <span class="switch-text"><b>Скрывать оценки на экране</b><small>Например, если телефон видят другие. Оценки не удаляются — их можно показать в любой момент.</small></span>
  </label>;
}

function clearLocalAccount(): void {
  const prefix = accountKey("");
  try { Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)); } catch { /* приватный режим */ }
}
function restart(href = location.href): void { invalidateIdentity(); location.replace(href); }
/** v2.2: смена аккаунта СГО — стираем локальные копии дневника этого аккаунта, но не оформление (ui.*). */
function clearLocalDiary(): void {
  const prefix = accountKey(""), keep = accountKey("ui.");
  try { Object.keys(localStorage).filter((k) => k.startsWith(prefix) && !k.startsWith(keep)).forEach((k) => localStorage.removeItem(k)); } catch { /* приватный режим */ }
}

/** v2.2 · «Аккаунт СГО» в профиле: какой дневник подключён и «Выйти / Сменить аккаунт СГО».
 *  Нижнее меню не трогаем — всё про аккаунты живёт здесь. Несколько аккаунтов СГО сразу пока не поддерживаются. */
function SgoAccount() {
  const [p, setP] = useState<{ school: string | null; connected: boolean } | null>(null);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // /api/v1/profile есть только у проверенного аккаунта платформы: иначе 401, а любой 401 сбрасывает вход
    // («Сессия изменилась»). Регрессия v2.2 найдена e2e phase3e_journeys и harness MAX.
    if (!profileAccount()) return;
    let live = true;
    onboarding.profile().then((x) => { if (live) setP({ school: x.school_name, connected: !!x.scid && x.onboarding_completed }); }).catch(() => { if (live) setP(null); });
    return () => { live = false; };
  }, []);
  if (!p?.connected) return null;
  const run = async () => {
    setBusy(true);
    try {
      await onboarding.logout();
      clearLocalDiary();
      restart(location.href.split("#")[0]);
    } catch (e) { toast(e instanceof Error ? e.message : "Не получилось выйти из СГО", "warn"); setBusy(false); }
  };
  return <div class="sgo-acc pt-3 l-v mt-3" role="group" aria-labelledby="sgo-acc-h">
    <p class="sgo-acc-row l-h l-g3"><span class="sgo-acc-ico l-center l-g0 f-a l-fix s-40 r-md" aria-hidden="true"><Icon name="book" /></span>
      <span class="sgo-acc-text l-v l-g1"><b id="sgo-acc-h">Сетевой город</b><small>{p.school ?? "Школьный дневник подключён"}</small></span></p>
    {ask
      ? <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label="Выйти из СГО"><p class="f-2">Отключить дневник «Сетевой город»? С сервера удалятся сессия СГО, ФИО из дневника и сохранённые оценки; аккаунт приложения и оформление останутся. Потом можно войти в другой аккаунт СГО.</p>
          <div class="hw-row-actions l-h l-wrap">
            <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={run}>{busy ? "Выходим…" : "Выйти из СГО"}</button>
            <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsk(false)}>Отмена</button></div></div>
      : <button type="button" class="btn btn-ghost btn-block sgo-acc-out" onClick={() => setAsk(true)}><Icon name="logout" />Выйти / Сменить аккаунт СГО</button>}
    <p class="hint-text">Несколько аккаунтов СГО одновременно пока не поддерживаются: смена — это выход и новый вход через мастер подключения.</p>
  </div>;
}

export function AccountSettings() {
  const w = principal();
  const [ask, setAsk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!w) return null;
  const confirmRow = (key: string, text: string, yes: string, run: () => void | Promise<void>) => ask === key
    ? <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label={yes}><p class="f-2">{text}</p><div class="hw-row-actions l-h l-wrap">
        <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setBusy(true); Promise.resolve(run()).catch((e) => { toast(e instanceof Error ? e.message : "Не получилось", "warn"); setBusy(false); }); }}>{yes}</button>
        <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsk(null)}>Отмена</button></div></div>
    : null;
  let body;
  if (w.sandbox) body = <><p class="hint-text">Демонстрация на сервере: аккаунтов здесь нет, роль и персонажа выдаёт сервер. Переключайтесь между учителем и учениками — данные общие для этой песочницы.</p><PersonaSwitch /></>;
  else if (w.auth === "web" || w.auth === "telegram") body = <>
    <p class="hint-text">{w.auth === "telegram" ? "Вход через Telegram" : "Вход в браузере"}: на этом устройстве открыт один аккаунт. Чтобы войти в другой, выйдите — откроется новая пустая сессия; к прежнему аккаунту можно вернуться через подключённый MAX или Telegram.</p>
    {confirmRow("logout", "Выйти на этом устройстве? Локальные копии данных этого аккаунта будут удалены с устройства; на сервере всё сохранится.", "Выйти", async () => {
      await connectionRequest("/api/v1/auth/logout", {});
      clearLocalAccount(); restart(location.href.split("#")[0]);
    }) ?? <button type="button" class="btn btn-secondary btn-block" onClick={() => setAsk("logout")}><Icon name="lock" />Выйти из аккаунта</button>}
  </>;
  else if (w.auth === "max") body = <>
    <p class="hint-text">Вход через MAX: аккаунт определяет MAX по подписи запуска. Чтобы открыть другой аккаунт, запустите приложение в MAX под ним — смешивания данных не будет.</p>
    {confirmRow("forget", "Удалить с этого устройства локальные копии данных этого аккаунта? На сервере ничего не удаляется.", "Удалить с устройства", () => { clearLocalAccount(); restart(); })
      ?? <button type="button" class="btn btn-ghost btn-block" onClick={() => setAsk("forget")}><Icon name="trash" />Забыть данные на этом устройстве</button>}
  </>;
  else body = <>
    <p class="hint-text">Демо-режим браузера: анонимный профиль выдан и подписан сервером. Новый профиль — чистые демо-данные; для жюри удобнее «Живая демонстрация».</p>
    {confirmRow("rotate", "Создать новый демо-профиль? Текущие демо-данные этого браузера станут недоступны.", "Новый профиль", () => {
      clearLocalAccount();
      forgetDevice();          // the server mints a fresh signed demo profile on the next start
      restart();
    }) ?? <button type="button" class="btn btn-ghost btn-block" onClick={() => setAsk("rotate")}><Icon name="refresh" />Новый демо-профиль</button>}
  </>;
  return <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="account-h"><h3 id="account-h">Аккаунт</h3>{body}{!w.sandbox && profileAccount() && <SgoAccount />}</section>;
}

/** v2.5 · Явное индивидуальное управление согласием на передачу текста внешнему ИИ.
 *  Статус читается только с сервера; запись выполняется только после действия пользователя.
 *  Внешний ИИ дополнительно зависит от серверного feature flag и настроенного правового основания.
 */
type AiConsentState = {
  granted: boolean;
  policy_version: string;
  external_ai_enabled?: boolean;
  legal_basis_configured?: boolean;
  scenarios?: string[];
  media_forbidden?: boolean;
};
const AI_CONSENT_POLICY = "ai-external-v2";

export function ExternalAiNotice() {
  const [isGranted, setIsGranted] = useState(false);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    void connectionRequest<AiConsentState>("/api/v1/ai/consent", undefined, controller.signal, "GET")
      .then((state) => {
        if (!live) return;
        setIsGranted(state.granted === true && state.policy_version === AI_CONSENT_POLICY);
        setAvailable(state.external_ai_enabled === true && state.legal_basis_configured === true);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live || controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Не удалось загрузить настройки внешнего ИИ.");
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, []);

  const changeConsent = async (next: boolean) => {
    if (saving || loading || !available) return;
    setSaving(true);
    setError(null);
    try {
      const state = await connectionRequest<AiConsentState>("/api/v1/ai/consent", {
        granted: next, policy_version: AI_CONSENT_POLICY,
      }, undefined, "PUT");
      setIsGranted(state.granted === true && state.policy_version === AI_CONSENT_POLICY);
      setAvailable(state.external_ai_enabled === true && state.legal_basis_configured === true);
      toast(state.granted ? "Согласие сохранено" : "Согласие отозвано", "ok");
    } catch (e: unknown) {
      const message = e instanceof ApiError && e.status === 409
        ? "Текст согласия изменился. Обновите приложение и ознакомьтесь с актуальными условиями."
        : e instanceof Error ? e.message : "Не удалось сохранить настройку. Попробуйте ещё раз.";
      setError(message);
      toast(message, "warn");
    } finally { setSaving(false); }
  };

  const locked = loading || saving || !available;
  return <section class="settings-block l-v l-g3 b-card mt-4 ai-consent" aria-labelledby="ai-consent-h">
    <h3 id="ai-consent-h">Внешний ИИ</h3>
    <p class="ai-consent-state l-h f-m f-2 mb-2" role="status">
      <Icon name={isGranted ? "check" : "lock"} />
      <span><b>{isGranted ? "Согласие предоставлено" : "Согласие не предоставлено"}</b> · {isGranted ? "текстовые запросы могут обрабатываться внешним ИИ при выполнении серверных проверок" : "внешний ИИ не получает ваши запросы"}</span>
    </p>
    <ul class="ai-consent-facts l-v l-g1 f-m f-2 mb-2">
      <li>При включении выбранные текстовые запросы тьютора могут передаваться провайдеру Groq (США) для обработки. Не отправляйте в запросах персональные данные, пароли и другую конфиденциальную информацию.</li>
      <li>Фотографии и голосовые записи во внешний ИИ не отправляются. Сервер дополнительно проверяет разрешённый сценарий, чувствительные данные и размер текста.</li>
      <li>Переключатель сохраняет ваш индивидуальный выбор. Для несовершеннолетнего пользователя согласие должно быть оформлено надлежащим образом законным представителем, если это требуется применимыми правилами.</li>
    </ul>
    <label class={`switch-row${locked ? " is-locked" : ""}`}>
      <input type="checkbox" role="switch" checked={isGranted} disabled={locked} aria-describedby="ai-consent-why"
        onChange={(e) => { void changeConsent((e.currentTarget as HTMLInputElement).checked); }} />
      <span class="switch-track" aria-hidden="true"><i /></span>
      <span class="switch-text"><b>Разрешить отправку текста во внешний ИИ</b><small id="ai-consent-why">{loading ? "Загружаем настройку…" : saving ? "Сохраняем…" : !available ? "Функция пока выключена на сервере или правовое основание не настроено." : "Вы можете отозвать согласие в любой момент."}</small></span>
    </label>
    {error && <p class="note warn" role="alert">{error}</p>}
  </section>;
}

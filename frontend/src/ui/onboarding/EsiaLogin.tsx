import { useEffect, useRef, useState } from "preact/hooks";
import { connectionRequest } from "../../lib/api";
import { handoffExternalUrl } from "../../lib/handoff";
import { hostAuthLinkAvailable, openAuthLink } from "../../lib/auth_window";
import { TwoFactorModal } from "../TwoFactorModal";
import { Icon } from "../Icon";

/** v3.2 · Шаг 3 мастера: главная кнопка «Войти через Госуслуги (ЕСИА)».
 *  oauth   — OAuth 2.0 + PKCE (S256) через региональный шлюз (app/sgo_oauth.py) → callback → сессия СГО в
 *            EncryptedDiaryVault → статус connected → дневник открывается в приложении;
 *  sandbox — встроенное окно подтверждения /diary-sandbox (только SFERUM_ENV=test|demo и SFERUM_ESIA_SANDBOX=1):
 *            тестовый код 2FA, реальный дневник не подключается — после проверки открывается демо-дневник.
 *  Если шлюз не настроен оператором, кнопка честно говорит об этом и предлагает вход по логину и паролю СГО. */
type Caps = { oauth_configured: boolean; sandbox_enabled: boolean };
type Flow = { challenge_id: string; status: string; demo: boolean; expires_in: number; authorization_url?: string };
export function EsiaLogin({ onConnected, onSandboxDone, onPassword }: { onConnected: () => void; onSandboxDone: () => void; onPassword?: () => void }) {
  const [caps, setCaps] = useState<Caps | null>(null), [flow, setFlow] = useState<Flow | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [note, setNote] = useState(""), [waiting, setWaiting] = useState(false), [left, setLeft] = useState(0), [sandboxOk, setSandboxOk] = useState(false);
  const deadline = useRef(0), alive = useRef(true);
  const call = (path: string, body?: unknown) => connectionRequest("/api/v1/diary/auth/" + path, body);
  useEffect(() => { alive.current = true; void call("capabilities?method=gosuslugi_esia").then((c: Caps) => { if (alive.current) setCaps(c); }).catch(() => { if (alive.current) setCaps({ oauth_configured: false, sandbox_enabled: false }); }); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!flow) return; let active = true;
    const tick = () => {
      if (!active) return; setLeft(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
      if (Date.now() >= deadline.current) { setFlow(null); setWaiting(false); setError("Время входа истекло. Начните заново."); return; }
      void call("status/" + encodeURIComponent(flow.challenge_id)).then((d: Flow) => {
        if (!active || !alive.current) return;
        if (d.status === "connected") { setFlow(null); setWaiting(false); if (d.demo) { setSandboxOk(true); setNote("Тестовый вход через Госуслуги пройден. В тестовом контуре реальный дневник не подключается."); } else onConnected(); }
        else if (["failed", "cancelled", "expired", "locked"].includes(d.status)) { setFlow(null); setWaiting(false); setError(d.status === "locked" ? "Слишком много неверных кодов. Начните вход заново." : "Вход не завершён. Начните заново."); }
      }).catch(() => {});
    };
    const t = setInterval(tick, 2000); tick();
    return () => { active = false; clearInterval(t); };
  }, [flow?.challenge_id]);
  const start = () => {
    if (busy || !caps) return;
    if (!caps.oauth_configured && !caps.sandbox_enabled) { setError(""); setNote("Вход через Госуслуги для вашей школы ещё не включён: региональный оператор не выдал реквизиты шлюза. Войдите по логину и паролю СГО — их выдаёт школа."); return; }
    const mode = caps.oauth_configured ? "oauth" : "sandbox";
    const popup = !hostAuthLinkAvailable() ? window.open("about:blank", "_blank") : null; if (popup) popup.opener = null;
    setBusy(true); setError(""); setNote("");
    void call("esia/start", { mode }).then((d: Flow) => {
      const url = d.authorization_url; if (!url) throw new Error("Шлюз не вернул адрес входа");
      const safe = handoffExternalUrl(url, location.origin);
      if (popup && !popup.closed) popup.location.replace(safe); else if (hostAuthLinkAvailable()) openAuthLink(safe); else throw new Error("Разрешите открытие окна входа и повторите.");
      deadline.current = Date.now() + d.expires_in * 1000; setLeft(d.expires_in); setFlow(d); setWaiting(mode === "sandbox");
      if (mode === "oauth") setNote("Завершите вход на официальном сайте Госуслуг — дневник откроется здесь автоматически.");
    }).catch((e: unknown) => { popup?.close(); setError(e instanceof Error ? e.message : "Не удалось начать вход"); }).finally(() => { if (alive.current) setBusy(false); });
  };
  const cancel = () => { const f = flow; setFlow(null); setWaiting(false); if (f) void call("cancel", { challenge_id: f.challenge_id }).catch(() => {}); };
  return <div class="ob-esia-login">
    <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-cta ob-esia-go" onClick={start} disabled={busy || !caps} aria-busy={busy}>
      <Icon name="shield" />Войти через Госуслуги (ЕСИА)</button>
    {onPassword && <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-btn-secondary b-box b-nob ob-pw-go" onClick={onPassword}>Войти по логину и паролю СГО</button>}
    {flow && !waiting && <p class="ob-note f-b f-3" role="status">Ждём подтверждения на Госуслугах · {left} с <button type="button" class="ob-link f-b f-a mt-1" onClick={cancel}>Отменить</button></p>}
    {note && <p class="ob-note f-b f-3" role="status">{note}</p>}
    {sandboxOk && <button type="button" class="ob-btn p-34 l-v l-inl l-jc l-g0 l-ac f-s f-tc b-tap l-w100 l-rel u-acc r-lg ob-btn-secondary b-box b-nob" onClick={onSandboxDone}>Открыть демо-дневник</button>}
    {error && <p class="ob-error l-v l-g1 f-b f-bad r-lg u-bad-s p-3" role="alert">{error}</p>}
    <TwoFactorModal resendIn={60} onResend={() => { if (flow) void call("resend-2fa", { challenge_id: flow.challenge_id }).catch((e: Error) => setError(e.message)); }}
      open={waiting} mode="sandbox" status={flow?.status || ""} expires={left} error={error} onClose={cancel}
      onReopen={() => { if (flow?.authorization_url) openAuthLink(flow.authorization_url); }}
      onVerify={(code) => { if (flow) void call("esia/verify-2fa", { challenge_id: flow.challenge_id, code }).then((d: Flow) => { if (d.status === "connected") { setWaiting(false); setFlow(null); setSandboxOk(true); setNote("Тестовый вход через Госуслуги пройден. В тестовом контуре реальный дневник не подключается."); } }).catch((e: Error) => setError(e.message)); }}
      onConfirm={() => {}} />
  </div>;
}

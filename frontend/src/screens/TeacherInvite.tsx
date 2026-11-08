/** v2.4 Step 1 · одноразовое приглашение учителя (вместо удалённого общего TEACHER_TOKEN).
 *  Код выдаёт оператор сервера (scripts/teacher_invites.py); принять его может только пользователь MAX,
 *  чья подпись launch-данных проверена сервером. Код не сохраняется в браузере и не логируется. */
import { useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";

const CODE = /^[A-Za-z0-9 _-]{8,64}$/;

export function TeacherInvite({ onBound }: { onBound: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const valid = CODE.test(code.trim());
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setMsg(null);
    try {
      await api.tm.redeemInvite(code.trim());
      setCode("");
      onBound();
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      setMsg(s === 401 ? "Откройте приложение в MAX — приглашение принимается только там."
        : s === 429 ? "Слишком много попыток. Попробуйте позже."
        : s === 409 ? "Этот аккаунт MAX уже привязан к профилю учителя. Обратитесь к администратору школы."
        : s === 403 ? "Код недействителен, истёк или уже использован."
        : "Не удалось проверить код. Проверьте связь и попробуйте ещё раз.");
    } finally { setBusy(false); }
  };
  return (
    <form class="tm-invite l-v mt-4 mb-2 l-mx l-w100" onSubmit={submit} aria-labelledby="tm-invite-h" noValidate>
      <h4 id="tm-invite-h">Есть код приглашения?</h4>
      <p class="faint tm-small f-m">Код выдаёт администратор школы. Он одноразовый и действует ограниченное время.</p>
      <label class="field"><span class="field-label">Код приглашения</span>
        <input class="input" name="invite" value={code} maxLength={64} autoComplete="one-time-code" autoCapitalize="characters"
          spellcheck={false} inputMode="text" placeholder="SFT-XXXX-XXXX-XXXX-XXXX" aria-invalid={msg ? "true" : undefined}
          aria-describedby={msg ? "tm-invite-err" : undefined} onInput={(e) => { setCode(e.currentTarget.value); setMsg(null); }}/></label>
      {msg && <span id="tm-invite-err" class="field-err" role="alert">{msg}</span>}
      <button type="submit" class="btn btn-primary btn-block" disabled={!valid || busy} aria-busy={busy}>{busy ? "Проверяем…" : "Подтвердить"}</button>
    </form>
  );
}

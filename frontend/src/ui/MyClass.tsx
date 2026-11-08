/**
 * Recovery 2: «Мой класс» — the student joins a teacher's class with the code the teacher shows.
 * The teacher approves the request; only then do assignments appear in the evening plan.
 * Every command carries an operation id; a retry after an unknown outcome reuses it (no duplicates).
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { createOnce } from "../lib/assignmentSync";
import { normalizeClassCode } from "../lib/hwFormat";
import type { HwMembership } from "../lib/hwTypes";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const once = createOnce();
const STATUS: Record<HwMembership["status"], string> = {
  pending: "Ждёт подтверждения учителя",
  active: "Вы в классе — задания приходят в план дня",
  rejected: "Учитель отклонил заявку. Проверьте код и имя",
  removed: "Учитель убрал вас из класса",
  left: "Вы вышли из класса",
};
const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : "Не удалось выполнить запрос");
export function MyClass({ server, onChanged, initialCode = "" }: { server: boolean; onChanged: () => void; initialCode?: string }) {
  const [list, setList] = useState<HwMembership[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(() => normalizeClassCode(initialCode));
  useEffect(() => { if (initialCode) setCode(normalizeClassCode(initialCode)); }, [initialCode]);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => api.hw.classes().then((r) => { setList(r.memberships); setErr(""); }).catch((e) => { setList((l) => l ?? []); setErr(errText(e)); });
  useEffect(() => { if (server) void load(); }, [server]);

  const pretty = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  const nameOk = name.trim().replace(/\s+/g, " ").length >= 2;
  const join = async (e: Event) => {
    e.preventDefault();
    if (busy || code.length < 4 || !nameOk) return;
    setBusy(true); setErr("");
    try {
      const display = name.trim().replace(/\s+/g, " ");
      const r = await once.run(`join|${code}|${display}`, (op) => api.hw.join(code, display, op));
      toast(r.membership.status === "active" ? `Вы уже в классе ${r.membership.class}` : `Заявка в ${r.membership.class} отправлена учителю`, "ok");
      setCode(""); await load();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  const leave = async (m: HwMembership) => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await once.run(`leave|${m.membership_id}`, (op) => api.hw.leave(m.membership_id, op));
      toast(r.revoked_issues ? `Вы вышли из ${m.class}. Открытые задания (${r.revoked_issues}) отозваны` : `Вы вышли из ${m.class}`, "info");
      setConfirm(null); await load(); onChanged();
    } catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };

  return <section class="my-class l-v l-g3 b-card mt-6 mb-6" aria-labelledby="my-class-title" aria-busy={busy}>
    <div class="my-class-head l-h l-g3"><span class="my-class-mark l-center l-g0 f-a l-fix s-40 r-lg u-sel" aria-hidden="true"><Icon name="users" /></span><div><h3 id="my-class-title">Мой класс</h3><p class="f-3">Задания от учителя — прямо в план дня</p></div></div>
    {!server ? <div class="note"><Icon name="info" /><div><b>Нужен сервер.</b> Задания учителя хранятся на сервере школы. В автономной DEMO-копии вступить в класс нельзя — здесь ничего не имитируется.</div></div> : <>
      {list === null ? <div class="sk" style="height:64px" aria-label="Загружаем классы" /> : list.length > 0 && <ul class="my-class-list l-v" aria-label="Мои классы">
        {list.map((m) => <li key={m.membership_id} class={`my-class-row l-h l-btw l-wrap b-card is-${m.status}`}>
          <div class="my-class-main l-h l-base l-wrap l-g1">
            <b>{m.class}</b><span class="f-2">{m.teacher_name ?? "Учитель"}</span>
            <small><i aria-hidden="true" style={{ background: m.status === "active" ? "var(--hw-progress)" : m.status === "pending" ? "var(--hw-paused)" : "var(--bad)" }} />{STATUS[m.status]} · как «{m.display_name}»</small>
          </div>
          {(m.status === "active" || m.status === "pending") && (confirm === m.membership_id
            ? <div class="my-class-confirm l-h l-wrap" role="group" aria-label={`Подтвердите выход из ${m.class}`}>
                <p class="f-2">{m.status === "active" ? "Открытые задания этого класса будут отозваны. Учитель увидит выход." : "Заявка будет отменена."}</p>
                <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={() => void leave(m)}>{m.status === "active" ? "Да, выйти" : "Да, отменить"}</button>
                <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm(null)}>Остаться</button>
              </div>
            : <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm(m.membership_id)}>{m.status === "active" ? "Выйти" : "Отменить заявку"}</button>)}
        </li>)}
      </ul>}
      {err && <p class="field-err" role="alert">{err}</p>}
      <form class="my-class-join l-v l-g3" onSubmit={join} noValidate>
        <label class="field"><span class="field-label">Код класса от учителя</span>
          <input class="input num" name="class-code" autoComplete="off" autoCapitalize="characters" spellcheck={false} inputMode="text" maxLength={16}
            placeholder="ABCD-2345" value={pretty} onInput={(e) => setCode(normalizeClassCode((e.currentTarget as HTMLInputElement).value))} /></label>
        <label class="field"><span class="field-label">Имя и фамилия для учителя</span>
          <input class="input" name="class-display-name" autoComplete="name" maxLength={60} value={name} aria-invalid={name.length > 0 && !nameOk}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} /></label>
        <p class="hint-text">Имя видит только учитель этого класса — по нему он подтвердит заявку. Код действует 7 дней.</p>
        <button type="submit" class="btn btn-primary btn-block" disabled={busy || code.length < 4 || !nameOk}>{busy ? "Отправляем…" : "Отправить заявку"}</button>
      </form>
    </>}
  </section>;
}

/**
 * «Живая демонстрация»: постоянная плашка — кто вы в песочнице и переход учитель ↔ ученик.
 * Персонажа меняет сервер (новый подписанный токен), клиент не выбирает ни id, ни роль.
 */
import { useState } from "preact/hooks";
import { principal } from "../lib/roleContext";
import { endSandbox, startSandbox, switchPersona } from "../lib/demoSession";
import type { SandboxPersona } from "../lib/sandbox";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const minutes = (n: number) => (n >= 120 ? `${Math.round(n / 60)} ч` : `${n} мин`);

export function usePersonaActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try { await f(); } catch (e) { toast(e instanceof Error && e.message ? e.message : "Не получилось — попробуйте ещё раз", "warn"); setBusy(null); }
  };
  return { busy, open: (p: SandboxPersona) => run(p.id, () => switchPersona(p.id)), restart: () => run("restart", () => startSandbox("teacher")), end: () => run("end", endSandbox) };
}

export function PersonaSwitch() {
  const sb = principal()?.sandbox;
  const a = usePersonaActions();
  if (!sb) return null;
  return <div class="sandbox-body l-v l-g3">
    <div class="sandbox-personas l-fit" role="group" aria-label="Открыть демонстрацию как">
      {sb.personas.filter((p) => p.id !== sb.persona.id).map((p) => <button key={p.id} type="button" class="sandbox-persona l-h l-g3 b-tile b-tap" disabled={!!a.busy} onClick={() => void a.open(p)}>
        <Icon name={p.role === "teacher" ? "cap" : "user"} />
        <span class="l-v l-g0"><b>{a.busy === p.id ? "Открываем…" : p.full_name}</b><small class="f-2">{p.role === "teacher" ? "Учитель" : "Ученик"} · {p.label}</small></span>
      </button>)}
    </div>
    <div class="hw-row-actions l-h l-wrap">
      <button type="button" class="btn btn-ghost btn-sm" disabled={!!a.busy} onClick={() => void a.restart()}><Icon name="refresh" />{a.busy === "restart" ? "Создаём…" : "Начать заново"}</button>
      <button type="button" class="btn btn-ghost btn-sm" disabled={!!a.busy} onClick={() => void a.end()}><Icon name="x" />{a.busy === "end" ? "Завершаем…" : "Завершить и удалить данные"}</button>
    </div>
  </div>;
}

/** v3.0: вход в демо-инструменты — одна капсула «Демо жюри» в шапке; плашка оставляет только честное «вы в песочнице» и смену роли. */
export function SandboxBar() {
  const sb = principal()?.sandbox;
  if (!sb) return null;
  const left = Math.max(0, Math.round((sb.expires_at * 1000 - Date.now()) / 60000));
  return <aside class="sandbox-bar" aria-label="Живая демонстрация">
    <details class="sandbox-controls b-box">
      <summary class="l-wrap b-tap p-23">
        <span class="sandbox-tag b-pill u-acc">DEMO · живая</span>
        <span class="sandbox-who l-v l-g0 l-grow"><b class="f-trunc">{sb.persona.full_name}</b><small class="f-trunc f-2">{sb.persona.role === "teacher" ? "Учитель" : "Ученик"} · {sb.class} · {sb.school}</small></span>
        <span class="sandbox-more l-h l-g1 l-fix f-a f-w6">Сменить роль<Icon name="chevron" /></span>
      </summary>
      <p class="hint-text px-3 mb-2">{sb.notice} Песочница закроется примерно через {minutes(left)}.</p>
      <PersonaSwitch />
    </details>
  </aside>;
}

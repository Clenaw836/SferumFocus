/**
 * v2.2 · «Опрос по коду учителя»: ученик вводит 6 цифр с экрана в классе (или сканирует QR камерой MAX).
 * Код — только навигация: ищем среди СВОИХ выданных опросов (локальный снимок, затем сервер). Если опроса
 * с таким кодом у ученика нет — честно говорим почему, ничего не «подбираем».
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { canScanCode, parseStart, scanCode, startFromLink } from "../lib/host";
import { hwInfos } from "../lib/hwSync";
import type { TeacherAssignment } from "../lib/hwTypes";
import { matchPin, normalizePin, pinGroups } from "../lib/quizCode";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

type Found = Pick<TeacherAssignment, "issue_id" | "template_id" | "title" | "subject" | "kind" | "status">;
type Msg = { kind: "warn" | "info"; text: string } | null;

/** Свои опросы: сначала снимок на устройстве, при промахе — свежий список с сервера (новый опрос мог прийти минуту назад). */
export async function findQuiz(match: (x: Found) => boolean): Promise<Found[] | null> {
  const local = (hwInfos() as Found[]).filter((x) => x.kind === "quiz" && match(x));
  if (local.length) return local;
  try {
    const r = await api.hw.mine();
    return (r.assignments as Found[]).filter((x) => x.kind === "quiz" && match(x));
  } catch { return null; }
}

export const NOT_FOUND = "Опроса с таким кодом нет в твоём плане. Проверь цифры или попроси учителя выдать опрос тебе: код работает только у учеников его класса.";
export const NOT_FOUND_LINK = "Этого опроса нет в твоём плане: учитель выдаёт опрос ученикам своего класса. Попроси его проверить, что ты есть в списке.";
export const OFFLINE = "Нет связи с сервером — опрос откроется, когда появится интернет. Если ты пишешь на листочке, учитель отметит работу сам.";

/** V23 · форма кода опроса вынесена из шторки: та же форма стоит сверху на экране «Практика».
 *  demo: в демо-копии нет опросов учителя — честно говорим это, ничего не ищем. */
export function QuizCodeForm({ onOpenIssue, onDone, demo = false, inline = false }: { onOpenIssue: (issueId: string) => void; onDone?: () => void; demo?: boolean; inline?: boolean }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [choices, setChoices] = useState<Found[] | null>(null);
  const open = (id: string) => { onDone?.(); onOpenIssue(id); };
  const go = (list: Found[] | null, missing = NOT_FOUND) => {
    if (list === null) { setMsg({ kind: "warn", text: OFFLINE }); return; }
    const live = list.filter((x) => x.status !== "revoked");
    if (live.length === 1) { open(live[0].issue_id); return; }
    if (live.length > 1) { setChoices(live); return; }
    setMsg({ kind: "info", text: list.length ? "Учитель отозвал этот опрос — его больше нет в плане." : missing });
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    const p = normalizePin(pin);
    if (p.length !== 6) { setMsg({ kind: "warn", text: "Код опроса — 6 цифр, их показывает учитель на экране." }); return; }
    if (demo) { setMsg({ kind: "info", text: DEMO_NOTE }); return; }
    setBusy(true); setMsg(null); setChoices(null);
    const found = await findQuiz((x) => matchPin(p, [x]).length > 0);
    setBusy(false);
    go(found);
  };
  const scan = async () => {
    setMsg(null); setChoices(null);
    const text = await scanCode();
    if (text === null) return;                          // отмена сканирования — молча, как в любом сканере
    const sp = parseStart(startFromLink(text));
    if (sp.kind !== "quiz") { setMsg({ kind: "warn", text: "Это не QR-код опроса СферумФокус. Наведи камеру на код с экрана учителя." }); return; }
    if (demo) { setMsg({ kind: "info", text: DEMO_NOTE }); return; }
    setBusy(true);
    const found = await findQuiz((x) => x.template_id === sp.template);
    setBusy(false);
    go(found, NOT_FOUND_LINK);
  };
  const hintId = inline ? "qc-hint-inline" : "qc-hint";
  return <><form class={`qc-form l-v l-g3${inline ? " qc-inline" : ""}`} onSubmit={(e) => void submit(e)} noValidate>
      <label class="field"><span class="field-label">{inline ? "6 цифр с экрана учителя" : "6 цифр с экрана"}</span>
        <span class="qc-row l-1a mt-1"><input class="input num qc-pin f-xl f-num f-tc b-tap" inputMode="numeric" autoComplete="off" maxLength={7} placeholder="000 000" aria-describedby={hintId} data-autofocus={inline ? undefined : true}
          value={pin.length > 3 ? pinGroups(pin.padEnd(6, " ")).trimEnd() : pin} onInput={(e) => { setPin(normalizePin((e.currentTarget as HTMLInputElement).value)); setMsg(null); }} />
        {inline && <button type="submit" class="btn btn-primary qc-go b-tap" disabled={busy} aria-label={busy ? "Ищем опрос" : "Открыть опрос"}><Icon name="chevron" /></button>}</span></label>
      {!inline && <button type="submit" class="btn btn-primary btn-block" disabled={busy}>{busy ? "Ищем опрос…" : "Открыть опрос"}</button>}
      {!inline && canScanCode() && <button type="button" class="btn btn-secondary btn-block" disabled={busy} onClick={() => void scan()}><Icon name="qr" />Сканировать QR-код</button>}
      {msg && <p class={`note ${msg.kind === "warn" ? "warn" : ""} qc-msg`} role="alert"><Icon name={msg.kind === "warn" ? "alert" : "info"} /><span>{msg.text}</span></p>}
      {choices && <div class="qc-choices l-v" role="group" aria-label="Несколько опросов с этим кодом">
        <p class="hint-text">С этим кодом у тебя несколько опросов — выбери нужный:</p>
        {choices.map((c) => <button key={c.issue_id} type="button" class="btn btn-secondary btn-block" onClick={() => open(c.issue_id)}>{c.title}, {c.subject}</button>)}
      </div>}
      <p class="hint-text" id={hintId}>Код открывает опрос, который учитель выдал тебе. Без телефона можно ответить на листочке — учитель отметит это сам.</p>
    </form>
  </>;
}

export const DEMO_NOTE = "В демо-копии нет опросов учителя. В школе этот код откроет опрос, который учитель выдал тебе.";

export function QuizCodeSheet({ open, onClose, onOpenIssue }: { open: boolean; onClose: () => void; onOpenIssue: (issueId: string) => void }) {
  const [round, setRound] = useState(0);
  useEffect(() => { if (open) setRound((n) => n + 1); }, [open]);
  return <Sheet open={open} onClose={onClose} eyebrow="Код показывает учитель" title="Опрос по коду">
    <QuizCodeForm key={round} onOpenIssue={onOpenIssue} onDone={onClose} />
  </Sheet>;
}

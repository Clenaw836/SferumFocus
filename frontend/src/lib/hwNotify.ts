/**
 * v2 · «Новое задание от учителя»: уведомление один раз на выдачу + индикатор «Новое» до открытия.
 *
 *  - «просмотрено» — серверный факт (seen_at): индикатор гаснет, когда ученик открыл задание,
 *    и учитель видит то же самое;
 *  - «уже показали тост» — память устройства по аккаунту (nsKey): без повторов после перезагрузки;
 *  - опрос /student/assignments раз в минуту и при возврате во вкладку, только когда она видима;
 *  - первая проверка на устройстве с несколькими новыми выдачами — один сводный тост (с последней выдачей), а не очередь.
 * Модуль не знает о UI: App передаёт, как показать тост и как открыть задание.
 */
import { api } from "./api";
import { DEMO, nsKey } from "./demo";
import { hwInfos, isHwNew } from "./hwSync";
import type { HwKind, TeacherAssignment } from "./hwTypes";

export type HwNotice = Pick<TeacherAssignment, "issue_id" | "title" | "status"> & { teacher_name?: string | null; kind?: HwKind; seen_at?: string | null; issued_at?: string | null };

const KEY = () => nsKey("sf.hw-announced.v1");
const KEEP = 300;
const POLL_MS = 60_000;
const MIN_GAP_MS = 15_000;

/** Pure: which issues deserve an announcement now and what to remember (bounded, only still-listed ids). */
export function planAnnounce(list: HwNotice[], known: readonly string[]): { fresh: HwNotice[]; known: string[] } {
  const prev = new Set(known);
  const listed = new Set(list.map((i) => i.issue_id));
  // newest first: the toast names the latest issue and «Открыть» opens it
  const fresh = list.filter((i) => isHwNew(i) && !prev.has(i.issue_id)).sort((a, b) => (b.issued_at ?? "").localeCompare(a.issued_at ?? ""));
  return { fresh, known: [...new Set([...known.filter((id) => listed.has(id)), ...fresh.map((i) => i.issue_id)])].slice(-KEEP) };
}

/** Pure: toast wording (one or a summary). */
export function announceText(fresh: readonly HwNotice[]): string {
  const i = fresh[0];
  if (!i) return "";
  if (fresh.length > 1) return `Новых заданий от учителя: ${fresh.length}. Последнее — ${i.kind === "quiz" ? "блиц-опрос" : "задание"} «${i.title}». Все уже в списке на вечер.`;
  return `${i.kind === "quiz" ? "Новый блиц-опрос" : "Новое задание"} от учителя${i.teacher_name ? ` · ${i.teacher_name}` : ""}: «${i.title}»`;
}

function readKnown(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY()) || "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
function writeKnown(v: string[]) { try { localStorage.setItem(KEY(), JSON.stringify(v)); } catch { /* quota: a repeated toast is the only cost */ } }

export interface NotifyDeps {
  /** Show one announcement; `open` opens the (first) new assignment; `fresh` — the new issues, newest first. */
  announce(text: string, open: () => void, fresh: readonly HwNotice[]): void;
  /** Reload initial-state so new assignments join the plan before «Открыть». */
  refresh(): Promise<void>;
  /** Open a teacher task by issue id (after refresh). */
  openIssue(issueId: string): void;
}

/** Wire once from App (student role, not the offline demo).  Returns cleanup. */
export function startHwNotify(d: NotifyDeps): () => void {
  if (DEMO) return () => undefined;
  let alive = true, busy = false, last = 0, stop = false;
  const check = async () => {
    if (!alive || busy || stop || document.hidden || Date.now() - last < MIN_GAP_MS) return;
    busy = true; last = Date.now();
    try {
      const { assignments } = await api.hw.mine();
      const plan = planAnnounce(assignments, readKnown());
      writeKnown(plan.known);
      if (!alive || !plan.fresh.length) return;
      const known = new Set(hwInfos().map((i) => i.issue_id));
      if (plan.fresh.some((i) => !known.has(i.issue_id))) await d.refresh();
      const first = plan.fresh[0].issue_id;
      if (alive) d.announce(announceText(plan.fresh), () => d.openIssue(first), plan.fresh);
    } catch (e) {
      // нет ученической личности (учитель, не вошёл) — опрос бессмыслен; сеть — попробуем позже
      const status = (e as { status?: number } | null)?.status ?? 0;
      if (status === 401 || status === 403 || status === 404 || status === 503) stop = true;
    } finally { busy = false; }
  };
  const first = window.setTimeout(() => { void check(); }, 1500);
  const timer = window.setInterval(() => { void check(); }, POLL_MS);
  const wake = () => { if (!document.hidden) void check(); };
  document.addEventListener("visibilitychange", wake); addEventListener("online", wake);
  return () => { alive = false; clearTimeout(first); clearInterval(timer); document.removeEventListener("visibilitychange", wake); removeEventListener("online", wake); };
}

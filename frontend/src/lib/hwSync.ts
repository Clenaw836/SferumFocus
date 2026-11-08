/**
 * Recovery 2: glue between the device focus timer, the evening plan and the server state of
 * teacher assignments.  The server is the record (teacher sees it); the device is the live view.
 *
 *  - user timer transitions (focus.onTransition) -> durable outbox -> /student/assignments/{id}/{action}
 *  - "Готово" on a teacher task -> complete with the device-measured worked seconds and study day
 *  - heartbeat every 30 s while the app is visible and the timer runs (confirmed time, never attention)
 *  - server snapshots (initial-state.teacher_assignments) reconcile the device only when no local
 *    action is pending and the snapshot is at least as new as our last acknowledgement
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { DEMO, nsKey } from "./demo";
import { focus } from "./focus";
import { actionFor, createHwOutbox, planSnapshot, retryDelay, type HwDropped } from "./assignmentSync";
import { studentStatusLabel } from "./hwFormat";
import type { HwAction, HwTransitionResult, TeacherAssignment } from "./hwTypes";

export interface HwDeps {
  /** Mark a server-completed assignment done on this device (no reward is granted twice). */
  markDone(title: string): void;
  /** The teacher renamed an assignment: move device state from the old plan title to the new one. */
  retitle(from: string, to: string): void;
  isDone(title: string): boolean;
  refresh(): void;
  toast(message: string, kind: "ok" | "info" | "warn" | "bad"): void;
}

const KNOWN = () => nsKey("sf.hw-known.v1");
let infos: TeacherAssignment[] = [];
let deps: HwDeps | null = null;
let lastError: string | null = null;
const acked = new Map<string, number>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export const hwOutbox = createHwOutbox<HwTransitionResult>(localStorage, () => nsKey("sf.hw-outbox.v1"),
  (op, sentAt) => api.hw.act(op.issue, op.action, { client_event_at: op.at, client_sent_at: Math.max(sentAt, op.at), ...op.body }, op.id));
hwOutbox.subscribe(notify);

export const hwInfo = (title: string | null | undefined) => (title ? infos.find((i) => i.task_title === title) ?? null : null);
export const hwInfos = () => infos;
export const isTeacherTask = (t: { source?: string | null } | null | undefined) => t?.source === "teacher";
/** Worked seconds the server already holds for a paused teacher assignment: the device timer continues from there. */
export const hwElapsed = (title: string) => { const i = hwInfo(title); return i && (i.status === "paused" || i.status === "in_progress") ? i.timer_sec : 0; };

function readKnown(): Record<string, string> {
  try { const v = JSON.parse(localStorage.getItem(KNOWN()) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function writeKnown(v: Record<string, string>) { try { localStorage.setItem(KNOWN(), JSON.stringify(v)); } catch { /* quota: only rename/revoke detection degrades */ } }

let retryTimer = 0;
export async function flushHw(): Promise<void> {
  if (DEMO) return;
  clearTimeout(retryTimer);
  const r = await hwOutbox.flush();
  for (const { op, result } of r.sent) {
    acked.set(op.issue, result.issue.revision);
    infos = infos.map((i) => (i.issue_id === op.issue ? { ...i, ...result.issue, task_title: i.task_title } : i));
    for (const other of result.auto_paused) infos = infos.map((i) => (i.issue_id === other ? { ...i, status: "paused", running_since: null } : i));
  }
  if (r.dropped.length) handleDropped(r.dropped);
  lastError = r.blocked ? "Нет связи: учитель увидит прогресс, когда появится интернет." : null;
  if (r.blocked) { const tries = hwOutbox.pending()[0]?.tries ?? 1; retryTimer = window.setTimeout(() => { void flushHw(); }, retryDelay(tries)); }
  notify();
}

function handleDropped(dropped: HwDropped[]) {
  const seen = new Set<string>();
  for (const d of dropped) {
    if (seen.has(d.op.issue)) continue;
    seen.add(d.op.issue);
    const info = infos.find((i) => i.issue_id === d.op.issue);
    if (info && focus.get()?.title === info.task_title && d.status !== 422) focus.drop({ silent: true });
    hwOutbox.forget(d.op.issue);
    deps?.toast(d.status === 404 ? "Это задание больше недоступно — учитель его отозвал." : d.message, "warn");
  }
  deps?.refresh();
}

/** «Готово» по заданию учителя: completion with the device-measured result.  Returns false for other tasks. */
export function completeHw(task: { title: string; source?: string | null; provider_assignment_id?: string | null }, workedSec: number | null, studyDay: string): boolean {
  if (!isTeacherTask(task) || !task.provider_assignment_id || DEMO) return false;
  try {
    hwOutbox.enqueue(task.provider_assignment_id, "complete", { reason: "list", study_day: studyDay, ...(workedSec != null ? { client_elapsed_sec: Math.max(0, Math.min(43200, Math.round(workedSec))) } : {}) });
  } catch (e) { deps?.toast((e as Error).message, "warn"); }
  void flushHw();
  return true;
}

/** Apply a server snapshot.  Never overrides a pending local action or a newer acknowledgement (see planSnapshot). */
export function applyHwSnapshot(list: TeacherAssignment[]): void {
  if (DEMO) return;
  const f = focus.get();
  const plan = planSnapshot(list, readKnown(), f ? { title: f.title, paused: f.pausedAt !== null, onBreak: !!f.breakAt, plannedSec: f.plannedSec } : null, {
    pending: (issue) => hwOutbox.pending(issue).length, acked: (issue) => acked.get(issue), isDone: (title) => !!deps?.isDone(title),
  });
  for (const step of plan.steps) {
    if (step.kind === "revoked") {
      if (step.stopTimer) { focus.drop({ silent: true }); deps?.toast(`Учитель отозвал «${step.title}». Таймер остановлен, уже отработанное время учитель видит.`, "info"); }
      hwOutbox.forget(step.issue);
    } else if (step.kind === "retitle") { focus.retitle(step.from, step.to); deps?.retitle(step.from, step.to); }
    else if (step.kind === "done") { if (step.stopTimer) focus.drop({ silent: true }); if (step.markDone) deps?.markDone(step.title); }
    else if (step.kind === "adopt") focus.adopt(step.title, step.plannedSec, step.elapsedSec, step.paused);
    else { try { hwOutbox.enqueue(step.issue, "pause", { reason: "switch" }); void flushHw(); } catch { /* full queue is reported on the next user action */ } }
  }
  writeKnown(plan.known);
  infos = list;
  notify();
}

/** Wire once from App; returns cleanup. */
export function startHwSync(d: HwDeps): () => void {
  deps = d;
  if (DEMO) return () => { deps = null; };
  const offTransition = focus.onTransition((t) => {
    const info = hwInfo(t.title);
    if (!info || info.status === "completed" || info.status === "revoked") return;
    const m = actionFor(t.kind, t.round);
    if (!m) return;
    try { if (hwOutbox.enqueue(info.issue_id, m.action, m.body)) void flushHw(); }
    catch (e) { d.toast((e as Error).message, "warn"); }
  });
  const beat = () => {
    const s = focus.get(), info = hwInfo(s?.title);
    if (!s || !info || s.pausedAt !== null || document.hidden || info.status !== "in_progress" || hwOutbox.pending(info.issue_id).length) return;
    api.hw.heartbeat(info.issue_id).then((r) => {
      infos = infos.map((i) => (i.issue_id === info.issue_id ? { ...i, ...r.issue, task_title: i.task_title } : i)); notify();
    }).catch(() => undefined);
  };
  const wake = () => { if (!document.hidden) { void flushHw(); beat(); } };
  const timer = window.setInterval(beat, 30_000);
  addEventListener("online", wake); document.addEventListener("visibilitychange", wake);
  void flushHw();
  return () => { offTransition(); clearInterval(timer); clearTimeout(retryTimer); removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); deps = null; };
}

/** v2: reload the server snapshot now (after a quiz start/submit the plan and the teacher view change). */
export const refreshHw = () => deps?.refresh();

/** v2: an issue the student has not opened yet («Новое» until opened; the teacher sees «не открыто»). */
export const isHwNew = (i: Pick<TeacherAssignment, "status"> & { seen_at?: string | null }) => !i.seen_at && i.status !== "completed" && i.status !== "revoked";
export const hwNewCount = () => infos.filter(isHwNew).length;

/**
 * v2: the student opened a teacher assignment.  The indicator goes off at once; if the server did not
 * confirm (offline), it comes back so the badge never claims what the teacher does not see.
 */
export function markHwSeen(issue: string): void {
  const i = infos.find((x) => x.issue_id === issue);
  if (DEMO || !i || !isHwNew(i)) return;
  const set = (seen: string | null) => { infos = infos.map((x) => (x.issue_id === issue ? { ...x, seen_at: seen } : x)); notify(); };
  set(new Date().toISOString());
  api.hw.seen(issue).then((r) => set(r.seen_at ?? new Date().toISOString())).catch(() => set(null));
}

/** Components: current infos + pending count + last delivery problem. */
export function useHw(): { infos: TeacherAssignment[]; pending: (issue: string) => number; next: (issue: string) => HwAction | null; error: string | null } {
  const [, setV] = useState(0);
  useEffect(() => { const f = () => setV((v) => v + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return { infos, pending: (issue: string) => hwOutbox.pending(issue).length, next: (issue: string) => { const q = hwOutbox.pending(issue); return q.length ? q[q.length - 1].action : null; }, error: lastError };
}

/** Human status for a student; a queued action shows what the device did, marked as not yet delivered. */
export function hwStatusLabel(i: Pick<TeacherAssignment, "status" | "timer_sec">, pending = 0, next: HwAction | null = null): string {
  return studentStatusLabel(i.status, i.timer_sec, pending, next);
}

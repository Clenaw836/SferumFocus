/**
 * Recovery 2: durable, ordered outbox for teacher-assignment timer transitions.
 *
 * Persist-before-send (like completionQueue): every user action becomes an immutable record with
 * its own UUIDv4 operation id and the device time it happened (client_event_at).  Retries reuse the
 * id, so the server replays instead of duplicating; client_sent_at is stamped per attempt, so the
 * server can measure the delivery delay on the device clock and the device clock offset cancels out.
 * Order is preserved per account: a transient failure (no network, 5xx, 429, 401) stops the flush;
 * a permanent refusal (403/404/409/422) drops only that record and is reported for a refetch.
 */
import type { HwAction, HwReason } from "./hwTypes";

export interface HwOpBody { reason?: HwReason; round?: number; study_day?: string; client_elapsed_sec?: number }
export interface HwOp { id: string; issue: string; action: HwAction; body: HwOpBody; at: number; tries: number }
export interface HwDropped { op: HwOp; status: number; message: string }
export interface HwFlushResult<R> { sent: { op: HwOp; result: R }[]; dropped: HwDropped[]; blocked: boolean }
interface Envelope { version: 1; items: HwOp[] }
type Failure = { status?: number; message?: string };

export const HW_OUTBOX_LIMIT = 300;
/** Statuses after which retrying the same request can never succeed. */
export const permanent = (status: number | undefined) => status === 403 || status === 404 || status === 409 || status === 410 || status === 422;

export function createHwOutbox<R>(storage: Pick<Storage, "getItem" | "setItem">, key: () => string,
  send: (op: HwOp, sentAt: number) => Promise<R>, opts: { now?: () => number; uuid?: () => string } = {}) {
  const now = opts.now ?? (() => Date.now());
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  let running: Promise<HwFlushResult<R>> | null = null;
  const listeners = new Set<() => void>();

  function read(k = key()): Envelope {
    let raw: string | null = null;
    try { raw = storage.getItem(k); } catch { return { version: 1, items: [] }; }
    if (!raw) return { version: 1, items: [] };
    try {
      const data = JSON.parse(raw) as Envelope;
      if (data?.version !== 1 || !Array.isArray(data.items)) return { version: 1, items: [] };
      return { version: 1, items: data.items.filter((x) => x && typeof x.id === "string" && typeof x.issue === "string" && typeof x.action === "string" && Number.isFinite(x.at)) };
    } catch { return { version: 1, items: [] }; }
  }
  function write(k: string, value: Envelope) { storage.setItem(k, JSON.stringify(value)); listeners.forEach((f) => f()); }

  return {
    pending: (issue?: string) => read().items.filter((x) => !issue || x.issue === issue),
    subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },
    /** Returns the queued record, or null when it would be a no-op (same state twice, after completion). */
    enqueue(issue: string, action: HwAction, body: HwOpBody = {}): HwOp | null {
      const k = key(), data = read(k);
      const mine = data.items.filter((x) => x.issue === issue);
      if (mine.some((x) => x.action === "complete")) return null;              // nothing follows a completion
      const last = mine[mine.length - 1];
      const same = (a: HwAction, b: HwAction) => a === b || (a !== "complete" && b !== "complete" && (a === "start" || a === "resume") && (b === "start" || b === "resume"));
      if (last && same(last.action, action) && action !== "complete" && last.body.round === body.round) return null;
      if (data.items.length >= HW_OUTBOX_LIMIT) throw new Error("Очередь таймера заполнена. Подключись к сети, чтобы учитель увидел прогресс.");
      const op: HwOp = { id: uuid(), issue, action, body: JSON.parse(JSON.stringify(body)), at: now(), tries: 0 };
      data.items.push(op); write(k, data); return op;
    },
    /** Drop records of an issue the server no longer accepts (revoked/removed). */
    forget(issue: string) { const k = key(), data = read(k); const n = data.items.filter((x) => x.issue !== issue); if (n.length !== data.items.length) write(k, { version: 1, items: n }); },
    flush(): Promise<HwFlushResult<R>> {
      if (running) return running;
      const k = key();
      running = (async () => {
        const out: HwFlushResult<R> = { sent: [], dropped: [], blocked: false };
        for (const op of read(k).items) {
          if (key() !== k) { out.blocked = true; break; }                       // account switched: never replay another queue
          try {
            const result = await send(op, now());
            const latest = read(k); latest.items = latest.items.filter((x) => x.id !== op.id); write(k, latest);   // delivered: never resend
            if (key() !== k) { out.blocked = true; break; }                     // the answer belongs to the previous account: do not merge it
            out.sent.push({ op, result });
          } catch (e) {
            const f = (e ?? {}) as Failure;
            const latest = read(k);
            if (permanent(f.status)) {
              latest.items = latest.items.filter((x) => x.id !== op.id); write(k, latest);
              if (key() !== k) { out.blocked = true; break; }
              out.dropped.push({ op, status: f.status ?? 0, message: f.message ?? "Сервер отклонил действие" });
              continue;
            }
            latest.items = latest.items.map((x) => (x.id === op.id ? { ...x, tries: x.tries + 1 } : x)); write(k, latest);
            out.blocked = true; break;                                            // unknown outcome: keep order, retry later
          }
        }
        return out;
      })().finally(() => { running = null; });
      return running;
    },
  };
}

/** Focus-timer transition -> server action (null = nothing to send). */
export function actionFor(kind: "start" | "pause" | "break" | "resume" | "next_round" | "finish" | "drop", round?: number): { action: HwAction; body: HwOpBody } | null {
  switch (kind) {
    case "start": return { action: "start", body: { reason: "timer" } };
    case "pause": return { action: "pause", body: { reason: "pause" } };
    case "break": return { action: "pause", body: { reason: "break" } };
    case "drop": return { action: "pause", body: { reason: "drop" } };
    case "resume": return { action: "resume", body: { reason: "resume" } };
    case "next_round": return { action: "resume", body: { reason: "next_round", ...(round ? { round: Math.min(99, round) } : {}) } };
    default: return null;                                                          // finish: completion is sent explicitly with its result
  }
}

/** Retry delay after a blocked flush: 2 s, 4 s … capped at 60 s. */
export const retryDelay = (tries: number) => Math.min(60_000, 2000 * 2 ** Math.max(0, Math.min(5, tries)));

/** Which server snapshot may overwrite local state: only one at least as new as our last acknowledgement. */
export function fresher(serverRevision: number, acked: number | undefined) { return acked === undefined || serverRevision >= acked; }

/**
 * Operation ids for teacher/student commands (create, issue, join …).  A retry after an unknown
 * outcome (no network, timeout, 5xx) reuses the id of the same request, so the server replays the
 * stored answer instead of applying the command twice; any definite answer releases the id.
 */
export function createOnce(uuid: () => string = () => crypto.randomUUID()) {
  const ids = new Map<string, string>();
  const unknown = (status: number | undefined) => status === undefined || status === 0 || status === -1 || status >= 500;
  return {
    pendingId: (fingerprint: string) => ids.get(fingerprint) ?? null,
    async run<T>(fingerprint: string, call: (operationId: string) => Promise<T>): Promise<T> {
      const id = ids.get(fingerprint) ?? uuid();
      ids.set(fingerprint, id);
      try { const r = await call(id); ids.delete(fingerprint); return r; }
      catch (e) { if (!unknown((e as Failure | null)?.status)) ids.delete(fingerprint); throw e; }
    },
  };
}

/** What the device must do with one server snapshot of teacher assignments (pure decision table). */
export interface SnapshotItem { issue_id: string; task_title: string; status: "assigned" | "in_progress" | "paused" | "completed" | "revoked"; revision: number; planned_minutes: number; timer_sec: number }
export interface LocalSession { title: string; paused: boolean; onBreak: boolean; plannedSec: number }
export type SnapshotStep =
  | { kind: "revoked"; issue: string; title: string; stopTimer: boolean }
  | { kind: "retitle"; issue: string; from: string; to: string }
  | { kind: "done"; issue: string; title: string; stopTimer: boolean; markDone: boolean }
  | { kind: "adopt"; issue: string; title: string; plannedSec: number; elapsedSec: number; paused: boolean }
  | { kind: "pause-other"; issue: string };

/**
 * Rules: an issue that disappeared (revoked, archived, left the class) stops its timer silently;
 * a renamed one moves the device state; a snapshot never overrides a pending local action or a
 * state older than our last acknowledgement; completed elsewhere → done here without a second
 * reward; running elsewhere → show it here, unless this device runs another task (then the server
 * is told to pause, like the automatic pause on start); paused elsewhere → pause here.
 */
export function planSnapshot(list: SnapshotItem[], known: Record<string, string>, session: LocalSession | null,
  ctx: { pending: (issue: string) => number; acked: (issue: string) => number | undefined; isDone: (title: string) => boolean }): { steps: SnapshotStep[]; known: Record<string, string> } {
  const steps: SnapshotStep[] = [];
  const current = new Map(list.map((i) => [i.issue_id, i]));
  let s = session ? { ...session } : null;
  for (const [issue, title] of Object.entries(known)) {
    const now = current.get(issue);
    if (!now) { steps.push({ kind: "revoked", issue, title, stopTimer: s?.title === title }); if (s?.title === title) s = null; continue; }
    if (now.task_title !== title) { steps.push({ kind: "retitle", issue, from: title, to: now.task_title }); if (s?.title === title) s = { ...s, title: now.task_title }; }
  }
  for (const i of list) {
    if (ctx.pending(i.issue_id) || !fresher(i.revision, ctx.acked(i.issue_id))) continue;
    const mine = s?.title === i.task_title, planned = i.planned_minutes * 60;
    if (i.status === "completed") {
      const markDone = !ctx.isDone(i.task_title);
      if (mine || markDone) steps.push({ kind: "done", issue: i.issue_id, title: i.task_title, stopTimer: mine, markDone });
      if (mine) s = null;
    } else if (i.status === "in_progress") {
      if (!s) { steps.push({ kind: "adopt", issue: i.issue_id, title: i.task_title, plannedSec: planned, elapsedSec: i.timer_sec, paused: false }); s = { title: i.task_title, paused: false, onBreak: false, plannedSec: planned }; }
      else if (mine && s.paused && !s.onBreak) { steps.push({ kind: "adopt", issue: i.issue_id, title: i.task_title, plannedSec: Math.max(s.plannedSec, planned), elapsedSec: i.timer_sec, paused: false }); s = { ...s, paused: false }; }
      else if (!mine) steps.push({ kind: "pause-other", issue: i.issue_id });
    } else if (i.status === "paused" && mine && s && !s.paused) {
      steps.push({ kind: "adopt", issue: i.issue_id, title: i.task_title, plannedSec: Math.max(s.plannedSec, planned), elapsedSec: i.timer_sec, paused: true });
      s = { ...s, paused: true };
    }
  }
  return { steps, known: Object.fromEntries(list.map((i) => [i.issue_id, i.task_title])) };
}

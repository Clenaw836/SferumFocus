/** Ephemeral tutor drafts and in-flight state. Never serialized to Web Storage. */
import type { SocraticGuide } from "../engine/guide";
/** guide — v2.1: автономный план по предмету, если ИИ недоступен (status=degraded_gracefully). */
export type TutorMsg = { role: "user" | "assistant"; content: string; photo?: boolean; notice?: string | null; guide?: SocraticGuide | null };
export type TutorPhoto = { base64: string; name: string };
type State = { draft: string; photo: TutorPhoto | null; msgs: TutorMsg[]; pending: symbol | null };
export class TutorSessionStore {
  private generation = 0;
  get epoch(): number { return this.generation; }
  private records = new Map<string, State>();
  private draftTimes = new Map<string, number>();
  private listeners = new Set<() => void>();
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { this.listeners.forEach(fn => fn()); }
  get(key: string, history: () => TutorMsg[] = () => []): State {
    let state = this.records.get(key);
    if (!state) { state = { draft: "", photo: null, msgs: history(), pending: null }; this.records.set(key, state); }
    return state;
  }
  edit(key: string, draft: string): void { this.get(key).draft = draft.slice(0, 500); this.draftTimes.set(key, Date.now()); this.emit(); }
  attach(key: string, photo: TutorPhoto | null): void { this.get(key).photo = photo; this.emit(); }
  begin(key: string) {
    const s = this.get(key), text = s.draft.trim() || (s.photo ? "Проверь моё решение на фото" : "");
    if (s.pending || !text) return null;
    const token = Symbol(), before = s.msgs, photo = s.photo;
    const next: TutorMsg[] = [...before, { role: "user", content: text, photo: !!photo }];
    s.pending = token; s.msgs = next; this.draftTimes.delete(key); s.draft = ""; s.photo = null; this.emit();
    return { token, before, next, text, photo };
  }
  finish(key: string, token: symbol, msgs: TutorMsg[]): boolean {
    const s = this.records.get(key);
    if (!s || s.pending !== token) return false; // revoked session / stale response
    s.pending = null; s.msgs = msgs.slice(-24); this.emit(); return true;
  }
  fail(key: string, token: symbol, before: TutorMsg[], text: string, photo: TutorPhoto | null): boolean {
    const s = this.records.get(key);
    if (!s || s.pending !== token) return false;
    s.pending = null; s.msgs = before;
    // A response must not erase the next draft typed while waiting.
    if (!s.draft && !s.photo) { s.draft = text; this.draftTimes.set(key, Date.now()); s.photo = photo; }
    this.emit(); return true;
  }
  clearHistory(key: string): boolean {
    const s = this.get(key); if (s.pending) return false;
    s.msgs = []; this.emit(); return true;
  }
  /** `today` (school day «YYYY-MM-DD»): tutor context lives one school day — threads of earlier days are not
   *  checkpointed to the server (session keys are «day|context»). */
  historySnapshot(today?: string):Record<string,TutorMsg[]> {
    // v2.1: guide (автономный план) детерминирован и пересчитывается — на сервер не уходит (лимит документа 64 КБ).
    return Object.fromEntries([...this.records].filter(([key])=>!today||key.startsWith(today+'|')).slice(-32).map(([key,s])=>[key,s.msgs.filter(m=>!m.photo).slice(-12).map(({guide:_guide,...m})=>m)]));
  }
  hydrateHistory(data:Record<string,TutorMsg[]>, today?: string):void {
    for(const [key,msgs] of Object.entries(data).slice(-32)) {
      if(!Array.isArray(msgs)||key.length>1000)continue;
      if(today&&!key.startsWith(today+'|'))continue;
      if(msgs.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>6000))continue;
      if(!this.records.has(key))this.records.set(key,{draft:'',photo:null,msgs:msgs.slice(-12),pending:null});
    }
  }
  /** Text-only encrypted server checkpoint. Never serialize photos/tokens to Web Storage. */
  draftSnapshot(now = Date.now()): Record<string, {text: string; expires: number}> {
    return Object.fromEntries([...this.records].slice(-32).flatMap(([key, s]) => {
      const at = this.draftTimes.get(key) || 0;
      return s.draft && at + 2 * 3600_000 > now ? [[key, {text: s.draft, expires: at + 2 * 3600_000}]] : [];
    }));
  }
  hydrateDrafts(data: unknown, now = Date.now()): void {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    for (const [key, value] of Object.entries(data).slice(-32)) {
      const d = value as {text?: unknown; expires?: unknown};
      if (key.length > 1000 || !d || typeof d.text !== "string" || d.text.length > 500 ||
          typeof d.expires !== "number" || d.expires <= now || d.expires > now + 2 * 3600_000) continue;
      const s = this.get(key);
      if (!s.draft && !s.pending) { s.draft = d.text; this.draftTimes.set(key, d.expires - 2 * 3600_000); }
    }
    this.emit();
  }
  reset(): void { this.generation++; this.records.clear(); this.draftTimes.clear(); this.emit(); }
}
export const tutorSession = new TutorSessionStore();

const TUTOR_LS = /(?:^|[:.])sf\.tutor\.(\d{4}-\d{2}-\d{2})\./;
/** Local tutor history is per school day: entries of earlier days are erased (every namespace on the device). */
export function purgeTutorCache(today: string, storage: Pick<Storage, "length" | "key" | "removeItem"> | null =
  typeof localStorage === "undefined" ? null : localStorage): number {
  if (!storage) return 0;
  const stale: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i), m = k ? TUTOR_LS.exec(k) : null;
      if (k && m && m[1] !== today) stale.push(k);
    }
    stale.forEach((k) => storage.removeItem(k));
  } catch { return 0; }
  return stale.length;
}

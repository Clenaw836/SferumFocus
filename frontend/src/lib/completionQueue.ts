/** Persist-before-send completion intents. No timer/interval is a source of truth.
 * Storage failures are errors, not optimistic success. Queue is account-scoped by caller.
 * Pending records are immutable: retries reuse BOTH UUID and payload.
 */
export interface CompletionIntent { operationId: string; title: string; day: string; payload: Record<string, unknown>; createdAt: number }
interface Envelope { version: 1; items: CompletionIntent[] }
export function createCompletionQueue<R>(storage: Pick<Storage, 'getItem'|'setItem'>, key: () => string,
  send: (intent: CompletionIntent) => Promise<R>, uuid: () => string = () => crypto.randomUUID()) {
  let running: Promise<{ intent: CompletionIntent; result: R }[]> | null = null;
  function read(k = key()): Envelope {
    const raw = storage.getItem(k); if (!raw) return {version:1,items:[]};
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.items) || data.items.some((x: CompletionIntent) => !x.operationId || !x.payload || !x.title || !x.day)) throw new Error('Очередь завершений требует сверки; данные сохранены без изменений');
    return data;
  }
  function write(k: string, value: Envelope) { storage.setItem(k, JSON.stringify(value)); }
  return {
    pending: () => read().items,
    enqueue(title: string, day: string, payload: Record<string, unknown>): CompletionIntent {
      const k = key(), data = read(k);
      const existing = data.items.find(x => x.day === day && x.title === title);
      if (existing) return existing;
      if (data.items.length >= 500) throw new Error('Очередь заполнена. Подключись к сети перед завершением задания.');
      const intent = {operationId:uuid(),title,day,payload:JSON.parse(JSON.stringify(payload)),createdAt:Date.now()};
      data.items.push(intent); write(k,data); return intent;
    },
    flush(eligible: (intent: CompletionIntent) => boolean = () => true): Promise<{ intent: CompletionIntent; result: R }[]> {
      if (running) return running;
      const k = key();
      running = (async () => {
        const acknowledgements: { intent: CompletionIntent; result: R }[] = [];
        for (const intent of read(k).items) {
          if (!eligible(intent)) continue; // retain reconciliation records without blocking independent current-day work
          if (key() !== k) break; // an account switch must never replay another account's queue
          try {
            const result = await send(intent);
            if (key() !== k) break;
            const latest = read(k); latest.items = latest.items.filter(x => x.operationId !== intent.operationId);
            write(k,latest); acknowledgements.push({intent,result});
          } catch { break; } // unknown outcome stays durable; next wake/online/manual action retries it
        }
        return acknowledgements;
      })().finally(() => { running = null; });
      return running;
    },
  };
}

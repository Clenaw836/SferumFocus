/**
 * v3.2.1 · «Работа над ошибками» блица — локально, без сети. Ошибка возвращается в следующие раунды темы,
 * пока не будет решена верно дважды подряд (упрощённый Лейтнер). До 20 вопросов на тему, старые вытесняются.
 * Хранилище — localStorage (через переданный store, чтобы тесты и приватный режим не падали).
 */
import type { BankQ } from "./blitzBank";

export interface Mistake extends BankQ { wins: number; at: number }
export interface KV { get<T>(k: string): T | null; set(k: string, v: unknown): void }
const KEY = "sf.blitz.mistakes.v1";
const CAP = 20;

export function mistakes(store: KV, topic: string): Mistake[] {
  const all = store.get<Record<string, Mistake[]>>(KEY) ?? {};
  return Array.isArray(all[topic]) ? all[topic].filter((m) => m && typeof m.q === "string" && Array.isArray(m.a) && m.a.length === 4) : [];
}

/** Итог раунда: неверные — в список (wins = 0), верные из списка — wins + 1, на 2-й победе удаляются. */
export function recordRound(store: KV, topic: string, results: { q: BankQ; ok: boolean }[], now = Date.now()): Mistake[] {
  const all = store.get<Record<string, Mistake[]>>(KEY) ?? {};
  let list = mistakes(store, topic);
  for (const { q, ok } of results) {
    const i = list.findIndex((m) => m.q === q.q);
    if (!ok) {
      if (i >= 0) list[i] = { ...list[i], wins: 0, at: now };
      else list.push({ q: q.q, a: q.a, why: q.why, wins: 0, at: now });
    } else if (i >= 0) {
      const wins = list[i].wins + 1;
      if (wins >= 2) list.splice(i, 1); else list[i] = { ...list[i], wins, at: now };
    }
  }
  list = list.sort((x, y) => y.at - x.at).slice(0, CAP);
  try { store.set(KEY, { ...all, [topic]: list }); } catch { /* приватный режим/квота: раунд всё равно засчитан */ }
  return list;
}

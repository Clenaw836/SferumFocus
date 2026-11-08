/**
 * Голос → текст. Порядок: 1) распознавание на устройстве (Web Speech API, ru-RU) — аудио не
 * уходит на наш сервер; 2) запись WAV → /speech/transcribe (ИИ на сервере), только если на
 * устройстве распознавания нет; 3) иначе микрофона нет вовсе — остаётся текст.
 * Аудио не хранится: буфер живёт только до ответа сервера.
 */
import { api } from "./api";
import { canRecord, record } from "./voice";

interface SR { lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number; start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null }
const SRCtor = (): (new () => SR) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
export type SttMode = "device" | "server" | null;
export const sttMode = (serverStt: boolean): SttMode => (SRCtor() ? "device" : canRecord() && serverStt ? "server" : null);

export interface Listening { stop(): void; cancel(): void; done: Promise<string> }
export async function listen(mode: Exclude<SttMode, null>, o: { onInterim?: (t: string) => void; onLevel?: (v: number) => void; maxSec?: number }): Promise<Listening> {
  if (mode === "device") {
    const r = new (SRCtor()!)();
    r.lang = "ru-RU"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let finalText = "", cancelled = false;
    const done = new Promise<string>((res, rej) => {
      r.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) finalText += x[0].transcript; else interim += x[0].transcript; }
        o.onInterim?.((finalText + " " + interim).trim());
      };
      r.onerror = (e) => { if (!cancelled) rej(new Error(e.error === "not-allowed" ? "Нет доступа к микрофону — разреши его или напиши текстом" : e.error === "no-speech" ? "Ничего не услышал — скажи ещё раз" : "Голос не распознался — попробуй ещё раз или напиши")); };
      r.onend = () => { if (cancelled) rej(new Error("cancel")); else res(finalText.trim()); };
    });
    r.start();
    const t = setTimeout(() => r.stop(), (o.maxSec ?? 20) * 1000);
    void done.finally(() => clearTimeout(t)).catch(() => undefined);
    return { stop: () => r.stop(), cancel: () => { cancelled = true; r.abort(); }, done };
  }
  let resolve!: (s: string) => void, reject!: (e: Error) => void;
  const done = new Promise<string>((a, b) => { resolve = a; reject = b; });
  const rec = await record(o.maxSec ?? 20, () => void finish(), o.onLevel);
  let over = false;
  const finish = async () => {
    if (over) return; over = true;
    try {
      const a = await rec.stop();
      if (a.sec < 1) throw new Error("Слишком коротко — скажи ещё раз");
      resolve((await api.transcribe(a.base64, a.mime)).text);
    } catch (e) { reject(e instanceof Error ? e : new Error("Не получилось распознать")); }
  };
  return { stop: () => void finish(), cancel: () => { over = true; rec.cancel(); reject(new Error("cancel")); }, done };
}

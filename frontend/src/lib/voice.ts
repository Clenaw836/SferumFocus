import { requestMediaAccess } from "./max";
import { checkpointTutor } from "./tutorSync";
// Запись голоса → WAV 16 кГц моно PCM16 (base64). WAV — единственный формат, который одинаково
// понимают ИИ-провайдеры и который не зависит от кодеков WebView (MediaRecorder в MAX на iOS/Android разный).
// Микрофон в WebView MAX требует разрешения клиента — ФИЗИЧЕСКАЯ ПРОВЕРКА В MAX ОБЯЗАТЕЛЬНА.
const audioContextClass = (): typeof AudioContext | undefined => {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext;
};
export const canRecord = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!audioContextClass();

export interface Recording { stop: () => Promise<{ base64: string; mime: string; sec: number }>; cancel: () => void }

const RATE = 16000;

export async function record(maxSec = 30, onAuto?: () => void, onLevel?: (rms: number) => void): Promise<Recording> {
  const Context = audioContextClass();
  if (!Context) throw new Error("Запись голоса не поддерживается в этом браузере");
  await requestMediaAccess("mic", checkpointTutor);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx: AudioContext;
  try { ctx = new Context(); }
  catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d);
    if (onLevel) { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * d[i]; onLevel(Math.min(1, Math.sqrt(s / (d.length / 4)) * 4)); }
  };
  src.connect(proc); proc.connect(ctx.destination);
  const t0 = Date.now();
  const timer = setTimeout(() => onAuto?.(), maxSec * 1000);
  const release = () => { clearTimeout(timer); try { proc.disconnect(); src.disconnect(); } catch { /* */ } stream.getTracks().forEach((t) => t.stop()); void ctx.close().catch(() => undefined); };
  return {
    cancel: release,
    async stop() {
      const rate = ctx.sampleRate;
      release();
      const len = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(len); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const k = rate / RATE; const n = Math.floor(len / k);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, all[Math.floor(i * k)] || 0)); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      const buf = new ArrayBuffer(44 + pcm.byteLength); const dv = new DataView(buf);
      const w = (p: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
      w(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
      dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.byteLength, true);
      new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));
      const bytes = new Uint8Array(buf); let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { base64: btoa(s), mime: "audio/wav", sec: Math.round((Date.now() - t0) / 1000) };
    },
  };
}

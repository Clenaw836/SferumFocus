import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { canRecord, record, type Recording } from "../lib/voice";
import { haptic } from "../lib/host";

const BARS = 28;

/** Голосовой ввод. Паттерн 21st.dev «AI Voice Input» (kokonutd, id 1451): кнопка → таймер → полоса-визуализатор.
 *  Адаптация: визуализатор показывает НАСТОЯЩИЙ уровень микрофона (RMS), а не случайные столбики;
 *  без Tailwind/lucide; отмена записи; reduced-motion — без анимации высоты. Нажал — пишет, нажал ещё раз — отправил. */
export function VoiceButton({ label, onAudio, maxSec = 30, disabled }: { label: string; onAudio: (a: { base64: string; mime: string }) => Promise<void> | void; maxSec?: number; disabled?: boolean }) {
  const [rec, setRec] = useState<Recording | null>(null);
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const ref = useRef<Recording | null>(null);
  const last = useRef(0);
  const mounted = useRef(true), requesting = useRef(false);
  ref.current = rec;
  useEffect(() => () => { mounted.current=false;ref.current?.cancel(); }, []);
  useEffect(() => {
    if (!rec) return;
    setSec(0);
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [rec]);
  if (!canRecord()) return null;
  const onLevel = (v: number) => {
    const now = performance.now(); if (now - last.current < 70) return; last.current = now;
    setLevels((xs) => [...xs.slice(1), v]);
  };
  const stop = async (r = ref.current) => {
    if (!r) return;
    setRec(null); setBusy(true);
    try { const a = await r.stop(); if (a.sec < 1) { toast("Слишком коротко — скажи ещё раз", "warn"); return; } await onAudio(a); }
    finally { setBusy(false); setLevels(Array(BARS).fill(0)); }
  };
  const cancel = () => { ref.current?.cancel(); setRec(null); setLevels(Array(BARS).fill(0)); haptic.select(); };
  const start = async () => {
    if (busy || ref.current || requesting.current) return;
    requesting.current=true;setBusy(true);
    try { const r = await record(maxSec, () => void stop(r), onLevel); if(!mounted.current){r.cancel();return;} ref.current = r; setRec(r); haptic.tap(); }
    catch (e) { toast(e instanceof Error && e.message.startsWith("Черновик") ? e.message : "Нет доступа к микрофону — разреши его в настройках или напиши текстом", "warn"); }
    finally { requesting.current=false;if(mounted.current)setBusy(false); }
  };
  const left = maxSec - sec;
  return (
    <div class={`voice l-v${rec ? " on" : ""}`}>
      <button type="button" class={`btn btn-secondary btn-rec${rec ? " on" : ""}${busy ? " is-loading" : ""}`} disabled={disabled || busy}
        aria-pressed={rec ? "true" : "false"} onClick={() => (rec ? stop() : start())}>
        <Icon name={rec ? "send" : "mic"} />{rec ? "Отправить" : label}
      </button>
      {rec && (
        <div class="voice-live l-h l-g3 b-tap r-md u-bad-s" role="group" aria-label="Идёт запись">
          <span class="voice-t f-b f-w6 f-bad num" aria-hidden="true">{`0:${String(sec).padStart(2, "0")}`}</span>
          <span class="voice-bars l-h l-g1 l-grow" aria-hidden="true">{levels.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />)}</span>
          <button type="button" class="icon-btn voice-x l-fix" onClick={cancel} aria-label="Отменить запись"><Icon name="x" /></button>
          <span class="sr" role="status">{sec === 0 ? "Запись началась. Нажми «Отправить», когда закончишь." : left === 5 ? "Осталось 5 секунд" : ""}</span>
        </div>
      )}
    </div>
  );
}

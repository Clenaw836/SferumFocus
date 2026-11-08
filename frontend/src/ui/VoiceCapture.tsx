import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { haptic } from "../lib/host";
import { listen, sttMode, type Listening } from "../lib/stt";

const BARS = 18;
/** Голос там, где сказать быстрее, чем напечатать. tap → слушаю (уровень/живой текст) → распознаю → текст
 *  уходит родителю в РЕДАКТИРУЕМОЕ поле (видно, что услышал; можно поправить, переписать или отменить).
 *  Нет распознавания — компонента нет, остаётся текст. Reduced motion — без анимации столбиков. */
export function VoiceCapture({ label, onText, serverStt, disabled, compact }: { label: string; onText: (t: string) => void; serverStt: boolean; disabled?: boolean; compact?: boolean }) {
  const mode = sttMode(serverStt);
  const [st, setSt] = useState<"idle" | "listening" | "processing">("idle");
  const [live, setLive] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const ref = useRef<Listening | null>(null);
  const last = useRef(0);
  useEffect(() => () => ref.current?.cancel(), []);
  if (!mode) return null;
  const start = async () => {
    setErr(null); setLive("");
    try {
      const l = await listen(mode, {
        onInterim: setLive,
        onLevel: (v) => { const n = performance.now(); if (n - last.current < 80) return; last.current = n; setLevels((xs) => [...xs.slice(1), v]); },
      });
      ref.current = l; setSt("listening"); haptic.tap();
      l.done.then((t) => { if (t.trim()) onText(t.trim()); else setErr("Ничего не услышал — скажи ещё раз или напиши"); })
        .catch((e: Error) => { if (e.message !== "cancel") setErr(e.message); })
        .finally(() => { ref.current = null; setSt("idle"); setLevels(Array(BARS).fill(0)); });
    } catch { setErr("Нет доступа к микрофону — разреши его в настройках или напиши текстом"); setSt("idle"); }
  };
  const stop = () => { if (!ref.current) return; setSt("processing"); ref.current.stop(); };
  const cancel = () => { ref.current?.cancel(); haptic.select(); };
  return (
    <div class={`vc${st !== "idle" ? " on" : ""}${compact ? " vc-compact" : ""}`}>
      {st === "idle" ? (
        <button type="button" class={`btn btn-secondary ${compact ? "vc-mic l-center l-g0 b-tap mw-44 r-lg" : "btn-block"}`} onClick={start} disabled={disabled} aria-label={compact ? label : undefined}>
          <Icon name="mic" />{compact ? null : label}
        </button>
      ) : (
        <div class="vc-live l-h b-tap r-lg u-acc-s" role="group" aria-label={st === "listening" ? "Слушаю" : "Распознаю"}>
          <span class="vc-dot b-round l-fix" aria-hidden="true" />
          {mode === "server" && st === "listening"
            ? <span class="vc-bars l-h l-g1 l-grow" aria-hidden="true">{levels.map((v, i) => <i key={i} style={{ height: `${Math.max(10, Math.round(v * 100))}%` }} />)}</span>
            : <span class="vc-text f-b f-trunc l-grow">{st === "processing" ? "Распознаю…" : live || "Слушаю…"}</span>}
          {st === "listening" && <button type="button" class="btn btn-primary btn-sm" onClick={stop}>Готово</button>}
          <button type="button" class="icon-btn" onClick={cancel} aria-label="Отменить запись"><Icon name="x" /></button>
          <span class="sr" role="status">{st === "listening" ? "Слушаю. Скажи и нажми «Готово»." : "Распознаю речь"}</span>
        </div>
      )}
      {err && <p class="vc-err f-b f-warn" role="alert">{err}</p>}
    </div>
  );
}

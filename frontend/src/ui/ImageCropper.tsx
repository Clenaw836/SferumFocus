/**
 * Master v2.0 · Features 1/4 — обрезка своего изображения: перетаскивание (палец/мышь), щипок и ползунок
 * масштаба, стрелки клавиатуры, «Сбросить кадр». Предпросмотр рисуется на canvas (без вставки исходника
 * в DOM), исходник освобождается при закрытии. Окно не прокручивает страницу (touch-action: none).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CENTER, checkFile, cropRect, decode, ImageInputError, panBy, render, type Crop, type Decoded } from "../lib/imageTools";
import { Icon } from "./Icon";

interface Props {
  file: File; aspect: number; out: { w: number; h: number }; title: string; round?: boolean;
  onDone: (canvas: HTMLCanvasElement) => void | Promise<void>; onCancel: () => void;
}
export function ImageCropper({ file, aspect, out, title, round, onDone, onCancel }: Props) {
  const [img, setImg] = useState<Decoded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState<Crop>(CENTER);
  const view = useRef<HTMLCanvasElement>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);

  useEffect(() => {
    let alive = true, got: Decoded | null = null;
    (async () => {
      try { checkFile(file); got = await decode(file); if (alive) setImg(got); else got.release(); }
      catch (e) { if (alive) setErr(e instanceof ImageInputError ? e.message : "Не удалось открыть изображение."); }
    })();
    return () => { alive = false; got?.release(); };
  }, [file]);

  useLayoutEffect(() => {
    const cv = view.current; if (!cv || !img) return;
    const w = cv.clientWidth || 280, h = Math.round(w / aspect), k = Math.min(2, globalThis.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * k)) { cv.width = Math.round(w * k); cv.height = Math.round(h * k); }
    const g = cv.getContext("2d"); if (!g) return;
    const r = cropRect(img.w, img.h, cv.width, cv.height, crop);
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(img.src, r.sx, r.sy, r.sw, r.sh, 0, 0, cv.width, cv.height);
  }, [img, crop, aspect]);

  const size = () => { const cv = view.current; return { w: cv?.clientWidth || 280, h: cv?.clientHeight || 280 / aspect }; };
  const move = (dx: number, dy: number) => { if (!img) return; const s = size(); setCrop((c) => panBy(c, dx, dy, s.w, s.h, img.w, img.h)); };
  const zoomTo = (z: number) => setCrop((c) => ({ ...c, zoom: Math.max(1, Math.min(4, z)) }));
  const dist = () => { const p = [...ptrs.current.values()]; return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  const done = async () => {
    if (!img || busy) return;
    setBusy(true); setErr(null);
    try { await onDone(render(img, crop, out.w, out.h)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Не удалось сохранить изображение."); setBusy(false); }
  };

  return <section class="cropper l-v l-g3 mt-1 mb-2" aria-labelledby="cropper-h">
    <h3 id="cropper-h">{title}</h3>
    {err && <div class="note bad" role="alert"><Icon name="alert" /><div>{err}</div></div>}
    {!img && !err && <div class="cropper-frame b-box b-nob l-mx l-w100 l-rel is-loading" style={{ aspectRatio: String(aspect) }} role="status"><span>Открываем изображение…</span></div>}
    {img && <>
      <div class={`cropper-frame b-box b-nob l-mx l-w100 l-rel${round ? " is-round" : ""}`} style={{ aspectRatio: String(aspect) }}>
        <canvas ref={view} class="cropper-view l-blk l-w100" tabIndex={0} role="img"
          aria-label="Кадр. Перетащите изображение или используйте стрелки; масштаб — ползунком ниже"
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.current.size === 2) pinch.current = { d: dist(), z: crop.zoom }; }}
          onPointerMove={(e) => {
            const p = ptrs.current.get(e.pointerId); if (!p) return;
            if (ptrs.current.size === 1) { move(e.clientX - p.x, e.clientY - p.y); }
            ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (ptrs.current.size === 2 && pinch.current && pinch.current.d > 0) zoomTo(pinch.current.z * dist() / pinch.current.d);
          }}
          onPointerUp={(e) => { ptrs.current.delete(e.pointerId); pinch.current = null; }}
          onPointerCancel={(e) => { ptrs.current.delete(e.pointerId); pinch.current = null; }}
          onWheel={(e) => { e.preventDefault(); zoomTo(crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }}
          onKeyDown={(e) => {
            const k: Record<string, [number, number]> = { ArrowLeft: [12, 0], ArrowRight: [-12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] };
            if (k[e.key]) { e.preventDefault(); move(...k[e.key]); }
            else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(crop.zoom * 1.1); }
            else if (e.key === "-") { e.preventDefault(); zoomTo(crop.zoom / 1.1); }
          }} />
      </div>
      <label class="cropper-zoom l-h f-b f-2"><span>Масштаб</span>
        <input type="range" min="1" max="4" step="0.01" value={crop.zoom} aria-valuetext={`${Math.round(crop.zoom * 100)} %`}
          onInput={(e) => zoomTo(Number((e.currentTarget as HTMLInputElement).value))} />
      </label>
      <p class="hint-text">Перетащите, чтобы выбрать кадр. Сохраняется уменьшенная копия {out.w}×{out.h}; исходный файл не хранится и никуда не отправляется.</p>
    </>}
    <div class="cropper-actions l-h l-je l-wrap">
      <button type="button" class={`btn btn-primary${busy ? " is-loading" : ""}`} disabled={!img || busy} onClick={done}><Icon name="check" />Готово</button>
      {img && <button type="button" class="btn btn-ghost" disabled={busy} onClick={() => setCrop(CENTER)}><Icon name="refresh" />Сбросить кадр</button>}
      <button type="button" class="btn btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
    </div>
  </section>;
}

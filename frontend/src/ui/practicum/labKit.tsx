/** v3.0 · общие детали лабораторий практикумов: ползунок, шаговые кнопки, сетка координат, формат чисел. */
import type { ComponentChildren } from "preact";

export const num = (v: unknown, d = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return d;
};
/** 2.5 → «2,5», −3 → «−3»: русская запятая и настоящий минус. */
export const fmt = (v: number, digits = 2): string => {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return (Object.is(r, -0) ? 0 : r).toString().replace(".", ",").replace("-", "−");
};
export type LabProps<S = Record<string, unknown>> = {
  cfg: Record<string, unknown> & { model: string; initial: Record<string, unknown> };
  state: S; readouts: Record<string, unknown>; onChange: (next: S) => void; readonly?: boolean; idp: string;
};

export function Slider({ id, label, value, min, max, step, unit = "", onChange, disabled }: {
  id: string; label: ComponentChildren; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  return <div class="sf-lab-slider-row l-a1a l-mid f-m f-2">
    <label for={id}>{label}</label>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-valuetext={`${fmt(value)}${unit}`}
      onInput={(e) => onChange(Number((e.currentTarget as HTMLInputElement).value))} />
    <output for={id} class="sf-tabular pl-out f-w6">{fmt(value)}{unit}</output>
  </div>;
}

export function Stepper({ label, value, min, max, onChange, disabled, unit = "" }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean; unit?: string;
}) {
  return <div class="pl-stepper f-m f-2" role="group" aria-label={label}>
    <span class="pl-stepper-label">{label}</span>
    <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`${label}: убрать`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>−</button>
    <output class="sf-tabular pl-stepper-val f-s f-tc" aria-live="polite">{value}{unit}</output>
    <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`${label}: добавить`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</button>
  </div>;
}

/** Координатная плоскость: мировые координаты → SVG. Ось Y вверх. */
export function plane(w: number, h: number, xmin: number, xmax: number, ymin: number, ymax: number) {
  const sx = (x: number) => ((x - xmin) / (xmax - xmin)) * w;
  const sy = (y: number) => h - ((y - ymin) / (ymax - ymin)) * h;
  return { sx, sy, w, h, xmin, xmax, ymin, ymax };
}
export function Grid({ p, step = 1, labels = true }: { p: ReturnType<typeof plane>; step?: number; labels?: boolean }) {
  const xs: number[] = [], ys: number[] = [];
  for (let x = Math.ceil(p.xmin / step) * step; x <= p.xmax + 1e-9; x += step) xs.push(Math.round(x * 1000) / 1000);
  for (let y = Math.ceil(p.ymin / step) * step; y <= p.ymax + 1e-9; y += step) ys.push(Math.round(y * 1000) / 1000);
  return <g class="pl-grid" aria-hidden="true">
    {xs.map((x) => <line key={`x${x}`} x1={p.sx(x)} x2={p.sx(x)} y1={0} y2={p.h} class={x === 0 ? "pl-axis" : "pl-gridline"} />)}
    {ys.map((y) => <line key={`y${y}`} y1={p.sy(y)} y2={p.sy(y)} x1={0} x2={p.w} class={y === 0 ? "pl-axis" : "pl-gridline"} />)}
    {labels && xs.filter((x) => x !== 0 && x % (step * 2) === 0).map((x) => <text key={`lx${x}`} x={p.sx(x)} y={Math.min(p.h - 3, Math.max(10, p.sy(0) + 11))} class="pl-tick f-c" text-anchor="middle">{fmt(x)}</text>)}
    {labels && ys.filter((y) => y !== 0 && y % (step * 2) === 0).map((y) => <text key={`ly${y}`} x={Math.min(p.w - 3, Math.max(3, p.sx(0) + 4))} y={p.sy(y) + 3} class="pl-tick f-c">{fmt(y)}</text>)}
  </g>;
}

/** Строка показаний прибора/модели (табличные цифры). */
export function Readouts({ rows }: { rows: [string, string][] }) {
  return <dl class="pl-readouts l-fit l-g0 o-h r-sm u-line">{rows.map(([k, v]) => <div key={k}><dt class="f-w6">{k}</dt><dd class="sf-tabular f-w6">{v}</dd></div>)}</dl>;
}

/** v3.0 · SVG-лаборатории точных наук: парабола, прямая, весы уравнений, площадь на сетке, закон Ома.
 *  Геометрия рисуется локально и мгновенно; проверка и показания — сервер (app/practicum_labs.py). */
import { fmt, Grid, num, plane, Readouts, Slider, Stepper, type LabProps } from "./labKit";

const W = 320, H = 220;
const yes = (v: unknown) => v === true;

function curve(f: (x: number) => number, p: ReturnType<typeof plane>, n = 200): string {
  let d = "";
  for (let i = 0; i <= n; i++) {
    const x = p.xmin + ((p.xmax - p.xmin) * i) / n;
    const y = Math.max(-60, Math.min(60, f(x)));
    d += `${i ? "L" : "M"}${p.sx(x).toFixed(1)},${p.sy(y).toFixed(1)}`;
  }
  return d;
}

export function QuadraticLab({ state, onChange, readonly, readouts: r, idp }: LabProps) {
  const a = num(state.a, 1), b = num(state.b, 0), c = num(state.c, 0);
  const p = plane(W, H, -8, 8, -10, 10);
  const x0 = -b / (2 * a), y0 = c - (b * b) / (4 * a), D = b * b - 4 * a * c;
  const roots = D > 0 ? [(-b - Math.sqrt(D)) / (2 * a), (-b + Math.sqrt(D)) / (2 * a)] : D === 0 ? [x0] : [];
  const set = (k: string) => (v: number) => onChange({ ...state, [k]: k === "a" && v === 0 ? (a > 0 ? -0.5 : 0.5) : v });
  const nRoots = num(r.n_roots, roots.length);
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="quadratic">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Парабола y = ${fmt(a)}x² ${b < 0 ? "−" : "+"} ${fmt(Math.abs(b))}x ${c < 0 ? "−" : "+"} ${fmt(Math.abs(c))}; вершина (${fmt(x0)}; ${fmt(y0)}); корней: ${nRoots}`}>
      <defs><clipPath id={`${idp}-clip`}><rect width={W} height={H} /></clipPath></defs>
      <Grid p={p} step={1} />
      <g clip-path={`url(#${idp}-clip)`}>
        <path d={curve((x) => a * x * x + b * x + c, p)} class="pl-curve" />
        <line x1={p.sx(x0)} x2={p.sx(x0)} y1={0} y2={H} class="pl-guide" />
        <circle cx={p.sx(x0)} cy={p.sy(y0)} r={4.5} class="pl-dot pl-dot--vertex" />
        {roots.map((x, i) => <circle key={i} cx={p.sx(x)} cy={p.sy(0)} r={4.5} class="pl-dot pl-dot--root" />)}
      </g>
    </svg>
    <div class="sf-lab-controls pt-2">
      <Slider id={`${idp}-a`} label={<>a <small>ветви</small></>} value={a} min={-3} max={3} step={0.5} onChange={set("a")} disabled={readonly} />
      <Slider id={`${idp}-b`} label={<>b <small>сдвиг</small></>} value={b} min={-8} max={8} step={1} onChange={set("b")} disabled={readonly} />
      <Slider id={`${idp}-c`} label={<>c <small>Oy</small></>} value={c} min={-9} max={9} step={1} onChange={set("c")} disabled={readonly} />
    </div>
    <Readouts rows={[["Вершина", `(${fmt(num(r.x0, x0))}; ${fmt(num(r.y0, y0))})`], ["D = b² − 4ac", fmt(num(r.D, D))],
      ["Корни", nRoots === 0 ? "нет" : nRoots === 1 ? fmt(num(r.x1, roots[0] ?? x0)) : `${fmt(num(r.x1, roots[0]))}; ${fmt(num(r.x2, roots[1]))}`],
      ["Ветви", (r.opens ?? (a > 0 ? "up" : "down")) === "up" ? "вверх (a > 0)" : "вниз (a < 0)"]]} />
  </div>;
}

export function LinearLab({ state, onChange, readonly, readouts: r, idp }: LabProps) {
  const k = num(state.k, 1), b = num(state.b, 0);
  const p = plane(W, H, -8, 8, -10, 10);
  const set = (key: string) => (v: number) => onChange({ ...state, [key]: v });
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="linear">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Прямая y = ${fmt(k)}x ${b < 0 ? "−" : "+"} ${fmt(Math.abs(b))}`}>
      <defs><clipPath id={`${idp}-clip`}><rect width={W} height={H} /></clipPath></defs>
      <Grid p={p} step={1} />
      <g clip-path={`url(#${idp}-clip)`}>
        <path d={curve((x) => k * x + b, p, 2)} class="pl-curve" />
        <circle cx={p.sx(0)} cy={p.sy(b)} r={4.5} class="pl-dot pl-dot--vertex" />
        {k !== 0 && <circle cx={p.sx(-b / k)} cy={p.sy(0)} r={4.5} class="pl-dot pl-dot--root" />}
      </g>
    </svg>
    <div class="sf-lab-controls pt-2">
      <Slider id={`${idp}-k`} label={<>k <small>наклон</small></>} value={k} min={-4} max={4} step={0.5} onChange={set("k")} disabled={readonly} />
      <Slider id={`${idp}-b`} label={<>b <small>Oy</small></>} value={b} min={-6} max={6} step={1} onChange={set("b")} disabled={readonly} />
    </div>
    <Readouts rows={[["Пересечение с Oy", `(0; ${fmt(b)})`], ["Нуль функции", k === 0 ? "нет" : fmt(num(r.x_zero, -b / k))],
      ["Функция", k === 0 ? "постоянная" : (r.increasing ?? k > 0) ? "возрастает (k > 0)" : "убывает (k < 0)"]]} />
  </div>;
}

/** Двухчашечные весы kx + m = nx + p: гири «x» и разновесы «1»; наклон считает сервер (x скрыт). */
export function ScalesLab({ state, onChange, readonly, readouts: r }: LabProps) {
  const lx = num(state.lx), lw = num(state.lw), rx = num(state.rx), rw = num(state.rw);
  const tilt = num(r.tilt, 0);
  const angle = -tilt * 7;
  const set = (key: string) => (v: number) => onChange({ ...state, [key]: Math.max(0, Math.min(60, v)) });
  const pan = (xs: number, ws: number, cx: number) => {
    const items: { x: boolean }[] = [...Array(Math.min(xs, 8))].map(() => ({ x: true })).concat([...Array(Math.min(ws, 12))].map(() => ({ x: false })));
    return items.map((it, i) => {
      const col = i % 5, row = Math.floor(i / 5);
      const x = cx - 44 + col * 22, y = 96 - row * 16;
      return it.x ? <g key={i}><rect x={x - 9} y={y - 14} width={18} height={14} rx={3} class="pl-weight pl-weight--x" /><text x={x} y={y - 4} class="pl-weight-label f-c f-w6" text-anchor="middle">x</text></g>
        : <g key={i}><rect x={x - 7} y={y - 11} width={14} height={11} rx={2} class="pl-weight" /><text x={x} y={y - 3} class="pl-weight-label f-c f-w6 pl-weight-label--n" text-anchor="middle">1</text></g>;
    });
  };
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="scales">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} 170`} role="img" aria-label={`Весы: слева ${lx}x + ${lw}, справа ${rx}x + ${rw}. ${tilt === 0 ? "Равновесие" : tilt > 0 ? "Перевешивает левая чаша" : "Перевешивает правая чаша"}`}>
      <polygon points="150,160 170,160 160,40" class="pl-stand" />
      <g transform={`rotate(${angle} 160 40)`} class="pl-beam-g">
        <line x1={50} x2={270} y1={40} y2={40} class="pl-beam" />
        <line x1={70} x2={70} y1={40} y2={100} class="pl-string" /><line x1={250} x2={250} y1={40} y2={100} class="pl-string" />
        <g transform={`rotate(${-angle} 70 100)`}><rect x={18} y={100} width={104} height={6} rx={3} class="pl-pan" />{pan(lx, lw, 70)}</g>
        <g transform={`rotate(${-angle} 250 100)`}><rect x={198} y={100} width={104} height={6} rx={3} class="pl-pan" />{pan(rx, rw, 250)}</g>
      </g>
      <circle cx={160} cy={40} r={4} class="pl-pivot" />
    </svg>
    <div class="sf-lab-controls pt-2 pl-scales-controls l-h l-wrap">
      <Stepper label="Левая: гири x" value={lx} min={0} max={8} onChange={set("lx")} disabled={readonly} />
      <Stepper label="Правая: гири x" value={rx} min={0} max={8} onChange={set("rx")} disabled={readonly} />
      <Stepper label="Левая: разновесы 1" value={lw} min={0} max={60} onChange={set("lw")} disabled={readonly} />
      <Stepper label="Правая: разновесы 1" value={rw} min={0} max={60} onChange={set("rw")} disabled={readonly} />
    </div>
    <Readouts rows={[["Уравнение", `${lx ? `${lx === 1 ? "" : lx}x` : ""}${lx && lw ? " + " : ""}${lw || !lx ? lw : ""} = ${rx ? `${rx === 1 ? "" : rx}x` : ""}${rx && rw ? " + " : ""}${rw || !rx ? rw : ""}`],
      ["Весы", yes(r.balanced) ? "равновесие" : `перевешивает ${String(r.heavier ?? "—")}`]]} />
  </div>;
}

const SHAPE_RU: Record<string, string> = { rectangle: "Прямоугольник", parallelogram: "Параллелограмм", triangle: "Треугольник", trapezoid: "Трапеция", circle: "Круг" };
/** Фигура на клетчатой сетке: основание a (b), высота h, сдвиг вершины; площадь и периметр считает сервер. */
export function AreaLab({ cfg, state, onChange, readonly, readouts: r, idp }: LabProps) {
  const shapes = (Array.isArray(cfg.shapes) && cfg.shapes.length ? cfg.shapes : [String(state.shape ?? "rectangle")]) as string[];
  const shape = String(state.shape ?? shapes[0]);
  const a = num(state.a, 4), b = num(state.b, 3), h = num(state.h, 3), off = num(state.offset, 0), rad = num(state.r, 3);
  const cell = 14, gx = 22, gy = 14, cols = 20, rows = 14;
  const X = (u: number) => 16 + u * cell, Y = (v: number) => 12 + (rows - v) * cell;
  let pts = "";
  if (shape === "rectangle") pts = `${X(2)},${Y(1)} ${X(2 + a)},${Y(1)} ${X(2 + a)},${Y(1 + b)} ${X(2)},${Y(1 + b)}`;
  else if (shape === "parallelogram") pts = `${X(4)},${Y(1)} ${X(4 + a)},${Y(1)} ${X(4 + a + off)},${Y(1 + h)} ${X(4 + off)},${Y(1 + h)}`;
  else if (shape === "triangle") pts = `${X(4)},${Y(1)} ${X(4 + a)},${Y(1)} ${X(4 + off + a / 2)},${Y(1 + h)}`;
  else if (shape === "trapezoid") pts = `${X(3)},${Y(1)} ${X(3 + a)},${Y(1)} ${X(3 + off + b)},${Y(1 + h)} ${X(3 + off)},${Y(1 + h)}`;
  const set = (k: string) => (v: number) => onChange({ ...state, [k]: v });
  const S = num(r.S, NaN);
  void gx; void gy;
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="area">
    {shapes.length > 1 && <div class="pl-chips l-h l-wrap l-g1" role="radiogroup" aria-label="Фигура">{shapes.map((s) =>
      <button key={s} type="button" role="radio" aria-checked={s === shape} class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" disabled={readonly} onClick={() => onChange({ ...state, shape: s })}>{SHAPE_RU[s] ?? s}</button>)}</div>}
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${32 + cols * cell} ${24 + rows * cell}`} role="img" aria-label={`${SHAPE_RU[shape] ?? shape} на клетчатой сетке${Number.isFinite(S) ? `, площадь ${fmt(S)} клеток` : ""}`}>
      <defs><clipPath id={`${idp}-clip`}><rect x={16} y={12} width={cols * cell} height={rows * cell} /></clipPath></defs>
      <g class="pl-grid" aria-hidden="true">
        {[...Array(cols + 1)].map((_, i) => <line key={`c${i}`} x1={X(i)} x2={X(i)} y1={Y(0)} y2={Y(rows)} class="pl-gridline" />)}
        {[...Array(rows + 1)].map((_, i) => <line key={`r${i}`} y1={Y(i)} y2={Y(i)} x1={X(0)} x2={X(cols)} class="pl-gridline" />)}
      </g>
      <g clip-path={`url(#${idp}-clip)`}>
        {shape === "circle" ? <><circle cx={X(10)} cy={Y(7)} r={rad * cell} class="pl-shape" /><line x1={X(10)} y1={Y(7)} x2={X(10 + rad)} y2={Y(7)} class="pl-measure" /></>
          : <polygon points={pts} class="pl-shape" />}
        {(shape === "parallelogram" || shape === "triangle" || shape === "trapezoid") &&
          <line x1={X((shape === "trapezoid" ? 3 : 4) + off + (shape === "triangle" ? a / 2 : 0))} x2={X((shape === "trapezoid" ? 3 : 4) + off + (shape === "triangle" ? a / 2 : 0))} y1={Y(1)} y2={Y(1 + h)} class="pl-measure pl-measure--h" />}
      </g>
    </svg>
    <div class="sf-lab-controls pt-2">
      {shape === "circle" ? <Slider id={`${idp}-r`} label={<>r <small>радиус</small></>} value={rad} min={1} max={10} step={1} onChange={set("r")} disabled={readonly} />
        : <Slider id={`${idp}-a`} label={<>a <small>основание</small></>} value={a} min={1} max={12} step={1} onChange={set("a")} disabled={readonly} />}
      {(shape === "rectangle" || shape === "trapezoid") && <Slider id={`${idp}-b`} label={<>b <small>{shape === "rectangle" ? "сторона" : "осн. 2"}</small></>} value={b} min={1} max={12} step={1} onChange={set("b")} disabled={readonly} />}
      {(shape === "parallelogram" || shape === "triangle" || shape === "trapezoid") && <>
        <Slider id={`${idp}-h`} label={<>h <small>высота</small></>} value={h} min={1} max={10} step={1} onChange={set("h")} disabled={readonly} />
        <Slider id={`${idp}-o`} label={<>сдвиг <small>вершины</small></>} value={off} min={-6} max={6} step={1} onChange={set("offset")} disabled={readonly} /></>}
    </div>
    <Readouts rows={[["Площадь S", Number.isFinite(S) ? `${fmt(S)} кл.` : "…"], ...(r.P !== null && r.P !== undefined ? [["Периметр P", `${fmt(num(r.P))} кл.`] as [string, string]] : []),
      ...(shape === "circle" ? [["S / π", fmt(num(r.S_over_pi, rad * rad))] as [string, string]] : [])]} />
  </div>;
}

/** Электрическая цепь: источник U, реостат R (и R₂ при последовательном/параллельном), амперметр, лампа. */
export function OhmLab({ state, onChange, readonly, readouts: r, idp }: LabProps) {
  const U = num(state.U, 6), R = num(state.R, 3), R2 = num(state.R2, 6);
  const closed = state.closed === true, mode = String(state.mode ?? "single");
  const I = num(r.I, closed ? U / R : 0);
  const glow = Math.max(0.08, Math.min(1, I / 4));
  const rows = Array.isArray(state.measurements) ? (state.measurements as { U: number; R: number; I: number | null }[]) : [];
  const set = (k: string) => (v: unknown) => onChange({ ...state, [k]: v });
  const record = () => onChange({ ...state, measurements: [...rows, { U, R, I: closed ? Math.round(I * 1000) / 1000 : 0 }].slice(-12) });
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="ohm">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} 180`} role="img" aria-label={`Цепь ${closed ? "замкнута" : "разомкнута"}: U = ${fmt(U)} В, R = ${fmt(R)} Ом, амперметр ${fmt(I)} А`}>
      <path d="M40 40 H280 V140 H40 Z" class={`pl-wire${closed ? " is-live" : ""}`} />
      <g transform="translate(40 90)"><rect x={-14} y={-22} width={28} height={44} rx={6} class="pl-device" /><line x1={-8} x2={8} y1={-6} y2={-6} class="pl-cell-long" /><line x1={-4} x2={4} y1={4} y2={4} class="pl-cell-short" /><text x={0} y={36} class="pl-dev-label f-c" text-anchor="middle">{fmt(U)} В</text></g>
      <g transform="translate(120 40)"><rect x={-26} y={-9} width={52} height={18} rx={4} class="pl-resistor" /><text x={0} y={-15} class="pl-dev-label f-c" text-anchor="middle">R {fmt(R)} Ом</text></g>
      {mode !== "single" && <g transform={mode === "series" ? "translate(200 40)" : "translate(120 75)"}><rect x={-26} y={-9} width={52} height={18} rx={4} class="pl-resistor" /><text x={0} y={mode === "series" ? -15 : 24} class="pl-dev-label f-c" text-anchor="middle">R₂ {fmt(R2)} Ом</text></g>}
      {mode === "parallel" && <path d="M86 40 V75 H94 M146 75 H154 V40" class="pl-wire" />}
      <g transform="translate(280 90)"><circle r={18} class="pl-device" /><text y={5} class="pl-dev-label f-c pl-dev-label--strong f-w6" text-anchor="middle">A</text><text x={-28} y={40} class="pl-dev-label f-c" text-anchor="middle">{fmt(I, 3)} А</text></g>
      <g transform="translate(160 140)"><circle r={14} class="pl-lamp" style={{ opacity: closed ? glow : 0.12 }} /><circle r={14} class="pl-lamp-ring" /><path d="M-6 -6 L6 6 M6 -6 L-6 6" class="pl-lamp-x" /></g>
      <g transform="translate(220 140)" class="pl-switch"><line x1={-14} x2={14} y1={0} y2={closed ? 0 : -10} class="pl-wire is-switch" /><circle cx={-14} r={3} class="pl-pivot" /><circle cx={14} r={3} class="pl-pivot" /></g>
    </svg>
    <div class="sf-lab-controls pt-2">
      <div class="pl-row-actions l-h l-wrap">
        <button type="button" class={`sf-btn p-23 l-h l-inl l-jc f-b f-w6 f-trunc b-tap mw-full sf-btn--secondary b-box b-nob pl-toggle${closed ? " is-on" : ""}`} aria-pressed={closed} disabled={readonly} onClick={() => set("closed")(!closed)}>{closed ? "Разомкнуть ключ" : "Замкнуть ключ"}</button>
        <button type="button" class="sf-btn p-23 l-h l-inl l-jc f-b f-w6 f-trunc b-tap mw-full sf-btn--ghost f-2" disabled={readonly || !closed} onClick={record}>Записать замер</button>
      </div>
      <Slider id={`${idp}-U`} label={<>U <small>вольт</small></>} value={U} min={0} max={24} step={1} unit=" В" onChange={(v) => set("U")(v)} disabled={readonly} />
      <Slider id={`${idp}-R`} label={<>R <small>ом</small></>} value={R} min={1} max={30} step={1} unit=" Ом" onChange={(v) => set("R")(v)} disabled={readonly} />
      {mode !== "single" && <Slider id={`${idp}-R2`} label={<>R₂ <small>ом</small></>} value={R2} min={1} max={30} step={1} unit=" Ом" onChange={(v) => set("R2")(v)} disabled={readonly} />}
    </div>
    <Readouts rows={[["Сила тока I", closed ? `${fmt(I, 3)} А` : "0 А (цепь разомкнута)"], ["Сопротивление цепи", `${fmt(num(r.R_total, R))} Ом`], ["Нагрев", String(r.heat ?? "—")]]} />
    {rows.length > 0 && <table class="pl-table f-m f-2 f-num l-w100"><caption>Таблица замеров</caption><thead><tr><th scope="col">№</th><th scope="col">U, В</th><th scope="col">R, Ом</th><th scope="col">I, А</th></tr></thead>
      <tbody>{rows.map((m, i) => <tr key={i}><td class="sf-tabular">{i + 1}</td><td class="sf-tabular">{fmt(num(m.U))}</td><td class="sf-tabular">{fmt(num(m.R))}</td><td class="sf-tabular">{m.I === null ? "—" : fmt(num(m.I), 3)}</td></tr>)}</tbody></table>}
  </div>;
}

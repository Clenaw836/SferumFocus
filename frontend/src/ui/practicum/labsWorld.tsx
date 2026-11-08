/** v3.0 · лаборатории естественных наук и информатики: конструктор молекул, экспедиция в горы,
 *  цепочка событий, сортировка по группам, исполнитель «Робот». Проверка — только сервер. */
import { useState } from "preact/hooks";
import { fmt, num, Readouts, Slider, type LabProps } from "./labKit";

const W = 320, H = 220;
type Atom = { id: string; el: string };
type Bond = { a: string; b: string; order: number };
const VALENCE: Record<string, number> = { H: 1, O: 2, C: 4, N: 3, S: 6, Cl: 1 };
const EL_RU: Record<string, string> = { H: "водород", O: "кислород", C: "углерод", N: "азот", S: "сера", Cl: "хлор" };
const ORDER_RU = ["", "одинарная", "двойная", "тройная"];
const asList = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Раскладка: «скелет» (валентность > 1) — в ряд по центру, концевые атомы — лучами вокруг соседа,
 *  свободные — в лотке снизу. Позиции считаются из связей, перетаскивать ничего не нужно. */
function layout(atoms: Atom[], bonds: Bond[]) {
  const pos: Record<string, { x: number; y: number }> = {};
  const skel = atoms.filter((a) => (VALENCE[a.el] ?? 1) > 1);
  const nb = (id: string) => bonds.flatMap((b) => (b.a === id ? [b.b] : b.b === id ? [b.a] : []));
  const gap = Math.min(78, (W - 70) / Math.max(1, skel.length - 1 || 1));
  skel.forEach((a, i) => { pos[a.id] = { x: W / 2 + (i - (skel.length - 1) / 2) * gap, y: H / 2 - 18 }; });
  const tray: Atom[] = [];
  const slots = [-90, 90, 180, 0, -135, -45, 135, 45];
  const used: Record<string, number[]> = {};
  for (const a of atoms) {
    if (pos[a.id]) continue;
    const host = nb(a.id).find((n) => skel.some((s) => s.id === n));
    if (!host) { tray.push(a); continue; }
    const hi = skel.findIndex((s) => s.id === host);
    const taken = used[host] ?? (used[host] = [
      ...(hi > 0 && nb(host).includes(skel[hi - 1].id) ? [180] : []),
      ...(hi < skel.length - 1 && nb(host).includes(skel[hi + 1].id) ? [0] : []),
      ...(hi > 0 ? [180] : []), ...(hi < skel.length - 1 ? [0] : [])]);
    const ang = slots.find((s) => !taken.includes(s)) ?? slots[taken.length % slots.length];
    taken.push(ang);
    const h = pos[host], rad = (ang * Math.PI) / 180;
    pos[a.id] = { x: h.x + Math.cos(rad) * 40, y: h.y + Math.sin(rad) * 40 };
  }
  tray.forEach((a, i) => { pos[a.id] = { x: 26 + i * 34, y: H - 20 }; });
  return pos;
}

export function MoleculeLab({ cfg, state, onChange, readonly, readouts: r }: LabProps) {
  const atoms = asList<Atom>(state.atoms), bonds = asList<Bond>(state.bonds);
  const palette = asList<string>(cfg.palette).filter((e) => e in VALENCE);
  const [sel, setSel] = useState<string | null>(null);
  const pos = layout(atoms, bonds);
  const bad = new Map(asList<{ id: string; used: number; valence: number }>(r.violations).map((v) => [v.id, v]));
  const label = (id: string) => { const a = atoms.find((x) => x.id === id); const n = atoms.filter((x) => x.el === a?.el).findIndex((x) => x.id === id) + 1; return a ? `${a.el}${n}` : id; };
  const emit = (nextAtoms: Atom[], nextBonds: Bond[]) => onChange({ ...state, atoms: nextAtoms, bonds: nextBonds });
  const add = (el: string) => {
    if (atoms.length >= 16) return;
    let n = 1; while (atoms.some((a) => a.id === `${el.toLowerCase()}${n}`)) n++;
    emit([...atoms, { id: `${el.toLowerCase()}${n}`, el }], bonds);
  };
  const tap = (id: string) => {
    if (readonly) return;
    if (!sel || sel === id) { setSel(sel === id ? null : id); return; }
    const i = bonds.findIndex((b) => (b.a === sel && b.b === id) || (b.a === id && b.b === sel));
    if (i < 0) emit(atoms, [...bonds, { a: sel, b: id, order: 1 }].slice(0, 24));
    else cycle(i);
    setSel(null);
  };
  const cycle = (i: number) => {
    const b = bonds[i];
    emit(atoms, b.order >= 3 ? bonds.filter((_, j) => j !== i) : bonds.map((x, j) => (j === i ? { ...x, order: x.order + 1 } : x)));
  };
  const removeAtom = (id: string) => { emit(atoms.filter((a) => a.id !== id), bonds.filter((b) => b.a !== id && b.b !== id)); setSel(null); };
  const violations = asList<{ id: string; used: number; valence: number }>(r.violations);
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="molecule">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={atoms.length ? `Модель: ${String(r.formula || "")}, атомов ${atoms.length}, связей ${bonds.length}` : "Поле конструктора пустое"}>
      {bonds.map((b, i) => {
        const p = pos[b.a], q = pos[b.b];
        if (!p || !q) return null;
        const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, ox = (-dy / L) * 3.5, oy = (dx / L) * 3.5;
        const offs = b.order === 1 ? [0] : b.order === 2 ? [-1, 1] : [-2, 0, 2];
        return <g key={i} class="pl-bond">{offs.map((k) => <line key={k} x1={p.x + ox * k} y1={p.y + oy * k} x2={q.x + ox * k} y2={q.y + oy * k} />)}</g>;
      })}
      {atoms.map((a) => {
        const p = pos[a.id]; const v = bad.get(a.id);
        return <g key={a.id} class={`pl-atom pl-atom--${a.el}${sel === a.id ? " is-selected" : ""}${v ? (v.used > v.valence ? " is-over" : " is-open") : ""}`}
          transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} onClick={() => tap(a.id)}>
          <circle r={a.el === "H" ? 12 : 15} /><text class="f-w6" text-anchor="middle" dy="0.35em">{a.el}</text>
        </g>;
      })}
      {!atoms.length && <text x={W / 2} y={H / 2} text-anchor="middle" class="pl-tick f-c">Добавь атомы кнопками ниже</text>}
    </svg>
    {!readonly && <div class="pl-chips l-h l-wrap l-g1" role="group" aria-label="Добавить атом">
      {palette.map((el) => <button key={el} type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" disabled={atoms.length >= 16} onClick={() => add(el)}
        aria-label={`Добавить атом: ${EL_RU[el] ?? el}, валентность ${VALENCE[el]}`}>+ {el} <small>{VALENCE[el]}</small></button>)}
    </div>}
    {atoms.length > 0 && <div class="pl-atom-list l-h l-wrap l-g1" role="group" aria-label="Атомы: выбери два, чтобы связать">
      {atoms.map((a) => <button key={a.id} type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix pl-chip--atom mw-44" aria-pressed={sel === a.id} disabled={readonly}
        onClick={() => tap(a.id)}>{label(a.id)}</button>)}
    </div>}
    {!readonly && <p class="pl-hint-line f-m f-3" aria-live="polite">{sel ? `Выбран ${label(sel)}. Нажми второй атом — появится связь; повторное нажатие повышает кратность.` : "Нажми атом, затем второй: так появляется связь."}</p>}
    {!readonly && sel && <div class="pl-row-actions l-h l-wrap"><button type="button" class="btn btn-ghost" onClick={() => removeAtom(sel)}>Убрать {label(sel)}</button></div>}
    {bonds.length > 0 && <ul class="pl-bond-list l-v l-g1" aria-label="Связи">
      {bonds.map((b, i) => <li class="f-2" key={`${b.a}-${b.b}-${i}`}><span>{label(b.a)} — {label(b.b)} · {ORDER_RU[b.order] ?? b.order}</span>
        {!readonly && <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Связь ${label(b.a)} — ${label(b.b)}: изменить кратность`} onClick={() => cycle(i)}>×{b.order}</button>}</li>)}
    </ul>}
    <Readouts rows={[["Формула", String(r.formula || "—")],
      ["Валентность", !atoms.length ? "—" : violations.length ? violations.slice(0, 3).map((v) => `${label(v.id)}: ${v.used} из ${v.valence}`).join(", ") : "все связи на месте"],
      ["Части", r.connected === false ? "несколько отдельных" : atoms.length ? "одна частица" : "—"]]} />
  </div>;
}

export function ClimateLab({ state, onChange, readonly, readouts: r, idp }: LabProps) {
  const alt = num(state.alt), lat = num(state.lat, 55);
  const T = num(r.T, 15 - (6 * alt) / 1000);
  const p = r.p === null ? null : num(r.p, 760 - alt / 10);
  const set = (k: string) => (v: number) => onChange({ ...state, [k]: v });
  const my = (a: number) => 196 - (a / 10000) * 170;
  const la = (lat * Math.PI) / 180;
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="climate">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Высота ${alt} м, температура ${fmt(T, 1)} °C, давление ${p === null ? "вне правила" : `${fmt(p, 0)} мм рт. ст.`}, широта ${lat}°, пояс ${String(r.belt || "")}`}>
      <path d="M6,196 L70,60 L96,92 L128,26 L190,196 Z" class="pl-mountain" />
      {[0, 2000, 4000, 6000, 8000, 10000].map((a) => <g key={a}><line x1={196} x2={204} y1={my(a)} y2={my(a)} class="pl-axis" />
        <text x={208} y={my(a) + 3} class="pl-tick f-c">{a / 1000} км</text></g>)}
      <line x1={0} x2={200} y1={my(3000)} y2={my(3000)} class="pl-guide" />
      <line x1={6} x2={196} y1={my(alt)} y2={my(alt)} class="pl-level" />
      <circle cx={100} cy={my(alt)} r={5} class="pl-dot pl-dot--vertex" />
      <g transform="translate(262 120)">
        <path d="M-40,0 A40,40 0 0 1 40,0" class="pl-globe" />
        <line x1={-46} x2={46} y1={0} y2={0} class="pl-axis" />
        <line x1={0} y1={0} x2={Math.cos(la) * 40} y2={-Math.sin(la) * 40} class="pl-curve" />
        <text x={0} y={18} text-anchor="middle" class="pl-tick f-c">{lat}° с. ш.</text>
      </g>
    </svg>
    <div class="sf-lab-controls pt-2">
      <Slider id={`${idp}-alt`} label="Высота" value={alt} min={0} max={10000} step={100} unit=" м" onChange={set("alt")} disabled={readonly} />
      <Slider id={`${idp}-lat`} label="Широта" value={lat} min={0} max={90} step={1} unit="°" onChange={set("lat")} disabled={readonly} />
    </div>
    <Readouts rows={[["Температура", `${fmt(T, 1)} °C`], ["Давление", p === null ? "правило −10 мм на 100 м работает до 3 км" : `${fmt(p, 0)} мм рт. ст.`],
      ["Пояс", String(r.belt || "—")]]} />
    <p class="pl-note f-m f-3">Учебная модель: −6 °C на каждый километр подъёма. Реальные границы поясов извилистее.</p>
  </div>;
}

export function OrderLab({ cfg, state, onChange, readonly }: LabProps) {
  const items = asList<{ id: string; text: string }>(cfg.items);
  const order = asList<string>(state.order).filter((id) => items.some((i) => i.id === id));
  const full = [...order, ...items.map((i) => i.id).filter((id) => !order.includes(id))];
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= full.length) return;
    const next = [...full]; [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...state, order: next });
  };
  const text = (id: string) => items.find((i) => i.id === id)?.text ?? id;
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="order">
    <ol class="pl-order l-v l-g1">
      {full.map((id, i) => <li key={id} class="pl-order-card l-a1a l-mid b-tile">
        <span class="pl-order-n f-b f-w6 f-a f-tc sf-tabular" aria-hidden="true">{i + 1}</span>
        <span class="pl-order-text f-b">{text(id)}</span>
        {!readonly && <span class="pl-order-move l-h l-inl l-g1">
          <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Поднять: ${text(id)}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Опустить: ${text(id)}`} disabled={i === full.length - 1} onClick={() => move(i, 1)}>↓</button>
        </span>}
      </li>)}
    </ol>
  </div>;
}

export function ClassifyLab({ cfg, state, onChange, readonly, readouts: r }: LabProps) {
  const buckets = asList<{ id: string; title: string }>(cfg.buckets);
  const items = asList<{ id: string; text: string }>(cfg.items);
  const assign = (state.assign && typeof state.assign === "object" ? state.assign : {}) as Record<string, string>;
  const put = (item: string, bucket: string | null) => {
    const next = { ...assign }; if (bucket === null || next[item] === bucket) delete next[item]; else next[item] = bucket;
    onChange({ ...state, assign: next });
  };
  const groups: { id: string | null; title: string }[] = [{ id: null, title: "Не разложено" }, ...buckets];
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="classify">
    {groups.map((g) => {
      const list = items.filter((i) => (g.id === null ? !assign[i.id] : assign[i.id] === g.id));
      if (g.id === null && !list.length) return null;
      return <section key={g.id ?? "_"} class={`pl-bucket l-v l-g1 b-tile${g.id === null ? " pl-bucket--pool" : ""}`} aria-label={g.title}>
        <h4 class="f-2">{g.title} <span class="sf-tabular">{list.length}</span></h4>
        {list.length ? <ul>{list.map((it) => <li key={it.id} class="pl-sort-card l-v l-g1 b-tile b-nob">
          <span>{it.text}</span>
          {!readonly && <span class="pl-chips l-h l-wrap l-g1" role="radiogroup" aria-label={`Куда: ${it.text}`}>
            {buckets.map((b) => <button key={b.id} type="button" role="radio" aria-checked={assign[it.id] === b.id} class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" onClick={() => put(it.id, b.id)}>{b.title}</button>)}
          </span>}
        </li>)}</ul> : <p class="pl-note f-m f-3">Пока пусто</p>}
      </section>;
    })}
    <Readouts rows={[["Разложено", `${num(r.assigned, Object.keys(assign).length)} из ${num(r.total, items.length)}`]]} />
  </div>;
}

const CMD: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
const CMD_RU: Record<string, string> = { up: "вверх", down: "вниз", left: "влево", right: "вправо" };
export function RobotLab({ cfg, state, onChange, readonly, readouts: r }: LabProps) {
  const w = num(cfg.w, 6), h = num(cfg.h, 5), maxLen = num(cfg.max_len, 30);
  const start = asList<number>(cfg.start), goal = asList<number>(cfg.goal), walls = asList<number[]>(cfg.walls);
  const program = asList<string>(state.program);
  const cell = Math.min(Math.floor((W - 8) / w), Math.floor((H - 8) / h));
  const ox = (W - cell * w) / 2, oy = (H - cell * h) / 2;
  const cx = (x: number) => ox + x * cell + cell / 2, cy = (y: number) => oy + y * cell + cell / 2;
  const path = asList<number[]>(r.path);
  const at = path.length ? path[path.length - 1] : start;
  const set = (p: string[]) => onChange({ ...state, program: p.slice(0, maxLen) });
  const loop = () => {
    if (!program.length) return;
    const last = program[program.length - 1]; const [name, times] = last.split("*");
    const n = times ? Number(times) + 1 : 2;
    set([...program.slice(0, -1), n > 9 ? name : `${name}*${n}`]);
  };
  const show = (c: string) => { const [n, t] = c.split("*"); return `${CMD[n] ?? n}${t ? `×${t}` : ""}`; };
  const say = (c: string) => { const [n, t] = c.split("*"); return t ? `повтори ${t} раза: ${CMD_RU[n]}` : CMD_RU[n] ?? n; };
  return <div class="sf-lab-viewport l-v l-g3 b-tile l-w100 l-rel pl-lab" data-model="robot">
    <svg class="sf-lab-svg-canvas l-blk l-w100 r-sm" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Поле ${w}×${h}. Робот в клетке (${at[0] ?? 0}; ${at[1] ?? 0}). ${r.reached ? "Цель достигнута." : r.crashed ? `Столкновение на шаге ${String(r.crashed_step ?? "")}.` : "Цель ещё не достигнута."}`}>
      {Array.from({ length: w * h }, (_, i) => <rect key={i} x={ox + (i % w) * cell} y={oy + Math.floor(i / w) * cell} width={cell} height={cell} class="pl-cell" />)}
      {walls.map(([x, y], i) => <rect key={`w${i}`} x={ox + x * cell + 2} y={oy + y * cell + 2} width={cell - 4} height={cell - 4} class="pl-wall" />)}
      {goal.length === 2 && <rect x={ox + goal[0] * cell + 6} y={oy + goal[1] * cell + 6} width={cell - 12} height={cell - 12} class="pl-goal" />}
      {path.length > 1 && <polyline points={path.map(([x, y]) => `${cx(x)},${cy(y)}`).join(" ")} class="pl-curve" />}
      {at.length === 2 && <circle cx={cx(at[0])} cy={cy(at[1])} r={cell * 0.28} class={`pl-robot${r.crashed ? " is-crashed" : ""}${r.reached ? " is-done" : ""}`} />}
    </svg>
    <ol class="pl-program l-h l-wrap l-g1" aria-label={`Программа: ${program.length} из ${maxLen} команд`}>
      {program.length ? program.map((c, i) => <li key={i} class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" aria-label={`${i + 1}. ${say(c)}`}>{show(c)}</li>) : <li class="pl-note f-m f-3">Программа пустая</li>}
    </ol>
    {!readonly && <div class="pl-robot-pad l-h l-wrap l-g1">
      {(["up", "left", "down", "right"] as const).map((c) => <button key={c} type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Команда: ${CMD_RU[c]}`} disabled={program.length >= maxLen} onClick={() => set([...program, c])}>{CMD[c]}</button>)}
      <button type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" disabled={!program.length} onClick={loop} aria-label="Повторить последнюю команду ещё раз (цикл)">×N</button>
      <button type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" disabled={!program.length} onClick={() => set(program.slice(0, -1))}>Стереть</button>
      <button type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" disabled={!program.length} onClick={() => set([])}>Очистить</button>
    </div>}
    <Readouts rows={[["Команд", `${program.length} из ${maxLen}`], ["Циклов", String(num(r.loops))],
      ["Итог", r.reached ? "цель достигнута" : r.crashed ? `стена на шаге ${String(r.crashed_step ?? "?")}` : "в пути"]]} />
  </div>;
}

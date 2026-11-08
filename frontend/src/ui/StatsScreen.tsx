/**
 * Master v2.0 · Feature 3 — «Статистика» внутри профиля. Столбчатая диаграмма (navy + бирюза),
 * периоды 7/14/30 дней, переключатель «Время / Задания», подписи осей с единицами, текстовая таблица,
 * загрузка/ошибка/пусто, объяснение каждого показателя. Только проверяемые данные сервера
 * (/webapp/my-week): «нет данных» ≠ 0, среднее/сравнение — лишь при достаточном объёме.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError, cache, dataMode } from "../lib/api";
import { DEMO } from "../lib/demo";
import { inSandbox } from "../lib/sandbox";
import { compare, fmtMin, longDate, niceScale, summarize, tickLabel, valueOf, xLabel, type Day, type Metric, type Period } from "../lib/statsChart";
import { plural } from "../lib/time";
import { Segmented } from "./Segmented";
import { Icon } from "./Icon";

const W = 340, H = 196, L = 44, R = 8, T = 18, B = 26;
type Data = { cur: Day[]; prev: Day[] | null };

function Chart({ days, metric, sel, onSel }: { days: Day[]; metric: Metric; sel: number | null; onSel: (i: number) => void }) {
  const vals = days.map((d) => valueOf(d, metric));
  const sc = niceScale(Math.max(0, ...vals.map((v) => v ?? 0)), metric);
  const pw = W - L - R, ph = H - T - B, slot = pw / days.length, bw = Math.max(3, Math.min(22, slot * 0.62));
  const y = (v: number) => T + ph - (v / sc.max) * ph;
  return <svg class="st-chart l-blk l-w100" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
    <defs><pattern id="st-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="st-hatch-bg" /><line x1="0" y1="0" x2="0" y2="5" class="st-hatch-line" /></pattern></defs>
    {sc.ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} class={t === 0 ? "st-axis" : "st-grid"} />
      <text x={L - 6} y={y(t) + 4} class="st-tick f-c f-num" text-anchor="end">{tickLabel(t, metric)}</text></g>)}
    {days.map((d, i) => {
      const x = L + slot * i + (slot - bw) / 2, v = vals[i];
      const label = xLabel(d.date, i, days.length);
      const segs: { v: number; cls: string }[] = [];
      if (v !== null && v > 0) {
        if (metric === "minutes" && d.actual_minutes != null && d.estimate_minutes != null) {
          if (d.actual_minutes > 0) segs.push({ v: d.actual_minutes, cls: "st-actual" });
          if (d.estimate_minutes > 0) segs.push({ v: d.estimate_minutes, cls: "st-estimate" });
        } else segs.push({ v, cls: metric === "minutes" ? "st-unsplit" : "st-tasks" });
      }
      let acc = 0;
      return <g key={d.date} class={`st-col${sel === i ? " is-sel" : ""}`} style={{ "--i": i }} onClick={() => onSel(i)}>
        <rect x={L + slot * i} y={T} width={slot} height={ph + B} class="st-hit" />
        {segs.map((s) => { const y1 = y(acc + s.v), y0 = y(acc); acc += s.v;
          return <rect key={s.cls} x={x} y={y1} width={bw} height={Math.max(1.5, y0 - y1)} rx={Math.min(3, bw / 3)} class={`st-bar ${s.cls}`} />; })}
        {v === null && <text x={x + bw / 2} y={y(0) - 4} class="st-na f-c" text-anchor="middle">—</text>}
        {d.counted && <circle cx={x + bw / 2} cy={Math.max(T - 6, y(v ?? 0) - 7)} r="3.2" class="st-mark" />}
        {label && <text x={x + bw / 2} y={H - 8} class="st-x f-c f-num" text-anchor="middle">{label}</text>}
      </g>;
    })}
  </svg>;
}

export function StatsScreen() {
  const [period, setPeriod] = useState<Period>(7);
  const [metric, setMetric] = useState<Metric>("minutes");
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [rk, setRk] = useState(0);
  useEffect(() => {
    let alive = true; setErr(null); setSel(null);
    const n = period === 30 ? 30 : period * 2;              // 7/14 — с предыдущим периодом для сравнения
    const key = `sf.stats.${n}`;
    const cached = cache.get<Day[]>(key);
    setData(cached ? { cur: cached.slice(-period), prev: n === period * 2 ? cached.slice(0, period) : null } : null);
    api.myWeek(n).then((w) => { if (!alive) return; cache.set(key, w.days); setData({ cur: w.days.slice(-period), prev: n === period * 2 && w.days.length === n ? w.days.slice(0, period) : null }); })
      .catch((e) => { if (alive) setErr(e instanceof ApiError ? e.message : "Не загрузилось"); });
    return () => { alive = false; };
  }, [period, rk]);
  const s = useMemo(() => (data ? summarize(data.cur) : null), [data]);
  const cmp = data?.prev ? compare(data.cur, data.prev) : null;
  const synthetic = DEMO || inSandbox();
  const local = dataMode() === "local";
  const periodName = period === 7 ? "неделю" : period === 14 ? "2 недели" : "30 дней";
  const prevName = period === 7 ? "прошлой неделе" : "прошлым 2 неделям";
  const empty = s && s.total === 0 && s.duels === 0 && !s.tasks;
  const d = data && sel !== null ? data.cur[sel] : null;

  return <div class="stats-screen l-v l-g3">
    {(synthetic || local) && <p class={`src-badge ${synthetic ? "demo" : "none"}`} role="note">{synthetic ? "Демонстрация: данные этой демо-сессии — синтетические, не школьные" : "Данные на этом устройстве (автономный режим)"}</p>}
    <div class="stats-controls l-v">
      <Segmented<string> label="Период" value={String(period)} onChange={(v) => setPeriod(Number(v) as Period)} options={[{ value: "7", label: "7 дней" }, { value: "14", label: "14 дней" }, { value: "30", label: "30 дней" }]} />
      <Segmented<Metric> label="Показатель" value={metric} onChange={setMetric} options={[{ value: "minutes", label: "Время" }, { value: "tasks", label: "Задания" }]} />
    </div>
    {err && !data && <div class="empty" role="alert"><Icon name="wifiOff" /><h3>Статистика не загрузилась</h3><p class="f-2">{err}</p><button type="button" class="btn btn-secondary btn-sm" onClick={() => setRk((k) => k + 1)}>Повторить</button></div>}
    {!data && !err && <div class="stats-skeleton" role="status" aria-label="Загружаем статистику"><div class="sk" style="height:196px" /><div class="sk" style="height:72px;margin-top:12px" /></div>}
    {data && s && <>
      {err && <p class="note warn" role="status"><Icon name="alert" /><span>Показаны сохранённые данные: {err}</span></p>}
      <figure class="stats-figure b-card" key={`${period}-${metric}`}>
        <figcaption class="stats-caption l-v l-g1 mb-2">
          <b>{metric === "minutes" ? "Время учёбы по дням" : "Задания «Готово» по дням"}</b>
          <span class="f-a">{metric === "minutes" ? `Ось — минуты и часы; за ${periodName}: ${fmtMin(s.total)}` : `Ось — количество; за ${periodName}: ${s.tasks ?? "нет данных"}${s.tasks !== null && s.tasksPartial ? " (часть дней без данных)" : ""}`}</span>
        </figcaption>
        {empty ? <div class="stats-empty l-v l-ac f-b f-a f-tc"><Icon name="chart" /><p>За {periodName} активности пока нет. Отметь «Готово» у задания или запусти фокус-таймер — столбики появятся здесь.</p></div>
          : <Chart days={data.cur} metric={metric} sel={sel} onSel={(i) => setSel(sel === i ? null : i)} />}
        {!empty && <ul class="stats-legend l-h l-wrap l-g1 f-m f-a mt-2" aria-label="Обозначения">
          {metric === "minutes" ? <><li><i class="lg r-xs st-actual u-acc-bg" />по фокус-таймеру</li><li><i class="lg r-xs st-estimate" />по оценке времени</li>{s.unsplitMinutes > 0 && <li><i class="lg r-xs st-unsplit u-acc-bg" />без разбивки</li>}</> : <li><i class="lg r-xs st-tasks u-acc-bg" />заданий</li>}
          <li><i class="lg-mark b-round" />день засчитан</li><li><span class="lg-na f-w6 f-2">—</span> нет данных</li>
        </ul>}
        {d && <p class="stats-day p-2 f-b mt-2 r-md u-acc-s" role="status"><b>{longDate(d.date)}:</b> {fmtMin(d.study_minutes)} учёбы
          {d.actual_minutes != null && d.estimate_minutes != null && d.study_minutes > 0 ? ` (таймер ${fmtMin(d.actual_minutes)}, оценка ${fmtMin(d.estimate_minutes)})` : ""}
          {d.tasks_done != null ? ` · ${d.tasks_done} ${plural(d.tasks_done, "задание", "задания", "заданий")}` : " · задания: нет данных"}
          {d.duels ? ` · блиц: ${d.duels}` : ""}{d.counted ? " · день засчитан ✓" : ""}</p>}
      </figure>
      <dl class="stats-kpis l-c2">
        <div><dt>Всего за {periodName}</dt><dd class="num f-w6">{fmtMin(s.total)}</dd>{s.total > 0 && <dd class="kpi-note f-m f-3">таймер {fmtMin(s.actual)} · оценка {fmtMin(s.estimate)}{s.unsplitMinutes ? ` · без разбивки ${fmtMin(s.unsplitMinutes)}` : ""}</dd>}</div>
        <div><dt>В среднем за активный день</dt><dd class="num f-w6">{s.avgActive !== null ? `≈ ${fmtMin(s.avgActive)}` : "мало данных"}</dd><dd class="kpi-note f-m f-3">{s.activeDays} {plural(s.activeDays, "активный день", "активных дня", "активных дней")}{s.avgActive === null ? " — среднее с 3 дней" : ""}</dd></div>
        <div><dt>Дней засчитано</dt><dd class="num f-w6">{s.counted} из {s.days}</dd><dd class="kpi-note f-m f-3">выполнено ≥ 65 % плана дня</dd></div>
        <div><dt>Блиц</dt><dd class="num f-w6">{s.duels} {plural(s.duels, "дуэль", "дуэли", "дуэлей")}</dd><dd class="kpi-note f-m f-3">{s.blitzAvg !== null ? `средний счёт ${String(s.blitzAvg).replace(".", ",")} из 3` : "средний счёт — от 3 дуэлей"}</dd></div>
      </dl>
      {cmp && <p class="stats-compare l-h f-b f-2"><Icon name={cmp.delta > 0 ? "up" : cmp.delta < 0 ? "down" : "flat"} />{cmp.delta === 0 ? `Столько же, сколько по ${prevName}` : `${cmp.delta > 0 ? "+" : "−"}${fmtMin(Math.abs(cmp.delta))} к ${prevName} (было ${fmtMin(cmp.prevTotal)})`}</p>}
      {!cmp && period !== 30 && <p class="hint-text">Сравнение с прошлым периодом появится, когда в обоих будет хотя бы 3 активных дня.</p>}
      <details class="stats-table-box b-tile">
        <summary>Таблица значений</summary>
        <table class="stats-table f-b f-num l-w100">
          <caption class="sr">Статистика по дням за {periodName}</caption>
          <thead><tr><th scope="col">День</th><th scope="col">Учёба</th><th scope="col">Таймер / оценка</th><th scope="col">Задания</th><th scope="col">Блиц</th><th scope="col">Засчитан</th></tr></thead>
          <tbody>{[...data.cur].reverse().map((x) => <tr key={x.date}><th scope="row">{longDate(x.date)}</th><td>{fmtMin(x.study_minutes)}</td>
            <td>{x.actual_minutes != null && x.estimate_minutes != null ? `${fmtMin(x.actual_minutes)} / ${fmtMin(x.estimate_minutes)}` : "нет данных"}</td>
            <td>{x.tasks_done ?? "нет данных"}</td><td>{x.duels}</td><td>{x.counted ? "да" : "нет"}</td></tr>)}</tbody>
        </table>
      </details>
    </>}
    <details class="stats-explain b-tile">
      <summary>Как считаются показатели</summary>
      <ul class="f-2">
        <li><b>Время учёбы</b> — по фокус-таймеру, если он был запущен; иначе по оценке времени задания. Это разные вещи, поэтому на диаграмме они разного цвета. Дни до обновления хранят только сумму — «без разбивки».</li>
        <li><b>Задания</b> — отметки «Готово», принятые сервером; повторная отправка не считается дважды.</li>
        <li><b>День засчитан</b> — сделано не меньше 65 % плана дня.</li>
        <li><b>Блиц</b> — сколько дуэлей сыграно; средний счёт из 3 показываем только от 3 дуэлей.</li>
        <li><b>Оценки</b> здесь не показываем: по датам их даёт только школьный дневник — смотри «Учёба → Дневник».</li>
      </ul>
    </details>
  </div>;
}

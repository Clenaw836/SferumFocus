/**
 * v17: прежний экран учителя — «Карта ДЗ» (данные приложения ученика: ДЗ + блиц).
 * Встраивается во вкладку «Классы» нового режима (embedded) и служит офлайн-фоллбеком.
 * v18: в фоллбеке разделы названы как в новом режиме («Сегодня», «Классы · карта ДЗ») — одна навигация, не две.
 * Режим учителя. Семантика (см. lib/performance.ts):
 *  «3/4»  — ВЫПОЛНЕНИЕ: сдано заданий ДЗ из общего числа;
 *  «67 %» — КАЧЕСТВО: доля ошибок в блиц-проверке по теме ДЗ. Цвет строки — только качество.
 * Строка целиком — кнопка: открывает карточку ученика (Sheet) с тем, что реально есть в данных.
 * Паттерн 21st.dev «Information Drawer» (список → детальная панель, поэтапное появление,
 * reduced-motion) — адаптирован на наш Sheet без GSAP.
 */
import { useEffect, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { Sheet } from "../ui/Sheet";
import { api, ApiError } from "../lib/api";
import { getPerformanceSeverity, needsAttention, rowErrorRate, SEVERITY_SCALE, type SeverityInfo } from "../lib/performance";
import { plural } from "../lib/time";
import { HW_ORDER_LABEL, sortHeatRows, type HwOrder } from "../lib/teacherSort";
import type { Heatmap, HeatRow, TeacherDay } from "../lib/types";

const pct = (n: number | null) => (n == null ? "нет данных" : `${n} %`);

/** Подпись для скринридера: «Выполнено 3 из 4. Ошибок 43 процента. Требует внимания.» */
export function rowAria(r: HeatRow): string {
  const e = rowErrorRate(r), s = getPerformanceSeverity(e);
  const err = e == null ? "Ошибки: нет данных." : `Ошибок ${e} ${plural(e, "процент", "процента", "процентов")}.`;
  return `${r.display_name.replace(/\.$/, "")}. Выполнено ${r.submitted_tasks} из ${r.total_tasks}. ${err} ${s.label}.`;
}

function hwStatus(r: HeatRow): { text: string; tone: "ok" | "warn" | "bad" } {
  if (r.submitted_tasks >= r.total_tasks) return { text: `Сдано полностью · ${r.submitted_tasks} из ${r.total_tasks}`, tone: "ok" };
  if (r.submitted_tasks > 0) return { text: `Сдано частично · ${r.submitted_tasks} из ${r.total_tasks}`, tone: "warn" };
  return { text: `Не сдано · 0 из ${r.total_tasks}`, tone: "bad" };
}

/** Рекомендация учителю — шаблон из реальных полей (не ИИ и не оценка ученика). */
function recommend(r: HeatRow, s: SeverityInfo): string {
  const topic = r.problem_tasks[0]?.title;
  const left = r.total_tasks - r.submitted_tasks;
  const remind = left > 0 ? ` Напомнить досдать ${left} ${plural(left, "задание", "задания", "заданий")}.` : "";
  if (s.severity === "critical") return `Разобрать ${topic ? `«${topic}»` : "тему ДЗ"} индивидуально до урока: 2–3 задачи на базовый приём, затем повторный блиц.${remind}`;
  if (s.severity === "attention") return `Проверить один пример ${topic ? `по теме «${topic}»` : "по теме ДЗ"} у доски — пробел небольшой.${remind}`;
  if (s.severity === "ok") return left > 0 ? `Качество в порядке — дело в выполнении.${remind}` : "Тема усвоена — можно дать задачу повышенной сложности.";
  return "Блиц-проверки не было — попросить пройти блиц по теме ДЗ (60 секунд).";
}

function Bar({ value, max, tone }: { value: number; max: number; tone: string }) {
  return <span class={`meter mt-1 o-h r-xs t-${tone}`} aria-hidden="true"><i style={{ width: `${max ? Math.round((value / max) * 100) : 0}%` }} /></span>;
}

function StudentInsight({ row, demo, onClose }: { row: HeatRow | null; demo: boolean; onClose: () => void }) {
  const [last, setLast] = useState<HeatRow | null>(row);
  useEffect(() => { if (row) setLast(row); }, [row]);
  const r = row ?? last;
  const e = r ? rowErrorRate(r) : null, s = getPerformanceSeverity(e);
  const hw = r ? hwStatus(r) : null;
  const details = r?.error_details ?? [];
  const bmax = r?.blitz_max ?? 3;
  return (
    <Sheet open={!!row} onClose={onClose} eyebrow={demo ? "Ученик · демо-данные" : "Ученик"} title={r?.display_name ?? ""}>
      {r && hw && (
        <div class="insight">
          <div class="ins-stats l-c2 l-g3">
            <div class="ins-stat l-v l-g1 b-card">
              <span class="ins-k f-m f-w6 f-3">Выполнение</span>
              <b class="num">{r.submitted_tasks}/{r.total_tasks}</b>
              <Bar value={r.submitted_tasks} max={r.total_tasks} tone={hw.tone} />
              <span class="ins-sub f-m f-3">заданий ДЗ сдано</span>
            </div>
            <div class="ins-stat l-v l-g1 b-card">
              <span class="ins-k f-m f-w6 f-3">Ошибки</span>
              <b class={`num c-${s.tone}`}>{pct(e)}</b>
              <span class={`sev l-h l-inl l-g1 f-m f-w6 f-2 f-nw t-${s.tone}`}><i aria-hidden="true" />{s.label}</span>
              <span class="ins-sub f-m f-3">в блиц-проверке</span>
            </div>
          </div>
          <p class="ins-desc f-b f-2 mt-3">{s.description}.</p>

          <h3 class="ins-h f-s mt-4 mb-2">Домашнее задание</h3>
          <ul class="ins-list">
            <li class="f-2"><span>Статус</span><b class={`c-${hw.tone}`}>{hw.text}</b></li>
            <li class="f-2"><span>Блиц по теме</span><b class="num">{r.blitz_score} из {bmax} верно</b></li>
          </ul>

          <h3 class="ins-h f-s mt-4 mb-2">Проблемные темы</h3>
          {r.problem_tasks.length ? (
            <ul class="ins-topics l-v">
              {r.problem_tasks.map((p) => {
                const [subj, ...rest] = p.title.split(":");
                const ps = getPerformanceSeverity(p.error_rate);
                return (
                  <li key={p.title}>
                    <div class="ins-topic-h l-h l-base l-btw l-g3"><span><b>{subj}</b>{rest.length ? `: ${rest.join(":").trim()}` : ""}</span><span class={`sev l-h l-inl l-g1 f-m f-w6 f-2 f-nw t-${ps.tone} num`}><i aria-hidden="true" />{p.error_rate} %</span></div>
                    {p.error_line != null && <div class="ins-where l-h l-top f-2"><Icon name="pin" />Где ошибся: строка {p.error_line} решения</div>}
                    {p.hint && <div class="ins-where l-h l-top f-2"><Icon name="book" />Что повторить: {p.hint.toLowerCase()}</div>}
                  </li>
                );
              })}
            </ul>
          ) : <p class="ins-empty f-b f-3">Проблемных тем нет.</p>}

          <h3 class="ins-h f-s mt-4 mb-2">Где именно ошибся</h3>
          {details.length ? (
            <ul class="ins-topics l-v">
              {details.map((d, i) => (
                <li key={i}>
                  <div class="ins-topic-h l-h l-base l-btw l-g3"><b>{d.task_title}</b>{d.attempts != null && <span class="faint num">попыток: {d.attempts}</span>}</div>
                  {d.question && <div class="ins-where l-h l-top f-2">Вопрос: {d.question}</div>}
                  {d.student_answer && <div class="ins-where l-h l-top f-2">Ответ ученика: <b class="c-bad">{d.student_answer}</b></div>}
                  {d.correct_answer && <div class="ins-where l-h l-top f-2">Верно: <b class="c-ok">{d.correct_answer}</b></div>}
                  {d.error_type && <div class="ins-where l-h l-top f-2">Тип ошибки: {d.error_type}</div>}
                  {d.submitted_at && <div class="ins-where l-h l-top f-2 faint">Сдано: {d.submitted_at}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <p class="ins-empty f-b f-3">Ответы по отдельным вопросам дневник пока не передаёт. Видно только итог блица{r.problem_tasks.some((p) => p.error_line != null) ? " и строку ошибки в решении" : ""} — додумывать не будем.</p>
          )}

          <h3 class="ins-h f-s mt-4 mb-2">Рекомендация</h3>
          <div class="note"><Icon name="bulb" /><div>{recommend(r, s)}<div class="faint" style="margin-top:6px;font-size:calc(12px*var(--fs,1))">Подсказка по данным карты, не оценка ученика.</div></div></div>
        </div>
      )}
    </Sheet>
  );
}

/** Легенда — из того же SEVERITY_SCALE, что и цвет строк. */
function Legend() {
  return (
    <details class="t-legend f-b f-2 mb-2">
      <summary class="f-2"><Icon name="info" />Как читать карту</summary>
      <dl>
        <div><dt class="num f-1 f-w6">3/4</dt><dd><b>Выполнение</b> — сколько заданий ДЗ сдано из заданных. Неполное выделено жирным, цветом не красится.</dd></div>
        <div><dt class="num f-1 f-w6">67 %</dt><dd><b>Ошибки</b> — доля неверных ответов в блиц-проверке по теме ДЗ. Задаёт цвет строки:</dd></div>
      </dl>
      <ul class="sev-scale l-v b-tile mb-3">
        {SEVERITY_SCALE.map((x) => <li key={x.severity}><span class={`sev l-h l-inl l-g1 f-m f-w6 f-2 f-nw t-${x.tone}`}><i aria-hidden="true" />{x.label}</span><span class="num faint">{x.range}</span></li>)}
      </ul>
    </details>
  );
}

export function LegacyTeacher({ onSwitchRole, embedded, note }: { onSwitchRole: () => void; embedded?: boolean; note?: string }) {
  const [view, setView] = useState<"class" | "day">("class");
  const [order, setOrder] = useState<HwOrder>("best");
  const [hm, setHm] = useState<Heatmap | null>(null);
  const [day, setDay] = useState<TeacherDay | null>(null);
  const [err, setErr] = useState<{ m: string; s: number } | null>(null);
  const [open, setOpen] = useState<HeatRow | null>(null);
  const load = () => {
    setErr(null);
    Promise.all([api.heatmap(), api.teacherDay()])
      .then(([h, d]) => { setHm(h); setDay(d); })
      .catch((e) => setErr(e instanceof ApiError ? { m: e.message, s: e.status } : { m: "Не загрузилось", s: 0 }));
  };
  useEffect(load, []);

  if (err) return (
    <section class={embedded ? "tm-embed mt-2" : "screen"}><div class="empty"><Icon name={err.s === 403 ? "lock" : "wifiOff"} /><h3>{err.s === 403 ? "Только для учителя" : "Не загрузилось"}</h3><p class="f-2">{err.m}</p>
      {err.s === 403 ? <button class="btn btn-secondary btn-sm" onClick={onSwitchRole}>Сменить роль</button> : <button class="btn btn-secondary btn-sm" onClick={load}>Повторить</button>}</div></section>
  );
  if (!hm) return <section class={embedded ? "tm-embed mt-2" : "screen"}><div class="sk" style="height:120px;margin-top:64px" />{[0, 1, 2, 3].map((i) => <div key={i} class="sk" style="height:48px;margin-top:12px" />)}</section>;

  const rows = sortHeatRows(hm.roster.map((r) => ({ r, e: rowErrorRate(r), s: getPerformanceSeverity(rowErrorRate(r)) })), order);
  const attention = rows.filter((x) => needsAttention(x.s.severity)).length;
  const critical = rows.filter((x) => x.s.severity === "critical").length;
  const okN = rows.length - attention;
  return (
    <>
    <section class={embedded ? "tm-embed mt-2" : "screen"} aria-labelledby="t-h">
      {note && <div class="note warn" style="margin-top:12px"><Icon name="wifiOff" /><div>{note}</div></div>}
      <header class={embedded ? "tm-subhead l-h l-g0" : "topbar l-h l-btw l-wrap l-g3 b-tap mb-2"}>{embedded ? <h2 id="t-h" class="h-sub f-s">Карта ДЗ · {hm.class_label}</h2> : <h1 id="t-h" class="h-sec">Класс {hm.class_label}</h1>}<span class="faint num" style="font-size:calc(13px*var(--fs,1))">{hm.is_demo ? "демо · " : ""}на {hm.generated_for}</span></header>
      {/* Иерархия учителя: кто требует внимания → бриф → карта */}
      <div class="t-hero l-h l-g4">
        <b class="num">{attention}</b>
        <div><div class="t-hero-l f-h">{attention ? `${plural(attention, "требует", "требуют", "требуют")} внимания` : "все в норме"}</div>
          <div class="faint num">сдали ДЗ {hm.submitted_count}/{hm.class_size} · блиц {hm.blitz_average.toFixed(1)}/3</div></div>
      </div>
      {/* Состояние класса считывается без цифр: доля норма / внимание / критично */}
      <div class="t-mix l-h l-g1 mt-1 mb-2" role="img" aria-label={`Норма ${okN}, внимание ${attention - critical}, критично ${critical} из ${rows.length}`}>
        {okN > 0 && <i class="t-ok" style={{ flexGrow: okN }} />}{attention - critical > 0 && <i class="t-warn" style={{ flexGrow: attention - critical }} />}{critical > 0 && <i class="t-bad" style={{ flexGrow: critical }} />}
      </div>
      <p class="t-mix-l l-h l-g3 f-b mb-4 num" aria-hidden="true"><span class="c-ok">норма {okN}</span><span class="c-warn">внимание {attention - critical}</span><span class="c-bad">критично {critical}</span></p>
      <blockquote class="brief"><div class="eyebrow">Бриф на 5 минут до урока</div><p>{hm.five_minute_brief}</p></blockquote>
      {!embedded && <div style="margin:24px 0 8px"><Segmented label="Раздел" value={view} onChange={setView} options={[{ value: "day", label: "Сегодня" }, { value: "class", label: "Классы · карта ДЗ" }]} /></div>}
      {view === "class" || embedded ? (
        <>
          <div class="tm-sort mt-3 mb-3"><Segmented label="Порядок учеников" value={order} onChange={setOrder} options={[{ value: "best", label: "Сначала лучшие" }, { value: "alpha", label: "По алфавиту" }, { value: "attention", label: "Внимание" }]} /></div>
          <p class="sr" role="status" aria-live="polite">Порядок: {HW_ORDER_LABEL[order]}</p>
          <Legend />
          <div class="roster-head py-2 f-m f-w6 f-3 b-sep" aria-hidden="true"><span>Ученик</span><span>Сдано</span><span>Ошибки</span></div>
          <ul class="roster" aria-label="Ученики: выполнение и ошибки">
            {rows.map(({ r, e, s }, i) => {
              const low = r.submitted_tasks < r.total_tasks;
              const topic = r.problem_tasks[0];
              return (
                <li key={r.display_name} style={{ "--i": i }}>
                  {/* Имя кнопки = видимый текст + скрытая расшифровка (WCAG 2.5.3 «метка в имени»):
                      скринридер читает «Захарова В. Выполнено 2 из 4. Ошибок 100 процентов. Критично.» */}
                  <button class={`roster-row b-sep t-${s.tone}`} onClick={() => setOpen(r)} aria-haspopup="dialog">
                    <span class="rr-main l-v l-g1"><span class="rr-name f-w6 f-trunc">{r.display_name}</span>{topic && <span class="problem f-m f-warn f-trunc">{topic.title}</span>}</span>
                    <span class={`frac f-b f-2 num${low ? " low" : ""}`} aria-hidden="true">{r.submitted_tasks}/{r.total_tasks}</span>
                    <span class={`sev-pill f-b f-w6 f-2 f-tc b-pill t-${s.tone} num`} aria-hidden="true">{e == null ? "—" : `${e} %`}</span>
                    <span class="sr">{rowAria(r).slice(r.display_name.replace(/\.$/, "").length + 1)}</span>
                    <Icon name="chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <ol class="tl" style="margin-top:12px">
          {(day?.lessons ?? []).map((l, i) => (
            <li class="tl-item l-a1 l-g3 k-work" key={i} style={{ "--i": i, "--c": "var(--s-sci)" }}>
              <span class="tl-time pt-3 f-b f-2 num">{l.starts_at}</span>
              <div class="tl-card l-rel"><div class="tl-label f-b f-w6 f-3">{l.subject} · {l.class_label}</div>{l.topic && <div class="tl-meta l-h l-wrap l-g3 f-b f-2">{l.topic}</div>}{l.prep_recommendation && <div class="tl-meta l-h l-wrap l-g3 f-b f-2" style="color:var(--ember-hi)">{l.prep_recommendation}</div>}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
    {/* вне .screen: у экрана свой stacking context (z-index + анимация) — лист оказался бы под таб-баром */}
    {/* встроенная карта живёт внутри .screen нового экрана → лист выносим в body порталом */}
    {embedded ? createPortal(<StudentInsight row={open} demo={!!hm.is_demo} onClose={() => setOpen(null)} />, document.body) : <StudentInsight row={open} demo={!!hm.is_demo} onClose={() => setOpen(null)} />}
    </>
  );
}

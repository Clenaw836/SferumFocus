/** v3.0 · каталог практикумов: предмет, тема, сложность, формат. Карточка честно показывает прогресс и связь с программой. */
import { useEffect, useState } from "preact/hooks";
import { practicumApi } from "../../lib/api";
import type { Catalog, CatalogItem, SubjectsOverview } from "../../lib/practicumTypes";
import { LoadingRows } from "../LoadingRows";
import { practicumError } from "./PracticumRunner";
import { PracticumPreview, previewKind } from "./PracticumPreview";
const shortFormat = (f: string) => f === "Виртуальная лаборатория" ? "Лаборатория" : f;

export function PracticumCard({ it, onOpen }: { it: CatalogItem; onOpen: (id: string) => void }) {
  const ps = it.progress_status;
  return <li class="pc-item">
    {/* имя кнопки — её видимый текст целиком (WCAG 2.5.3 «Label in Name»), без отдельного aria-label */}
    <button type="button" class="pc-card" data-practicum={it.practicum_id} onClick={() => onOpen(it.practicum_id)}>
      <PracticumPreview kind={previewKind(it.subject.title, it.topic.title, it.title)} />
      <span class="pc-body">
        <span class="pc-title">{it.title}</span>
        <span class="pc-sub">{it.subject.title} · {it.topic.title}</span>
        {/* v3.2 · не больше двух бейджей: «15 мин · Лаборатория» и, если есть, «тема урока» */}
        <span class="pc-top"><span class="sf-mode-badge"><span class="sf-tabular">{it.duration_minutes} мин</span> · {shortFormat(it.format_type)}</span>
          {it.curriculum_match.current_topic ? <span class="pc-flag">тема урока</span> : it.curriculum_match.recommended ? <span class="pc-flag">рекомендуем</span> : null}</span>
        <span class={`pc-progress is-${ps.state}`}>
          <span class="pc-progress-track" aria-hidden="true"><span style={{ transform: `scaleX(${ps.total ? Math.min(ps.step, ps.total) / ps.total : 0})`, ...(ps.state === "completed" ? { background: "var(--ok)" } : {}) }} /></span>
          <span class="pc-progress-label">{ps.label}</span></span>
      </span>
    </button>
  </li>;
}

export function PracticumCatalog({ grade: grade0, subject: subject0 = null, topicId = null, onOpen, showSubjects = true, rev = 0, onOffline }: {
  /** v3.2.1 · практикумы проверяет сервер; без сети предлагаем офлайн-тренировку в Блице. */
  onOffline?: () => void;
  grade: number; subject?: string | null; topicId?: string | null; onOpen: (id: string) => void; showSubjects?: boolean;
  /** растёт, когда закрыли практикум: статусы карточек перечитываются с сервера */ rev?: number;
}) {
  const [grade, setGrade] = useState(grade0);
  const [subject, setSubject] = useState<string | null>(subject0);
  const [scope, setScope] = useState<"all" | "current">(topicId ? "current" : "all");
  const [difficulty, setDifficulty] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubjectsOverview | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setGrade(grade0); }, [grade0]);
  useEffect(() => { if (showSubjects) practicumApi.subjects(grade).then(setSubs).catch(() => setSubs(null)); }, [grade, showSubjects]);
  const load = () => {
    setErr(null);
    practicumApi.catalog({ subject, grade, topicId, scope: topicId ? scope : "all", difficulty, format })
      .then(setCat).catch((e) => { setCat(null); setErr(practicumError(e)); });
  };
  useEffect(load, [grade, subject, topicId, scope, difficulty, format, rev]);
  const chip = (on: boolean, label: string, click: () => void, key: string) =>
    <button key={key} type="button" role="radio" aria-checked={on} class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" onClick={click}>{label}</button>;
  const withPr = (subs?.subjects ?? []).filter((x) => x.practicums > 0);
  return <div class="pc-catalog l-v l-g3">
    {showSubjects && withPr.length > 0 && <div class="pc-filter" role="radiogroup" aria-label={`Предмет, ${grade} класс`}>
      {chip(subject === null, "Все предметы", () => setSubject(null), "_all")}
      {withPr.map((x) => chip(subject === x.key, `${x.title} · ${x.practicums}`, () => setSubject(x.key), x.key))}
    </div>}
    {topicId && <div class="pc-filter" role="radiogroup" aria-label="Тема">
      {chip(scope === "current", "Текущая тема", () => setScope("current"), "cur")}{chip(scope === "all", "Все темы предмета", () => setScope("all"), "all")}
    </div>}
    {cat && (Object.keys(cat.facets.difficulty).length > 1 || difficulty) && <div class="pc-filter" role="radiogroup" aria-label="Сложность">
      {chip(difficulty === null, "Любая сложность", () => setDifficulty(null), "_d")}
      {Object.entries(cat.facets.difficulty).map(([k, n]) => chip(difficulty === k, `${k} · ${n}`, () => setDifficulty(difficulty === k ? null : k), k))}
    </div>}
    {cat && (Object.keys(cat.facets.format_type).length > 1 || format) && <div class="pc-filter" role="radiogroup" aria-label="Формат">
      {chip(format === null, "Любой формат", () => setFormat(null), "_f")}
      {Object.entries(cat.facets.format_type).map(([k, n]) => chip(format === k, `${k} · ${n}`, () => setFormat(format === k ? null : k), k))}
    </div>}
    {err ? <div class="pr-error l-v l-g3 b-card" role="alert"><p>{err}</p><button type="button" class="btn btn-secondary btn-sm" onClick={load}>Повторить</button>
      {onOffline && <><p class="muted f-s">Пока нет связи, можно тренироваться в Блице: задачи по алгебре, геометрии, физике и химии собираются прямо на телефоне, ошибки вернутся на повтор.</p>
        <button type="button" class="btn btn-primary btn-sm" onClick={onOffline}>Тренироваться без сети</button></>}</div>
      : !cat ? <LoadingRows label="Загружаем практикумы" rows={3} />
      : <>
        <p class="pc-count" role="status">{cat.total ? `Практикумов: ${cat.total} · ${grade} класс` : cat.message || `Для ${grade} класса по этому фильтру практикумов пока нет.`}</p>
        {cat.items.length > 0 && <ul class="pc-list">{cat.items.map((it) => <PracticumCard key={it.practicum_id} it={it} onOpen={onOpen} />)}</ul>}
        {!cat.total && cat.other_grades.length > 0 && <div class="pc-filter">{cat.other_grades.map((g) =>
          <button key={g.grade} type="button" class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" onClick={() => setGrade(g.grade)}>Показать для {g.grade} класса · {g.count}</button>)}</div>}
      </>}
  </div>;
}

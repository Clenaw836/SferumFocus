/** v3.0 · лист «Практикумы СферумФокус»: предмет → развилка [Квиз-опрос | Практикум] → прохождение.
 *  Один лист со стеком экранов, чтобы «Назад» MAX и Esc вели на шаг назад, а не закрывали всё. */
import { useEffect, useState } from "preact/hooks";
import { practicumApi } from "../../lib/api";
import type { Hub } from "../../lib/practicumTypes";
import { Sheet } from "../Sheet";
import { LoadingRows } from "../LoadingRows";
import { PracticumCatalog } from "./PracticumCatalog";
import { PracticumRunner, practicumError } from "./PracticumRunner";
import { SkillMasteryMap } from "./SkillMasteryMap";
import { TopicQuiz } from "./TopicQuiz";

export type PracticumView =
  | { kind: "hub"; subject: string; hw?: string | null; topicId?: string | null }
  | { kind: "catalog"; subject: string | null; topicId: string | null; title: string }
  | { kind: "run"; id: string }
  | { kind: "quiz"; topicId: string };

const PATH_STATE: Record<string, string> = { known: "известно", unknown: "нет данных", needs_clarification: "уточнить" };

function SubjectHub({ v, grade, go, setTopic }: { v: Extract<PracticumView, { kind: "hub" }>; grade: number; go: (next: PracticumView) => void; setTopic: (id: string) => void }) {
  const [hub, setHub] = useState<Hub | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { setErr(null); setHub(null); practicumApi.hub(v.subject, grade, { topicId: v.topicId, hw: v.hw }).then(setHub).catch((e) => setErr(practicumError(e))); };
  useEffect(load, [v.subject, v.topicId, v.hw, grade]);
  if (err) return <div class="pr-error l-v l-g3 b-card" role="alert"><p>{err}</p><button type="button" class="btn btn-secondary btn-sm" onClick={load}>Повторить</button></div>;
  if (!hub) return <LoadingRows label="Подбираем тему и практикумы" rows={3} />;
  const t = hub.current_topic, quiz = hub.cards.find((c) => c.kind === "quiz"), pr = hub.cards.find((c) => c.kind === "practicum");
  return <div class="ph-hub l-v l-g4">
    <div class="ph-topic l-v l-g1">
      <p class="pr-eyebrow f-m f-w6 f-3">{hub.subject.title} · {hub.subject.grade} класс</p>
      {t ? <><h3 class="ph-topic-title f-h">{t.title}</h3><p class="ph-topic-src f-b f-2">{hub.topic_source.reason}</p><p class="ph-fgos f-c f-3">{t.fgos_ref}</p></>
        : <h3 class="ph-topic-title f-h">Какая тема сейчас на уроках?</h3>}
      {!t && <p class="ph-topic-src f-b f-2">{hub.topic_source.reason}</p>}
      {/* Тему можно сменить всегда: дневник мог ошибиться параграфом, а ученик — захотеть повторить прошлую. */}
      {hub.topic_options.length > 0 && <div class="pc-filter" role="radiogroup" aria-label={t ? "Сменить тему урока" : "Тема урока"}>{hub.topic_options.map((o) =>
        <button key={o.topic_id} type="button" role="radio" aria-checked={t?.topic_id === o.topic_id} class="pl-chip l-h l-inl l-g1 f-b f-w6 f-nw b-pill l-fix" onClick={() => setTopic(o.topic_id)}>{o.title}</button>)}</div>}
    </div>
    <div class="sf-mode-fork-grid l-c2 l-g3" role="group" aria-label="Как заниматься темой">
      {quiz && <button type="button" class="sf-mode-card l-v l-btw l-g3 b-card" data-mode="quiz" disabled={!quiz.available || !t} aria-describedby="ph-quiz-meta"
        onClick={() => t && go({ kind: "quiz", topicId: t.topic_id })}>
        <span class="sf-mode-badge">{quiz.badge}</span><span class="sf-mode-title f-s">{quiz.title}</span><span class="sf-mode-text f-m f-2">{quiz.text}</span>
        <span id="ph-quiz-meta" class="sf-mode-meta f-c f-w6 f-3 sf-tabular">{quiz.available && t ? `${quiz.questions} вопросов · ~${quiz.minutes} мин` : quiz.reason || "Сначала выбери тему"}</span>
      </button>}
      {pr && <button type="button" class="sf-mode-card l-v l-btw l-g3 b-card" data-mode="practicum" disabled={!pr.available} aria-describedby="ph-pr-meta"
        onClick={() => go({ kind: "catalog", subject: hub.subject.key, topicId: t?.topic_id ?? null, title: `Практикумы · ${hub.subject.title}` })}>
        <span class="sf-mode-badge">{pr.badge}</span><span class="sf-mode-title f-s">{pr.title}</span><span class="sf-mode-text f-m f-2">{pr.text}</span>
        <span id="ph-pr-meta" class="sf-mode-meta f-c f-w6 f-3 sf-tabular">{pr.available ? `${pr.count} в ${hub.subject.grade} классе` : pr.reason || "Практикумов пока нет"}</span>
      </button>}
    </div>
    {hub.recommendation?.text && <div class="ph-reco p-34 l-v l-as r-md u-acc-s" role="note"><p>{hub.recommendation.text}</p>
      {hub.recommendation.practicum_id && <button type="button" class="btn btn-secondary btn-sm" onClick={() => go({ kind: "run", id: hub.recommendation!.practicum_id! })}>Открыть «{hub.recommendation.title}»</button>}</div>}
    {hub.skill_map && <SkillMasteryMap map={hub.skill_map} />}
    <details class="ph-path pt-3"><summary>Откуда тема: программа и учебник</summary>
      <ol>{hub.curriculum_path.map((l) => <li key={l.level} class={`is-${l.state}`}><span class="ph-path-level f-c f-w6 f-3">{l.level}</span>
        <span class="ph-path-body l-v l-g1"><b>{l.title}</b><small>{l.detail}</small></span><span class="ph-path-state f-c f-w6 f-3 f-nw">{PATH_STATE[l.state] ?? l.state}</span></li>)}</ol>
    </details>
  </div>;
}

export function PracticumSheet({ open, start, grade, onClose }: { open: boolean; start: PracticumView | null; grade: number; onClose: () => void }) {
  const [stack, setStack] = useState<PracticumView[]>(start ? [start] : []);
  useEffect(() => { if (open && start) setStack([start]); }, [open, start]);
  const top = stack[stack.length - 1];
  const go = (next: PracticumView) => setStack((s) => [...s, next]);
  const back = () => { if (stack.length > 1) setStack((s) => s.slice(0, -1)); else onClose(); };
  const title = !top ? "Практика" : top.kind === "hub" ? "Предмет" : top.kind === "catalog" ? top.title : top.kind === "quiz" ? "Квиз-опрос" : "Практикум";
  return <Sheet open={open && !!top} onClose={back} title={title} eyebrow="Практикумы СферумФокус" full variant="pr-sheet">
    {stack.length > 1 && <button type="button" class="btn btn-ghost btn-sm pr-back mb-2 l-self-s" onClick={back}>← Назад</button>}
    {top?.kind === "hub" && <SubjectHub v={top} grade={grade} go={go} setTopic={(topicId) => setStack((s) => [...s.slice(0, -1), { ...top, topicId }])} />}
    {top?.kind === "catalog" && <PracticumCatalog grade={grade} subject={top.subject} topicId={top.topicId} showSubjects={false} onOpen={(id) => go({ kind: "run", id })} />}
    {top?.kind === "run" && <PracticumRunner key={top.id} id={top.id} onExit={back} onOpen={(id) => setStack((s) => [...s.slice(0, -1), { kind: "run", id }])} />}
    {top?.kind === "quiz" && <TopicQuiz key={top.topicId} topicId={top.topicId} onExit={back} onPracticum={(id) => go({ kind: "run", id })} />}
  </Sheet>;
}

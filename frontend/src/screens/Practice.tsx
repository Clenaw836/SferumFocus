/** v3.0 · вкладка «Практика»: [Практикумы | Блиц и квиз-опросы]. Блиц — прежний экран без изменений логики. */
import type { ComponentChildren } from "preact";
import { Segmented } from "../ui/Segmented";
import { PracticumCatalog } from "../ui/practicum/PracticumCatalog";

import type { PracticeSeg } from "../lib/practiceSeg";
import type { Task } from "../lib/types";
export { gradeNum, rememberedSeg, rememberSeg, type PracticeSeg } from "../lib/practiceSeg";

/** v3.2.1 · «По твоим заданиям»: ДЗ из плана дня → тот же разбор темы, что «Разобрать тему» под уроком
 *  (квиз-опрос или практикум по теме из программы). Каталог ниже остаётся для свободной тренировки. */
function ForHomework({ tasks, onHub }: { tasks: Task[]; onHub: (subject: string, hw: string) => void }) {
  const rows = tasks.map((t) => { const i = t.title.indexOf(": "); return i > 0 ? { key: t.title, subject: t.title.slice(0, i), hw: t.title.slice(i + 2) } : null; })
    .filter((x): x is { key: string; subject: string; hw: string } => !!x).slice(0, 4);
  if (!rows.length) return null;
  return <section class="pr-forhw b-box" aria-labelledby="pr-forhw-h">
    <h2 id="pr-forhw-h" class="f-s">По твоим заданиям на сегодня</h2>
    <p class="f-3">Разбор темы к ДЗ: короткий квиз или практикум — потом задание делается быстрее.</p>
    <ul class="pr-forhw-list">
      {rows.map((r) => <li key={r.key}><button type="button" class="pr-forhw-row b-tap" onClick={() => onHub(r.subject, r.hw)}>
        <span class="pr-forhw-txt"><b class="f-2">{r.subject}</b><small class="f-3">{r.hw}</small></span><span class="pr-forhw-go f-3">Разобрать →</span>
      </button></li>)}
    </ul>
  </section>;
}

export function Practice({ seg, onSeg, grade, rev = 0, onOpen, blitz, forHw = [], onHub }: {
  seg: PracticeSeg; onSeg: (s: PracticeSeg) => void; grade: number; rev?: number; onOpen: (id: string) => void; blitz: (head: ComponentChildren) => ComponentChildren;
  forHw?: Task[]; onHub?: (subject: string, hw: string) => void;
}) {
  const head = <div class="practice-seg mb-4"><Segmented label="Режим практики" value={seg} onChange={onSeg}
    options={[{ value: "practicum", label: "Практикумы" }, { value: "blitz", label: "Блиц и квиз-опросы" }]} /></div>;
  if (seg === "blitz") return <>{blitz(head)}</>;
  return <section class="screen practice practice-pr l-v l-g3" aria-labelledby="practice-pr-h">
    {head}
    <h1 id="practice-pr-h" class="practice-title f-h">Практикумы · {grade} класс</h1>
    <p class="practice-lead f-b f-2">Тему осваиваешь действием: меняешь модель, проверяешь гипотезу, сервер объясняет каждую ошибку.</p>
    {onHub && <ForHomework tasks={forHw} onHub={onHub} />}
    <PracticumCatalog grade={grade} rev={rev} onOpen={onOpen} onOffline={() => onSeg("blitz")} />
  </section>;
}

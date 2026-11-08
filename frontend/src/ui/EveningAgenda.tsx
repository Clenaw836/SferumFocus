import { Icon } from './Icon';
import { splitTitle, subjectColor } from '../lib/subjects';
import type { CalculateResponse, Task } from '../lib/types';
import { hwInfo, hwStatusLabel, isHwNew, useHw } from '../lib/hwSync';
import { dueText } from '../lib/hwFormat';
/** Presentation only: the server/local planner remains the authority on ordering and times.
 * Repeated work intervals stay separate; tasks omitted from a plan are never silently hidden. */
export function EveningAgenda({ tasks, done, current, plan, onOpen }: {
    tasks: Task[];
    done: string[];
    current?: string;
    plan: CalculateResponse | null;
    onOpen: (task: Task) => void;
}) {
    const hw = useHw();   // Recovery 2: teacher assignments show their server status (re-renders on sync)
    const entries = plan?.plan.plan ?? [];
    const represented = new Set(entries.filter(e => e.kind === 'work').map(e => e.task ?? e.label));
    const taskRow = (task: Task, key: string, time?: string, end?: string) => {
        const title = splitTitle(task.title), completed = done.includes(task.title);
        const live = !completed && task.title === current;
        const info = task.source === 'teacher' ? hwInfo(task.title) : null;
        const meta = completed ? (info ? 'Выполнено — учитель видит' : 'Выполнено на устройстве') : live ? (info ? 'Сессия в работе · учитель видит статус' : 'Сессия в работе')
            : info ? `${info.kind === 'quiz' ? 'Блиц-опрос от учителя' : 'От учителя'} · ${info.kind === 'quiz' && info.quiz?.state === 'submitted' ? `${info.quiz.score ?? 0} из ${info.quiz.max_score}` : hwStatusLabel(info, hw.pending(info.issue_id), hw.next(info.issue_id))}${info.due_date ? ' · ' + dueText(info.due_date) : ''}`
            : end ? `До ${end} · интервал плана` : `${task.planned_minutes} мин · оценка`;
        return <li key={key} class={`agenda-item b-sep${completed ? ' is-done' : ''}${live ? ' is-current' : ''}${info ? ' is-teacher' : ''}`}>
            <button class="agenda-task py-4 l-a1a l-g3 l-mid l-w100 l-rel" style={{"--subject":subjectColor(task.title)}} onClick={() => onOpen(task)} aria-current={live ? 'step' : undefined}>
                <span class="agenda-subject-icon r-lg" style={{"--subject":subjectColor(task.title)}} aria-hidden="true"><Icon name={completed ? "check" : task.type === "oral" ? "book" : "calendar"}/></span>
                <span class="agenda-copy l-v l-g1"><strong>{title.subject}{info && isHwNew(info) && <span class="hw-fresh f-c f-w6 b-pill u-acc">Новое</span>}</strong><span class="f-2">{title.detail || (task.type === 'oral' ? 'Устное задание' : 'Письменное задание')}</span>
                    <small>{meta}</small></span>
                <span class="agenda-open l-v l-g1 l-ac f-a"><span class="agenda-time f-m f-2 f-num f-nw b-bare">{completed ? "Готово" : time || `${task.planned_minutes} мин`}</span><Icon name="chevron"/><span class="sr">Открыть задание</span></span>
            </button>
        </li>;
    };
    return <ol class="evening-agenda b-card" aria-label={plan ? 'Последовательность плана вечера' : 'Задания на вечер'}>
        {entries.map((entry, i) => {
            const task = entry.kind === 'work' ? tasks.find(t => t.title === (entry.task ?? entry.label)) : null;
            return task ? taskRow(task, `plan-${i}`, entry.start, entry.end) : <li key={`plan-${i}`} class="agenda-interlude py-3 l-a1 l-g3 f-c f-3 b-sep"><span>{entry.start}</span><div><b class="f-2">{entry.label}</b><small>{entry.end}{entry.kind === 'break' ? ' · перерыв' : ''}</small></div></li>;
        })}
        {tasks.filter(task => !represented.has(task.title)).map(task => taskRow(task, task.title))}
    </ol>;
}

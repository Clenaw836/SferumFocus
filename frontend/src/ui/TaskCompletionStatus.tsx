import { Icon } from './Icon';
import { dayStore, execState } from '../lib/day';
import type { Task } from '../lib/types';
/** The task's completion source, not a quiz's passed flag. */
export function TaskCompletionStatus({task,done}:{task:Task;done:boolean}) {
 if(!done)return null;
 const r=dayStore.log()[task.title],st=execState(task.title,[task.title],null);
 return <div class="exec-done l-h f-b f-2 mb-4 r-md p-3" role="status"><Icon name="check"/><span><b>{st==='completed'?'Сдано':'Выполнено · ждёт синхронизации'}</b>{r?.actualMin!=null?` · факт ${r.actualMin} мин из ${r.plannedMin}`:` · план ${task.planned_minutes} мин`}{r?.rounds&&r.rounds>1?` · ${r.rounds} помидора`:''}</span></div>;
}

import { useState } from 'preact/hooks';
import { eveningLoad, SANPIN_REF } from '../lib/sanpin';
/** v3.0: вместо «кубка очков» — вечерняя нагрузка по норме СанПиН (минуты д/з против нормы класса).
 *  onProfile/onProgress/rewards оставлены для совместимости вызовов: очки живут в «Учёба → Прогресс». */
interface Props { rewards?: unknown; name: string; meta: string; status?: string | null; onProfile?: () => void; onProgress?: () => void;
  tasks: { planned_minutes: number }[]; grade: string | null | undefined; }
const LEVEL_RU = { ok: 'в норме', near: 'близко к норме', over: 'выше нормы', none: '' } as const;
export function Hud({ name, meta, status, tasks, grade }: Props) {
  const [open, setOpen] = useState(false);
  const load = eveningLoad(tasks, grade);
  const pct = load.limit ? Math.min(100, Math.round((load.minutes / load.limit) * 100)) : 0;
  return <header class="personal-header l-h l-top l-btw l-wrap l-g0 l-rel o-h">
    <div class="personal-greeting l-rel as-c"><h1 id="dashboard-h" class="sr">Привет, {name}</h1><p class="f-2 sr">{meta}</p><small>{status || 'Твой темп. Твой результат.'}</small></div>
    <div class="personal-controls">
      <button type="button" class={`sanpin-pill l-h l-inl b-pill b-tap is-${load.level}`} aria-expanded={open} aria-controls="sanpin-note" onClick={() => setOpen(!open)}>
        <svg class="sanpin-ring l-fix s-28" viewBox="0 0 20 20" aria-hidden="true"><circle class="sanpin-track" cx="10" cy="10" r="8" /><circle class="sanpin-val" cx="10" cy="10" r="8" style={load.level === "near" ? { stroke: "var(--warn)" } : load.level === "over" ? { stroke: "var(--bad)" } : undefined} stroke-dasharray={`${(pct * 0.5027).toFixed(2)} 50.27`} /></svg>
        <span class="sanpin-cap f-m f-2">Нагрузка вечера</span>
        <span class="sanpin-num f-b f-w6 f-nw sf-tabular">{load.minutes}<small>{load.limit ? `/${load.limit} мин` : ' мин'}</small></span>
        {load.level !== "none" && <span class="sr">, {LEVEL_RU[load.level]}</span>}
      </button>
    </div>
    {open && <p id="sanpin-note" class="sanpin-note f-m f-2 b-tile mt-2" role="note">{load.limit === null
      ? `Класс не указан — норму времени на домашние задания показать не можем. Запланировано ${load.minutes} мин.`
      : load.limit === 0 ? `В 1 классе домашних заданий по норме нет (${SANPIN_REF}).`
      : `Норма для ${load.grade} класса — до ${load.limit} мин домашних заданий в день (${SANPIN_REF}). Сейчас запланировано ${load.minutes} мин${load.level === 'over' ? ' — больше нормы: часть можно перенести на завтра.' : '.'}`}</p>}
  </header>;
}

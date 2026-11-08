import { addDays, WD_NAME, WD_SHORT, WEEKDAYS, weekdayOf, type Weekday } from "../lib/schedule";

/** Быстрый выбор дня без ИИ: [ПН] [ВТ] [СР] [ЧТ] [ПТ] (+[СБ] при шестидневке). Ближайшая дата каждого дня. */
export function DayChips({ today, schoolWeek, value, onPick, label = "На какой день?" }: { today: string; schoolWeek: number; value: string | null; onPick: (date: string) => void; label?: string }) {
  const days = WEEKDAYS.slice(0, schoolWeek >= 6 ? 6 : 5);
  const ti = WEEKDAYS.indexOf(weekdayOf(today));
  const dateOf = (w: Weekday) => addDays(today, (WEEKDAYS.indexOf(w) - ti + 7) % 7);
  return (
    <div class="daychips l-fit l-g1" role="radiogroup" aria-label={label}>
      {days.map((w) => {
        const d = dateOf(w), on = value === d;
        return (
          <button key={w} type="button" role="radio" aria-checked={on ? "true" : "false"} class={`daychip l-center l-g0 f-2 b-box b-tap${on ? " on" : ""}`} onClick={() => onPick(d)}
            aria-label={`${WD_NAME[w]}, ${Number(d.slice(8, 10))}.${d.slice(5, 7)}${d === today ? ", сегодня" : ""}`}>
            <b>{WD_SHORT[w]}</b><span class="num">{d.slice(8, 10)}.{d.slice(5, 7)}</span>
          </button>
        );
      })}
    </div>
  );
}

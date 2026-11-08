/** v3.0 · карта освоения темы: только проверенные действия (практикумы + квиз-опросы). Нет данных — нет процента. */
import type { SkillMap } from "../../lib/practicumTypes";

export function SkillMasteryMap({ map, compact }: { map: SkillMap; compact?: boolean }) {
  return <section class="sf-skill-map l-v l-g3 b-card" aria-labelledby={`skm-${map.topic_id}`}>
    <h3 id={`skm-${map.topic_id}`} class="sf-skill-map-title f-b f-w6">Карта освоения · {map.topic_title}</h3>
    <ul class="sf-skill-map-list l-v l-g3">
      {map.skills.map((s) => {
        const pct = s.mastery_percent;
        const tone = pct === null ? "" : pct >= 80 ? " sf-skill-bar-fill--high" : pct < 50 ? " sf-skill-bar-fill--low" : "";
        return <li key={s.skill_key} class="sf-skill-row l-v l-g1">
          <div class="sf-skill-row__header l-h l-base l-btw f-b"><span>{s.title}</span>
            <span class="skill-percent f-m f-w6 f-2 f-num sf-tabular">{pct === null ? "нет данных" : `${pct}%`}</span></div>
          <div class="sf-skill-bar-track b-box b-nob l-w100 o-h" role="progressbar" aria-label={s.title} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={pct ?? undefined} aria-valuetext={pct === null ? "Нет проверенных действий" : `${pct}% · ${s.status}`}>
            {pct !== null && <div class={`sf-skill-bar-fill${tone}`} style={{ width: `${Math.max(2, pct)}%` }} />}
          </div>
          {!compact && <p class="sf-skill-meta f-c f-3">{s.status}{s.verified_actions ? ` · проверено действий: ${s.verified_actions}` : ""}</p>}
        </li>;
      })}
    </ul>
    {!compact && <p class="sf-skill-basis f-m f-3">{map.has_data ? map.basis : "Пока нет проверенных действий по теме — пройди практикум или квиз-опрос, и здесь появятся проценты."}</p>}
  </section>;
}

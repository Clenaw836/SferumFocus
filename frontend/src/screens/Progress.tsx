import { nowDate } from "../lib/clock";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { withLaunch } from "../lib/max";
import { api, ApiError, cache } from "../lib/api";
import { useCountTo } from "../lib/useCountTo";
import { dur, plural, weekdayShort } from "../lib/time";
import type { MyWeek, Rewards } from "../lib/types";
import type { ComponentChildren } from "preact";
export function Progress({ rewards, onRewards, seg, onStats }: {
    rewards: Rewards | null;
    onRewards: (r: Rewards) => void;
    seg?: ComponentChildren;
    /** Master v2.0 · Feature 3: подробная диаграмма — в профиле («Статистика»), здесь только итог недели. */
    onStats?: () => void;
}) {
    const [week, setWeek] = useState<MyWeek | null>(cache.get<MyWeek>("sf.week"));
    const [err, setErr] = useState<string | null>(null);
    const load = () => {
        setErr(null);
        Promise.all([api.rewards(), api.myWeek()])
            .then(([r, w]) => { onRewards(r); setWeek(w); cache.set("sf.week", w); })
            .catch((e) => setErr(e instanceof ApiError ? e.message : "Не загрузилось"));
    };
    useEffect(load, []);
    const pts = useCountTo(rewards?.total_points ?? 0, 0, 900);
    if (!rewards && err)
        return <section class="screen"><h1 class="h-sec">Мой прогресс</h1>{seg}<div class="empty"><Icon name="wifiOff"/><h3>Прогресс не загрузился</h3><p class="f-2">{err}</p><button class="btn btn-secondary btn-sm" onClick={load}>Повторить</button></div></section>;
    if (!rewards)
        return <section class="screen"><h1 class="h-sec">Мой прогресс</h1>{seg}<div class="sk" style="height:112px;margin-top:64px"/><div class="sk" style="height:132px;margin-top:24px"/></section>;
    const today = `${nowDate().getFullYear()}-${String(nowDate().getMonth()+1).padStart(2,"0")}-${String(nowDate().getDate()).padStart(2,"0")}`;
    const unlocked = rewards.achievements.filter((a) => a.unlocked).length;
    // R-10: a brand-new student sees one clear first step instead of a screen of zeros and locks.
    const fresh = rewards.total_points === 0 && unlocked === 0 && rewards.current_streak === 0 && (!week || week.week_study_minutes === 0);
    return (<section class="screen progress-workspace" aria-labelledby="pr-h">
      <header class="topbar l-h l-btw l-wrap l-g3 b-tap mb-2"><h1 id="pr-h" class="h-sec">Мой прогресс</h1>
        <span class="hud-stats l-h l-g1 b-bare b-tap l-fix mw-full" role="group" aria-label={`Серия ${rewards.current_streak} ${plural(rewards.current_streak, "день", "дня", "дней")}, ${rewards.total_points} очков`}>
          <span class="hud-chip l-h l-inl l-g1 f-m f-w6 f-a b-tile b-tap mw-44 streak num"><Icon name="flame"/>{rewards.current_streak}</span>
          <span class="hud-chip l-h l-inl l-g1 f-m f-w6 f-a b-tile b-tap mw-44 pts num"><Icon name="bolt"/>{rewards.total_points}</span>
        </span>
      </header>
      {seg}
      {fresh && <div class="progress-first l-h l-top l-g3 b-card mt-3 mb-1" role="note" data-testid="progress-first">
        <Icon name="chart"/>
        <div><h2>Здесь появится твой прогресс</h2>
          <p class="f-2">Очки, серия и достижения считаются только по настоящим делам. Отметь «Готово» у первого задания или пройди таймер — и этот экран оживёт.</p>
          <button type="button" class="btn btn-primary btn-sm" onClick={() => { location.hash = withLaunch("tonight"); }}>Открыть план дня</button></div>
      </div>}

      {/* Уровень — типографика + XP-полоса вместо «кольца в карточке» (паттерн XP bar, без 8-bit стилизации) */}
      <section class="progress-overview l-a1 l-g4 l-mid" aria-label="Прогресс уровня"><div class="level-orbit l-center l-g0 l-rel" role="progressbar" aria-label="Прогресс текущего уровня" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rewards.level_progress_percent}><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" class="orbit-track"/><circle cx="60" cy="60" r="50" class="orbit-value" style={{ opacity: rewards.level_progress_percent > 0 ? 1 : 0 }} pathLength="100" stroke-dasharray={`${Math.max(0,Math.min(100,rewards.level_progress_percent))} 100`}/></svg><strong>{rewards.level_progress_percent}%</strong></div><div class="progress-intro"><span>{rewards.level_name}</span><h2>Уровень {rewards.level}</h2><p class="f-2">Ещё {rewards.points_to_next_level} очков до следующего</p></div></section>
      <dl class="progress-ledger l-c3 l-g0 f-tc b-sep mb-6"><div><dd class="num">{pts}</dd><dt>Очки</dt></div><div><dd class="num">{rewards.current_streak}</dd><dt>Серия, дней</dt></div><div><dd class="num">{unlocked}</dd><dt>Достижения</dt></div></dl>

      <div class="sec-head"><h2 class="h-sec">Моя неделя</h2><span class="faint num" style="font-size:calc(12px*var(--fs,1))">{week ? `${dur(week.week_study_minutes)} · ${week.week_duels} ${plural(week.week_duels, "дуэль", "дуэли", "дуэлей")}` : "день засчитан при 65%"}</span></div>
      {week && week.week_study_minutes === 0 ? (<div class="week-empty b-card">
          <div class="week-dots l-c7 l-g0 f-c f-3 f-tc" aria-hidden="true">{week.days.map((d) => <span key={d.date} class={d.date === today ? "today" : ""}><i />{weekdayShort(d.date)}</span>)}</div>
          <p class="f-2">Неделя пустая — первое «Готово» сегодня зажжёт этот день. Засчитывается, когда сделано 65% плана.</p>
        </div>) : week ? (<div class="week-summary">
          <p class="f-2"><b class="num">{week.days.filter((d) => d.counted).length} из 7</b> {plural(week.days.filter((d) => d.counted).length, "день засчитан", "дня засчитано", "дней засчитано")} · активных дней: <b class="num">{week.days.filter((d) => d.study_minutes > 0).length}</b></p>
        </div>) : err ? <div class="note bad" role="status"><Icon name="alert"/><div>Неделя не загрузилась. <button class="btn btn-secondary btn-sm" onClick={load}>Повторить</button></div></div> : <div class="sk" style="height:56px"/>}
      {onStats && <button type="button" class="btn btn-secondary btn-block progress-stats-link mt-2 mb-1" onClick={onStats}><Icon name="chart"/>Статистика по дням — в профиле</button>}

      <div class="sec-head"><h2 class="h-sec">Достижения</h2><span class="faint num" style="font-size:calc(13px*var(--fs,1))">{unlocked}/{rewards.achievements.length}</span></div>
      <div class="achievement-grid l-v">
        {[...rewards.achievements].sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || b.progress_percent - a.progress_percent).map((a) => (<div key={a.title} class={`ach l-a1a l-g3 l-mid b-tile${a.unlocked ? " on" : ""}`}>
            <span class="ach-ico l-center l-g0 f-a b-box"><Icon name={a.unlocked ? "trophy" : "lock"}/></span>
            <div><div class="ach-t f-b">{a.title}</div><div class="ach-d f-c f-2 mt-1">{a.description}</div>{!a.unlocked && a.progress_percent > 0 && <div class="meter mt-1 o-h r-xs"><i style={{ width: `${a.progress_percent}%` }}/></div>}</div>
            <span class="faint num" style="font-size:calc(12px*var(--fs,1))">{a.unlocked ? "✓" : `${a.progress_percent}%`}</span>
          </div>))}
      </div>
    </section>);
}

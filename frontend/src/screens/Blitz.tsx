/**
 * Блиц-дуэль — отдельная вкладка: короткий матч на 5 вопросов по темам вечера.
 * Соперник — честный «призрак»: твой рекорд по теме или результат одноклассника,
 * пришедший вызовом из чата MAX (диплинк startapp=blitz_<тема>_<очки>). Никаких
 * выдуманных онлайн-игроков: ждать некого, демо не может «не найти соперника».
 * Победа (≥3 верных) засчитывается в прогресс тем же событием, что и дуэль задания.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { QuizTimer, useQuizClock } from "../ui/QuizTimer";
import { QuizClock, QUIZ_CONFIG, questionMs } from "../lib/quizClock";
import { celebrate } from "../ui/Celebrate";
import { toast } from "../ui/Toast";
import { api } from "../lib/api";
import { appLink, bindBack, closingGuard, haptic, share } from "../lib/host";
import { cache } from "../lib/api";
import { schoolDay } from "../lib/day";
import { subjectColor } from "../lib/subjects";
import { QuizCodeForm } from "../ui/QuizCode";
import { useCountTo } from "../lib/useCountTo";
import { pointsFor, ROUND_MAX, TOPICS, topicByKey, topicFor, type Challenge, type RoundQ, type Topic } from "../lib/blitzBank";
export { parseChallenge, type Challenge } from "../lib/blitzBank";
import { hasGenerator, smartRound } from "../lib/blitzGen";
import { mistakes, recordRound } from "../lib/blitzMistakes";
import type { Rewards, Task } from "../lib/types";
import { secondChanceNote } from "../lib/secondChance";
type Phase = "arena" | "count" | "play" | "result" | "second";
interface Best {
    score: number;
    correct: number;
}
interface Ans {
    pick: number;
    ok: boolean;
    ms: number;
    pts: number;
}
const BEST_KEY = "sf.blitz.best";
const dayKey = () => `sf.blitz.day.${schoolDay()}`;
const bests = (): Record<string, Best> => cache.get<Record<string, Best>>(BEST_KEY) ?? {};
const KEYS = ["1", "2", "3", "4"];
/** v3.2.1 · события блица, не дошедшие до сервера (офлайн), — дошлём при следующем раунде; event_id идемпотентен. */
const PENDING_KEY = "sf.blitz.pending.v1";
type PendingEvent = { event_id: string; score: number; attempt: number; task: string; mode: "blitz" };
const asBank = (q: RoundQ) => ({ q: q.q, a: [q.options[q.answer], ...q.options.filter((_, j) => j !== q.answer)] as [string, string, string, string], why: q.why });
async function flushPending(onRewards: (r: Rewards) => void): Promise<void> {
    const list = cache.get<PendingEvent[]>(PENDING_KEY) ?? [];
    if (!list.length || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const left: PendingEvent[] = [];
    for (const e of list.slice(-20)) {
        try { onRewards(await api.event("duel_completed", e)); } catch { left.push(e); }
    }
    cache.set(PENDING_KEY, left);
}
const LETTERS = "АБВГ";
interface Props {
  /** V23 · опрос учителя по 6-значному коду прямо на экране «Блиц» (эталон). */
  onCodeIssue?: (issueId: string) => void;
  codeDemo?: boolean;
  /** v3.0 · переключатель вкладки «Практика» — только на стартовом экране блица (в игре скрыт). */
  head?: ComponentChildren;
    tasks: Task[];
    done: string[];
    rewards: Rewards | null;
    onRewards: (r: Rewards) => void;
    preset: {
        key: string;
        n: number;
    } | null;
    challenge: Challenge | null;
    onChallengeUsed: () => void;
    botName: string | null;
    onPlaying: (on: boolean) => void;
    onDeepDuel: ((title: string) => void) | null;
}
export function Blitz({ tasks, done, rewards, onRewards, preset, challenge, onChallengeUsed, botName, onPlaying, onDeepDuel, onCodeIssue, codeDemo, head }: Props) {
    // Темы вечера первыми: только что сделанное → «закрепи», устное → «завтра у доски».
    const tonight = useMemo(() => {
        const seen = new Set<string>();
        const out: {
            t: Topic;
            why: string;
            title: string;
        }[] = [];
        const ordered = [...tasks].sort((a, b) => Number(done.includes(b.title)) - Number(done.includes(a.title)));
        for (const task of ordered) {
            const t = topicFor(task.title);
            if (!t || seen.has(t.key))
                continue;
            seen.add(t.key);
            out.push({ t, title: task.title, why: done.includes(task.title) ? "только что сделал — закрепи" : task.type === "oral" ? "завтра у доски" : "в плане дня" });
        }
        return out;
    }, [tasks, done]);
    const others = TOPICS.filter((t) => !tonight.some((x) => x.t.key === t.key));
    const [key, setKey] = useState<string>(challenge?.key ?? preset?.key ?? tonight[0]?.t.key ?? "lit");
    const [calm, setCalm] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const [phase, setPhase] = useState<Phase>("arena");
    const [round, setRound] = useState<RoundQ[]>([]);
    const [target, setTarget] = useState<{
        score: number;
        who: "record" | "friend";
    } | null>(null);
    const [answers, setAnswers] = useState<Ans[]>([]);
    const [result, setResult] = useState<{
        score: number;
        correct: number;
        newRecord: boolean;
        prevBest: number | null;
        xp: number | null;
        counted: boolean;
    } | null>(null);
    const topic = topicByKey(key) ?? TOPICS[0];
    const [secondRound, setSecondRound] = useState<RoundQ[]>([]);
    const [second, setSecond] = useState<{
        fixed: number;
        total: number;
    } | null>(null);
    useEffect(() => { if (preset) {
        setKey(preset.key);
        setPhase("arena");
    } }, [preset?.n]);
    useEffect(() => { if (challenge) {
        setKey(challenge.key);
        setPhase("arena");
    } }, [challenge]);
    const playing = phase === "count" || phase === "play" || phase === "second";
    useEffect(() => { onPlaying(playing); closingGuard(playing, "blitz"); }, [playing]);
    useEffect(() => () => { onPlaying(false); closingGuard(false, "blitz"); }, []);
    // «Назад» MAX из вопроса/отсчёта → на арену (уровень ниже), а не закрытие мини-аппа
    useEffect(() => (playing ? bindBack(() => setPhase("arena")) : undefined), [playing]);
    const begin = () => {
        const best = bests()[topic.key];
        const t = challenge && challenge.key === topic.key ? { score: challenge.score, who: "friend" as const } : best ? { score: best.score, who: "record" as const } : null;
        setTarget(t);
        setRound(smartRound(topic, mistakes(cache, topic.key)));
        void flushPending(onRewards);
        setAnswers([]);
        setResult(null);
        setSecond(null);
        haptic.tap("medium");
        setPhase("count");
    };
    const finish = async (ans: Ans[]) => {
        const score = ans.reduce((a, x) => a + x.pts, 0), correct = ans.filter((x) => x.ok).length;
        recordRound(cache, topic.key, round.map((q, k) => ({ q: asBank(q), ok: !!ans[k]?.ok })));
        const all = bests();
        const prev = all[topic.key] ?? null;
        const newRecord = !prev || score > prev.score;
        if (newRecord)
            cache.set(BEST_KEY, { ...all, [topic.key]: { score, correct } });
        const counted = correct >= 3;
        setResult({ score, correct, newRecord: newRecord && !!prev, prevBest: prev?.score ?? null, xp: null, counted });
        setPhase("result");
        if (challenge?.key === topic.key)
            onChallengeUsed();
        haptic.notify(counted ? "success" : "warning");
        if ((newRecord && prev) || (target?.who === "friend" && score > target.score))
            setTimeout(() => celebrate(0, { x: innerWidth / 2, y: innerHeight * 0.28 }, true), 380);
        if (!counted)
            return;
        const day = cache.get<Record<string, number>>(dayKey()) ?? {};
        const attempt = (day[topic.key] ?? 0) + 1;
        cache.set(dayKey(), { ...day, [topic.key]: attempt });
        const before = rewards?.total_points ?? null;
        const ev: PendingEvent = { event_id: `blitz:${topic.key}:${attempt}:${Date.now()}`, score: Math.round((correct * 3) / 5), attempt, task: topic.label, mode: "blitz" };
        try {
            const r = await api.event("duel_completed", ev);
            setResult((x) => (x ? { ...x, xp: before !== null ? r.total_points - before : null } : x));
            onRewards(r);
        }
        catch { /* офлайн: результат и рекорд уже сохранены локально; очки дойдут при следующем раунде с сетью */
            cache.set(PENDING_KEY, [...(cache.get<PendingEvent[]>(PENDING_KEY) ?? []), ev].slice(-20));
        }
    };
    if (phase === "count")
        return <Countdown topic={topic} onGo={() => setPhase("play")}/>;
    if (phase === "play")
        return <Play topic={topic} round={round} calm={calm} target={target} onAnswers={setAnswers} onDone={finish} onQuit={() => setPhase("arena")}/>;
    if (phase === "second")
        return (<Play topic={topic} round={secondRound} calm target={null} onAnswers={() => undefined} onQuit={() => setPhase("result")} onDone={(a) => { recordRound(cache, topic.key, secondRound.map((q, k) => ({ q: asBank(q), ok: !!a[k]?.ok }))); setSecond({ fixed: a.filter((x) => x.ok).length, total: a.length }); setPhase("result"); haptic.notify("success"); }}/>);
    if (phase === "result" && result) {
        const wrong = round.filter((_, k) => !answers[k]?.ok);
        return <Result topic={topic} result={result} answers={answers} round={round} target={target} rewards={rewards} botName={botName} onAgain={begin} onOther={() => setPhase("arena")} second={second} onSecond={wrong.length && !second ? () => {
                // второй шанс: только ошибки, спокойно, без таймера и без очков; варианты перемешаны
                setSecondRound(wrong.map((q) => { const o = q.options.map((_, k) => k).sort(() => Math.random() - 0.5); return { ...q, options: o.map((k) => q.options[k]), answer: o.indexOf(q.answer) }; }));
                setPhase("second");
            } : null}/>;
    }
    const bestMap = bests();
    const oral = tasks.find((t) => t.blitz_eligible && !done.includes(t.title) && topicFor(t.title)?.key === topic.key);
    // функция, а не компонент: DOM кнопок не пересоздаётся → фокус не теряется при выборе стрелками
    const row = (t: Topic, why: string) => {
        const b = bestMap[t.key];
        const on = t.key === key;
        return (<button key={t.key} class={`bz-topic l-a1a l-g3 l-mid b-card l-w100${on ? " on" : ""}`} role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-key={t.key} onClick={() => { setKey(t.key); haptic.select(); }} style={{ "--c": subjectColor(t.label) }}>
          <span class="topic-selector l-center l-g0 b-round l-fix" aria-hidden="true">{on ? <Icon name="check" /> : null}</span>
          <span class="bz-topic-main l-v l-g0"><b>{t.label}</b><span class="f-3">{why}</span></span>
          <span class="bz-topic-best l-v l-g0 f-w6 num">{b ? <>{b.score}<small class="f-w6">рекорд</small></> : <small class="f-w6">новая</small>}</span>
      </button>);
    };
    return (<div class="screen bz blitz-workspace">
      {head}
      <header class="bz-head pt-4">
        {onCodeIssue && <section class="bz-pin b-card mt-1 mb-4" aria-labelledby="bz-pin-h"><h2 id="bz-pin-h" class="h-sec">Опрос учителя по коду</h2><QuizCodeForm inline demo={codeDemo} onOpenIssue={onCodeIssue}/></section>}
        <div class="eyebrow"><Icon name="bolt"/>Блиц-дуэль</div>
        <h1 class="bz-title f-xl mt-2">Блиц по теме</h1>
        <p class="muted bz-lead f-s mt-3">5 вопросов по теме вечера. Быстрее — больше очков. Соперник — твой рекорд или одноклассник из чата.</p>
      </header>

      {challenge && (<div class="bz-challenge p-4 l-h l-g3 mt-4" role="note">
          <span class="vs-ava l-center l-g0 f-h b-round l-fix" style={{ "--c": subjectColor(topicByKey(challenge.key)?.label ?? "") }} aria-hidden="true"><Icon name="swords"/></span>
          <div><b>Вызов из чата</b><span>{topicByKey(challenge.key)?.label}: <b class="num">{challenge.score}</b> очков. Побьёшь?</span></div>
        </div>)}

      <div class="blitz-selection"><div class="sec-head"><h2 class="h-sec">Выбери предмет</h2>{tonight.length > 0 && <span class="faint" style="font-size:calc(13px*var(--fs,1))">из плана дня</span>}</div>
      {/* radiogroup по APG: одна табуляция в группу, стрелки двигают выбор */}
      <div class="bz-topics l-v l-g1 mt-2" role="radiogroup" aria-label="Тема блиц-дуэли" onKeyDown={(e) => {
            const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
            if (!d)
                return;
            e.preventDefault();
            const btns = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role=radio]")];
            const k = btns.findIndex((x) => x.dataset.key === key);
            const nx = btns[(k + d + btns.length) % btns.length];
            if (nx?.dataset.key) {
                setKey(nx.dataset.key);
                haptic.select();
                nx.focus();
            }
        }}>
        {tonight.map((x) => row(x.t, x.why))}
        {(showAll || !tonight.length) && others.map((t) => row(t, "по программе 7–9 класса"))}
      </div>
      {!showAll && tonight.length > 0 && <button class="btn btn-ghost btn-sm bz-more mt-1" onClick={() => setShowAll(true)} aria-expanded={false}>Другие предметы · {others.length}</button>}

      </div><div class="blitz-round-config"><p class="eyebrow">Твой раунд</p><h2>{topic.label}</h2><dl class="duel-facts py-3 l-c3 l-g0 b-sep mt-6 bz-facts f-tc mt-4">
        <div><dt class="f-w6">Вопросов</dt><dd class="num f-w6">5</dd></div>
        <div><dt class="f-w6">На ответ</dt><dd class="num f-w6">{calm ? "без лимита" : `${QUIZ_CONFIG.questionSeconds} с`}</dd></div>
        <div><dt class="f-w6">Засчёт</dt><dd class="num f-w6">от 3/5</dd></div>
      </dl>
      {(() => { const n = mistakes(cache, topic.key).length; const gen = hasGenerator(topic.key);
        return (n > 0 || gen) && <p class="bz-offline muted f-s mt-2">{n > 0 && <><b class="num">{Math.min(2, n)}</b> из прошлых ошибок вернутся в раунд. </>}{gen ? "Задачи с новыми числами каждый раунд — работает и без интернета." : "Работает и без интернета."}</p>; })()}
      <label class="switch bz-calm mt-2">
        <span><b style="font-weight:600">Спокойный режим</b><br /><span class="muted" style="font-size:calc(13px*var(--fs,1))">Без таймера на вопрос — очки только за верные ответы</span></span>
        <input type="checkbox" checked={calm} onChange={(e) => setCalm((e.target as HTMLInputElement).checked)}/>
      </label>

      {onDeepDuel && (<button class="btn btn-ghost btn-block" style="margin-top:4px" onClick={() => onDeepDuel(oral?.title ?? topic.label)}>Свой опрос, фото параграфа или вопросы ИИ <Icon name="chevron"/></button>)}
      {/* CTA прилипает над доком: старт всегда под большим пальцем, без прокрутки */}
      <div class="bz-cta pt-4 mt-3">
        <button class="btn btn-primary btn-block btn-hero bz-start mt-4" onClick={begin}><Icon name="bolt"/>Старт · {topic.label}</button>
      </div>
      </div>
    </div>);
}
function Countdown({ topic, onGo }: {
    topic: Topic;
    onGo: () => void;
}) {
    const [n, setN] = useState(3);
    useEffect(() => {
        const fast = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const step = fast ? 350 : 700;
        const t = setTimeout(() => { if (n > 1) {
            setN(n - 1);
            haptic.select();
        }
        else
            onGo(); }, step);
        return () => clearTimeout(t);
    }, [n]);
    return (<div class="screen bz-count l-v l-jc l-g0 l-ac f-tc" style={{ "--c": subjectColor(topic.label) }}>
      <h1 class="sr">Блиц-дуэль: {topic.label}</h1>
      <div class="eyebrow">{topic.label} · 5 вопросов</div>
      <div class="bz-count-n f-xl mt-4 num" key={n} aria-hidden="true">{n}</div>
      <p class="sr" role="status">Старт через три секунды</p>
    </div>);
}
function Play({ topic, round, calm, target, onAnswers, onDone, onQuit }: {
    topic: Topic;
    round: RoundQ[];
    calm: boolean;
    target: {
        score: number;
        who: "record" | "friend";
    } | null;
    onAnswers: (a: Ans[]) => void;
    onDone: (a: Ans[]) => void;
    onQuit: () => void;
}) {
    // v16.1: время вопроса — общий QuizClock (дедлайн по меткам времени), а не setTimeout + CSS-анимация.
    // Экземпляр живёт, пока жив раунд: перерисовка его не пересоздаёт и не сбрасывает отсчёт.
    const clock = useMemo(() => new QuizClock(round.length, { timed: !calm, durationMs: questionMs() }), [round]);
    const { now } = useQuizClock(clock);
    const snap = clock.snapshot();
    const i = Math.min(snap.index, round.length - 1);
    const q = round[i];
    const qRef = useRef<HTMLHeadingElement>(null);
    const nextRef = useRef<HTMLButtonElement>(null);
    const doneSent = useRef(false);
    const [advancing, setAdvancing] = useState(false);
    const ans: Ans[] = snap.results.map((r) => ({ pick: r.pick ?? -1, ok: r.ok, ms: r.ms, pts: calm ? (r.ok ? 100 : 0) : pointsFor(r.ok, r.ms) }));
    const score = ans.reduce((a, x) => a + x.pts, 0);
    const shown = useCountTo(score, ans.length ? score - ans[ans.length - 1].pts : 0, 520);
    let combo = 0;
    for (let k = ans.length - 1; k >= 0 && ans[k].ok; k--)
        combo++;
    const last = snap.current ? ans[snap.results.findIndex((r) => r.index === snap.current!.index)] ?? null : null;
    const beat = target ? score > target.score : false;
    const pick = snap.current ? snap.current.pick ?? -1 : null;
    // вопрос показан (кадр отрисован) → старт отсчёта; на скрытой вкладке rAF ждёт — время не списывается
    useEffect(() => {
        if (snap.phase !== "idle" && snap.phase !== "loading")
            return;
        clock.load();
        const id = requestAnimationFrame(() => { if (clock.start())
            qRef.current?.focus({ preventScroll: true }); });
        return () => cancelAnimationFrame(id);
    }, [clock, snap.index, snap.phase]);
    // новый результат (ответ или пропуск по времени): отдать наверх, вибрация, автопереход после верного
    useEffect(() => {
        if (!snap.current)
            return;
        onAnswers(ans);
        if (snap.current.ok) {
            haptic.notify("success");
            setAdvancing(true);
            const t = setTimeout(() => { setAdvancing(false); clock.next(); }, QUIZ_CONFIG.revealMs);
            return () => clearTimeout(t);
        }
        haptic.notify("error");
        const t = setTimeout(() => nextRef.current?.focus({ preventScroll: true }), 60);
        return () => clearTimeout(t);
    }, [clock, snap.results.length]);
    useEffect(() => {
        if (snap.phase !== "done" || doneSent.current)
            return;
        doneSent.current = true;
        onDone(ans);
    }, [snap.phase]);
    const answer = (k: number) => { clock.answer(k, k === q.answer); }; // отклонён (повтор, вышел срок) → null, ничего не делаем
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)
                return;
            const k = KEYS.indexOf(e.key);
            if (k >= 0 && k < q.options.length && snap.phase === "asking") {
                e.preventDefault();
                answer(k);
            }
        };
        addEventListener("keydown", h);
        return () => removeEventListener("keydown", h);
    }, [clock, i, snap.phase]);
    if (snap.phase === "done" || snap.phase === "cancelled")
        return <div class="screen bz-play l-rel" aria-busy="true"/>;
    const locked = snap.phase !== "asking";
    return (<div class="screen bz-play l-rel" style={{ "--c": subjectColor(topic.label) }}>
      <h1 class="sr">Блиц-дуэль: {topic.label}</h1>
      <div class="bz-bar l-a1a l-g3 l-mid mb-6">
        <button class="icon-btn" onClick={() => { clock.cancel(); onQuit(); }} aria-label="Выйти из дуэли"><Icon name="x"/></button>
        <ol class="bz-steps l-c5 l-g1" aria-label={`Вопрос ${i + 1} из ${round.length}`}>
          {round.map((_, k) => <li key={k} class={k < ans.length ? (ans[k].ok ? "ok" : "bad") : k === i ? "now" : ""}/>)}
        </ol>
        <div class="bz-score l-h l-inl l-je l-g1 f-s num" aria-label={`${score} очков`}><Icon name="bolt"/>{shown}</div>
      </div>

      {target && (<div class={`bz-ghost l-1a l-g3 l-mid f-m f-3 mt-3${beat ? " beat" : ""}`} aria-label={`${target.who === "friend" ? "Соперник" : "Твой рекорд"}: ${target.score}. ${beat ? "Ты впереди" : `Осталось ${Math.max(0, target.score - score + 1)}`}`}>
          <span class="bz-ghost-track l-rel r-xs u-soft" aria-hidden="true">
            <i style={{ transform: `scaleX(${Math.min(1, score / ROUND_MAX)})` }}/>
            <b style={{ left: `${(target.score / ROUND_MAX) * 100}%` }}/>
          </span>
          <span class="bz-ghost-l">{beat ? (target.who === "friend" ? "обгоняешь соперника" : "рекорд побит") : `${target.who === "friend" ? "соперник" : "рекорд"} ${target.score}`}</span>
        </div>)}

      <section class="quiz-surface b-card mt-4 mb-6 l-rel" aria-label={`Вопрос ${i + 1} из ${round.length}`}><div class="quiz-topic l-h l-btw l-g3 f-c f-a mb-4"><span>{topic.label}</span><Icon name="bolt"/></div>
      <div class="bz-q b-bare mt-6" key={i}>
        <div class="q-num l-h l-base l-g1 f-m f-w6 mb-3"><span class="sr">Вопрос </span><b class="num">{i + 1}</b><span class="num q-of f-s f-3"><span class="sr"> из </span><span aria-hidden="true">/</span>{round.length}</span>{combo >= 2 && <span class="bz-combo f-a as-c r-sm u-acc-s" key={combo}>серия ×{combo}</span>}{round[i]?.src === "review" && <span class="bz-review f-s f-3">повтор ошибки</span>}</div>
        <QuizTimer clock={clock} now={now} advancing={advancing}/>
        <h2 class="q-text f-h mt-2" tabIndex={-1} ref={qRef}>{q.q}</h2>
      </div>

      <div class="opts l-v mt-4 bz-opts" role="group" aria-label="Варианты ответа">
        {q.options.map((o, k) => {
            const cls = pick === null ? "" : k === q.answer ? " right" : k === pick ? " wrong" : " dim";
            return (<button key={`${i}-${k}`} class={`opt${cls}`} onClick={() => answer(k)} disabled={locked} aria-keyshortcuts={KEYS[k]} style={{ "--i": k }}>
              <span class="k l-center l-g0 f-b f-2 b-box l-fix s-28" aria-hidden="true">{LETTERS[k]}</span><span>{o}</span>
              {pick === k && last && last.ok && <span class="bz-pts f-w6 f-ok p-abs num" aria-hidden="true">+{last.pts}</span>}
            </button>);
        })}
      </div>

      </section>
      <div role="status" aria-live="polite" class="bz-feedback-wrap f-b">
        {last && (last.ok
            ? <p class="sr">Верно, плюс {last.pts}</p>
            : <div class="verdict p-4 l-a1 l-g3 f-b mt-4 v-miss u-bad-s bz-why b-box"><Icon name={last.pick === -1 ? "timer" : "x"}/><div><b>{last.pick === -1 ? "Время вышло — пропуск, 0 очков" : "Мимо"}</b>Правильно: «{q.options[q.answer]}». {q.why}</div></div>)}
      </div>
      {last && !last.ok && snap.phase === "revealed" && (<button ref={nextRef} class="btn btn-secondary btn-block" style="margin-top:12px" onClick={() => clock.next()}>
          {i + 1 >= round.length ? "К результату" : "Дальше"} <Icon name="chevron"/>
        </button>)}
    </div>);
}
function Result({ topic, result, answers, round, target, rewards, botName, onAgain, onOther, second, onSecond }: {
    topic: Topic;
    result: {
        score: number;
        correct: number;
        newRecord: boolean;
        prevBest: number | null;
        xp: number | null;
        counted: boolean;
    };
    answers: Ans[];
    round: RoundQ[];
    target: {
        score: number;
        who: "record" | "friend";
    } | null;
    rewards: Rewards | null;
    botName: string | null;
    onAgain: () => void;
    onOther: () => void;
    second: {
        fixed: number;
        total: number;
    } | null;
    onSecond: (() => void) | null;
}) {
    const shown = useCountTo(result.score, 0, 1100);
    const okMs = answers.filter((a) => a.pick !== -1);
    const avg = okMs.length ? okMs.reduce((a, x) => a + x.ms, 0) / okMs.length / 1000 : null;
    let bestRun = 0, run = 0;
    for (const a of answers) {
        run = a.ok ? run + 1 : 0;
        bestRun = Math.max(bestRun, run);
    }
    const vsFriend = target?.who === "friend";
    const won = target ? result.score > target.score : false;
    const headRef = useRef<HTMLHeadingElement>(null);
    useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, []);
    const title = vsFriend ? (won ? "Вызов выигран." : "Почти. Реванш?") : result.newRecord ? "Новый рекорд." : result.counted ? "Тема держится." : "Есть пробелы.";
    const onShare = async () => {
        const link = appLink(`blitz_${topic.key}_${result.score}`, botName);
        const r = await share(`Блиц «${topic.label}»: ${result.score} очков, ${result.correct}/5. Побьёшь?`, link);
        if (r === "copied")
            toast("Ссылка-вызов скопирована — вставь в чат класса", "ok");
    };
    return (<div class="screen bz-res f-tc">
      <div class="bz-res-hero l-rel">
        <div class={`bz-medal l-center l-g0 f-2 b-round l-mx l-rel${result.newRecord || won ? " gold" : ""}`} aria-hidden="true"><Icon name={result.newRecord || won ? "trophy" : result.counted ? "check" : "bolt"}/><span class="ring-burst"/></div>
        <div class="bz-res-score f-xl mt-4 num" aria-hidden="true">{shown}</div>
        <div class="faint bz-res-unit f-b mt-1">очков из {ROUND_MAX}</div>
        <h1 class="h-title" tabIndex={-1} ref={headRef}>{title}<span class="sr"> {result.score} очков, верно {result.correct} из 5.</span></h1>
        {vsFriend && target && <p class="bz-vs f-s f-2 mt-2 num"><b>Ты {result.score}</b> : {target.score} соперник</p>}
        {!vsFriend && result.prevBest !== null && !result.newRecord && <p class="muted" style="margin:6px 0 0">Рекорд {result.prevBest} — не хватило {result.prevBest - result.score + 1}.</p>}
      </div>

      <dl class="duel-facts py-3 l-c3 l-g0 b-sep mt-6">
        <div><dt class="f-w6">Верно</dt><dd class="num f-w6">{result.correct}/5</dd></div>
        <div><dt class="f-w6">Ср. ответ</dt><dd class="num f-w6">{avg === null ? "—" : `${avg.toFixed(1).replace(".", ",")} с`}</dd></div>
        <div><dt class="f-w6">Серия</dt><dd class="num f-w6">{bestRun}</dd></div>
      </dl>

      <div class={`bz-reward l-h l-jc f-b mt-4 r-md u-acc-s p-3${result.counted ? "" : " no"}`} role="status">
        {result.counted
            ? <><Icon name="flame"/><span>{result.xp !== null && result.xp > 0 ? <><b class="num f-a">+{result.xp}</b> в прогресс</> : "Засчитано в прогресс"}{rewards && rewards.current_streak > 0 ? <> · стрик <b class="num f-a">{rewards.current_streak}</b> дн.</> : null}</span></>
            : <><Icon name="info"/><span>Для засчёта нужно 3 верных из 5 — разбор ниже.</span></>}
      </div>

      <details class="bz-review mt-4" open={!result.counted}>
        <summary>Разбор ответов</summary>
        <ol>
          {round.map((q, k) => {
            const a = answers[k];
            return (<li key={k} class={a?.ok ? "ok" : "bad"}>
                <Icon name={a?.ok ? "check" : "x"} label={a?.ok ? "верно" : "неверно"}/>
                <div><b>{q.q}</b><span>{q.options[q.answer]}{!a?.ok && <> — {q.why}</>}</span></div>
              </li>);
        })}
        </ol>
      </details>

      {second && (() => { const s = secondChanceNote(second.fixed, second.total); return <div class={`bz-reward l-h l-jc f-b mt-4 r-md u-acc-s p-3${s.allFixed ? "" : " no"}`} role="status"><Icon name={s.allFixed ? "check" : "info"}/><span>Второй шанс: исправлено <b class="num f-a">{second.fixed}</b> из {second.total}. {s.note}</span></div>; })()}
      <div class="stack" style="margin-top:20px">
        {onSecond && <button class="btn btn-secondary btn-block" onClick={onSecond}><Icon name="refresh"/>Второй шанс · {5 - result.correct} {5 - result.correct === 1 ? "ошибка" : "ошибки"} без таймера</button>}
        <button class="btn btn-primary btn-block btn-hero" onClick={onAgain}><Icon name="refresh"/>Реванш</button>
        <div class="actions l-c2">
          <button class="btn btn-secondary" onClick={onShare}><Icon name="share"/>Вызов в чат</button>
          <button class="btn btn-secondary" onClick={onOther}>Другая тема</button>
        </div>
      </div>
    </div>);
}

/**
 * Блиц-дуэль — игровое ядро. Три источника вопросов (как в main.py):
 *  • «С ИИ» — Active Recall, 3 верных ответа закрывают тему (без ключа — честная самопроверка);
 *  • «Свой опрос» — черновик ученика → викторина (работает и без ключа);
 *  • «Фото параграфа» — мультимодальная модель (только с ключом, иначе честный disabled).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { celebrate } from "../ui/Celebrate";
import { Segmented } from "../ui/Segmented";
import { toast } from "../ui/Toast";
import { api, ApiError, fileToBase64 } from "../lib/api";
import { closingGuard, haptic, share } from "../lib/host";
import { splitTitle, subjectColor } from "../lib/subjects";
import type { BlitzTurn, QuizQuestion, Rewards, Verdict } from "../lib/types";
import { VoiceButton } from "../ui/VoiceButton";

type Mode = "ai" | "own" | "photo";
interface Win { score: number; total: number; points: number | null; level: string | null; fixed?: number }

interface Props {
  title: string | null;
  aiOnline: boolean | null;
  onClose: () => void;
  onWin: (rewards: Rewards | null) => void;
  prevPoints: number;
}

export function Duel({ title, aiOnline, onClose, onWin, prevPoints }: Props) {
  const [mode, setMode] = useState<Mode>("ai");
  const [win, setWin] = useState<Win | null>(null);
  const [inGame, setInGame] = useState(false);
  const attempt = useRef(1);
  useEffect(() => { if (title) { setWin(null); setMode("ai"); attempt.current = 1; } }, [title]);
  useEffect(() => { closingGuard(inGame, "duel"); return () => closingGuard(false, "duel"); }, [inGame]);

  const finish = async (score: number, total: number, fixed = 0) => {
    setInGame(false);
    haptic.notify("success");
    let rewards: Rewards | null = null;
    try { rewards = await api.event("duel_completed", { event_id: `duel:${title}:${attempt.current}:${Date.now()}`, score: Math.min(3, score), attempt: attempt.current, task: title }); } catch { /* офлайн: победа всё равно засчитана локально */ }
    if (score >= Math.min(3, total)) setTimeout(() => celebrate(0, { x: innerWidth / 2, y: innerHeight * 0.3 }, true), 120);
    setWin({ score, total, fixed, points: rewards ? rewards.total_points - prevPoints : null, level: rewards?.level_name ?? null });
    onWin(rewards);
  };

  const subject = title ? splitTitle(title).subject : "";
  return (
    <Sheet open={!!title} onClose={onClose} full eyebrow="Блиц-дуэль" title={win ? "Раунд завершён" : subject}>
      {win ? <Victory win={win} subject={subject} onAgain={() => { attempt.current += 1; setWin(null); }} onClose={onClose} /> : title && (
        <>
          <Segmented label="Режим дуэли" value={mode} onChange={(m) => { if (!inGame) setMode(m); else toast("Сначала закончи текущую дуэль", "warn"); }}
            options={[{ value: "ai", label: aiOnline === false ? "Самопроверка" : "С ИИ" }, { value: "own", label: "Свой опрос" }, { value: "photo", label: "По фото", disabled: aiOnline === false }]} />
          {mode === "ai" && <AiDuel key={`ai-${attempt.current}`} title={title} aiOnline={aiOnline} onStart={() => setInGame(true)} onDone={(s) => finish(s, 3)} />}
          {mode === "own" && <OwnQuiz key="own" topic={subject} onStart={() => setInGame(true)} onDone={finish} />}
          {mode === "photo" && <PhotoQuiz key="photo" onStart={() => setInGame(true)} onDone={finish} />}
        </>
      )}
    </Sheet>
  );
}

const VERDICT: Record<Verdict, { t: string; icon: string }> = {
  correct: { t: "Верно", icon: "check" },
  partial: { t: "Почти", icon: "alert" },
  miss: { t: "Мимо", icon: "x" },
};

function Pips({ n, total = 3 }: { n: number; total?: number }) {
  return <div class="pips" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={n} aria-label={`${n} из ${total}`}>{Array.from({ length: total }, (_, i) => <span key={i} class={`pip${i < n ? " on" : ""}`} />)}</div>;
}

function AiDuel({ title, aiOnline, onStart, onDone }: { title: string; aiOnline: boolean | null; onStart: () => void; onDone: (score: number) => void }) {
  const [q, setQ] = useState<string | null>(null);
  const [history, setHistory] = useState<BlitzTurn[]>([]);
  const [progress, setProgress] = useState(0);
  const [answer, setAnswer] = useState("");
  const [last, setLast] = useState<{ v: Verdict; f: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const start = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.blitzStart(title); setQ(r.question); onStart(); haptic.tap("medium"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Дуэль не стартовала"); }
    finally { setBusy(false); }
  };

  const send = async (text: string, audio?: { base64: string; mime: string }) => {
    if (!q || (!text.trim() && !audio) || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = audio ? await api.blitzVoice(title, audio.base64, audio.mime, history, q) : await api.blitzAnswer(title, text.trim(), history, q);
      const v = r.verdict ?? "partial";
      setHistory([...history, { question: q, answer: audio ? "(голосом)" : text.trim(), verdict: v }]);
      setLast({ v, f: (r.feedback ?? "").replace(/Если верно, напиши «проверил по учебнику»\.?/, "Если верно — нажми «Сверил — верно».") });
      setProgress(r.progress);
      if (v === "correct") haptic.notify("success");
      else { haptic.notify(v === "miss" ? "error" : "warning"); cardRef.current?.classList.remove("shake"); void cardRef.current?.offsetWidth; cardRef.current?.classList.add("shake"); }
      if (r.done) { setTimeout(() => onDone(3), 650); return; }
      if (r.question && r.question !== q) { setQ(r.question); setAnswer(""); }
    } catch (e) {
      const m = e instanceof ApiError ? (e.status === 429 ? `Слишком часто. Подожди ${e.retryAfter ?? 30} с.` : e.message) : "Ответ не отправился";
      setErr(m); haptic.notify("error");
    } finally { setBusy(false); }
  };

  if (!q) {
    return (
      <div class="duel-intro f-tc">
        {/* «Versus»-композиция вместо текста + карточки-предупреждения: ты против темы, три пустых слота */}
        <div class="vs l-h l-jc l-g4" aria-hidden="true">
          <span class="vs-side"><span class="vs-ava l-center l-g0 f-h b-round l-fix me">Ты</span></span>
          <span class="vs-x l-center l-g0 f-a s-40"><Icon name="swords" /></span>
          <span class="vs-side"><span class="vs-ava l-center l-g0 f-h b-round l-fix" style={{ "--c": subjectColor(title) }}>{splitTitle(title).subject.slice(0, 1)}</span></span>
        </div>
        <h3 class="duel-h f-xl mt-6">Три верных ответа —<br />и тема закрыта.</h3>
        <div class="duel-slots l-h l-jc mt-4" role="img" aria-label="Нужно три верных ответа">{[0, 1, 2].map((i) => <i key={i} style={{ "--i": i }} />)}</div>
        <dl class="duel-facts py-3 l-c3 l-g0 b-sep mt-6">
          <div><dt class="f-w6">Вопросов</dt><dd class="num f-w6">3</dd></div>
          <div><dt class="f-w6">Время</dt><dd class="num f-w6">≈ 2 мин</dd></div>
          <div><dt class="f-w6">Проверка</dt><dd class="f-w6">{aiOnline === false ? "по учебнику" : "ИИ"}</dd></div>
        </dl>
        <p class="duel-why f-b f-2 mt-4 l-mx">Отвечаешь своими словами, без подглядывания — так тема запоминается, а не «прочитана».{aiOnline === false && " Без ИИ-ключа вопросы из офлайн-банка, ответ сверяешь сам."}</p>
        {err && <div class="note bad" role="alert" style="margin:16px 0"><Icon name="alert" /><div>{err}</div></div>}
        <button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} style="margin-top:24px" onClick={start} disabled={busy} data-autofocus><Icon name="swords" />Начать дуэль</button>
      </div>
    );
  }

  const offlineCheck = aiOnline === false && last?.v === "partial";
  return (
    <div style="padding-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:center"><Pips n={progress} /><span class="faint num" style="font-size:calc(13px*var(--fs,1))">{progress}/3</span></div>
      <div ref={cardRef} class="q-card b-card mt-4" key={q}>
        <div class="q-num l-h l-base l-g1 f-m f-w6 mb-3">Вопрос {Math.min(3, progress + 1)}</div>
        <p class="q-text f-h mt-2">{q}</p>
      </div>
      {last && (
        <div class={`verdict p-4 l-a1 l-g3 f-b mt-4 v-${last.v}`} role="status"><Icon name={VERDICT[last.v].icon} /><div><b>{VERDICT[last.v].t}</b>{last.f}</div></div>
      )}
      {err && <div class="note bad" role="alert" style="margin-top:12px"><Icon name="alert" /><div>{err}</div></div>}
      <form style="margin-top:16px" onSubmit={(e) => { e.preventDefault(); send(answer); }}>
        <label class="sr" for="duel-a">Твой ответ</label>
        <textarea id="duel-a" class="textarea" value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} placeholder="Ответь своими словами" maxLength={1500} data-autofocus />
        <div class="actions l-c2" style="margin-top:12px">
          {offlineCheck
            ? <button type="button" style="white-space:nowrap" class={`btn btn-secondary${busy ? " is-loading" : ""}`} onClick={() => send("проверил по учебнику")} disabled={busy}><Icon name="book" />Сверил — верно</button>
            : aiOnline ? <VoiceButton label="Ответить голосом" disabled={busy} onAudio={(a) => send("", a)} /> : <span />}
          <button class={`btn btn-primary${busy ? " is-loading" : ""}`} disabled={!answer.trim() || busy}>Ответить</button>
        </div>
      </form>
    </div>
  );
}

/** Викторина в два шага: выбор → «Дай ответ» → вердикт → «Дальше». Ошибки — второй шанс в конце
 *  (один раз, варианты перемешаны). Очки — только за первую попытку; исправленные считаются отдельно. */
function QuizPlay({ questions, onDone }: { questions: QuizQuestion[]; onDone: (score: number, total: number, fixed: number) => void }) {
  type Item = QuizQuestion & { second?: boolean };
  const [queue, setQueue] = useState<Item[]>(questions);
  const [i, setI] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState(0);
  const [fixed, setFixed] = useState(0);
  const q = queue[i];
  const ok = pick !== null && pick === q.answer;
  const check = () => {
    if (pick === null || checked) return;
    setChecked(true);
    if (ok) { if (q.second) setFixed((f) => f + 1); else setScore((s) => s + 1); haptic.notify("success"); }
    else haptic.notify("error");
  };
  const next = () => {
    let nq = queue;
    if (!ok && !q.second) {
      // второй шанс: перемешиваем варианты, верный индекс пересчитываем
      const order = q.options.map((_, k) => k).sort(() => Math.random() - 0.5);
      nq = [...queue, { question: q.question, options: order.map((k) => q.options[k]), answer: order.indexOf(q.answer), second: true }];
      setQueue(nq);
    }
    if (i + 1 >= nq.length) { onDone(score, questions.length, fixed); return; }
    setI(i + 1); setPick(null); setChecked(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (checked) return;
    const n = q.options.length;
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = ((pick ?? -1) + d + n) % n;
    setPick(k);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[k]?.focus();
  };
  return (
    <div style="padding-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:center"><Pips n={Math.min(questions.length, i + (checked ? 1 : 0))} total={Math.max(questions.length, queue.length)} /><span class="faint num" style="font-size:calc(13px*var(--fs,1))">{score} верно{fixed ? ` · ${fixed} исправлено` : ""}</span></div>
      <div class="q-card b-card mt-4" key={i}>
        <div class="q-num l-h l-base l-g1 f-m f-w6 mb-3">{q.second ? <span class="q-second f-w6 f-warn">Второй шанс</span> : `Вопрос ${i + 1} из ${questions.length}`}</div>
        <p class="q-text f-h mt-2" id={`qq-${i}`}>{q.question}</p>
      </div>
      <div class="opts l-v mt-4" role="radiogroup" aria-labelledby={`qq-${i}`} onKeyDown={onKey}>
        {q.options.map((o, k) => {
          const cls = !checked ? (pick === k ? " picked" : "") : k === q.answer ? " right" : k === pick ? " wrong" : " dim";
          return (
            <button key={k} type="button" role="radio" aria-checked={pick === k ? "true" : "false"} tabIndex={(pick ?? 0) === k ? 0 : -1}
              class={`opt${cls}`} onClick={() => { if (!checked) { setPick(k); haptic.select(); } }} aria-disabled={checked ? "true" : undefined}>
              <span class="k l-center l-g0 f-b f-2 b-box l-fix s-28">{"АБВГДЕ"[k]}</span>{o}
            </button>
          );
        })}
      </div>
      {checked && (
        <div class={`verdict p-4 l-a1 l-g3 f-b mt-4 v-${ok ? "correct" : "miss"}`} role="status">
          <Icon name={ok ? "check" : "x"} />
          <div><b>{ok ? (q.second ? "Исправлено" : "Верно") : "Мимо"}</b>{ok ? "" : ` Верно: ${q.options[q.answer]}.${q.second ? "" : " Вернёмся к этому вопросу в конце."}`}</div>
        </div>
      )}
      <div style="margin-top:16px">
        {!checked
          ? <button class="btn btn-primary btn-block" onClick={check} disabled={pick === null}>Дай ответ</button>
          : <button class="btn btn-primary btn-block" onClick={next} data-autofocus>{i + 1 >= queue.length && (ok || q.second) ? "Итог" : "Дальше"}</button>}
      </div>
    </div>
  );
}

const DRAFT = `Когда была Бородинская битва?
- 1805
* 1812
- 1825
Кто написал «Капитанскую дочку»?
* Пушкин
- Лермонтов
- Гоголь
Столица России при Петре I?
* Санкт-Петербург
- Москва`;

function OwnQuiz({ topic, onStart, onDone }: { topic: string; onStart: () => void; onDone: (s: number, t: number, f: number) => void }) {
  const [raw, setRaw] = useState("");
  const [qs, setQs] = useState<QuizQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const build = async () => {
    if (!raw.trim() || busy) return;
    setBusy(true); setErr(null);
    try { const r = await api.quizManual(topic, raw, 6); setQs(r.questions); onStart(); haptic.tap("medium"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Опрос не собрался"); haptic.notify("error"); }
    finally { setBusy(false); }
  };
  if (qs) return <QuizPlay questions={qs} onDone={onDone} />;
  return (
    <div style="padding-top:24px">
      <p class="muted" style="margin-top:0">Напиши вопросы сам — так тема запоминается дважды. Варианты с «-», верный — со «*».</p>
      <label class="field">
        <span class="field-label">Черновик вопросов</span>
        <textarea class="textarea" style="min-height:180px;font-size:calc(15px*var(--fs,1))" value={raw} onInput={(e) => setRaw((e.target as HTMLTextAreaElement).value)} placeholder={DRAFT} maxLength={20000} aria-invalid={!!err} />
      </label>
      <div class="examples l-h l-wrap mt-2"><button class="example f-m f-2 b-tile b-tap" onClick={() => setRaw(DRAFT)}>Вставить пример</button></div>
      {err && <div class="note bad" role="alert" style="margin-top:12px"><Icon name="alert" /><div>{err}</div></div>}
      <button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} style="margin-top:20px" onClick={build} disabled={!raw.trim() || busy}>Собрать опрос</button>
    </div>
  );
}

function PhotoQuiz({ onStart, onDone }: { onStart: () => void; onDone: (s: number, t: number, f: number) => void }) {
  const [qs, setQs] = useState<QuizQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const onFiles = async (e: Event) => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []).slice(0, 8);
    (e.target as HTMLInputElement).value = "";
    if (!files.length) return;
    setBusy(true); setErr(null);
    try { const imgs = await Promise.all(files.map((f) => fileToBase64(f))); const r = await api.quizPhoto(imgs, 4); setQs(r.questions); onStart(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : "Не получилось"); }
    finally { setBusy(false); }
  };
  if (qs) return <QuizPlay questions={qs} onDone={onDone} />;
  return (
    <div style="padding-top:24px">
      <p class="muted" style="margin-top:0">Сфотографируй параграф — ИИ соберёт 4 вопроса по тексту.</p>
      <input ref={ref} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      {err && <div class="note bad" role="alert" style="margin-bottom:12px"><Icon name="alert" /><div>{err}</div></div>}
      <button class={`btn btn-primary btn-block${busy ? " is-loading" : ""}`} onClick={() => ref.current?.click()} disabled={busy}><Icon name="camera" />Выбрать фото</button>
    </div>
  );
}

function Victory({ win, subject, onAgain, onClose }: { win: Win; subject: string; onAgain: () => void; onClose: () => void }) {
  const sparks = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2, d = 90 + (i % 3) * 26;
    return { x: `${Math.cos(a) * d}px`, y: `${Math.sin(a) * d}px`, r: `${i * 47}deg`, c: i % 3 === 0 ? "var(--ok)" : i % 3 === 1 ? "var(--ember-hi)" : "#fff" };
  });
  const perfect = win.score >= Math.min(3, win.total);
  const onShare = async () => {
    const r = await share(`Прошёл раунд «${subject}» в блиц-дуэли: ${win.score}/${win.total} — СферумФокус в MAX`);
    if (r === "copied") toast("Скопировано — вставь в чат класса", "ok");
  };
  return (
    <div class="victory f-tc l-rel">
      <div style="position:relative;width:132px;margin:0 auto">
        <div class="medal l-center l-g0 b-round l-mx l-rel"><Icon name={perfect ? "trophy" : "check"} /></div>
        <span class="ring-burst" />
        {sparks.map((s, i) => <span key={i} class="spark p-abs r-xs" style={{ "--x": s.x, "--y": s.y, "--r": s.r, "--c": s.c }} />)}
      </div>
      <h3 class="h-title" style="margin-top:28px">{perfect ? "Раунд пройден." : "Раунд завершён."}</h3>
      <p class="muted" style="margin:8px auto 0;max-width:28ch">{subject}: {win.score} из {win.total}{win.fixed ? ` · исправлено ${win.fixed}` : ""}. {perfect ? "Это результат раунда, а не оценка освоения всей темы." : "Повтори слабые места перед уроком."}</p>
      {win.points !== null && win.points > 0 && <div class="points-pop f-h f-a mt-4 num">+{win.points} очков</div>}
      {win.level && <p class="faint" style="font-size:calc(13px*var(--fs,1))">Уровень: {win.level}</p>}
      <div class="stack" style="margin-top:28px;text-align:left">
        <button class="btn btn-primary btn-block" onClick={onClose} data-autofocus>Дальше по плану</button>
        <div class="actions l-c2">
          <button class="btn btn-secondary" onClick={onShare}><Icon name="share" />Поделиться</button>
          <button class="btn btn-secondary" onClick={onAgain}>Ещё раз</button>
        </div>
      </div>
    </div>
  );
}

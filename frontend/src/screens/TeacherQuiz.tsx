/**
 * v2 · Блиц-опросы учителя: конструктор (вручную, черновик ИИ по отдельной учительской политике или v2.2 —
 * встроенный банк задач без ИИ),
 * статистика участия и результатов, ручной ввод результата для учеников без приложения, текст для печати.
 * Ключи ответов живут только у учителя; ученик получает вопросы без ключей и видит разбор после сдачи.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { api, ApiError } from "../lib/api";
import { createOnce } from "../lib/assignmentSync";
import { KIND_LABEL, QUIZ_MAX, blankQuestion, maxScore, quizText } from "../lib/quizForm";
import type { HwIssueRow, HwTemplate, ManualHow, QuizBankTopics, QuizDraft, QuizDraftRequest, QuizKind, QuizQuestionDraft, QuizStats, TeacherQuiz } from "../lib/hwTypes";
import { plural } from "../lib/time";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/Toast";

const once = createOnce();
const fp = (...xs: unknown[]) => JSON.stringify(xs);
const LETTERS = "АБВГДЕ";
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error) && e.message ? e.message : "Не получилось";

/* ------------------------------------------------------------------ конструктор */
function QuestionEditor({ q, n, errs, onChange, onRemove, onMove, total }: {
  q: QuizQuestionDraft; n: number; total: number; errs: Record<string, string>;
  onChange: (q: QuizQuestionDraft) => void; onRemove: () => void; onMove: (d: -1 | 1) => void;
}) {
  const k = `q${n}`;
  const set = (p: Partial<QuizQuestionDraft>) => onChange({ ...q, ...p });
  const kind = (v: QuizKind) => set(v === "short" ? { kind: v, options: [], correct: [], answers: q.answers.length ? q.answers : [""] }
    : { kind: v, options: q.options.length >= 2 ? q.options : ["", ""], answers: [], correct: v === "single" ? q.correct.slice(0, 1) : q.correct });
  const toggle = (i: number) => set({ correct: q.kind === "single" ? [i] : q.correct.includes(i) ? q.correct.filter((c) => c !== i) : [...q.correct, i] });
  const dropOption = (i: number) => set({ options: q.options.filter((_, j) => j !== i), correct: q.correct.filter((c) => c !== i).map((c) => (c > i ? c - 1 : c)) });
  return <fieldset class="qz-q l-v l-g3 b-card" aria-labelledby={`${k}-legend`}>
    <legend id={`${k}-legend`}><span class="qz-num l-center l-g0 f-b f-w6 l-fix r-sm u-sel num">{n}</span>Вопрос {n}</legend>
    <div class="seg-mini qz-kind" role="radiogroup" aria-label={`Тип вопроса ${n}`}>
      {(["single", "multi", "short"] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={q.kind === v} onClick={() => kind(v)}>{KIND_LABEL[v]}</button>)}
    </div>
    <label class="field"><span class="field-label">Текст вопроса</span>
      <textarea class="textarea" rows={2} maxLength={500} value={q.text} aria-invalid={!!errs[`${k}.text`]} onInput={(e) => set({ text: (e.currentTarget as HTMLTextAreaElement).value })} />
      {errs[`${k}.text`] && <span class="field-err">{errs[`${k}.text`]}</span>}</label>
    {q.kind === "short" ? <label class="field"><span class="field-label">Верные ответы <small class="faint">— через «;», регистр и «ё/е» не важны, 0,5 = 0.5</small></span>
        <input class="input" maxLength={300} value={q.answers.join("; ")} aria-invalid={!!errs[`${k}.answers`]} placeholder="Например: 0,6; 0.6"
          onInput={(e) => set({ answers: (e.currentTarget as HTMLInputElement).value.split(";").map((a) => a.trimStart()).slice(0, 5) })} />
        {errs[`${k}.answers`] && <span class="field-err">{errs[`${k}.answers`]}</span>}</label>
      : <div class="qz-options l-v" role="group" aria-label={`Варианты ответа к вопросу ${n}`}>
        {q.options.map((o, i) => <div class="qz-option l-a1a l-mid" key={i}>
          <label class={`qz-correct l-center l-g0 f-w6 f-2 b-box l-rel s-44${q.correct.includes(i) ? " is-on" : ""}`} title="Верный ответ">
            <input type={q.kind === "single" ? "radio" : "checkbox"} name={`${k}-correct`} checked={q.correct.includes(i)} onChange={() => toggle(i)} aria-label={`Вариант ${LETTERS[i]} — верный`} />
            <span aria-hidden="true">{q.correct.includes(i) ? "✓" : LETTERS[i]}</span>
          </label>
          <input class="input" maxLength={200} value={o} placeholder={`Вариант ${LETTERS[i]}`} aria-label={`Вариант ${LETTERS[i]}`}
            onInput={(e) => { const opts = [...q.options]; opts[i] = (e.currentTarget as HTMLInputElement).value; set({ options: opts }); }} />
          {q.options.length > 2 && <button type="button" class="icon-btn qz-del s-44" aria-label={`Удалить вариант ${LETTERS[i]}`} onClick={() => dropOption(i)}><Icon name="x" /></button>}
        </div>)}
        {q.options.length < 6 && <button type="button" class="btn btn-ghost btn-sm" onClick={() => set({ options: [...q.options, ""] })}><Icon name="plus" />Вариант</button>}
        {(errs[`${k}.options`] || errs[`${k}.correct`]) && <span class="field-err">{errs[`${k}.options`] ?? errs[`${k}.correct`]}</span>}
        <p class="hint-text qz-legend"><span aria-hidden="true">✓</span> — верный ответ{q.kind === "multi" ? "; ученик должен отметить все верные" : ""}.</p>
      </div>}
    <div class="hw-two l-c2 l-g3">
      <label class="field"><span class="field-label">Баллы</span>
        <select class="input" value={q.points} onChange={(e) => set({ points: Number((e.currentTarget as HTMLSelectElement).value) })}>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      <label class="field"><span class="field-label">Пояснение</span>
        <input class="input" maxLength={500} value={q.explain} placeholder="Покажем после сдачи" onInput={(e) => set({ explain: (e.currentTarget as HTMLInputElement).value })} /></label>
    </div>
    <div class="hw-row-actions l-h l-wrap qz-q-actions">
      {n > 1 && <button type="button" class="btn btn-ghost btn-sm" aria-label={`Поднять вопрос ${n}`} onClick={() => onMove(-1)}><Icon name="up" />Выше</button>}
      {n < total && <button type="button" class="btn btn-ghost btn-sm" aria-label={`Опустить вопрос ${n}`} onClick={() => onMove(1)}><Icon name="down" />Ниже</button>}
      {total > 1 && <button type="button" class="btn btn-ghost btn-sm" aria-label={`Удалить вопрос ${n}`} onClick={onRemove}><Icon name="trash" />Удалить</button>}
    </div>
  </fieldset>;
}

export function QuizBuilder({ quiz, setQuiz, errs, cls, subject, aiAvailable, edited = true }: {
  quiz: QuizDraft; setQuiz: (q: QuizDraft, edited?: boolean) => void; errs: Record<string, string>;
  cls: string; subject: string; aiAvailable: boolean; edited?: boolean;
}) {
  const put = (i: number, q: QuizQuestionDraft) => setQuiz({ ...quiz, questions: quiz.questions.map((x, j) => (j === i ? q : x)) }, true);
  const move = (i: number, d: -1 | 1) => { const qs = [...quiz.questions]; const j = i + d; [qs[i], qs[j]] = [qs[j], qs[i]]; setQuiz({ ...quiz, questions: qs }, true); };
  return <div class="qz-builder l-v l-g3">
    <DraftPanel cls={cls} subject={subject} available={aiAvailable} topic={quiz.topic} onDraft={(d) => setQuiz({ ...d, reviewed: false }, false)}
      dirty={edited && quiz.questions.some((q) => q.text.trim())} />
    <div class="hw-two l-c2 l-g3">
      <label class="field"><span class="field-label">Тема <small class="faint">— для статистики</small></span>
        <input class="input" maxLength={120} value={quiz.topic} placeholder="Например: квадратные корни" onInput={(e) => setQuiz({ ...quiz, topic: (e.currentTarget as HTMLInputElement).value }, true)} /></label>
      <label class="field"><span class="field-label">Время на опрос</span>
        <select class="input" value={quiz.time_limit_min ?? 0} aria-invalid={!!errs.time} onChange={(e) => { const v = Number((e.currentTarget as HTMLSelectElement).value); setQuiz({ ...quiz, time_limit_min: v || null }, true); }}>
          <option value={0}>Без ограничения</option>{[3, 5, 7, 10, 15, 20, 30, 45].map((m) => <option key={m} value={m}>{m} мин</option>)}
        </select>{errs.time && <span class="field-err">{errs.time}</span>}</label>
    </div>
    <label class="hw-check l-h f-b b-tap qz-show b-tile"><input type="checkbox" checked={quiz.show_answers} onChange={(e) => setQuiz({ ...quiz, show_answers: (e.currentTarget as HTMLInputElement).checked }, true)} />
      <span>Показать ученику верные ответы и пояснения сразу после сдачи</span></label>
    {quiz.origin !== "manual" && <label class="hw-check l-h f-b b-tap qz-review b-tile" data-testid="ai-review">
      <input type="checkbox" checked={quiz.reviewed === true} aria-invalid={!!errs.review} aria-describedby={errs.review ? "qz-review-err" : undefined}
        onChange={(e) => setQuiz({ ...quiz, reviewed: (e.currentTarget as HTMLInputElement).checked })} />
      <span><b>Я проверил(а) каждый вопрос и верные ответы</b> — {REVIEW_TEXT[quiz.origin] ?? REVIEW_TEXT.ai}</span></label>}
    {errs.review && <p class="field-err" id="qz-review-err" role="alert">{errs.review}</p>}
    {quiz.questions.map((q, i) => <QuestionEditor key={i} q={q} n={i + 1} total={quiz.questions.length} errs={errs} onChange={(x) => put(i, x)}
      onRemove={() => setQuiz({ ...quiz, questions: quiz.questions.filter((_, j) => j !== i) }, true)} onMove={(d) => move(i, d)} />)}
    {errs.quiz && <p class="field-err" role="alert">{errs.quiz}</p>}
    <div class="qz-foot l-h l-btw l-wrap">
      <span class="faint num">{quiz.questions.length} {plural(quiz.questions.length, "вопрос", "вопроса", "вопросов")} · {maxScore(quiz)} {plural(maxScore(quiz), "балл", "балла", "баллов")}</span>
      {quiz.questions.length < QUIZ_MAX && <button type="button" class="btn btn-secondary btn-sm" onClick={() => setQuiz({ ...quiz, questions: [...quiz.questions, blankQuestion(quiz.questions[quiz.questions.length - 1]?.kind ?? "single")] }, true)}><Icon name="plus" />Добавить вопрос</button>}
    </div>
  </div>;
}

type Difficulty = "easy" | "normal" | "hard";
type Source = "ai" | "bank";
const REVIEW_TEXT: Record<string, string> = { ai: "черновик ИИ без этой отметки не выдаётся", ai_edited: "черновик ИИ без этой отметки не выдаётся", bank: "черновик из банка без этой отметки не выдаётся" };

/** v2.2 · Черновик опроса: ИИ (если ключ есть на сервере) или встроенный банк задач — шаблоны с числами, ответы
 *  считает сервер, работает без ИИ и без сети. Оба пути дают только черновик: учитель проверяет и выдаёт сам. */
function DraftPanel({ cls, subject, available, topic, onDraft, dirty }: { cls: string; subject: string; available: boolean; topic: string; onDraft: (d: QuizDraft) => void; dirty: boolean }) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState(topic);
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<Source | "">("");
  const [msg, setMsg] = useState<{ text: string; kind: "info" | "warn" } | null>(null);
  const [ask, setAsk] = useState<{ source: Source; variant: number } | null>(null);
  const [bank, setBank] = useState<QuizBankTopics | null>(null);
  const [last, setLast] = useState<{ key: string; variant: number } | null>(null);
  useEffect(() => {
    if (!open || !subject) return;
    let live = true;
    api.hw.quizBank(subject).then((r) => { if (live) setBank(r); }).catch(() => { if (live) setBank({ subject, supported: false, topics: [] }); });
    return () => { live = false; };
  }, [open, subject]);
  const bankKey = `${subject}|${t.trim().toLowerCase()}|${count}|${difficulty}`;
  const go = async (source: Source, variant = 0, sure = false) => {
    if (busy) return;
    if (t.trim().length < 2) { setMsg({ text: "Напишите тему опроса или выберите тему банка", kind: "warn" }); return; }
    if (dirty && !sure) { setAsk({ source, variant }); return; }
    setAsk(null); setBusy(source); setMsg(null);
    const body: QuizDraftRequest = source === "ai"
      ? { class: cls, subject, topic: t.trim(), count, difficulty, notes: notes.trim() }
      : { class: cls, subject, topic: t.trim(), count, difficulty, notes: "", source: "bank", variant };
    try {
      const r = await once.run(fp("draft", body, Date.now() >> 16), (op) => api.hw.quizDraft(body, op));
      onDraft(r.draft);
      setLast(source === "bank" ? { key: bankKey, variant } : null);
      setMsg({ text: `${r.notice}${r.dropped ? ` Отброшено вопросов, не прошедших проверку: ${r.dropped}.` : ""}`, kind: "info" });
    } catch (e) {
      setMsg({ text: source === "ai" && e instanceof ApiError && e.status === 503 ? "ИИ сейчас недоступен на сервере. Соберите опрос из встроенного банка или вручную — всё остальное работает." : errText(e), kind: "warn" });
    } finally { setBusy(""); }
  };
  const bankOk = bank?.supported !== false;
  const nextVariant = last && last.key === bankKey ? last.variant + 1 : 0;
  return <details class="qz-ai b-box" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
    <summary><Icon name={available ? "bot" : "book"} /><span><b>{available ? "Черновик с ИИ или из банка" : "Черновик из встроенного банка"}</b>
      <small>{available ? "Учитель проверяет каждый вопрос перед выдачей" : "ИИ на сервере не подключён — банк задач работает без него"}</small></span><Icon name="chevron" /></summary>
    <div class="qz-ai-body l-v l-g3" aria-busy={!!busy}>
      <label class="field"><span class="field-label">Тема</span><input class="input" maxLength={200} value={t} onInput={(e) => setT((e.currentTarget as HTMLInputElement).value)} placeholder="Например: квадратные уравнения" /></label>
      {bank && bank.supported && <span class="qz-bank-cap f-c f-3" id="qz-bank-cap">Темы банка · <span class="num">{bank.topics.length}</span></span>}
      {bank && bank.supported && <div class="qz-bank-topics l-h l-wrap" role="group" aria-labelledby="qz-bank-cap">
        {bank.topics.map((x) => <button key={x.key} type="button" class={`chip qz-bank-chip px-3 f-b f-nw b-tap l-fix${t.trim().toLowerCase() === x.title.toLowerCase() ? " on" : ""}`} aria-pressed={t.trim().toLowerCase() === x.title.toLowerCase()} onClick={() => setT(x.title)}>{x.title}</button>)}
      </div>}
      <div class="hw-two l-c2 l-g3">
        <label class="field"><span class="field-label">Вопросов</span><select class="input" value={count} onChange={(e) => setCount(Number((e.currentTarget as HTMLSelectElement).value))}>{[3, 5, 7, 10].map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label class="field"><span class="field-label">Сложность</span><select class="input" value={difficulty} onChange={(e) => setDifficulty((e.currentTarget as HTMLSelectElement).value as Difficulty)}>
          <option value="easy">Базовая</option><option value="normal">Средняя</option><option value="hard">Повышенная</option></select></label>
      </div>
      {available && <label class="field"><span class="field-label">Пожелания для ИИ <small class="faint">— необязательно, без персональных данных учеников</small></span>
        <textarea class="textarea" rows={2} maxLength={1500} value={notes} onInput={(e) => setNotes((e.currentTarget as HTMLTextAreaElement).value)} placeholder="Например: без вычислений с дробями, один вопрос на ошибку знака" /></label>}
      {ask ? <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label="Заменить вопросы"><p class="f-2">Текущие вопросы будут заменены {ask.source === "ai" ? "черновиком ИИ" : "вопросами из банка"}.</p><div class="hw-row-actions l-h l-wrap">
          <button type="button" class="btn btn-secondary btn-sm" onClick={() => void go(ask.source, ask.variant, true)}>Заменить</button><button type="button" class="btn btn-ghost btn-sm" onClick={() => setAsk(null)}>Отмена</button></div></div>
        : <div class="qz-draft-actions l-v">
          {available && <button type="button" class="btn btn-secondary btn-block" disabled={!!busy} onClick={() => void go("ai")}><Icon name="bot" />{busy === "ai" ? "Генерируем черновик…" : "Сгенерировать черновик"}</button>}
          {bankOk && <button type="button" class={`btn ${available ? "btn-ghost" : "btn-secondary"} btn-block`} disabled={!!busy} onClick={() => void go("bank", nextVariant)}>
            <Icon name={nextVariant ? "refresh" : "book"} />{busy === "bank" ? "Собираем…" : nextVariant ? `Другой вариант · ${nextVariant + 1}` : available ? "Из встроенного банка (без ИИ)" : "Собрать из банка"}</button>}
        </div>}
      {!bankOk && <p class="hint-text">Для предмета «{subject}» во встроенном банке пока нет тем.{available ? "" : " Ключ ИИ на сервере не задан, поэтому генерация выключена честно, без имитации."} Вопросы можно составить вручную ниже.</p>}
    </div>
    {msg && <p class={`note ${msg.kind === "warn" ? "warn" : ""} qz-ai-msg mb-3`} role="status"><Icon name={msg.kind === "warn" ? "alert" : "info"} /><span>{msg.text}</span></p>}
  </details>;
}

/* ------------------------------------------------------------------ статистика */
const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);
function Funnel({ s }: { s: QuizStats }) {
  const steps: [string, number, number, string][] = [
    ["Получили", s.received, s.received, "users"], ["С приложением", s.with_app, s.received, "user"], ["Открыли", s.seen, s.with_app, "check"],
    ["Начали", s.started, s.with_app, "play"], ["Сдали в приложении", s.submitted, s.with_app, "trophy"], ["Внесено учителем", s.manual, s.received, "book"],
  ];
  return <ol class="qz-funnel l-v" aria-label="Участие в опросе">{steps.map(([label, n, of, icon]) => <li key={label}>
    <span class="qz-funnel-label l-h l-g1 f-2"><Icon name={icon} />{label}</span>
    <span class="qz-funnel-bar l-blk o-h r-pill u-line" aria-hidden="true"><i style={{ width: `${pct(n, of)}%` }} /></span>
    <b class="num">{n}<small>/{of}</small></b>
  </li>)}</ol>;
}

export function QuizStatsPanel({ d }: { d: TeacherQuiz }) {
  const templateId = d.template_id;
  const s = d.stats;
  if (!s) return null;
  const buckets = Object.entries(s.buckets);
  const top = Math.max(1, ...buckets.map(([, n]) => n));
  return <section class="qz-stats l-v l-g3" aria-labelledby={`qz-st-${templateId}`}>
    <h3 class="hw-h3 f-b f-w6 mt-4 mb-2" id={`qz-st-${templateId}`}>Результаты блиц-опроса</h3>
    <dl class="qz-kpi l-c2">
      <div><dt>Средний результат</dt><dd class="num f-w6">{s.avg_pct === null ? "—" : `${s.avg_pct}%`}</dd></div>
      <div><dt>Результатов</dt><dd class="num f-w6">{s.results}<small>/{s.received}</small></dd></div>
      <div><dt>В процессе</dt><dd class="num f-w6">{s.in_progress}</dd></div>
      <div><dt>Не начали</dt><dd class="num f-w6">{s.not_started}</dd></div>
    </dl>
    <Funnel s={s} />
    {(s.late > 0 || s.overtime > 0 || s.older_version > 0) && <p class="hint-text">
      {s.late > 0 && `После срока: ${s.late}. `}{s.overtime > 0 && `Дольше лимита времени: ${s.overtime}. `}{s.older_version > 0 && `Сдано по прежней версии вопросов: ${s.older_version} (не входят в разбор по вопросам).`}
    </p>}
    {s.insufficient
      ? <p class="note qz-insufficient"><Icon name="info" /><span>Пока результатов меньше трёх — распределение и разбор по вопросам появятся, когда сдадут больше учеников. Цифры выше — только факты с сервера.</span></p>
      : <>
        <h4 class="qz-h4 f-b f-w6 mt-1">Распределение результатов</h4>
        <ul class="qz-buckets l-v">{buckets.map(([b, n]) => <li key={b}><span class="num">{b}%</span><span class="qz-bucket-bar l-blk o-h r-pill u-line" aria-hidden="true"><i style={{ width: `${pct(n, top)}%` }} /></span><b class="num">{n} {plural(n, "ученик", "ученика", "учеников")}</b></li>)}</ul>
        <h4 class="qz-h4 f-b f-w6 mt-1">По вопросам</h4>
        <ol class="qz-perq l-v">{s.questions.map((q, i) => <li key={q.id} class={q.correct_pct !== null && q.correct_pct < 50 ? "is-hard" : ""}>
          <p class="qz-perq-text f-b"><b class="num">{i + 1}.</b> {q.text}</p>
          <p class="qz-perq-score l-h l-wrap l-g1 f-b f-2">{q.correct_pct === null ? "Нет ответов" : <><b class="num">{q.correct_pct}%</b> верно · {q.correct} из {q.answered}{q.correct_pct < 50 && <span class="qz-flag l-h l-inl l-g1 f-m f-w6 f-warn b-pill u-warn"><Icon name="alert" />стоит разобрать на уроке</span>}</>}</p>
          {q.options.length > 0 && <ul class="qz-opts l-v l-g1">{q.options.map((o, j) => <li key={j} class={o.is_correct ? "is-correct" : ""}>
            <span class="qz-opt-mark l-center l-g0 f-m f-w6 b-box" aria-hidden="true">{o.is_correct ? "✓" : LETTERS[j]}</span><span class="qz-opt-text">{o.text}{o.is_correct && <span class="sr"> (верный)</span>}</span><b class="num">{o.picked}</b>
          </li>)}</ul>}
          {q.top_wrong.length > 0 && <p class="hint-text">Частые неверные ответы: {q.top_wrong.map(([t, n]) => `«${t}» × ${n}`).join(", ")}</p>}
        </li>)}</ol>
      </>}
  </section>;
}

/* ------------------------------------------------------------------ ручной результат */
export function ManualEntry({ row, quizMax, onSaved, onCancel }: { row: HwIssueRow; quizMax: number | null; onSaved: () => void; onCancel: () => void }) {
  const [score, setScore] = useState(row.manual?.score != null ? String(row.manual.score) : "");
  const [max, setMax] = useState(row.manual?.max_score != null ? String(row.manual.max_score) : quizMax ? String(quizMax) : "");
  const [note, setNote] = useState(row.manual?.note ?? "");
  const [how, setHow] = useState<ManualHow | null>(row.manual?.how ?? null);   // v2.2 · как сдано (необязательно при баллах)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    const sc = score.trim() === "" ? null : Number(score), mx = quizMax ?? (max.trim() === "" ? null : Number(max));
    if (quizMax !== null && sc === null && !how) { setErr("Укажите баллы или отметьте, как сдано: устно или на листочке"); return; }
    if (quizMax === null && (sc === null) !== (mx === null)) { setErr("Укажите и баллы, и максимум — или оставьте оба пустыми"); return; }
    if (sc !== null && (!Number.isInteger(sc) || !Number.isInteger(mx) || (mx as number) < 1 || sc < 0 || sc > (mx as number))) { setErr(`Баллы — целое число от 0 до ${mx ?? "максимума"}`); return; }
    setBusy(true); setErr("");
    const body = { score: sc, max_score: sc === null ? null : mx, note: note.trim(), how };
    try { await once.run(fp("manual", row.issue_id, body.score, body.max_score, body.note, how), (op) => api.hw.manual(row.issue_id, body, op)); toast(`Результат внесён: ${row.display_name}`, "ok"); onSaved(); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  };
  return <form class="hw-confirm l-v l-w100 u-warn r-lg p-3 qz-manual" onSubmit={(e) => void save(e)} noValidate aria-label={`Результат ${row.display_name}`}>
    <p class="f-2">Результат работы на бумаге или без устройства. Ученик не сможет его изменить; запись видна в истории.</p>
    <div class="seg-mini qz-how mb-1" role="radiogroup" aria-label="Как сдано">
      {([["oral", "Устно"], ["paper", "На листочке"], [null, "Не указывать"]] as [ManualHow | null, string][]).map(([v, label]) =>
        <button key={label} type="button" role="radio" aria-checked={how === v} onClick={() => { setHow(v); setErr(""); }}>{label}</button>)}
    </div>
    <div class="hw-two l-c2 l-g3">
      <label class="field"><span class="field-label">Баллы</span><input ref={ref} class="input num" inputMode="numeric" value={score} onInput={(e) => setScore((e.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 3))} /></label>
      <label class="field"><span class="field-label">Из</span><input class="input num" inputMode="numeric" value={quizMax ?? max} disabled={quizMax !== null} onInput={(e) => setMax((e.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 3))} /></label>
    </div>
    <label class="field"><span class="field-label">Заметка <small class="faint">— необязательно</small></span><input class="input" maxLength={300} value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} /></label>
    {err && <p class="field-err" role="alert">{err}</p>}
    <div class="hw-row-actions l-h l-wrap"><button type="submit" class="btn btn-secondary btn-sm" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить результат"}</button><button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Отмена</button></div>
  </form>;
}

/* ------------------------------------------------------------------ копия и печать */
export function PaperCopy({ t, quiz }: { t: HwTemplate; quiz: TeacherQuiz["quiz"] | null }) {
  const [printing, setPrinting] = useState<string | null>(null);
  const copy = (keys: boolean) => {
    const text = quizText(t, quiz, keys);
    if (!navigator.clipboard) { toast("Буфер обмена недоступен — используйте печать", "info"); return; }
    navigator.clipboard.writeText(text).then(() => toast(keys ? "Скопировано с ключами ответов" : "Текст для учеников скопирован", "ok"), () => toast("Скопировать не удалось", "warn"));
  };
  useEffect(() => {
    if (printing === null) return;
    const done = () => setPrinting(null);
    addEventListener("afterprint", done);
    const t = setTimeout(() => { try { print(); } catch { toast("Печать недоступна в этом приложении — скопируйте текст", "info"); done(); } }, 50);
    return () => { clearTimeout(t); removeEventListener("afterprint", done); };
  }, [printing]);
  return <div class="qz-paper l-v">
    <p class="hint-text">Для учеников без приложения: распечатайте или перешлите текст, результат внесите вручную в строке ученика.</p>
    <div class="hw-row-actions l-h l-wrap">
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => copy(false)}><Icon name="share" />Скопировать для учеников</button>
      {quiz && <button type="button" class="btn btn-ghost btn-sm" onClick={() => copy(true)}><Icon name="lock" />С ключами (для учителя)</button>}
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => setPrinting(quizText(t, quiz, false))}><Icon name="book" />Печать</button>
    </div>
    {/* Печать: отдельный блок прямо в <body>, всё остальное скрывает @media print (design-system-core.css, секция v2.css). */}
    {printing !== null && createPortal(<pre class="print-only" aria-hidden="true">{printing}</pre>, document.body)}
  </div>;
}

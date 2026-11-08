import { useEffect, useRef, useState } from "preact/hooks";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { api, ApiError, fileToBase64 } from "../lib/api";
import { haptic } from "../lib/host";
import type { Task } from "../lib/types";
import { reviewParts, reviewValid } from "../lib/taskReview";
import { VoiceButton } from "../ui/VoiceButton";
const EXAMPLES = ["История: §8, пересказ", "Геометрия №512, 514", "Английский: выучить слова, стр. 34"];
export function AddTask({ open, onClose, onAdded, aiOnline, prefill, intent }: {
    /** v3.2 · «Внести ДЗ по фото» из «Учёбы»: фокус сразу на кнопке фото. */
    intent?: "text" | "photo";
    open: boolean;
    onClose: () => void;
    onAdded: (t: Task[]) => void;
    aiOnline: boolean | null;
    prefill?: string | null;
}) {
    const [text, setText] = useState("");
    useEffect(() => { if (open && prefill)
        setText(prefill); }, [open, prefill]);
    const [busy, setBusy] = useState<"text" | "photo" | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [review, setReview] = useState<Task[] | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const generation = useRef(0);
    const confirmed = useRef(false);
    const [photo, setPhoto] = useState<{base64:string;mime:string;name:string} | null>(null);
    const flight = useRef<number | null>(null);
    const photoBtn = useRef<HTMLButtonElement>(null);
    useEffect(() => { if (open && intent === "photo") { const t = setTimeout(() => photoBtn.current?.focus(), 260); return () => clearTimeout(t); } }, [open, intent]);
    const abort = useRef<AbortController | null>(null);
    useEffect(() => () => { generation.current++; abort.current?.abort(); }, []);
    useEffect(() => { generation.current++; if (open) confirmed.current = false; if (!open) {
        abort.current?.abort();
        flight.current = null;
        setBusy(null);
        setReview(null);
    } }, [open]);
    const close = () => { generation.current++; abort.current?.abort(); flight.current = null; setBusy(null); onClose(); };
    const confirm = () => {
        if (confirmed.current || !review?.length || review.some(t => !reviewValid(t)))
            return;
        confirmed.current = true;
        try {
            onAdded(review.map(t => ({ ...t, title: t.title.trim(), source: "manual", id: t.id ?? `manual:${crypto.randomUUID()}` })));
            haptic.notify("success");
            setText("");
            setPhoto(null);
            setErr(null);
            setReview(null);
            close();
        } catch {
            confirmed.current = false;
            haptic.notify("error");
            setErr("Не удалось сохранить задание на устройстве. Освободи место и нажми «Добавить» ещё раз — текст и правки остались здесь.");
        }
    };
    const edit = (index: number, patch: Partial<Task>) => setReview(items => items?.map((t, i) => i === index ? { ...t, ...patch } : t) ?? null);
    const fileRef = useRef<HTMLInputElement>(null);
    const done = (tasks: Task[], notice?: string | null) => {
        if (!tasks.length) {
            setErr(notice || "Не нашли заданий — уточни предмет и номера.");
            return;
        }
        setNotice(notice ?? null);
        setReview(tasks);
        setErr(null);
    };
    const fail = (e: unknown) => { haptic.notify("error"); setErr(e instanceof ApiError ? e.message : "Не получилось разобрать"); };
    const submit = async (e?: Event, override?: string) => {
        e?.preventDefault();
        const value = (override ?? text).trim();
        if ((!value && !photo) || busy || flight.current !== null)
            return;
        setBusy(photo ? "photo" : "text");
        setErr(null);
        const ticket = generation.current;
        flight.current = ticket;
        abort.current = new AbortController();
        try {
            const r = photo ? await api.parsePhoto(photo.base64, photo.mime, value, abort.current.signal) : await api.parseText(value);
            if (ticket === generation.current)
                done(r.tasks, r.notice);
        }
        catch (x) {
            if (ticket === generation.current)
                fail(x);
        }
        finally {
            if (flight.current === ticket) flight.current = null;
            if (ticket === generation.current) setBusy(null);
        }
    };
    /** F9 · «Вставить из чата класса»: одно нажатие — текст из буфера обмена сразу разбирается на карточки по предметам. */
    const textRef = useRef<HTMLTextAreaElement>(null);
    const [pasteNote, setPasteNote] = useState<string | null>(null);
    const pasteFromChat = async () => {
        if (busy || flight.current !== null) return;
        setPasteNote(null);
        let clip = "";
        try { clip = (await navigator.clipboard?.readText?.()) ?? ""; } catch { clip = ""; }
        if (!clip.trim()) {
            setPasteNote("Буфер обмена недоступен в этом приложении. Зажми поле ниже и выбери «Вставить», затем «Разобрать».");
            textRef.current?.focus();
            return;
        }
        const value = clip.slice(0, 1000);
        setText(value);
        void submit(undefined, value);
    };
    const onPhoto = async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        (e.target as HTMLInputElement).value = "";
        if (!f || busy || flight.current !== null) return;
        const ticket = ++generation.current;
        try {
            const img = await fileToBase64(f);
            if (ticket === generation.current) { setPhoto({...img, name:f.name}); setErr(null); }
        } catch (x) { if (ticket === generation.current) fail(x); }
    };
    return (<Sheet open={open} onClose={close} eyebrow="Новое задание" title={review ? "Проверь перед добавлением" : "Что задали?"} footer={review ? <button class="btn btn-primary btn-block" onClick={confirm} disabled={!review.length || review.some(t => !reviewValid(t))}>Добавить · {review.length}</button> : <button class={`btn btn-primary btn-block${busy === "text" ? " is-loading" : ""}`} onClick={submit} disabled={(!text.trim() && !photo) || !!busy || aiOnline === false && !!photo}>{photo ? "Распознать задание" : "Разобрать и оценить время"}</button>}>
      <ol class="capture-steps l-c3 f-c f-3 mb-6" aria-label="Добавление задания"><li aria-current={!busy && !review ? "step" : undefined}>1 · Ввод</li><li aria-current={busy ? "step" : undefined}>2 · Разбор</li><li aria-current={review ? "step" : undefined}>3 · Проверка</li></ol>
      {busy && <div class="capture-pending f-tc b-card mb-4" role="status"><span class="sk"/><b>{busy === "photo" ? "Распознаём фото" : "Разбираем задание"}</b><p class="f-2">Обработка на сервере. Затем проверь результат перед добавлением.</p></div>}
      {err && <div class="note bad" role="alert" style="margin-top:16px"><Icon name="alert"/><div>{err}</div></div>}
      {review ? <div class="add-review" aria-live="polite">
        <p class="muted">Задания ещё не добавлены. Проверь текст, тип и время — распознавание может ошибаться.</p>
        {notice && <p class="note warn" role="status"><Icon name="info"/><span>{notice}</span></p>}
        {review.map((task, index) => <div class="add-review-item b-card mt-4 mb-4" key={index}>
          <div class="review-step l-h mb-4"><span>{String(index + 1).padStart(2, "0")}</span><b>Проверь распознанное задание</b></div>
          <label class="field"><span class="field-label">Предмет {index + 1}</span><input class="input" maxLength={70} value={reviewParts(task.title).subject} onInput={e => edit(index, { title: `${e.currentTarget.value}: ${reviewParts(task.title).detail || ""}`.trim() })}/></label>
          <label class="field"><span class="field-label">Задание {index + 1}</span><textarea class="textarea" maxLength={220} value={reviewParts(task.title).detail || ""} onInput={e => edit(index, { title: `${reviewParts(task.title).subject}: ${e.currentTarget.value}`.trim() })}/></label>
          <div class="add-review-meta l-c2 l-g3"><label class="field"><span class="field-label">Минуты</span><input class="input" type="number" min={1} max={600} value={task.planned_minutes} onInput={e => edit(index, { planned_minutes: Number(e.currentTarget.value) })}/></label>
          <label class="field"><span class="field-label">Тип</span><select class="input" value={task.type} onChange={e => edit(index, { type: e.currentTarget.value as Task["type"] })}><option value="written">Письменное</option><option value="oral">Устное</option></select></label></div>
          <button class="btn btn-ghost" onClick={() => setReview(items => items?.filter((_, i) => i !== index) ?? null)}>Убрать задание {index + 1}</button>
        </div>)}
        <button class="btn btn-secondary" onClick={() => setReview(null)}>Вернуться к вводу</button>
      </div> : <>

      {photo && <section class="photo-review b-card mb-4" aria-label="Выбранное фото"><img src={`data:${photo.mime};base64,${photo.base64}`} alt="Выбранная фотография задания"/><p>Фото выбрано, но ещё не отправлено. Пояснение ниже отправится вместе с ним.</p><button type="button" class="btn btn-secondary" disabled={!!busy} onClick={() => setPhoto(null)}>Убрать фото</button></section>}
      <div class="capture-heading l-h l-g0"><div><b>Новое задание</b><p class="f-2">Напиши условие или выбери источник ниже.</p></div></div><form class="capture-text b-card" onSubmit={submit}>
        {!photo && <button type="button" class="btn btn-secondary btn-block capture-paste b-tap mb-3" onClick={() => void pasteFromChat()} disabled={!!busy}>
          <Icon name="chat"/><span>Вставить из чата класса<small>«на завтра по алгебре №355, по истории §8» → задания по предметам</small></span></button>}
        {pasteNote && <p class="note warn" role="status"><Icon name="info"/><span>{pasteNote}</span></p>}
        <label class="field">
          <span class="field-label">{photo ? "Пояснение к фото (необязательно)" : "Как в дневнике или своими словами"}</span>
          <textarea ref={textRef} class="textarea" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} maxLength={1000} placeholder="Алгебра: №387, 388" aria-invalid={!!err} aria-describedby="add-hint" data-autofocus/>
        </label>
        <div id="add-hint" class="hint-text">Если класс известен, используем нормативы; иначе — приблизительную оценку. Перед добавлением можно всё проверить.</div>
        <div class="examples l-h l-wrap mt-2">{EXAMPLES.map((x) => <button type="button" key={x} class="example f-m f-2 b-tile b-tap" onClick={() => setText(x)}>{x}</button>)}</div>
      </form>

      <div class="capture-divider l-h l-jc f-c f-3 mt-4 mb-3"><span>ИЛИ ДОБАВЬ ИЗ ИСТОЧНИКА</span></div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto}/>
      <button ref={photoBtn} data-capture="photo" class={`btn btn-secondary btn-block${busy === "photo" ? " is-loading" : ""}`} onClick={() => fileRef.current?.click()} disabled={!!busy || aiOnline === false}>
        <Icon name="camera"/>Сфотографировать доску
      </button>
      {aiOnline !== false && (<div style="margin-top:8px;display:grid">
          <VoiceButton label="Надиктовать задание" disabled={!!busy} onAudio={async (a) => {
                    setErr(null);
                    setBusy("text");
                    const ticket = generation.current;
                    try {
                        const r = await api.parseAudio(a.base64, a.mime);
                        if (ticket === generation.current)
                            done(r.tasks);
                    }
                    catch (x) {
                        if (ticket === generation.current)
                            fail(x);
                    }
                    finally {
                        if (ticket === generation.current)
                            setBusy(null);
                    }
                }}/>
        </div>)}
      {aiOnline === false && <p class="hint-text" style="text-align:center">Фото и голос распознаёт ИИ — на сервере не задан ключ Groq. Текстом работает без ключа.</p>}
      <p class="hint-text" style="text-align:center;margin-top:12px">Быстрее всего — переслать домашку из чата класса боту: задания появятся здесь сами.</p>
      </>}
    </Sheet>);
}

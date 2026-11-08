/**
 * v2.2 · Весь класс на уроке.
 *
 *  - «Показать классу»: QR-код и код из 6 цифр на весь экран (проектор/интерактивная доска), живые счётчики
 *    «Открыли / Сдали / Без приложения». На экране класса — ни имён, ни баллов: только код и общие цифры.
 *  - «Печать карточки»: тот же QR и код на бумаге — повесить на доску или раздать.
 *  - «Сводка для журнала»: таблица «ученик · как сдано · баллы · процент» в буфер обмена (TSV), без оценок.
 *  - Отметки офлайн-сдачи («Сдал устно» / «На листочке») — в строке ученика (TeacherAssignments.tsx).
 */
import { createPortal } from "preact/compat";
import { useEffect, useMemo, useState } from "preact/hooks";
import { appLink, brightScreen } from "../lib/host";
import type { HwIssueRow, HwTemplate, TeacherQuiz } from "../lib/hwTypes";
import { encodeQr, qrPath } from "../lib/qr";
import { journalTsv, pinGroups, quizPin, quizStart } from "../lib/quizCode";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { toast } from "../ui/Toast";

/** QR на белом поле с тихой зоной 4 модуля — так его читают и камеры телефонов, и сканер MAX. */
export function QrSvg({ text, label, class: cls = "qr-svg" }: { text: string; label: string; class?: string }) {
  const code = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!code) return <p class="field-err">Ссылка слишком длинная для QR-кода — покажите классу код из цифр.</p>;
  const n = code.size + 8;
  return <svg class={cls} viewBox={`0 0 ${n} ${n}`} role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : "true"}
    shape-rendering="crispEdges" data-qr-version={code.version}><rect width={n} height={n} fill="#fff" /><path d={qrPath(code)} fill="#000" /></svg>;
}

/** Печать через отдельный блок в <body> (см. @media print в секции v2.css ядра design-system-core.css); в мини-приложении печати может не быть. */
function usePrint(on: boolean, done: () => void, fallback: string) {
  useEffect(() => {
    if (!on) return;
    addEventListener("afterprint", done);
    const t = setTimeout(() => {
      try { print(); setTimeout(done, 1500); } catch { toast(fallback, "info"); done(); }
    }, 50);
    return () => { clearTimeout(t); removeEventListener("afterprint", done); };
  }, [on]);
}

function copyText(text: string, ok: string): Promise<boolean> {
  if (!navigator.clipboard) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => { toast(ok, "ok"); return true; }, () => false);
}

type WakeLock = { release(): Promise<void> };
type WakeNav = Navigator & { wakeLock?: { request(kind: "screen"): Promise<WakeLock> } };

/** Экран не гаснет, пока показан код (Screen Wake Lock, где он есть; в MAX — ещё и яркость на максимум). */
function useAwake(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let lock: WakeLock | null = null, alive = true;
    const want = () => {
      const wl = (navigator as WakeNav).wakeLock;
      if (!wl || document.hidden) return;
      wl.request("screen").then((l) => { if (alive) lock = l; else void l.release().catch(() => undefined); }).catch(() => undefined);
    };
    want(); brightScreen(true);
    // MAX держит максимальную яркость ~30 с (dev.max.ru/docs/webapps/bridge) — продлеваем, пока экран показа открыт
    const keep = window.setInterval(() => { if (!document.hidden) brightScreen(true); }, 25000);
    const vis = () => { if (!document.hidden) { want(); brightScreen(true); } };
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false; window.clearInterval(keep); document.removeEventListener("visibilitychange", vis);
      void lock?.release().catch(() => undefined); brightScreen(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [on]);
}

export interface ClassCounts { app: number; opened: number; sent: number; offline: number; offlineDone: number }
export function classCounts(rows: readonly HwIssueRow[], tq: TeacherQuiz | null): ClassCounts {
  const live = rows.filter((r) => r.status !== "revoked");
  const app = live.filter((r) => r.access !== "offline"), off = live.filter((r) => r.access === "offline");
  return {
    app: app.length, opened: app.filter((r) => !!r.seen_at).length,
    sent: tq?.stats ? tq.stats.submitted : app.filter((r) => r.quiz?.state === "submitted").length,
    offline: off.length, offlineDone: off.filter((r) => !!r.manual).length,
  };
}


export function ProjectorSheet({ open, onClose, t, tq, rows, botName }: {
  open: boolean; onClose: () => void; t: HwTemplate; tq: TeacherQuiz | null; rows: readonly HwIssueRow[]; botName: string | null;
}) {
  const pin = quizPin(t.template_id);
  const link = appLink(quizStart(t.template_id), botName);
  const c = classCounts(rows, tq);
  const [printing, setPrinting] = useState(false);
  useAwake(open);
  usePrint(printing, () => setPrinting(false), "Печать недоступна в этом приложении — откройте СферумФокус в браузере компьютера");
  const fullscreen = () => {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => undefined); return; }
    const el = document.documentElement;
    if (!el.requestFullscreen) { toast("Полноэкранный режим недоступен — разверните окно вручную", "info"); return; }
    void el.requestFullscreen().catch(() => toast("Полноэкранный режим недоступен — разверните окно вручную", "info"));
  };
  return <Sheet open={open} onClose={onClose} variant="is-projector" bodyFocusable eyebrow={`${t.class} · ${t.subject} · показ классу`} title={t.title}
    footer={<div class="hw-row-actions l-h l-wrap hw-sheet-actions l-w100 qz-proj-actions">
      <button type="button" class="btn btn-secondary" onClick={fullscreen}><Icon name="screen" />На весь экран</button>
      <button type="button" class="btn btn-ghost" onClick={() => setPrinting(true)}><Icon name="printer" />Печать карточки</button>
      <button type="button" class="btn btn-ghost" onClick={() => void copyText(link, "Ссылка на опрос скопирована").then((ok) => { if (!ok) toast(`Ссылка: ${link}`, "info"); })}><Icon name="copy" />Ссылка</button>
    </div>}>
    <div class="qz-proj l-c2 l-mid">
      <div class="qz-proj-qr l-center l-g0"><QrSvg text={link} label={`QR-код опроса «${t.title}»`} /></div>
      <div class="qz-proj-side l-v l-g3">
        <p class="qz-proj-k f-b f-w6 f-2">Код опроса</p>
        <p class="qz-proj-pin l-blk f-xl f-num f-nw num" aria-label={`Код опроса: ${pin.split("").join(" ")}`}>{pinGroups(pin)}</p>
        <ol class="qz-proj-steps l-v l-g1 f-s">
          <li>Наведите камеру телефона на QR-код — опрос откроется в СферумФокус.</li>
          <li>Или откройте СферумФокус, нажмите «Код» и введите цифры.</li>
          <li>Без телефона — отвечайте на листочке, учитель отметит.</li>
        </ol>
        <dl class="qz-proj-live l-fit mt-1">
          <div><dt>Открыли</dt><dd class="num f-w6">{c.opened}<small>/{c.app}</small></dd></div>
          <div><dt>Сдали</dt><dd class="num f-w6">{c.sent}<small>/{c.app}</small></dd></div>
          {c.offline > 0 && <div><dt>Сдали офлайн</dt><dd class="num f-w6">{c.offlineDone}<small>/{c.offline}</small></dd></div>}
        </dl>
        <p class="hint-text qz-proj-note">На экране только код и общие счётчики — без имён и баллов. Цифры обновляются каждые 5 секунд.</p>
      </div>
    </div>
    {printing && createPortal(<div class="print-only qz-print-card" aria-hidden="true">
      <p class="qz-pc-eyebrow">{t.class} · {t.subject}</p>
      <h1>{t.title}</h1>
      <div class="qz-pc-row"><QrSvg text={link} label="" class="qz-pc-qr" /><div><p>Код опроса</p><p class="qz-pc-pin">{pinGroups(pin)}</p></div></div>
      <ol>
        <li>Отсканируйте QR-код камерой телефона — опрос откроется в СферумФокус.</li>
        <li>Или: СферумФокус → «Код» → введите цифры.</li>
        <li>Без телефона — ответьте на листочке и сдайте учителю.</li>
      </ol>
      <p class="qz-pc-link">{link}</p>
    </div>, document.body)}
  </Sheet>;
}

/** «Сводка для журнала»: копия таблицы; если буфер обмена недоступен — та же таблица в поле для ручного копирования. */
export function JournalCopy({ rows }: { rows: readonly HwIssueRow[] }) {
  const [manual, setManual] = useState<string | null>(null);
  const run = () => {
    const { text, count } = journalTsv(rows);
    void copyText(text, `Скопировано строк: ${count}. Вставьте в таблицу или журнал — оценки ставите вы`).then((ok) => { if (!ok) setManual(text); });
  };
  return <div class="hw-journal l-v">
    <button type="button" class="btn btn-ghost btn-sm" onClick={run}><Icon name="copy" />Сводка для журнала</button>
    {manual !== null && <label class="field hw-journal-manual"><span class="field-label">Буфер обмена недоступен — выделите и скопируйте вручную</span>
      <textarea class="input" readOnly rows={Math.min(8, manual.split("\n").length)} value={manual} onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()} /></label>}
  </div>;
}

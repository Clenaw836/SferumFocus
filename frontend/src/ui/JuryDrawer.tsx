/**
 * v2.1 · B3 «Демо для жюри»: три сценария за минуту и «Инженерная телеметрия».
 *  Ученик — оценка → «Симулятор оценок» → «Начать 15-минутную Фокус-миссию» → сократический тьютор;
 *  Учитель — задание за 10 секунд, статусы, дубль/отзыв/архив без перезагрузки;
 *  Сбой СГО — настоящие учения на сервере (POST /api/v1/health/swr-drill), а не анимация.
 * v2.2: два режима проверки — «Живое демо на сервере» (общий демо-класс 8А в SQLite, выдача учителя сразу
 * приходит ученику зелёным уведомлением) и «Вход как в жизни» (мастер: реальная школа + вход в СГО).
 * Иконки — монохромные SVG (stroke 1.75), без эмодзи.
 * v3.0: вверху — «Демо-профили» (8А, Учитель, СГО, Офлайн, Сброс); вход — одна капсула «Демо жюри» в шапке.
 * Телеметрия — GET /api/v1/health/deep (тот же вход, что у остального API). Нет сервера — так и пишем, цифр не рисуем.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, telemetry } from "../lib/api";
import { drillLine, drillVerdict, telemetryRows, type DeepHealth, type SwrDrill } from "../lib/juryTelemetry";
import { endSandbox } from "../lib/demoSession";
import { inSandbox } from "../lib/sandbox";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

type Load<T> = { state: "idle" } | { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

export function telemetryError(e: unknown, drill = false): string {
  if (!(e instanceof ApiError)) return "Не удалось получить данные";
  if (e.status === 0 || e.status === -1) return "Нет связи с сервером. Автономная DEMO-копия работает без сети, а телеметрия и учения — только на сервере.";
  if (e.status === 401 || e.status === 403) return "Телеметрия доступна внутри приложения после входа (MAX, Telegram или браузерная сессия).";
  if (e.status === 404) return drill ? "На этом сервере учения выключены (SFERUM_SWR_DRILL)." : "На этом сервере телеметрия выключена (SFERUM_DEEP_HEALTH=0).";
  if (e.status === 409 || e.status === 429) return e.message;
  return e.message || `Ошибка ${e.status}`;
}

const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
const STATUS_RU = { ok: "всё в норме", degraded: "работает с ограничениями", fail: "есть сбой" } as const;

export function JuryDrawer({ open, onClose, onStudent, onTeacher, teacherNote, onLive, current = "student", sgoHref, onReset }: {
  open: boolean;
  onClose: () => void;
  onStudent: () => void;
  onTeacher: () => void;
  /** Что именно увидит жюри у учителя в этом режиме (автономная копия / живая песочница / сервер). */
  teacherNote: string;
  /** Автономная копия: переход в живую песочницу, где выдача заданий идёт через настоящий сервер. */
  onLive?: () => void;
  /** v3.0 · какой демо-профиль открыт сейчас (подсветка плитки). */
  current?: "student" | "teacher";
  /** v3.0 · «СГО»: настоящий мастер подключения дневника (только автономная DEMO-копия). */
  sgoHref?: string;
  /** v3.0 · «Сброс»: чистый лист демо (локальные demo:-ключи или новая песочница). */
  onReset?: () => void;
}) {
  const [health, setHealth] = useState<Load<DeepHealth>>({ state: "idle" });
  const [drill, setDrill] = useState<Load<SwrDrill>>({ state: "idle" });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadHealth = (probe = false) => {
    setHealth({ state: "loading" });
    telemetry.deep(probe).then((data) => { if (alive.current) setHealth({ state: "ready", data }); },
      (e) => { if (alive.current) setHealth({ state: "error", message: telemetryError(e) }); });
  };
  useEffect(() => { if (open && health.state === "idle") loadHealth(); }, [open]);
  const runDrill = () => {
    if (drill.state === "loading") return;
    setDrill({ state: "loading" });
    telemetry.drill().then((data) => { if (alive.current) setDrill({ state: "ready", data }); },
      (e) => { if (alive.current) setDrill({ state: "error", message: telemetryError(e, true) }); });
  };
  const busy = health.state === "loading";
  return <Sheet open={open} onClose={onClose} title="Демо для жюри" eyebrow="Профили · 3 сценария · около минуты">
    <div class="jd l-v l-g3">
      {/* v3.0: все демо-инструменты — здесь, а не россыпью чипов на первом экране (одна капсула в шапке). */}
      <section class="jd-profiles mb-4" aria-labelledby="jd-prof-h">
        <h3 class="f-2" id="jd-prof-h">Демо-профили</h3>
        <div class="jd-profile-grid l-c2">
          <button type="button" class="jd-profile l-v l-jc l-g1 f-b f-w6 b-tile b-tap" aria-pressed={current === "student"} onClick={onStudent}><Icon name="user" /><b>8А</b><small>Ученик</small></button>
          <button type="button" class="jd-profile l-v l-jc l-g1 f-b f-w6 b-tile b-tap" aria-pressed={current === "teacher"} onClick={onTeacher}><Icon name="cap" /><b>Учитель</b><small>Класс 8А</small></button>
          {sgoHref && <a class="jd-profile l-v l-jc l-g1 f-b f-w6 b-tile b-tap" href={sgoHref} aria-label="Подключить дневник СГО"><Icon name="book" /><b>СГО</b><small>Подключить дневник</small></a>}
          <button type="button" class="jd-profile l-v l-jc l-g1 f-b f-w6 b-tile b-tap" onClick={runDrill} disabled={drill.state === "loading"} aria-describedby="jd-drill-out"><Icon name="wifiOff" /><b>Офлайн</b><small>Сбой СГО: учения</small></button>
          {onReset && <button type="button" class="jd-profile l-v l-jc l-g1 f-b f-w6 b-tile b-tap" onClick={onReset}><Icon name="refresh" /><b>Сброс</b><small>Чистый лист демо</small></button>}
        </div>
      </section>
      <p class="jd-lead f-b f-2">Каждый сценарий — настоящий экран приложения или настоящий серверный код, не слайд.</p>
      <JuryModes onLive={onLive} />
      <ul class="jd-cases l-v">
        <li><button type="button" class="jd-case l-a1a l-g3 l-mid b-card l-w100" onClick={onStudent}>
          <span class="jd-ico l-center l-g0 f-a b-box s-40" aria-hidden="true"><Icon name="cap" /></span>
          <span class="jd-case-text l-v l-g1"><b>Ученик: оценка → 15 минут</b><small>«Симулятор оценок» по предмету → «Начать 15-минутную Фокус-миссию» → сократический тьютор</small></span>
          <Icon name="chevron" />
        </button></li>
        <li><button type="button" class="jd-case l-a1a l-g3 l-mid b-card l-w100" onClick={onTeacher}>
          <span class="jd-ico l-center l-g0 f-a b-box s-40" aria-hidden="true"><Icon name="users" /></span>
          <span class="jd-case-text l-v l-g1"><b>Учитель: задание за 10 секунд</b><small>{teacherNote}</small></span>
          <Icon name="chevron" />
        </button>{onLive && <button type="button" class="btn btn-ghost btn-sm jd-live mt-1" onClick={onLive}>Открыть живую демонстрацию на сервере</button>}</li>
        <li><button type="button" class="jd-case l-a1a l-g3 l-mid b-card l-w100" onClick={runDrill} disabled={drill.state === "loading"} aria-describedby="jd-drill-out">
          <span class="jd-ico l-center l-g0 f-a b-box s-40" aria-hidden="true"><Icon name="wifiOff" /></span>
          <span class="jd-case-text l-v l-g1"><b>{drill.state === "loading" ? "Идут учения…" : drill.state === "ready" ? "Сбой СГО: повторить учения" : "Сбой СГО: запустить учения"}</b><small>Сервер школы «падает» — ученик получает ответ 200 из сохранённой копии; 5 запросов = 1 поход в СГО</small></span>
          <Icon name="bolt" />
        </button></li>
      </ul>
      <div id="jd-drill-out" class="jd-drill l-v" aria-live="polite">
        {drill.state === "error" && <p class="jd-muted f-b f-2">{drill.message}</p>}
        {drill.state === "ready" && <>
          <p class={`jd-verdict l-h l-top f-w6 ${drill.data.passed ? "is-ok" : "is-bad"}`}><Icon name={drill.data.passed ? "check" : "alert"} />{drillVerdict(drill.data)}</p>
          <ol class="jd-steps l-v l-g1">{drill.data.steps.map((s) => <li key={s.id} class={s.passed ? "is-ok" : "is-bad"}>
            <span class="jd-mark f-w6" aria-hidden="true">{s.passed ? "✓" : "✗"}</span><span class="sr">{s.passed ? "Пройден: " : "Не пройден: "}</span>
            <span class="jd-step-text">{drillLine(s)}</span><span class="jd-step-ms f-m f-3 f-num f-nw num">{Math.round(s.ms)} мс</span>
          </li>)}</ol>
          <p class="jd-foot f-m f-3">Временная зашифрованная база, настоящий SGOMultiRegionAdapter: реальные ученики и СГО не затронуты.</p>
        </>}
      </div>
      <section class="jd-tele l-v b-card" aria-labelledby="jd-tele-h" aria-busy={busy}>
        <div class="jd-tele-head l-h l-btw l-wrap l-g1">
          <h3 id="jd-tele-h">Инженерная телеметрия</h3>
          {health.state === "ready" && <span class={`jd-badge f-m f-w6 b-pill is-${health.data.status}`}>{STATUS_RU[health.data.status]}</span>}
        </div>
        {health.state === "loading" && <p class="jd-muted f-b f-2">Проверяем подсистемы…</p>}
        {health.state === "error" && <p class="jd-muted f-b f-2">{health.message}</p>}
        {health.state === "ready" && <ul class="jd-rows l-v">{telemetryRows(health.data).map((r) => <li key={r.id} class={`jd-row l-a1 tone-${r.tone}`} data-row={r.id}>
          <span class="jd-dot b-round mt-1" aria-hidden="true" />
          <div class="jd-row-main l-v l-g1"><div class="jd-row-top l-h l-base l-btw l-wrap l-g1"><b>{r.title}</b><span class="jd-val f-b f-w6 f-num">{r.value}</span></div><small>{r.detail}</small></div>
        </li>)}</ul>}
        <div class="jd-tele-actions l-h l-wrap">
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => loadHealth(false)}><Icon name="refresh" />Обновить</button>
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={() => loadHealth(true)}><Icon name="bolt" />Проверить Groq вживую</button>
        </div>
        {health.state === "ready" && <p class="jd-foot f-m f-3">Проверено в {clock(health.data.checked_at)} · {Math.round(health.data.duration_ms)} мс{health.data.cached ? " · из кэша сервера (до 5 с)" : ""}</p>}
      </section>
    </div>
  </Sheet>;
}

/** v2.2 · два режима проверки для жюри. Ничего не имитируем: живое демо — серверная песочница (SQLite, срок жизни),
 *  «как в жизни» — обычный вход и мастер подключения СГО (нужен собственный аккаунт «Сетевого города»). */
function JuryModes({ onLive }: { onLive?: () => void }) {
  const live = inSandbox();
  const plain = () => { const u = new URL(location.href); u.search = ""; u.hash = "#tonight"; location.assign(u.href); };
  return <section class="jd-modes l-v mb-4" aria-labelledby="jd-modes-h">
    <h3 class="f-2" id="jd-modes-h">Два режима проверки</h3>
    <div class={`jd-mode l-a1a l-g3 l-mid b-tile${live ? " is-on" : ""}`}>
      <span class="jd-ico l-center l-g0 f-a b-box s-40" aria-hidden="true"><Icon name="users" /></span>
      <div class="jd-mode-text l-v l-g1"><b>Живое демо на сервере</b>
        <small>Общий демо-класс 8А в базе сервера: учитель выдаёт ДЗ или обязательный блиц — ученик сразу видит зелёное уведомление, потом капсулу «Приступить» над «Вечером».</small>
        {live && <ol class="jd-flow l-v l-g1 f-m f-2 mt-1"><li>Учитель → «Задания» → «Обязательный блиц-опрос» → выдать 8А.</li><li>Плашка демо сверху → ученик.</li><li>Уведомление «[ НОВОЕ ЗАДАНИЕ ОТ УЧИТЕЛЯ ]» → «Приступить».</li></ol>}
      </div>
      {live ? <span class="jd-here f-c f-w6 f-a f-num f-nw">вы здесь</span> : onLive ? <button type="button" class="btn btn-secondary btn-sm" onClick={onLive}>Открыть</button> : <span class="jd-here f-c f-w6 f-a f-num f-nw is-off">нужен сервер</span>}
    </div>
    <div class="jd-mode l-a1a l-g3 l-mid b-tile">
      <span class="jd-ico l-center l-g0 f-a b-box s-40" aria-hidden="true"><Icon name="lock" /></span>
      <div class="jd-mode-text l-v l-g1"><b>Вход как в жизни</b>
        <small>Мастер подключения: реальная школа и вход в «Сетевой город» своим аккаунтом. Пароль нужен только для входа в СГО и не сохраняется; в базе — зашифрованная сессия.</small></div>
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => { if (live) void endSandbox(); else plain(); }}>{live ? "Выйти из демо" : "Без демо"}</button>
    </div>
  </section>;
}

/** v3.0 · единственный вход в демо-инструменты: капсула «Демо жюри» справа в шапке (иконка-мишень — SVG, без эмодзи). */
export { JuryButton } from "./JuryButton";

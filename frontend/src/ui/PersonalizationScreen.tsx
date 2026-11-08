/**
 * Master v2.0 · Feature 4 — «Персонализация» в профиле: тема и текст, шрифт, цвета статусов, фон и обложка.
 * Простые варианты сразу, фото и тонкая настройка — по раскрытию. Каждое изменение видно мгновенно
 * (на самом приложении и в предпросмотре), последнее можно отменить, всё — вернуть к стандартному виду.
 */
import { useRef, useState } from "preact/hooks";
import { minVeil, sample, toBudget } from "../lib/imageTools";
import { BUDGET, OUT, bgImage, canUndo, isDefault, memoryOnly, resetPersonal, setBgImage, setPersonal, undoPersonal, usePersonal, veilFor, visibleBackdrop,
  type Backdrop, type ColorVision, type FontSet, type Slot } from "../lib/personal";
import { useAppearance } from "../lib/theme";
import { AppearanceSettings } from "./ProfileSettings";
import { ImageCropper } from "./ImageCropper";
import { Icon } from "./Icon";
import { toast } from "./Toast";

const FONT_OPT: { v: FontSet; t: string; d: string }[] = [
  { v: "system", t: "Стандартный", d: "Системный шрифт телефона" },
  { v: "readable", t: "Для чтения", d: "Noto Sans, шире интервалы между буквами и словами" },
  { v: "serif", t: "С засечками", d: "Классический шрифт с засечками — спокойнее для длинного текста" },
];
const CV_OPT: { v: ColorVision; t: string; d: string }[] = [
  { v: "standard", t: "Стандартные цвета", d: "Как задумано дизайном" },
  { v: "rg", t: "Красный и зелёный похожи", d: "Статусы — синим, оранжевым и жёлтым" },
  { v: "by", t: "Синий и жёлтый похожи", d: "Статусы — бирюзовым, красным и розовым" },
  { v: "mono", t: "Без опоры на цвет", d: "Нейтральные цвета; статусы — значками и штриховкой" },
];
const BG_OPT: { v: Backdrop; t: string }[] = [
  { v: "none", t: "Без фона" }, { v: "dusk", t: "Сумерки" }, { v: "tide", t: "Прилив" }, { v: "paper", t: "Бумага" }, { v: "photo", t: "Своё фото" },
];

function Preview() {
  const p = usePersonal(); useAppearance();
  const b = visibleBackdrop(p), img = b === "photo" ? bgImage("app") : null;
  return <div class="pz-preview l-blk b-box l-rel" data-backdrop={b} aria-label="Предпросмотр оформления" role="img">
    {img && <span class="pz-preview-img l-fill" style={{ backgroundImage: `url("${img.url}")` }} />}
    {b !== "none" && <span class="pz-preview-veil b-box b-nob l-fill" style={{ opacity: String(veilFor(p)) }} />}
    <span class="pz-preview-body p-4 l-v l-g1 l-rel">
      <b>Вечер · 3 задания</b>
      <small>Так текст выглядит поверх фона</small>
      <span class="pz-chips l-h l-wrap l-g1 mt-1"><span class="pz-chip s-ok"><Icon name="check" />готово</span><span class="pz-chip s-warn"><Icon name="clock" />в работе</span><span class="pz-chip s-bad"><Icon name="alert" />просрочено</span></span>
    </span>
  </div>;
}

/** Обрезка выбранного файла для слота → сжатие под бюджет → порог затемнения для обеих тем → сохранение. */
function Crop({ slot, file, label, onClose }: { slot: Slot; file: File; label: string; onClose: () => void }) {
  const o = OUT[slot];
  return <ImageCropper file={file} aspect={o.w / o.h} out={o} title={label} onCancel={onClose}
    onDone={(cv) => {
      const url = toBudget(cv, BUDGET[slot]);
      if (!url) throw new Error("Не получилось сжать изображение до допустимого размера — выберите другое.");
      const px = sample(cv);
      const saved = setBgImage(slot, { url, w: cv.width, h: cv.height, veil: { dark: minVeil(px, "dark"), light: minVeil(px, "light") } });
      onClose();
      toast(saved ? "Изображение сохранено" : "Не хватило места на устройстве — изображение действует до перезапуска", saved ? "ok" : "warn");
    }} />;
}

export function PersonalizationScreen({ backgrounds = true }: { backgrounds?: boolean }) {
  const p = usePersonal(); const ap = useAppearance();
  const [pending, setPending] = useState<{ slot: Slot; file: File } | null>(null);
  const appInput = useRef<HTMLInputElement>(null), coverInput = useRef<HTMLInputElement>(null);
  const pickFile = (slot: Slot) => (slot === "app" ? appInput : coverInput).current?.click();
  const onFile = (slot: Slot) => (e: Event) => { const el = e.currentTarget as HTMLInputElement; const f = el.files?.[0]; el.value = ""; if (f) setPending({ slot, file: f }); };
  const [askReset, setAskReset] = useState(false);
  const img = bgImage("app"), cover = bgImage("cover");
  const floor = p.bg === "photo" && img ? img.veil[ap.theme] : 0;
  const shown = Math.round(veilFor(p) * 100);
  return <div class="pz-screen l-v l-g0">
    <Preview />
    <p class="hint-text">Изменения применяются сразу. Настройки хранятся на этом устройстве отдельно для каждого аккаунта; фото не отправляются на сервер.</p>

    <AppearanceSettings />

    <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="pz-font-h">
      <h3 id="pz-font-h">Шрифт</h3>
      <div class="pz-options l-v" role="radiogroup" aria-labelledby="pz-font-h">
        {FONT_OPT.map((f) => <label key={f.v} class={`pz-option l-h l-g3 b-tile b-tap l-rel${p.font === f.v ? " is-on" : ""}`} data-font-sample={f.v}>
          <input type="radio" name="pz-font" checked={p.font === f.v} onChange={() => setPersonal({ font: f.v })} />
          <span class="pz-sample l-center l-g0 f-s b-box l-fix" aria-hidden="true">Аа 123</span><span><b>{f.t}</b><small>{f.d}</small></span>
        </label>)}
      </div>
      <p class="hint-text">Шрифты распространяются по лицензии SIL Open Font License и загружаются только при выборе. Размер текста — в блоке «Оформление».</p>
    </section>

    <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="pz-cv-h">
      <h3 id="pz-cv-h">Цвета статусов</h3>
      <p class="hint-text">Выберите вариант, в котором «готово», «в работе» и «просрочено» различаются лучше всего. Это не тест и не диагноз — просто удобство. Статусы всегда подписаны словами и значками.</p>
      <div class="pz-options l-v" role="radiogroup" aria-labelledby="pz-cv-h">
        {CV_OPT.map((c) => <label key={c.v} class={`pz-option l-h l-g3 b-tile b-tap l-rel${p.cv === c.v ? " is-on" : ""}`} data-cv-sample={c.v}>
          <input type="radio" name="pz-cv" checked={p.cv === c.v} onChange={() => setPersonal({ cv: c.v })} />
          <span class="pz-swatches l-h l-g1 l-fix" aria-hidden="true"><i class="sw-ok" /><i class="sw-warn" /><i class="sw-bad" /></span><span><b>{c.t}</b><small>{c.d}</small></span>
        </label>)}
      </div>
      {ap.highContrast && <p class="hint-text">Сейчас включена «Повышенная различимость» — её палитра уже рассчитана на разные типы цветовосприятия и действует поверх выбора здесь.</p>}
    </section>

    {backgrounds && <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="pz-bg-h">
      <h3 id="pz-bg-h">Фон приложения</h3>
      {ap.highContrast && <p class="note warn" role="note"><Icon name="info" /><span>В режиме «Повышенная различимость» фон не показывается — так текст остаётся максимально контрастным. Выбор сохранится.</span></p>}
      <div class="pz-tiles l-fit" role="radiogroup" aria-labelledby="pz-bg-h">
        {BG_OPT.map((b) => <label key={b.v} class={`pz-tile l-v l-g1 f-b f-tc b-tile l-rel${p.bg === b.v ? " is-on" : ""}`} data-tile={b.v}>
          <input type="radio" name="pz-bg" checked={p.bg === b.v} onChange={() => { if (b.v === "photo" && !img) pickFile("app"); else setPersonal({ bg: b.v }); }} />
          <span class="pz-tile-art l-center l-g0 f-3 b-box" aria-hidden="true" style={b.v === "photo" && img ? { backgroundImage: `url("${img.url}")` } : undefined}>{b.v === "photo" && !img && <Icon name="image" />}</span>
          <span>{b.t}</span>
        </label>)}
      </div>
      <input ref={appInput} type="file" accept="image/jpeg,image/png,image/webp" class="sr" tabIndex={-1} aria-hidden="true" onChange={onFile("app")} />
      {pending?.slot === "app" && <Crop slot="app" file={pending.file} label="Кадр для фона (вертикальный)" onClose={() => setPending(null)} />}
      {p.bg !== "none" && pending?.slot !== "app" && <div class="pz-dim l-v">
        <label><span>Затемнение под текстом: <b class="num">{shown} %</b></span>
          <input type="range" min="0" max="90" step="5" value={p.dim} aria-valuetext={`${shown} %`} onChange={(e) => setPersonal({ dim: Number((e.currentTarget as HTMLInputElement).value) })} />
        </label>
        {floor > p.dim && <p class="hint-text" role="note"><Icon name="info" /> Для этого фото в {ap.theme === "dark" ? "тёмной" : "светлой"} теме затемнение не ниже {floor} % — иначе мелкий текст станет нечитаемым.</p>}
        {p.bg === "photo" && img && <div class="pz-row l-h l-wrap"><button type="button" class="btn btn-secondary btn-sm" onClick={() => pickFile("app")}><Icon name="image" />Заменить фото</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => { setBgImage("app", null); toast("Фото фона убрано", "ok"); }}><Icon name="trash" />Убрать фото</button></div>}
        {memoryOnly("app") && <p class="note warn" role="status"><Icon name="alert" /><span>Фото не поместилось в память устройства и пропадёт после перезапуска.</span></p>}
      </div>}
      <p class="hint-text">Своё фото: JPEG, PNG или WebP до 15 МБ. Сохраняется уменьшенная копия до 720×1280.</p>
    </section>}

    {backgrounds && <section class="settings-block l-v l-g3 b-card mt-4" aria-labelledby="pz-cover-h">
      <h3 id="pz-cover-h">Обложка профиля</h3>
      <div class="pz-cover b-box" data-has={cover ? "1" : "0"} style={cover ? { backgroundImage: `url("${cover.url}")` } : undefined} aria-hidden="true" />
      <input ref={coverInput} type="file" accept="image/jpeg,image/png,image/webp" class="sr" tabIndex={-1} aria-hidden="true" onChange={onFile("cover")} />
      {pending?.slot === "cover" ? <Crop slot="cover" file={pending.file} label="Кадр для обложки (3:1)" onClose={() => setPending(null)} />
        : <div class="pz-row l-h l-wrap"><button type="button" class="btn btn-secondary btn-sm" onClick={() => pickFile("cover")}><Icon name="image" />{cover ? "Заменить обложку" : "Выбрать обложку"}</button>
          {cover && <button type="button" class="btn btn-ghost btn-sm" onClick={() => { setBgImage("cover", null); toast("Обложка убрана", "ok"); }}><Icon name="trash" />Убрать</button>}</div>}
    </section>}

    <section class="settings-block l-v l-g3 b-card mt-4 pz-footer" aria-label="Отмена и сброс">
      <button type="button" class="btn btn-secondary btn-block" disabled={!canUndo()} onClick={() => { if (undoPersonal()) toast("Последнее изменение отменено", "ok"); }}><Icon name="refresh" />Отменить последнее изменение</button>
      {askReset ? <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label="Вернуть стандартный вид">
        <p class="f-2">Вернуть стандартный вид? Шрифт, цвета, фон и обложка станут исходными, свои фото удалятся с устройства. Тема и размер текста не меняются.</p>
        <div class="hw-row-actions l-h l-wrap"><button type="button" class="btn btn-secondary btn-sm" onClick={() => { resetPersonal(); setAskReset(false); toast("Стандартный вид восстановлен — можно отменить", "ok"); }}>Вернуть</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setAskReset(false)}>Отмена</button></div>
      </div> : <button type="button" class="btn btn-ghost btn-block" disabled={isDefault()} onClick={() => setAskReset(true)}>Вернуть стандартный вид</button>}
    </section>
  </div>;
}

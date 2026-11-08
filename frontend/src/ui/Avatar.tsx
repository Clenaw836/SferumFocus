/**
 * Master v2.0 · Feature 1 — аватар (вход в профиль в верхней панели) и его редактор в профиле.
 * Своё фото: JPEG/PNG/WebP ≤ 15 МБ → обрезка 1:1 → 256×256 (WebP/JPEG ≤ ~65 КБ) → только на этом
 * устройстве, отдельно для каждого аккаунта. Фото MAX — из подписанного initData (сервер).
 */
import { useRef, useState } from "preact/hooks";
import { AVATAR_BUDGET, AVATAR_PX, hostAvatar, hostAvatarFailed, setOwnAvatar, useAvatar } from "../lib/avatar";
import { toBudget } from "../lib/imageTools";
import { ImageCropper } from "./ImageCropper";
import { Icon } from "./Icon";
import { toast } from "./Toast";

export function Avatar({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  const v = useAvatar(name);
  const [broken, setBroken] = useState<string | null>(null);
  const style = { "--av": `${size}px`, "--av-h": String(v.hue) };
  if (v.url && v.url !== broken) {
    return <span class="avatar" style={style} data-kind={v.kind}>
      <img src={v.url} alt="" width={size} height={size} decoding="async" referrerpolicy="no-referrer" draggable={false}
        onError={() => { if (v.kind === "max" && v.url) hostAvatarFailed(v.url); else setBroken(v.url); }} />
    </span>;
  }
  if (!v.initial) return <span class="avatar avatar-mono avatar-anon f-2 b-box b-nob" style={style} data-kind="none" aria-hidden="true"><Icon name="user" /></span>;
  return <span class={`avatar avatar-mono${v.initial.length > 1 ? " is-pair" : ""}`} style={style} data-kind="none" aria-hidden="true">{v.initial}</span>;
}

/** Кнопка-аватар в верхней панели: единственная точка входа в профиль (нижняя навигация — 4 раздела).
 *  Имя кнопки всегда «Профиль: <имя> — …»: без имени — то же обращение, что в приветствии («Ученик»), как было у
 *  прежней кнопки профиля (регрессия найдена старым набором reference_extra в финальном прогоне). */
export function AvatarButton({ name, fallback = "без имени", onOpen }: { name: string | null | undefined; fallback?: string; onOpen: () => void }) {
  // v2.2 · WCAG 2.5.3 «Label in Name»: инициалы — видимый текст кнопки, поэтому они входят и в её имя отдельным
  // словом («Профиль: Мария Ивановна, МИ — …»; axe 4.14 не учитывает текст в скобках): голосовая команда «нажми МИ»
  // находит кнопку.
  const v = useAvatar(name);
  const shown = !v.url && v.initial ? `, ${v.initial}` : "";
  return <button type="button" class="brand-avatar personal-profile b-bare b-tap mw-44" aria-haspopup="dialog" onClick={onOpen}
    aria-label={`Профиль: ${name || fallback}${shown} — статистика, персонализация, настройки`}>
    <Avatar name={name} size={40} />
  </button>;
}

const NOTE: Record<"own" | "max" | "none", string> = {
  own: "Своё фото · хранится только на этом устройстве для этого аккаунта",
  max: "Фото из профиля MAX",
  none: "Фото не выбрано — показываем инициалы имени",
};

export function AvatarEditor({ name }: { name: string | null | undefined }) {
  const v = useAvatar(name);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [ask, setAsk] = useState(false);
  if (file) {
    return <ImageCropper file={file} aspect={1} round out={{ w: AVATAR_PX, h: AVATAR_PX }} title="Кадр для аватара"
      onCancel={() => setFile(null)}
      onDone={(cv) => {
        const url = toBudget(cv, AVATAR_BUDGET);
        if (!url) throw new Error("Не получилось сжать фото — выберите другое изображение.");
        const saved = setOwnAvatar(url);
        setFile(null);
        toast(saved ? "Фото профиля обновлено" : "Не хватило места на устройстве — фото действует до перезапуска", saved ? "ok" : "warn");
      }} />;
  }
  return <div class="avatar-editor l-v mb-4">
    <div class="avatar-editor-side l-v">
      <p class="avatar-note f-b f-2">{NOTE[v.kind]}</p>
      <div class="avatar-actions l-h l-wrap">
        <button type="button" class="btn btn-secondary btn-sm" onClick={() => input.current?.click()}><Icon name="camera" />{v.kind === "own" ? "Заменить фото" : "Выбрать фото"}</button>
        {v.kind === "own" && !ask && <button type="button" class="btn btn-ghost btn-sm" onClick={() => setAsk(true)}><Icon name="trash" />Убрать</button>}
      </div>
      {ask && <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label="Убрать своё фото">
        <p class="f-2">Убрать своё фото с этого устройства?{hostAvatar() ? " Вернётся фото из профиля MAX." : " Вернётся буква имени."}</p>
        <div class="hw-row-actions l-h l-wrap">
          <button type="button" class="btn btn-secondary btn-sm" onClick={() => { setOwnAvatar(null); setAsk(false); toast("Своё фото убрано", "ok"); }}>Убрать</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setAsk(false)}>Отмена</button>
        </div>
      </div>}
      <p class="hint-text">Фото — только оформление: оно не подтверждает личность и не влияет на роль и доступ.</p>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" class="sr" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; (e.currentTarget as HTMLInputElement).value = ""; if (f) setFile(f); }} />
    </div>
  </div>;
}

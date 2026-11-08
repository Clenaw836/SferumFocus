import { AvatarButton } from "./Avatar";
import { Icon } from "./Icon";
import { JuryButton } from "./JuryButton";

/** Верхняя панель. Master v2.0: справа — аватар, единственная точка входа в профиль (вкладок внизу 4). */
/** v2.2 · onCode — кнопка «Код» (опрос по коду/QR учителя), только у ученика. */
/** V23 · эталон: на «Вечере» слева аватар, имя и класс; на других вкладках — название экрана и «СферумФокус». */
/** v3.0 · jury — капсула «Демо жюри» справа (DEMO-копия или живая песочница); who — кто вы в демо (для диктора). */
type Jury = { onOpen: () => void; who?: string | null; demo?: boolean };
function JurySlot({ jury }: { jury?: Jury }) {
  if (!jury) return null;
  return <span class={jury.demo ? "demo-header jury-slot" : "jury-slot"} aria-label={jury.demo ? "Демонстрационный профиль" : undefined}>{jury.who && <span class="sr">{jury.who}</span>}<JuryButton onClick={jury.onOpen} /></span>;
}
export function BrandBar({ context, name, fallback, onProfile, onCode, person, title, jury }: { context: string; name?: string | null; fallback?: string; onProfile?: () => void; onCode?: () => void; person?: { name: string; meta?: string | null } | null; title?: string; jury?: Jury }) {
  if (person) return <header class="brand-bar is-person">{onProfile && <AvatarButton name={name} fallback={fallback} onOpen={onProfile} />}<span class="brand-person"><b>{person.name}</b>{person.meta && <small>{person.meta}</small>}</span>
    <span class="brand-side"><span class="brand-context sr">{context}</span><JurySlot jury={jury} />{onCode && <button type="button" class="brand-code" aria-label="Код опроса от учителя" onClick={onCode}><Icon name="qr" /><span aria-hidden="true">Код</span></button>}</span></header>;
  return <header class="brand-bar"><div class="brand-lockup"><svg class="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle class="brand-mark-disc" cx="20" cy="20" r="17"/><path class="brand-mark-wave" d="M11.5 26.5c5.5 1.6 13-1.6 15.8-7.4 1.2-2.6.2-5.1-2.3-5.6-3.3-.7-6.3 3.4-9.7 3.2-2.2-.1-3-1.8-2.4-3.6" stroke-width="2.6" stroke-linecap="round"/></svg><span class="brand-copy"><span class="brand-name">{title ?? "СферумФокус"}</span><small>{title ? "СферумФокус" : "Твой день. Твои цели."}</small></span></div>
    <span class="brand-side"><span class="brand-context sr">{context}</span><JurySlot jury={jury} />{onCode && <button type="button" class="brand-code" aria-label="Код опроса от учителя" onClick={onCode}><Icon name="qr" /><span aria-hidden="true">Код</span></button>}{onProfile && <AvatarButton name={name} fallback={fallback} onOpen={onProfile} />}</span></header>;
}

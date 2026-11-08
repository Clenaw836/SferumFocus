import { Icon } from "./Icon";

/** Капсула «Демо жюри» в шапке; сама шторка (JuryDrawer) — отдельный чанк. */
export function JuryButton({ onClick }: { onClick: () => void }) {
  return <button type="button" class="jury-open sf-jury-capsule" onClick={onClick} aria-haspopup="dialog"><Icon name="target" /><span>Демо жюри</span></button>;
}

/**
 * Клавиатура для групп role="radiogroup" из кнопок (seg-mini): стрелки и Home/End выбирают соседний
 * вариант, выбор следует за фокусом — как в WAI-ARIA APG «Radio Group». Один слушатель на документ:
 * разметку групп менять не нужно. Если компонент сам обработал клавишу (preventDefault) — не вмешиваемся.
 */
const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function nextRadioIndex(key: string, at: number, count: number): number | null {
  if (count < 2 || at < 0 || at >= count) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const d = STEP[key];
  return d ? (at + d + count) % count : null;
}

export function installRadioKeys(doc: Document = document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== "BUTTON" || t.getAttribute("role") !== "radio") return;
    const group = t.closest('[role="radiogroup"]');
    if (!group) return;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('button[role="radio"]'))
      .filter((b) => !b.disabled && b.closest('[role="radiogroup"]') === group);
    const n = nextRadioIndex(e.key, radios.indexOf(t as HTMLButtonElement), radios.length);
    if (n === null) return;
    e.preventDefault();
    const next = radios[n];
    next.focus();
    if (next.getAttribute("aria-checked") !== "true") next.click();
  };
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
}

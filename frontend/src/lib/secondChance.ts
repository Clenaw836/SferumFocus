/**
 * V23-N27 · Итоговая строка «Второго шанса» в Блице.
 * Очки после второго шанса не меняются. «Все ошибки исправлены» — только если исправлены все.
 */
export function secondChanceNote(fixed: number, total: number): { allFixed: boolean; note: string } {
  const allFixed = total > 0 && fixed >= total;
  return allFixed
    ? { allFixed, note: "Очки не меняются — зато все ошибки исправлены." }
    : { allFixed, note: "Очки не меняются. Правильные ответы — в разборе выше." };
}

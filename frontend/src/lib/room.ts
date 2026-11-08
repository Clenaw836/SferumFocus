// v3.2: «каб. каб. 31» — СГО иногда уже кладёт префикс в поле room.
export function roomLabel(room: string | null | undefined): string {
  const r = String(room ?? "").trim();
  if (!r) return "";
  return /^(каб|кабинет)\.?\s*/i.test(r) ? r.replace(/^(каб|кабинет)\.?\s*/i, "каб. ") : `каб. ${r}`;
}

/** v3.0 · сегмент вкладки «Практика»; v3.2 вынесено из screens/Practice.tsx, чтобы экран грузился лениво. */
export type PracticeSeg = "practicum" | "blitz";
const SEG_KEY = "sf.practice.seg";
export const rememberedSeg = (): PracticeSeg => { try { return localStorage.getItem(SEG_KEY) === "blitz" ? "blitz" : "practicum"; } catch { return "practicum"; } };
/** «8А», «8 класс», «8» → 8; вне 5–11 — 8 (программа практикумов покрывает 5–11 классы). */
export const gradeNum = (g: string | number | null | undefined): number => { const n = parseInt(String(g ?? ""), 10); return n >= 5 && n <= 11 ? n : 8; };
export const rememberSeg = (s: PracticeSeg) => { try { localStorage.setItem(SEG_KEY, s); } catch { /* приватный режим */ } };

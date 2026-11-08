// Цвет предмета — функциональный код (узнаётся на шкале вечера), не декор.
const MAP: [RegExp, string, string][] = [
  [/алгебр|геометр|математ/i, "Математика", "var(--s-math)"],
  [/физик|хими|информат/i, "Естеств.", "var(--s-sci)"],
  [/русск|англ|язык/i, "Язык", "var(--s-lang)"],
  [/литер|истор|общест|географ|биолог/i, "Устный", "var(--s-oral)"],
];
export const subjectColor = (title: string): string =>
  (MAP.find(([re]) => re.test(title)) ?? [null, "", "var(--s-other)"])[2] as string;
/** Винительный падеж названия предмета для «сделать …»: алгебра → алгебру, химия → химию,
 *  физическая культура → физическую культуру; «русский язык», «обществознание» не меняются. */
export const accusative = (subject: string): string =>
  subject.split(" ").map((w) => {
    const l = w.toLowerCase();
    if (/[^а-яё]/.test(l) || l.length < 3) return w;
    if (/ая$/.test(l)) return w.slice(0, -2) + "ую";
    if (/яя$/.test(l)) return w.slice(0, -2) + "юю";
    if (/а$/.test(l)) return w.slice(0, -1) + "у";
    if (/я$/.test(l)) return w.slice(0, -1) + "ю";
    return w;
  }).join(" ");
/** «Алгебра: §13, упр. 355–357 (…)» → { subject: «Алгебра», detail: «§13, упр. 355–357 (…)» } */
export const splitTitle = (title: string): { subject: string; detail: string } => {
  const i = title.indexOf(":");
  if (i > 0 && i < 32) return { subject: title.slice(0, i).trim(), detail: title.slice(i + 1).trim() };
  return { subject: title, detail: "" };
};

/** v3.2 · Pass 8 (Visuals): живые мини-превью лабораторий на карточках «Практики» — чистые векторные схемы
 *  (stroke 1.75, currentColor, без растров и градиентов). Вид схемы выбирается по предмету и теме. */
export type PreviewKind = "parabola" | "scales" | "ohm" | "geometry" | "molecule" | "map" | "text";
export function previewKind(subject: string, topic: string, title = ""): PreviewKind {
  const t = `${subject} ${topic} ${title}`.toLowerCase();
  if (/парабол|квадрат|функц|график|дискрим/.test(t)) return "parabola";
  if (/уравнен|равенств|весы|баланс|пропорц|дроб/.test(t)) return "scales";
  if (/электр|ток|ом\b|напряж|сопротивл|цеп/.test(t)) return "ohm";
  if (/геометр|треуг|угол|площад|окружн|многоуг|вектор|координат/.test(t)) return "geometry";
  if (/хими|молекул|вещест|атом|реакц|биолог|клетк/.test(t)) return "molecule";
  if (/географ|истори|карт|материк|климат/.test(t)) return "map";
  return "text";
}
const P: Record<PreviewKind, preact.JSX.Element> = {
  parabola: <><path d="M6 40h52M32 6v38" class="pv-axis" /><path d="M12 10c6 26 14 30 20 30s14-4 20-30" /><circle cx="32" cy="40" r="2.2" class="pv-dot" /></>,
  scales: <><path d="M32 8v32M20 44h24M12 16h40" class="pv-axis" /><path d="M12 16 6 28h12zM52 16l-6 12h12z" /><path d="M6 28a6 3 0 0 0 12 0M46 28a6 3 0 0 0 12 0" /></>,
  ohm: <><path d="M10 14h16M38 14h16v22H10V14" class="pv-axis" /><path d="M26 14l2-4 3 8 3-8 2 4h2" /><circle cx="32" cy="36" r="5" /><path d="M30 36h4M32 34v4" /></>,
  geometry: <><path d="M8 40h48M8 28h48M8 16h48M20 6v40M32 6v40M44 6v40" class="pv-axis" /><path d="M14 38 30 12l20 26z" /><circle cx="30" cy="12" r="2.2" class="pv-dot" /></>,
  molecule: <><path d="M32 22 18 32M32 22l14 10M32 22V10M18 32v10M46 32v10" /><circle cx="32" cy="22" r="5" class="pv-dot" /><circle cx="18" cy="32" r="3.5" /><circle cx="46" cy="32" r="3.5" /><circle cx="32" cy="9" r="3" /><circle cx="18" cy="43" r="2.5" /><circle cx="46" cy="43" r="2.5" /></>,
  map: <><path d="M8 12l14-5 20 5 14-5v32l-14 5-20-5-14 5z" class="pv-axis" /><path d="M22 7v32M42 12v32" class="pv-axis" /><path d="M14 28c6-8 12 4 18-4s10 2 16-6" /><circle cx="48" cy="18" r="2.2" class="pv-dot" /></>,
  text: <><rect x="10" y="8" width="44" height="32" rx="4" class="pv-axis" /><path d="M18 18h28M18 25h20M18 32h24" /><circle cx="46" cy="32" r="2.2" class="pv-dot" /></>,
};
export function PracticumPreview({ kind }: { kind: PreviewKind }) {
  return <svg class={`pc-preview pv-${kind}`} viewBox="0 0 64 48" width="64" height="48" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{P[kind]}</svg>;
}

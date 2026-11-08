/**
 * Odometer — цифры «докручиваются» до значения, как барабан табло.
 * Паттерн: 21st.dev «Number Ticker» (danielpetho / shadcnspace) — колонка 0–9 на цифру,
 * сдвиг transform: translateY. Адаптация: без framer-motion и spring-физики — один
 * CSS-transition на колонку + каскадная задержка; только transform → композитный слой,
 * без перерисовки текста. Скринридер получает готовую строку (aria-label), а не барабан.
 */
import { useEffect, useState } from "preact/hooks";

const DIG = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function Odometer({ value, label, from = "" }: { value: string; label: string; from?: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let b = 0;
    const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setOn(true)); });
    return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
  }, []);
  const chars = [...value];
  return (
    <span class="odo l-h l-top l-inl l-g0 f-num" role="img" aria-label={label}>
      {chars.map((ch, i) => {
        if (!/\d/.test(ch)) return <span key={i} class="odo-sep" aria-hidden="true">{ch}</span>;
        const start = Number(from[i] ?? 0) || 0;
        const d = on ? Number(ch) : start;
        return (
          <span key={i} class="odo-col o-h" aria-hidden="true">
            <span class="odo-strip l-v l-g0" style={{ transform: `translateY(${-d * 10}%)`, transitionDelay: `${i * 80}ms` }}>
              {DIG.map((x) => <span key={x}>{x}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

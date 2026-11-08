import { useEffect, useRef, useState } from "preact/hooks";

/** Плавный «отсчёт» числа (минуты, очки). При reduced-motion — сразу финальное значение. */
export function useCountTo(target: number, from: number, ms = 900): number {
  const [v, setV] = useState(target);
  const raf = useRef(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === target) { setV(target); return; }
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 4);
      setV(Math.round(from + (target - from) * e));
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, from, ms]);
  return v;
}

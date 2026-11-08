import { h, type ComponentType, type VNode } from "preact";
import { useEffect, useState } from "preact/hooks";

/** v3.2 · PERF-01: ленивый компонент без preact/compat.
 *  when(props) — грузить чанк только когда компонент реально нужен (шторка открыта);
 *  preload() — фоновая догрузка после первого экрана (lazyIdle). Сбой сети — честная плашка с повтором. */
type Opts<P> = { when?: (p: P) => boolean; fallback?: (p: P) => VNode | null };
type Lazy<P> = ComponentType<P> & { preload: () => Promise<unknown> };
const all: Array<() => Promise<unknown>> = [];

export function lazy<P extends object>(load: () => Promise<ComponentType<P>>, opts: Opts<NoInfer<P>> = {}): Lazy<P> {
  let C: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => (pending ??= load().then((c) => (C = c), (e) => { pending = null; throw e; }));
  function LazyView(props: P) {
    const want = !opts.when || opts.when(props);
    const [, setTick] = useState(0);
    const [failed, setFailed] = useState(0);
    useEffect(() => {
      if (C || !want || failed < 0) return;
      let live = true;
      get().then(() => { if (live) setTick((n) => n + 1); }, () => { if (live) setFailed(-1); });
      return () => { live = false; };
    }, [want, failed]);
    if (C) return h(C as ComponentType<P>, props);
    if (failed < 0 && want) return <div class="lazy-fail" role="alert"><p>Раздел не загрузился — проверь связь.</p>
      <button type="button" class="btn btn-secondary btn-sm" onClick={() => setFailed(1)}>Повторить</button></div>;
    return want && opts.fallback ? opts.fallback(props) : null;
  }
  all.push(() => get().catch(() => undefined));
  return Object.assign(LazyView as ComponentType<P>, { preload: get });
}

let idleStarted = false;
/** Догрузить все ленивые чанки, когда первый экран уже показан (последовательно, чтобы не забивать слабую сеть). */
export function lazyIdle(delay = 1200): void {
  if (idleStarted || typeof window === "undefined") return;
  idleStarted = true;
  const run = async () => { for (const p of all) await p(); };
  const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  setTimeout(() => (idle ? idle(() => void run(), { timeout: 3000 }) : void run()), delay);
}

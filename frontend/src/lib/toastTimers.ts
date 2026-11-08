/** Owned notification timers: pause, dismiss, eviction and unmount all cancel work. */
export function createToastTimers(
  expire: (id: number) => void,
  schedule: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const pause = (id: number) => {
    const handle = timers.get(id);
    if (handle !== undefined) cancel(handle);
    timers.delete(id);
  };
  return {
    arm(id: number, ms: number) {
      pause(id);
      timers.set(
        id,
        schedule(() => {
          timers.delete(id);
          expire(id);
        }, ms),
      );
    },
    pause,
    retain(ids: Set<number>) {
      for (const id of timers.keys()) if (!ids.has(id)) pause(id);
    },
    dispose() {
      for (const id of timers.keys()) pause(id);
    },
  };
}

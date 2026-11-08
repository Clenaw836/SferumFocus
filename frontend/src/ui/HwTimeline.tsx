/** Recovery 2: history of one assignment — the same server events for the teacher and the student. */
import { ACTOR, delayText, eventDetail, when } from "../lib/hwFormat";
import type { HwEvent } from "../lib/hwTypes";

export function HwTimeline({ events, viewer }: { events: HwEvent[]; viewer: "teacher" | "student" }) {
  if (!events.length) return <p class="muted hw-pad f-b mt-1 mb-2">Событий пока нет.</p>;
  return <ol class="hw-timeline l-v mt-1" aria-label="История задания">{events.map((e) => {
    const detail = eventDetail(e), delay = delayText(e);
    const who = viewer === "student" && e.actor === "student" ? "вы" : ACTOR[e.actor];
    return <li key={e.seq} class={`k-${e.kind}`}>
      <time class="f-3" dateTime={e.effective_at}>{when(e.effective_at)}</time>
      <span><b>{e.label}</b> <small>· {who}{detail ? ` · ${detail}` : ""}</small>{delay && <small class="hw-delay l-blk">{delay}</small>}</span>
    </li>;
  })}</ol>;
}

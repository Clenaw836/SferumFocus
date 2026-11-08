/** Stable, non-interactive placeholders. Never presented as real school records. */
export function LoadingRows({label, rows = 3}: {label: string; rows?: number}) {
  return <div class="loading-rows mt-4 mb-4" role="status" aria-label={label}>
    <span class="sr">{label}…</span>
    <div aria-hidden="true">{Array.from({length: rows}, (_, index) =>
      <div class="loading-row l-v l-g3 b-sep" key={index}><i/><i/></div>)}</div>
  </div>;
}

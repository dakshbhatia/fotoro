export function PhotoPicks({count, total, ready, busy, done, detail, reviewing, onReview, onSave}: {
  count: number; total: number; ready: number; busy: boolean; done: number; detail?: string;
  reviewing: boolean; onReview: () => void;
  onSave?: () => void;
}) {
  const missing = Math.max(0, count - ready);
  const context = !busy && missing ? `Reopen ${missing} ${missing === 1 ? "original" : "originals"} to sync` : detail;
  return <section className="photo-picks" aria-label="Photo selection">
    <div className="photo-pick-status" role="status">
      <p className="photo-pick-count">{busy ? `Choosing photos… ${done} of ${total}` : <>{count} selected <span>· {total} {total === 1 ? "photo" : "photos"}</span></>}</p>
      {context && <p className="photo-pick-context">{context}</p>}
    </div>
    <div className="header-actions">
      {onSave && <button disabled={busy || !count || ready < count} onClick={onSave} aria-label={`Save ${count} selected ${count === 1 ? "photo" : "photos"}`}>Save {count}</button>}
      <button aria-label={reviewing ? "Done editing selection" : "Edit selection"} aria-pressed={reviewing} onClick={onReview}>{reviewing ? "Done" : "Edit"}</button>
    </div>
  </section>;
}

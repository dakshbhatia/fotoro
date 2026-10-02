export function PhotoPicks({count, total, ready, busy, done, unassessed, reviewing, onReview, onAll, onSuggested}: {
  count: number; total: number; ready: number; busy: boolean; done: number; unassessed: number;
  reviewing: boolean; onReview: () => void; onAll: () => void; onSuggested: () => void;
}) {
  return <section className="photo-picks" aria-label="Photo selection">
    <p className="photo-pick-count" role="status">{busy ? `Choosing photos… ${done} of ${total}` : `${count} of ${total} selected`}</p>
    <p className="hint">{busy ? "You can keep browsing and searching." : `${ready} ${ready === 1 ? "original is" : "originals are"} ready for Sync. All photos remain available.`}</p>
    {!busy && unassessed > 0 && <p className="hint">{unassessed} could not be assessed. You can still select them.</p>}
    <div className="photo-pick-actions">
      <button aria-label={reviewing ? "Done reviewing picks" : "Review picks"} aria-pressed={reviewing} onClick={onReview}>{reviewing ? "Done" : "Review"}</button>
      <button onClick={onSuggested} disabled={busy}>Suggested 10%</button>
      <button onClick={onAll}>Select all</button>
    </div>
  </section>;
}

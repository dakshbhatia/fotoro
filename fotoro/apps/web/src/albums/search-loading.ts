import type {AlbumActionQueue} from "./action-queue";

// Continue metadata pages only. Each page yields to queued user actions and
// reacquires the cursor, since a refresh can replace it while search waits.
export async function loadAlbumSearchPages({queue, current, page, load}: {
  queue: AlbumActionQueue; current: () => boolean;
  page: () => {hasMore: boolean; nextCursor?: string};
  load: (cursor: string) => Promise<void>;
}) {
  for (let count = 0; current() && page().hasMore; count++) {
    if (count >= 10) throw new Error("ALBUM_PAGE_MISMATCH");
    const ran = await queue.runWhenIdle(async () => {
      const before = page(); if (!before.hasMore) return;
      if (!before.nextCursor) throw new Error("ALBUM_PAGE_MISMATCH");
      await load(before.nextCursor);
      if (current() && page().hasMore && page().nextCursor === before.nextCursor) throw new Error("ALBUM_PAGE_MISMATCH");
    }, current);
    if (!ran) return;
  }
}

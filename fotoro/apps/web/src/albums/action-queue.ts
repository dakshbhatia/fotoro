// Foreground work waits behind a poll instead of disappearing during it.
export class AlbumActionQueue {
  private tail = Promise.resolve();
  private pending = 0;
  private foreground = 0;
  constructor(private current: () => boolean, private foregroundChanged: (busy: boolean) => void) {}
  run(task: () => Promise<void>, background = false): Promise<void> {
    if (!this.current() || background && this.pending > 0) return Promise.resolve();
    this.pending++;
    if (!background && ++this.foreground === 1) this.foregroundChanged(true);
    const execution = this.tail.then(async () => {if (this.current()) await task();});
    const finished = execution.finally(() => {
      this.pending--;
      if (!background && --this.foreground === 0) this.foregroundChanged(false);
    });
    this.tail = finished.then(() => {}, () => {});
    return finished;
  }
}

export function bindAlbumAction<T>(currentSource: () => T, task: () => Promise<void>, changed: () => void) {
  const source = currentSource();
  return async () => {
    if (currentSource() !== source) {changed(); return;}
    await task();
  };
}

// One bounded batch at a time. A failed draft waits for another explicit edit or manual retry.
export class BackgroundAnnotations {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private flight?: Promise<void>;
  private blocked = new Set<string>();
  private queued?: {key: string; save: (signal: AbortSignal) => Promise<void>};
  request(key: string, save: (signal: AbortSignal) => Promise<void>) {
    if (this.blocked.has(key)) return;
    this.queued = {key, save};
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {this.timer = undefined; this.flush();}, 700);
  }
  private flush() {
    if (this.flight || !this.queued) return;
    const job = this.queued; this.queued = undefined;
    const controller = new AbortController(); this.controller = controller;
    const flight = Promise.resolve().then(() => job.save(controller.signal)).catch(() => {
      if (!controller.signal.aborted) {
        this.blocked.add(job.key);
        if (this.blocked.size > 64) this.blocked.delete(this.blocked.values().next().value!);
      }
    }).finally(() => {
      if (this.flight === flight) {this.flight = undefined; this.controller = undefined;}
      if (this.queued && !this.timer) this.request(this.queued.key, this.queued.save);
    });
    this.flight = flight;
  }
  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.queued = undefined;
    this.controller?.abort();
    await this.flight;
  }
}

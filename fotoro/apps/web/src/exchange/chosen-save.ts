import type { LocalPhoto } from "../local/resources";

export interface ChosenSaveSnapshot {
  readonly photos: readonly LocalPhoto[];
  readonly files: readonly File[];
}

/* A Save click authorizes this exact selection once, after the chosen account opens. */
export class ChosenSaveIntent {
  readonly snapshot: ChosenSaveSnapshot;
  private state: "pending" | "running" | "complete" | "cancelled" = "pending";
  private started = false;
  private session?: object;
  private authentication?: { generation: number };
  private controller = new AbortController();

  constructor(photos: readonly LocalPhoto[], session?: object) {
    const files = new Set<File>();
    const sources = photos.flatMap(photo => {
      if (!(photo.file instanceof File) || files.has(photo.file)) return [];
      files.add(photo.file);
      const source: LocalPhoto = { ...photo, labels: photo.labels?.slice(), keywords: photo.keywords?.slice(), facts: photo.facts?.slice(), ocr: photo.ocr ? { ...photo.ocr } : undefined };
      for (const value of [source.labels, source.keywords, source.facts, source.ocr]) if (value) Object.freeze(value);
      return [Object.freeze(source)];
    });
    this.snapshot = Object.freeze({ photos: Object.freeze(sources), files: Object.freeze([...files]) });
    this.session = session;
  }

  get pending() { return this.state === "pending"; }
  get needsInitialSave() { return this.pending && !this.started; }
  get boundVault() { return this.session; }
  bindInitialVault(session: object) {
    if (this.pending && !this.session && !this.authentication) this.session = session;
  }
  beginAuthentication(generation: number) {
    if (!this.pending || this.session) return;
    return this.authentication = { generation };
  }
  finishAuthentication(ticket: { generation: number } | undefined, result?: {session: object; generation: number; current: () => boolean}, error?: unknown) {
    if (!ticket || this.authentication !== ticket) return;
    this.authentication = undefined;
    if (error instanceof Error && error.name === "AbortError") { this.cancel(); return; }
    if (!result) return; // A rejected password keeps the original Save available for retry.
    if (!this.pending || !result.current() || result.generation !== ticket.generation + 1) { this.cancel(); return; }
    this.session = result.session;
  }
  vaultLocked() {
    // unlockVault emits its own lock before installing the authenticated vault.
    if (this.session || !this.authentication) this.cancel();
  }
  cancel() {
    this.state = "cancelled";
    this.authentication = undefined;
    this.controller.abort();
  }
  async start(options: {
    active: boolean;
    busy: boolean;
    session: object;
    current: () => boolean;
    save: (snapshot: ChosenSaveSnapshot, signal: AbortSignal, current: () => boolean) => Promise<boolean>;
  }) {
    if (!this.pending || !options.active || options.busy || !this.session) return false;
    if (this.session !== options.session || !options.current()) { this.cancel(); return false; }
    this.started = true;
    this.state = "running";
    const current = () => this.state === "running" && options.current() && !this.controller.signal.aborted;
    try {
      const accepted = await options.save(this.snapshot, this.controller.signal, current);
      if (this.state === "running") this.state = accepted ? "complete" : current() ? "pending" : "cancelled";
      return accepted;
    } catch (error) {
      if (current()) this.state = "pending";
      else this.cancel();
      throw error;
    }
  }
}

import type {Photo} from "../library/catalog";
import type {IncomingAlbumIntent} from "./intent";

export interface AlbumEntrySelection {revision: number; photos: Photo[];}

// A new same-page invitation gets a fresh panel lifetime, even for the same album/card.
export class AlbumEntryRevision {
  private incoming: IncomingAlbumIntent | null | undefined;
  private revision = 0;
  private returning?: {incoming: IncomingAlbumIntent; session: object; origin: string};
  key(incoming: IncomingAlbumIntent | null | undefined) {
    if (incoming !== this.incoming) {this.incoming = incoming; this.revision++; this.cancelReturn();}
    return this.revision;
  }
  capture(photos: readonly Photo[]): AlbumEntrySelection {return {revision: this.revision, photos: [...photos]};}
  photos(selection: AlbumEntrySelection | null): Photo[] {return selection?.revision === this.revision ? selection.photos : [];}
  suspend(incoming: IncomingAlbumIntent | null | undefined, session: object | undefined, origin: string) {
    this.cancelReturn();
    if (!session || incoming !== this.incoming || !incoming?.current(session)) return false;
    this.returning = {incoming, session, origin}; return true;
  }
  resume(incoming: IncomingAlbumIntent | null | undefined, session: object | undefined, origin: string, active: boolean) {
    const returning = this.returning; this.cancelReturn();
    if (!returning || !active || incoming !== returning.incoming || session !== returning.session
      || origin !== returning.origin || !incoming.current(session)) return false;
    // Force fresh verification even if hidden/visible events share a React commit.
    this.revision++; return true;
  }
  cancelReturn() {this.returning = undefined;}
}

export function subscribeAlbumLifetime(windowTarget: EventTarget, documentTarget: EventTarget & {visibilityState: string}, dispose: () => void, close: () => void, suspend = close) {
  const hidden = () => {if (documentTarget.visibilityState === "hidden") suspend();};
  // The account owner decides whether this lock retains an incoming invitation.
  // Stop private work immediately without turning reauthentication into Close.
  windowTarget.addEventListener("fotoro-lock", dispose);
  windowTarget.addEventListener("pagehide", close);
  documentTarget.addEventListener("visibilitychange", hidden);
  return () => {
    dispose();
    windowTarget.removeEventListener("fotoro-lock", dispose);
    windowTarget.removeEventListener("pagehide", close);
    documentTarget.removeEventListener("visibilitychange", hidden);
  };
}

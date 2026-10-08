import type {Photo} from "../library/catalog";
import type {IncomingAlbumIntent} from "./intent";

export interface AlbumEntrySelection {revision: number; photos: Photo[];}

// A new same-page invitation gets a fresh panel lifetime, even for the same album/card.
export class AlbumEntryRevision {
  private incoming: IncomingAlbumIntent | null | undefined;
  private revision = 0;
  key(incoming: IncomingAlbumIntent | null | undefined) {
    if (incoming !== this.incoming) {this.incoming = incoming; this.revision++;}
    return this.revision;
  }
  capture(photos: readonly Photo[]): AlbumEntrySelection {return {revision: this.revision, photos: [...photos]};}
  photos(selection: AlbumEntrySelection | null): Photo[] {return selection?.revision === this.revision ? selection.photos : [];}
}

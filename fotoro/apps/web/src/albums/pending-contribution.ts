import type {Photo} from "../library/catalog";
import {ShareSelection} from "../exchange/sharing";

// Saving succeeded; a retry must contribute these exact Saved sources, never
// import the device originals again with fresh photo IDs.
export class PendingAlbumContribution {
  private readonly selection: ShareSelection;
  constructor(photos: readonly Photo[], private readonly admitted: (photos: readonly Photo[]) => boolean) {
    this.selection = new ShareSelection(photos);
  }
  get current() {
    if (!this.selection.current) return false;
    if (this.admitted(this.selection.photos)) return true;
    this.cancel(); return false;
  }
  get count() {return this.selection.photos.length;}
  cancel() {this.selection.dispose();}
  async add(add: (photos: readonly Photo[]) => Promise<number>) {
    const check = () => {if (!this.current) {this.cancel(); throw new DOMException("Trip closed", "AbortError");}};
    check();
    try {
      const added = await add(this.selection.photos);
      check(); this.cancel(); return added;
    } catch (error) {
      if (!this.current) this.cancel();
      throw error;
    }
  }
}

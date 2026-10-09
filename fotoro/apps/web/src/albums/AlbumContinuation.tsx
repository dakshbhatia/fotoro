import type {Photo} from "../library/catalog";

export interface AlbumDestination {albumId: string; current: () => boolean;}
// The destination survives leaving the panel; photo choices are captured only on this gesture.
export function AlbumContinuation({destination, photos, disabled, onContinue}: {destination: AlbumDestination | null; photos: readonly Photo[]; disabled?: boolean; onContinue: (photos: Photo[], albumId: string) => void}) {
  if (!destination?.current()) return null;
  return <button className="primary-action" disabled={disabled || !photos.length} onClick={() => {
    if (!disabled && photos.length && destination.current()) onContinue([...photos], destination.albumId);
  }}>Continue to trip</button>;
}

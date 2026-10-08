import {lazy, Suspense, type ComponentProps} from "react";
import type {Albums as AlbumsComponent} from "./Albums";

const Albums = lazy(() => import("./Albums").then(module => ({default: module.Albums})));
type Props = Omit<ComponentProps<typeof AlbumsComponent>, "onChoosePhotos"> & {onChoosePhotos: () => void; onIncomingDone?: () => void};

export function AlbumPanel({onClose, onChoosePhotos, onIncomingDone, incoming, ...props}: Props) {
  const close = () => {onClose(); onIncomingDone?.();};
  const choosePhotos = (albumId: string) => {
    onClose();
    // Preserve an invitation only when choosing photos for that same album.
    if (incoming?.pending && incoming.link.albumId !== albumId) onIncomingDone?.();
    onChoosePhotos();
  };
  return <Suspense fallback={<aside className="albums-sheet" role="dialog" aria-modal="true" aria-label="Live albums"><header><p role="status">Opening albums…</p><button autoFocus onClick={close}>Close</button></header></aside>}>
    <Albums {...props} onClose={close} onChoosePhotos={choosePhotos} incoming={incoming?.pending ? incoming : undefined} />
  </Suspense>;
}

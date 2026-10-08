import {lazy, Suspense, type ComponentProps} from "react";
import type {Albums as AlbumsComponent} from "./Albums";

const Albums = lazy(() => import("./Albums").then(module => ({default: module.Albums})));
type Props = ComponentProps<typeof AlbumsComponent> & {onIncomingDone?: () => void};

export function AlbumPanel({onClose, onChoosePhotos, onIncomingDone, incoming, ...props}: Props) {
  const close = () => {onClose(); onIncomingDone?.();};
  // Choosing Saved photos leaves the panel, while its verified invitation remains pending.
  const choosePhotos = () => {onClose(); onChoosePhotos();};
  return <Suspense fallback={<aside className="albums-sheet" role="dialog" aria-modal="true" aria-label="Live albums"><header><p role="status">Opening albums…</p><button autoFocus onClick={close}>Close</button></header></aside>}>
    <Albums {...props} onClose={close} onChoosePhotos={choosePhotos} incoming={incoming?.pending ? incoming : undefined} />
  </Suspense>;
}

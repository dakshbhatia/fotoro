import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
import type { LocalPhoto } from "./local/resources";
import type { ConsumerSyncSummary } from "./library/consumer-sync";
import type { OwnedPhotoSnapshot } from "./library/consumer-search";
import { ChosenSaveIntent } from "./exchange/chosen-save";
const CloudApp = lazy(() => import("./CloudApp"));
const SavedViewer = lazy(() => import("./library/Viewer").then(module => ({default: module.Viewer})));
export default function App() {
  const [cloud, setCloud] = useState(false),
    [opened, setOpened] = useState(false),
    [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([]),
    [syncSummary, setSyncSummary] = useState<ConsumerSyncSummary>({state: "notStarted", skippedPhotos: 0, action: "signIn"}),
    [ownedPhotos, setOwnedPhotos] = useState<OwnedPhotoSnapshot | null>(null),
    [savedViewer, setSavedViewer] = useState<string | null>(null),
    [saveIntent, setSaveIntent] = useState<ChosenSaveIntent | null>(null);
  const pendingSave = useRef<ChosenSaveIntent | null>(null);
  const cancelSave = useCallback(() => {pendingSave.current?.cancel(); pendingSave.current = null; setSaveIntent(null);}, []);
  const syncOpener = useRef<HTMLElement | null>(null);
  const returnToPhotos = () => {
    cancelSave();
    setCloud(false);
    requestAnimationFrame(() => {
      const opener = syncOpener.current;
      const target = opener?.isConnected && !opener.closest("[hidden],[inert]")
        ? opener : document.querySelector<HTMLButtonElement>(".local-trial .sync-pill");
      target?.focus({preventScroll: true});
    });
  };
  useEffect(() => {
    const locked = () => {setOwnedPhotos(null); setSavedViewer(null); pendingSave.current?.vaultLocked();};
    const hidden = () => {if (document.visibilityState === "hidden") cancelSave();};
    window.addEventListener("fotoro-lock", locked);
    window.addEventListener("pagehide", cancelSave);
    window.addEventListener("storage", cancelSave);
    document.addEventListener("visibilitychange", hidden);
    return () => {window.removeEventListener("fotoro-lock", locked); window.removeEventListener("pagehide", cancelSave); window.removeEventListener("storage", cancelSave); document.removeEventListener("visibilitychange", hidden); pendingSave.current?.cancel();};
  }, [cancelSave]);
  const viewingSaved = !!savedViewer && !!ownedPhotos?.current() && ownedPhotos.photos.some(photo => photo.manifest.photoId === savedViewer);
  useEffect(() => {if (savedViewer && !viewingSaved) setSavedViewer(null);}, [savedViewer, viewingSaved]);
  return (
    <>
      <div hidden={cloud} inert={viewingSaved ? true : undefined}>
        <LocalTrial
          active={!cloud}
          onPhotosChange={setLocalPhotos}
          syncSummary={syncSummary}
          ownedPhotos={ownedPhotos}
          onOpenSaved={setSavedViewer}
          onCancelSave={cancelSave}
          onSave={photos => {
            cancelSave();
            const intent = new ChosenSaveIntent(photos, ownedPhotos?.current() ? ownedPhotos.token : undefined);
            if (!intent.snapshot.files.length) return;
            pendingSave.current = intent;
            setSaveIntent(intent);
            setLocalPhotos([...intent.snapshot.photos]);
            syncOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setOpened(true); setCloud(true);
          }}
          onBackup={() => {
            cancelSave();
            syncOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setOpened(true);
            setCloud(true);
          }}
        />
      </div>
      {opened && (
        <div hidden={!cloud}>
          <Suspense fallback={<p className="hint">Opening Fotoro…</p>}>
            <CloudApp
              active={cloud}
              saveIntent={saveIntent}
              localPhotos={localPhotos}
              onSyncSummary={setSyncSummary}
              onOwnedPhotos={setOwnedPhotos}
              onBack={returnToPhotos}
            />
          </Suspense>
        </div>
      )}
      {viewingSaved && ownedPhotos && savedViewer && <Suspense fallback={<p className="busy" role="status">Opening photo…</p>}><SavedViewer key={savedViewer} photos={ownedPhotos.photos} initial={savedViewer} onSaved={() => {}} onClose={() => setSavedViewer(null)} /></Suspense>}
    </>
  );
}

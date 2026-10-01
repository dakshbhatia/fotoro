import { lazy, Suspense, useEffect, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
import type { LocalPhoto } from "./local/resources";
import type { ConsumerSyncSummary } from "./library/consumer-sync";
import type { OwnedPhotoSnapshot } from "./library/consumer-search";
const CloudApp = lazy(() => import("./CloudApp"));
const SavedViewer = lazy(() => import("./library/Viewer").then(module => ({default: module.Viewer})));
export default function App() {
  const [cloud, setCloud] = useState(false),
    [opened, setOpened] = useState(false),
    [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([]),
    [syncSummary, setSyncSummary] = useState<ConsumerSyncSummary>({state: "notStarted", skippedPhotos: 0, action: "signIn"}),
    [ownedPhotos, setOwnedPhotos] = useState<OwnedPhotoSnapshot | null>(null),
    [savedViewer, setSavedViewer] = useState<string | null>(null);
  useEffect(() => {
    const locked = () => {setOwnedPhotos(null); setSavedViewer(null);};
    window.addEventListener("fotoro-lock", locked); return () => window.removeEventListener("fotoro-lock", locked);
  }, []);
  const viewingSaved = !!savedViewer && !!ownedPhotos?.current() && ownedPhotos.photos.some(photo => photo.manifest.photoId === savedViewer);
  useEffect(() => {if (savedViewer && !viewingSaved) setSavedViewer(null);}, [savedViewer, viewingSaved]);
  return (
    <>
      <div hidden={cloud} inert={viewingSaved ? true : undefined}>
        <LocalTrial
          onPhotosChange={setLocalPhotos}
          syncSummary={syncSummary}
          ownedPhotos={ownedPhotos}
          onOpenSaved={setSavedViewer}
          onBackup={() => {
            setOpened(true);
            setCloud(true);
          }}
        />
      </div>
      {opened && (
        <div hidden={!cloud}>
          <Suspense fallback={<p className="hint">Opening Sync photos…</p>}>
            <CloudApp
              active={cloud}
              localPhotos={localPhotos}
              onSyncSummary={setSyncSummary}
              onOwnedPhotos={setOwnedPhotos}
              onBack={() => setCloud(false)}
            />
          </Suspense>
        </div>
      )}
      {viewingSaved && ownedPhotos && savedViewer && <Suspense fallback={<p className="busy" role="status">Opening photo…</p>}><SavedViewer key={savedViewer} photos={ownedPhotos.photos} initial={savedViewer} onSaved={() => {}} onClose={() => setSavedViewer(null)} /></Suspense>}
    </>
  );
}

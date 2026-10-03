import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
import type { LocalPhoto } from "./local/resources";
import type { ConsumerSyncSummary } from "./library/consumer-sync";
import type { OwnedPhotoSnapshot } from "./library/consumer-search";
import { ChosenSaveIntent } from "./exchange/chosen-save";
import {IncomingShareIntent} from "./exchange/sharing";
import {parseShareLink} from "@fotoro/contracts/share-links";
import {requireVault} from "./vault/vault";
import type {Photo} from "./library/catalog";
function readIncomingLink() {
  if (!/^#(?:contact|moment)=/.test(location.hash)) return null;
  try {
    let session;
    try {session = requireVault();} catch {}
    return new IncomingShareIntent(parseShareLink(location.href, location.origin), session);
  } catch {return null;}
}
const CloudApp = lazy(() => import("./CloudApp"));
const SavedViewer = lazy(() => import("./library/Viewer").then(module => ({default: module.Viewer})));
export default function App() {
  const [incoming, setIncoming] = useState(readIncomingLink);
  const [incomingError, setIncomingError] = useState(() => /^#(?:contact|moment)=/.test(location.hash) && !incoming ? "This link could not be opened. Ask the sender for a new Fotoro link." : "");
  const [cloud, setCloud] = useState(() => !!incoming || !!incomingError),
    [opened, setOpened] = useState(() => !!incoming || !!incomingError),
    [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([]),
    [syncSummary, setSyncSummary] = useState<ConsumerSyncSummary>({state: "notStarted", skippedPhotos: 0, action: "signIn"}),
    [ownedPhotos, setOwnedPhotos] = useState<OwnedPhotoSnapshot | null>(null),
    [savedViewer, setSavedViewer] = useState<string | null>(null),
    [saveIntent, setSaveIntent] = useState<ChosenSaveIntent | null>(null),
    [sharePhotos, setSharePhotos] = useState<Photo[] | null>(null);
  const pendingShare = useRef(incoming);
  const cancelIncoming = useCallback(() => {
    pendingShare.current?.cancel(); pendingShare.current = null; setIncoming(null); setIncomingError("");
    if (/^#(?:contact|moment)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  }, []);
  useEffect(() => {
    const changed = () => {
      pendingShare.current?.cancel();
      const intent = readIncomingLink(); pendingShare.current = intent; setIncoming(intent);
      const invalid = /^#(?:contact|moment)=/.test(location.hash) && !intent;
      setIncomingError(invalid ? "This link could not be opened. Ask the sender for a new Fotoro link." : "");
      if (intent || invalid) {setOpened(true); setCloud(true);}
    };
    window.addEventListener("hashchange", changed);
    return () => {window.removeEventListener("hashchange", changed); pendingShare.current?.cancel();};
  }, []);
  const pendingSave = useRef<ChosenSaveIntent | null>(null);
  const cancelSave = useCallback(() => {pendingSave.current?.cancel(); pendingSave.current = null; setSaveIntent(null);}, []);
  const syncOpener = useRef<HTMLElement | null>(null);
  const returnToPhotos = () => {
    cancelSave(); cancelIncoming(); setSharePhotos(null);
    setCloud(false);
    requestAnimationFrame(() => {
      const opener = syncOpener.current;
      const target = opener?.isConnected && !opener.closest("[hidden],[inert]")
        ? opener : document.querySelector<HTMLButtonElement>(".local-trial .sync-pill");
      target?.focus({preventScroll: true});
    });
  };
  useEffect(() => {
    const locked = () => {setOwnedPhotos(null); setSavedViewer(null); setSharePhotos(null); pendingSave.current?.vaultLocked(); pendingShare.current?.vaultLocked(); if (pendingShare.current && !pendingShare.current.pending) cancelIncoming();};
    const hidden = () => {if (document.visibilityState === "hidden") cancelSave();};
    window.addEventListener("fotoro-lock", locked);
    window.addEventListener("pagehide", cancelSave);
    window.addEventListener("pagehide", cancelIncoming);
    window.addEventListener("storage", cancelSave);
    window.addEventListener("storage", cancelIncoming);
    document.addEventListener("visibilitychange", hidden);
    return () => {window.removeEventListener("fotoro-lock", locked); window.removeEventListener("pagehide", cancelSave); window.removeEventListener("pagehide", cancelIncoming); window.removeEventListener("storage", cancelSave); window.removeEventListener("storage", cancelIncoming); document.removeEventListener("visibilitychange", hidden); pendingSave.current?.cancel();};
  }, [cancelSave, cancelIncoming]);
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
              incoming={incoming}
              incomingError={incomingError}
              onIncomingDone={cancelIncoming}
              sharePhotos={sharePhotos}
              onShareDone={() => setSharePhotos(null)}
              localPhotos={localPhotos}
              onSyncSummary={setSyncSummary}
              onOwnedPhotos={setOwnedPhotos}
              onBack={returnToPhotos}
            />
          </Suspense>
        </div>
      )}
      {viewingSaved && ownedPhotos && savedViewer && <Suspense fallback={<p className="busy" role="status">Opening photo…</p>}><SavedViewer key={savedViewer} photos={ownedPhotos.photos} initial={savedViewer} onSaved={() => {}} onShare={photo => {
        if (!ownedPhotos.current() || !ownedPhotos.photos.includes(photo)) return;
        setSavedViewer(null); setSharePhotos([photo]); setOpened(true); setCloud(true);
      }} onClose={() => setSavedViewer(null)} /></Suspense>}
    </>
  );
}

import { lazy, Suspense, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
import type { LocalPhoto } from "./local/resources";
const CloudApp = lazy(() => import("./CloudApp"));
export default function App() {
  const [cloud, setCloud] = useState(false),
    [opened, setOpened] = useState(false),
    [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([]);
  return (
    <>
      <div hidden={cloud}>
        <LocalTrial
          onPhotosChange={setLocalPhotos}
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
              onBack={() => setCloud(false)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

import { lazy, Suspense, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
const CloudApp = lazy(() => import("./CloudApp"));
export default function App() {
  const [cloud, setCloud] = useState(false),
    [opened, setOpened] = useState(false),
    [localFiles, setLocalFiles] = useState<File[]>([]);
  return (
    <>
      <div hidden={cloud}>
        <LocalTrial
          onPhotosChange={setLocalFiles}
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
              localFiles={localFiles}
              onBack={() => setCloud(false)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

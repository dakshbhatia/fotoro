import { lazy, Suspense, useState } from "react";
import { LocalTrial } from "./local/LocalTrial";
const CloudApp = lazy(() => import("./CloudApp"));
export default function App() {
  const [cloud, setCloud] = useState(false);
  return (
    <>
      <div hidden={cloud}>
        <LocalTrial onBackup={() => setCloud(true)} />
      </div>
      {cloud && (
        <Suspense fallback={<p className="hint">Opening backup & sharing…</p>}>
          <CloudApp onBack={() => setCloud(false)} />
        </Suspense>
      )}
    </>
  );
}

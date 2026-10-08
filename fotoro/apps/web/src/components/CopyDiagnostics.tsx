import {useState} from "react";
import {exportDiagnostics} from "../diagnostics";

export function CopyDiagnostics() {
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState<string>();
  const copy = async () => {
    const value = exportDiagnostics();
    try {await navigator.clipboard.writeText(value); setFallback(undefined); setNotice("Diagnostics copied.");}
    catch {setFallback(value); setNotice("Select and copy diagnostics below.");}
  };
  return <div><button onClick={() => {void copy();}}>Copy diagnostics</button>
    <p className="hint">Recent operation results from this tab. Photo details and passwords are excluded.</p>
    {notice && <p role="status">{notice}</p>}
    {fallback && <textarea aria-label="Diagnostics to copy" readOnly value={fallback} onFocus={event => event.currentTarget.select()} />}
  </div>;
}

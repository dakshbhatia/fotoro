import {useRef, useState} from "react";
import {clearDiagnostics, exportDiagnostics} from "../diagnostics";

export function CopyDiagnostics() {
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState<string>();
  const copyVersion = useRef(0);
  const copy = async () => {
    const value = exportDiagnostics(), version = ++copyVersion.current;
    try {await navigator.clipboard.writeText(value); if (copyVersion.current === version) {setFallback(undefined); setNotice("Diagnostics copied.");}}
    catch {if (copyVersion.current === version) {setFallback(value); setNotice("Select and copy diagnostics below.");}}
  };
  return <div><button onClick={() => {void copy();}}>Copy diagnostics</button>
    <button onClick={() => {copyVersion.current++; clearDiagnostics(); setFallback(undefined); setNotice("Diagnostics cleared.");}}>Clear diagnostics</button>
    <p className="hint">Recent operation results stay in this tab across reloads. Photo details and passwords are excluded.</p>
    {notice && <p role="status">{notice}</p>}
    {fallback && <textarea aria-label="Diagnostics to copy" readOnly value={fallback} onFocus={event => event.currentTarget.select()} />}
  </div>;
}

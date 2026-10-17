import {useRef, useState} from "react";
import {clearDiagnostics, diagnosticSummary, exportDiagnostics} from "../diagnostics";

export function CopyDiagnostics() {
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState<string>();
  const [summary, setSummary] = useState(diagnosticSummary);
  const copyVersion = useRef(0);
  const copy = async () => {
    const value = exportDiagnostics(), version = ++copyVersion.current;
    try {await navigator.clipboard.writeText(value); if (copyVersion.current === version) {setFallback(undefined); setNotice("Diagnostics copied.");}}
    catch {if (copyVersion.current === version) {setFallback(value); setNotice("Select and copy diagnostics below.");}}
  };
  return <div><button onClick={() => {void copy();}}>Copy diagnostics</button>
    <button onClick={() => {copyVersion.current++; clearDiagnostics(); setSummary([]); setFallback(undefined); setNotice("Diagnostics cleared.");}}>Clear diagnostics</button>
    <p className="hint">Recent operation results stay in this tab across reloads. Photo details and passwords are excluded.</p>
    <details onToggle={event => {if (event.currentTarget.open) setSummary(diagnosticSummary());}}><summary>Recent performance and failures</summary>
      <p className="hint">This tab’s retained sample only. Timings cover successful operations, including waiting; they do not measure scrolling frame rate.</p>
      <button onClick={() => setSummary(diagnosticSummary())}>Refresh operation summary</button>
      {!summary.length ? <p>No completed operations in this sample.</p> : <ul>{summary.map(row => <li key={row.operation}>
        <strong>{row.operation}</strong>: {row.succeeded} succeeded · {row.failed} failed · {row.cancelled} cancelled
        {row.p50Ms !== undefined && <> · median {row.p50Ms} ms · 95th percentile {row.p95Ms} ms</>}
        {Object.entries(row.reasons).length > 0 && <span> · {Object.entries(row.reasons).map(([reason, count]) => `${reason}: ${count}`).join(" · ")}</span>}
      </li>)}</ul>}
    </details>
    {notice && <p role="status">{notice}</p>}
    {fallback && <textarea aria-label="Diagnostics to copy" readOnly value={fallback} onFocus={event => event.currentTarget.select()} />}
  </div>;
}

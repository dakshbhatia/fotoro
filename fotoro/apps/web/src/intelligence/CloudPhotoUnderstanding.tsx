import {useEffect, useRef, useState} from "react";
import {cloudCapabilities, observeCloudPhoto, prepareCloudPreview, observationMatches,
  type CloudConnection, type CloudPhotoBinding, type CloudModel, type CloudObservation} from "./cloud-photo";

export interface CloudPhotoUnderstandingProps extends CloudConnection, CloudPhotoBinding {
  scopeKey: string;
  current: () => boolean;
  getPreview: (signal: AbortSignal) => Promise<Blob>;
  onObservation: (observation: CloudObservation) => void | Promise<void>;
}
// Reset consent, results and in-flight work on every source or vault change.
export function CloudPhotoUnderstanding(props: CloudPhotoUnderstandingProps) {
  return <CloudPhotoUnderstandingSession key={JSON.stringify([props.scopeKey, props.apiBase, props.token, props.photoId, props.sourceRevision])} {...props}/>;
}
function CloudPhotoUnderstandingSession(props: CloudPhotoUnderstandingProps) {
  const [available, setAvailable] = useState(false), [consent, setConsent] = useState(false);
  const [model, setModel] = useState<CloudModel>("gemini-3.8-flash");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [kept, setKept] = useState(false);
  const [result, setResult] = useState<CloudObservation>();
  const request = useRef<AbortController | undefined>(undefined), alive = useRef(true), generation = useRef(0);
  const callbacks = useRef(props); callbacks.current = props;
  const current = () => alive.current && document.visibilityState !== "hidden" && callbacks.current.current();
  useEffect(() => {
    alive.current = true;
    let capabilitiesRequest: AbortController | undefined;
    const refresh = () => {
      if (!current()) return;
      const controller = new AbortController(); capabilitiesRequest?.abort(); capabilitiesRequest = controller;
      const epoch = generation.current;
      void cloudCapabilities(props, controller.signal).then(value => {
        if (!controller.signal.aborted && current() && generation.current === epoch) setAvailable(value);
      }).catch(() => {});
    };
    const clear = () => {
      generation.current++; capabilitiesRequest?.abort(); request.current?.abort();
      setAvailable(false); setConsent(false); setResult(undefined); setBusy(false); setError(""); setKept(false);
    };
    const visibility = () => {clear(); if (document.visibilityState !== "hidden") refresh();};
    refresh();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("fotoro-lock", clear);
    window.addEventListener("pagehide", clear);
    window.addEventListener("storage", clear);
    return () => {
      alive.current = false; generation.current++; capabilitiesRequest?.abort(); request.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("fotoro-lock", clear);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("storage", clear);
    };
  }, [props.apiBase, props.token]);
  async function analyze() {
    if (!consent || busy || !available || !current()) return;
    const controller = new AbortController(); request.current = controller;
    const epoch = generation.current;
    const active = () => current() && !controller.signal.aborted && epoch === generation.current;
    const timeout = setTimeout(() => controller.abort(), 45000);
    setBusy(true); setError(""); setResult(undefined); setKept(false);
    try {
      const source = await callbacks.current.getPreview(controller.signal);
      if (!active()) return;
      const preview = await prepareCloudPreview(source, controller.signal);
      if (!active()) return;
      const observation = await observeCloudPhoto(props, props, preview, model, "send-this-preview-to-google", controller.signal);
      if (!active() || !observationMatches(observation, callbacks.current)) return;
      setResult(observation);
    } catch (failure) {
      if (current() && epoch === generation.current) setError(controller.signal.aborted ? "Analysis canceled."
        : failure instanceof Error && failure.message === "CLOUD_WORK_LIMIT" ? "Cloud analysis limit reached. Try later."
        : "Cloud analysis unavailable. Check your connection or try later.");
    } finally {
      clearTimeout(timeout);
      if (alive.current && epoch === generation.current) {setBusy(false); setConsent(false);}
    }
  }
  async function keep() {
    if (!result || busy || !current() || !observationMatches(result, callbacks.current)) return;
    const epoch = generation.current;
    setBusy(true); setError("");
    try {
      await callbacks.current.onObservation(result);
      if (!current() || epoch !== generation.current || !observationMatches(result, callbacks.current)) return;
      setResult(undefined); setKept(true);
    } catch {
      if (current() && epoch === generation.current) setError("Could not keep observations. Try again.");
    } finally {if (alive.current && epoch === generation.current) setBusy(false);}
  }
  if (!available || !current()) return null;
  return <section aria-label="Optional cloud photo understanding">
    <h3>Cloud photo understanding</h3>
    <p>Google Gemini can observe objects, scenes, and visible text. Results may be wrong.</p>
    <p>This sends a reduced JPEG of this photo to Fotoro’s server and Google. It can include faces and visible text. <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">Google’s data terms</a></p>
    <label>Model <select value={model} disabled={busy} onChange={event => setModel(event.target.value as CloudModel)}>
      <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
      <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite</option>
    </select></label>
    <label><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)}/> Send this photo preview to Google for this analysis</label>
    <button type="button" disabled={!consent || busy} onClick={() => void analyze()}>{busy ? "Working…" : "Analyze photo"}</button>
    {busy && !result && <button type="button" onClick={() => request.current?.abort()}>Cancel</button>}
    {error && <p role="status">{error}</p>}
    {kept && <p role="status">Observations kept on this device.</p>}
    {result && <div aria-label="Machine observations">
      <h4>Machine observations</h4>
      {result.observations.objects.length > 0 && <p>Objects: {result.observations.objects.join(", ")}</p>}
      {result.observations.scene.length > 0 && <p>Scene: {result.observations.scene.join(", ")}</p>}
      {result.observations.visibleText && <p>Visible text: {result.observations.visibleText}</p>}
      {result.observations.uncertainty.length > 0 && <p>Uncertainty: {result.observations.uncertainty.join("; ")}</p>}
      <button type="button" disabled={busy} onClick={() => void keep()}>Keep observations</button>
      <button type="button" disabled={busy} onClick={() => {setResult(undefined); setConsent(false);}}>Discard observations</button>
    </div>}
  </section>;
}

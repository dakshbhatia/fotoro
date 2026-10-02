import {useState} from "react";
export interface LocalChoices {readText: boolean; retain: boolean}
const key = "fotoro.local-choices.v1";
export function loadLocalChoices(): LocalChoices | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value.readText === "boolean" && typeof value.retain === "boolean" ? value : undefined;
  } catch {return undefined;}
}
export function saveLocalChoices(value: LocalChoices) {
  try {localStorage.setItem(key, JSON.stringify(value));} catch {}
}
export function shouldOfferLocalChoices(hasPhotos: boolean, retained: boolean, choice?: LocalChoices) {
  return hasPhotos && !retained && !choice;
}
export function ConsumerChoices({onChoose}: {onChoose: (choice: LocalChoices) => void}) {
  const [readText, setReadText] = useState(false), [retain, setRetain] = useState(false);
  return <section className="consumer-choices" aria-label="Optional photo features">
    <div><h2>Make photos easier to find</h2><p className="hint">Your choice. Everything happens on this device.</p></div>
    <label className="choice-row"><input type="checkbox" checked={readText} onChange={event => setReadText(event.target.checked)} /><span>Find words in photos<small>Read English text on this device, including receipts and screenshots.</small></span></label>
    <label className="choice-row"><input type="checkbox" checked={retain} onChange={event => setRetain(event.target.checked)} /><span>Remember these photos<small>Keep search data and previews up to 100 MB in this browser. Originals need to be selected again to share.</small></span></label>
    <div className="actions"><button className="primary-action" onClick={() => onChoose({readText, retain})}>Continue</button><button className="text-button" onClick={() => onChoose({readText: false, retain: false})}>Not now</button></div>
  </section>;
}

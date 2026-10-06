import {annotationObservation} from "@fotoro/contracts/intelligence";
import {peopleNames} from "@fotoro/contracts/people";
export function KeptObservations({facts, photoId, sourceRevision}: {facts?: string[]; photoId: string; sourceRevision: string}) {
  const observation = annotationObservation({facts}, {photoId, sourceRevision});
  const names = peopleNames(facts, sourceRevision);
  return <>
    {names.length > 0 && <p>People: {names.join(", ")}</p>}
    {observation && <details><summary>Kept machine observations</summary>
      <p>{observation.processor} · {new Date(observation.observedAt).toLocaleString()}</p>
      {observation.observations.objects.length > 0 && <p>Objects: {observation.observations.objects.join(", ")}</p>}
      {observation.observations.scene.length > 0 && <p>Scene: {observation.observations.scene.join(", ")}</p>}
      {observation.observations.visibleText && <p>Visible text: {observation.observations.visibleText}</p>}
      {observation.observations.uncertainty.length > 0 && <p>Uncertainty: {observation.observations.uncertainty.join("; ")}</p>}
    </details>}
  </>;
}

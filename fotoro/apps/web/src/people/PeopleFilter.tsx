import {useLayoutEffect, useMemo, useState} from "react";
import type {SearchPhoto} from "../local/search";
import {emptyPeopleFilter, reviewedPeople, type PeopleFilter as Filter, type ReviewedPerson} from "./filter";

export function usePeopleFilter(photos: readonly SearchPhoto[], scope: unknown) {
  const [stored, setStored] = useState(() => ({scope, filter: emptyPeopleFilter()}));
  const filter = stored.scope === scope ? stored.filter : emptyPeopleFilter();
  const people = useMemo(() => reviewedPeople(photos), [photos]);
  const change = (filter: Filter) => setStored({scope, filter});
  useLayoutEffect(() => {setStored({scope, filter: emptyPeopleFilter()});}, [scope]);
  useLayoutEffect(() => {
    const clear = () => setStored({scope, filter: emptyPeopleFilter()});
    window.addEventListener("fotoro-lock", clear); window.addEventListener("pagehide", clear);
    return () => {window.removeEventListener("fotoro-lock", clear); window.removeEventListener("pagehide", clear);};
  }, [scope]);
  return {people, filter, change};
}
export function PeopleFilter({people, value, onChange, onReview, disabled = false}: {
  people: ReviewedPerson[]; value: Filter; onChange: (value: Filter) => void; onReview?: () => void; disabled?: boolean;
}) {
  const labels = useMemo(() => {
    const counts = new Map<string, number>(), positions = new Map<string, number>();
    for (const person of people) {const name = person.names.join(" / "); counts.set(name, (counts.get(name) ?? 0) + 1);}
    return new Map(people.map(person => {
      const name = person.names.join(" / "), position = (positions.get(name) ?? 0) + 1; positions.set(name, position);
      return [person.id, counts.get(name)! > 1 ? `${name} · Group ${position}` : name];
    }));
  }, [people]);
  if (!people.length && !value.ids.size && !onReview) return null;
  return <div className="people-filter-bar"><details className="people-filter" onKeyDown={event => {
    if (event.key === "Escape") {event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();}
  }}><summary>People{value.ids.size ? ` (${value.ids.size})` : ""}</summary><div className="people-filter-options">
    <fieldset disabled={disabled}><legend>Reviewed people</legend>
      {people.map(person => {
        return <label key={person.id}><input type="checkbox" checked={value.ids.has(person.id)} onChange={event => {
          const ids = new Set(value.ids); event.target.checked ? ids.add(person.id) : ids.delete(person.id); onChange({...value, ids});
        }} /><span>{labels.get(person.id)}</span><small>{person.photoCount} {person.photoCount === 1 ? "photo" : "photos"}</small></label>;
      })}
      {!people.length && <p className="hint">Name reviewed groups in People to filter photos.</p>}
      {value.ids.size > 0 && [...value.ids].some(id => !people.some(person => person.id === id)) && <p className="hint" role="status">A selected person is no longer available. Clear people to reset this filter.</p>}
    </fieldset>
    <label className="people-match-mode">Match<select aria-label="Match selected people" value={value.mode} disabled={disabled} onChange={event => onChange({...value, mode: event.target.value as Filter["mode"]})}>
      <option value="any">Any selected people</option><option value="everyone">Everyone in a photo</option>
    </select></label>
    <div className="actions">{value.ids.size > 0 && <button disabled={disabled} onClick={() => onChange(emptyPeopleFilter())}>Clear people</button>}{onReview && <button disabled={disabled} onClick={onReview}>Review and name people</button>}</div>
  </div></details>{value.ids.size > 0 && <div className="people-filter-chips" aria-label="Selected People filters">{[...value.ids].map(id => <button key={id} className="people-filter-chip" disabled={disabled}
    aria-label={`Remove ${labels.get(id) || "unavailable person"} from People filter`} onClick={() => {const ids = new Set(value.ids); ids.delete(id); onChange({...value, ids});}}>
    <span>{labels.get(id) || "Unavailable person"}</span><span aria-hidden="true">×</span></button>)}<span className="people-mode-chip">{value.mode === "everyone" ? "Everyone in a photo" : "Any selected people"}</span></div>}</div>;
}

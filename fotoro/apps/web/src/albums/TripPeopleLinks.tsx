import {useState} from "react";
import type {AccountCardV1, TripPersonLinkV1} from "@fotoro/contracts";
import type {ReviewedPerson} from "../people/filter";
import type {LinkedTripPerson} from "./people-links";
import type {PeopleLinksReview} from "../exchange/people-links";
export function TripPeopleLinks({sources, cards, linked, conflicts, disabled, pending, failed, label, onSave, onRemove, onResolve, onRetry}: {
  sources: readonly ReviewedPerson[]; cards: readonly AccountCardV1[]; linked: readonly LinkedTripPerson[]; conflicts: readonly PeopleLinksReview[];
  disabled: boolean; pending: boolean; failed: boolean; label: (id: string) => string;
  onSave: (name: string, aliases: TripPersonLinkV1["aliases"]) => void; onRemove: (link: TripPersonLinkV1) => void;
  onResolve: (review: PeopleLinksReview, choice: "local" | "remote") => void; onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false), [chosen, setChosen] = useState(new Set<string>()), [name, setName] = useState("");
  const available = sources.filter(source => !linked.some(person => person.aliases.includes(source.id)));
  const aliases = [...chosen].flatMap(id => {
    const source = available.find(source => source.id === id); if (!source) return [];
    const [accountId, exactName] = JSON.parse(id) as [string, string], card = cards.find(card => card.accountId === accountId);
    return card ? [{card, name: exactName}] : [];
  });
  return <>
    {!editing && available.length >= 2 && <button disabled={disabled || !!conflicts.length} onClick={() => {setChosen(new Set()); setName(""); setEditing(true);}}>Link names</button>}
    {editing && <fieldset disabled={disabled || !!conflicts.length}><legend>Link names</legend>
      {available.map(source => <label key={source.id}><input type="checkbox" checked={chosen.has(source.id)} onChange={event => {
        const next = new Set(chosen); event.target.checked ? next.add(source.id) : next.delete(source.id); setChosen(next);
        if (!chosen.size && event.target.checked) setName(source.names[0]);
      }} />{source.names[0]} · {label(JSON.parse(source.id)[0])}</label>)}
      <label>Person name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <button disabled={aliases.length < 2 || aliases.length !== chosen.size || !name.trim()} onClick={() => {onSave(name.trim(), aliases); setEditing(false);}}>Confirm link</button>
      <button onClick={() => setEditing(false)}>Cancel</button>
    </fieldset>}
    {linked.map(person => <div key={person.id}><span>{person.name}</span><button disabled={disabled || !!conflicts.length} aria-label={"Remove link for " + person.name} onClick={() => onRemove(person.link)}>Remove link</button></div>)}
    {conflicts.map(review => <div key={review.field}><span role="status">Linked names changed on another device.</span>
      <details><summary>Review linked names</summary>{([["This device", review.local], ["Synced", review.remote]] as const).map(([title, book]) => <section key={title} aria-label={title + " linked names"}><strong>{title}</strong><ul>{book.links.map(link => <li key={link.id}>
        <span>{link.name}{link.deleted ? " · Removed" : ""}</span>
        <ul>{link.aliases.map((alias, index) => <li key={index}>{alias.name} · {label(alias.card.accountId)} · <span aria-label={"Public signing key ending " + alias.card.signingPublicKey.slice(-8)}>key …{alias.card.signingPublicKey.slice(-8)}</span></li>)}</ul>
      </li>)}</ul></section>)}</details>
      <button disabled={disabled} onClick={() => onResolve(review, "local")}>Keep mine</button><button disabled={disabled} onClick={() => onResolve(review, "remote")}>Use synced</button></div>)}
    {(pending || failed) && <div role="status">{failed ? "Linked names could not sync." : "Linked names waiting to sync."}<button disabled={disabled} onClick={onRetry}>Retry sync</button></div>}
  </>;
}

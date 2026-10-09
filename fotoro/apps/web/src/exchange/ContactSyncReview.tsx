import {useEffect, useState} from "react";
import type {UnlockedVault} from "../vault/vault";
import {contactSyncState, resolveContactConflict, subscribeContacts, type ContactReview} from "./contacts";
import type {ShareScope} from "./share-service";
import {identityLabel} from "./sharing";

export function ContactSyncReview({session, scope, busy, run}: {session: UnlockedVault; scope: ShareScope; busy: boolean; run: (task: () => Promise<unknown>, message?: string) => Promise<void>}) {
  const [reviews, setReviews] = useState<ContactReview[]>([]);
  useEffect(() => {
    let alive = true;
    const reload = () => {void contactSyncState(session, scope).then(value => {if (alive && !scope.signal?.aborted && (!scope.current || scope.current())) setReviews(value.conflicts);}).catch(() => {});};
    const detach = subscribeContacts(reload); reload();
    return () => {alive = false; detach();};
  }, [session]);
  if (!reviews.length) return null;
  return <section aria-label="Review synced contacts">
    <h3>Review synced contacts</h3>
    <p className="hint">These contacts changed on another device. Choose what to keep before contacts sync again.</p>
    {reviews.map(review => <div className="identity-confirmation" key={review.accountId}>
      <h4>{review.local?.name || review.remote?.name || "Fotoro contact"}</h4>
      {(review.fields.includes("card") || review.fields.includes("deleted")) && <>
        <p className="hint">This person’s identity changed. Confirm the synced identity with them before using it.</p>
        {review.local?.card && <p className="contact-identity">This device: Fotoro {identityLabel(review.local.card)}</p>}
        {review.remote?.card && <p className="contact-identity">Synced: Fotoro {identityLabel(review.remote.card)}</p>}
        <details><summary>Identity keys</summary>
          <p className="contact-identity">This device · signing: {review.local?.card?.signingPublicKey}<br />encryption: {review.local?.card?.boxPublicKey}</p>
          <p className="contact-identity">Synced · signing: {review.remote?.card?.signingPublicKey}<br />encryption: {review.remote?.card?.boxPublicKey}</p>
        </details>
      </>}
      {review.fields.includes("name") && <><p>This device: {review.local?.name || "No name"}</p><p>Synced: {review.remote?.name || "No name"}</p></>}
      {review.fields.includes("deleted") && <p className="hint">{review.remote?.card === null ? "This contact was removed on another device while it changed here." : "This contact was removed here while it changed on another device."}</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void run(() => resolveContactConflict(review, "local", scope), "Keeping contact…")}>Keep this device</button>
        <button disabled={busy} onClick={() => void run(() => resolveContactConflict(review, "remote", scope), "Updating contact…")}>Use synced contact</button>
      </div>
    </div>)}
  </section>;
}

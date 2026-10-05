import {useEffect, useRef, useState} from "react";
import type {AccountCardV1, GrantV1} from "@fotoro/contracts";
import {createContactLink, createMomentLink, parseShareLink, type FotoroShareLink} from "@fotoro/contracts/share-links";
import {Icon} from "../library/icons";
import {api} from "./api";
import {mediaURL, requireVault, type UnlockedVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {photoBytes, type Photo} from "../library/catalog";
import {useDialogFocus} from "../library/dialog-focus";
import {contacts, contactNames, saveContactName, pinCard, receive, sharePhotos, trustedCard, contribute, type ShareScope} from "./share-service";
import {grantState, identityLabel, IncomingShareIntent, readableShareError, sameIdentity, ShareSelection} from "./sharing";
export {pinCard, trustedCard, sharePhotos, receive, saveReceivedPhoto, contribute} from "./share-service";

interface ExchangeContextUpdate {
  candidate?: AccountCardV1; candidateChecked?: boolean; candidateName?: string; identityChanged?: boolean;
  names?: Map<string, string>; people?: AccountCardV1[]; grants?: GrantV1[]; inboxFailed?: boolean;
}
export async function loadExchangeContext(session: UnlockedVault, scope: ShareScope, publish: (update: ExchangeContextUpdate) => void, card?: AccountCardV1) {
  const current = () => sameVault(session) && !scope.signal?.aborted && (!scope.current || scope.current());
  if (!current()) return;
  if (card) {
    // An invitation already carries its public sender. Its optional inbox is unrelated to acceptance.
    publish({candidate: card, candidateChecked: false});
    const identity = trustedCard(card.accountId, session, scope).catch(error => {
      if (error instanceof Error && error.message === "PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL") return undefined;
      throw error;
    }).then(known => {if (current()) publish({identityChanged: !!known && !sameIdentity(card, known)});});
    const names = contactNames(scope).then(storedNames => {
      if (current()) publish({names: storedNames, candidateName: storedNames.get(card.accountId) ?? ""});
    });
    // Settle both local checks before allowing retry or another candidate to replace this one.
    for (const result of await Promise.allSettled([identity, names])) if (result.status === "rejected") throw result.reason;
    if (current()) publish({candidateChecked: true});
    return;
  }
  await Promise.all([
    Promise.all([contacts(scope), contactNames(scope)]).then(([people, names]) => {if (current()) publish({people, names});}),
    api<{grants: GrantV1[]}>("/v1/grants", undefined, "GrantInboxV1", "GET", scope.signal)
      .then(inbox => {if (current()) publish({grants: inbox.grants, inboxFailed: false});})
      .catch(() => {if (current()) publish({inboxFailed: true});}),
  ]);
}

function SharePreview({photo}: {photo: Photo}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const session = requireVault(); let current = true;
    void photoBytes(photo, "thumbnail").then(bytes => {
      try {if (current && sameVault(session)) setUrl(mediaURL(photo.manifest.photoId + ":thumbnail", bytes, "image/jpeg", 256 * 256 * 4));}
      finally {bytes.fill(0);}
    }).catch(() => {});
    return () => {current = false;};
  }, [photo]);
  return <span className="share-preview">{url ? <img src={url} alt={photo.metadata.filename} /> : <span>{photo.metadata.filename}</span>}</span>;
}

export function Exchange({selection, incoming, onClose, onReceived, onRefresh, onRetryPassword}: {
  selection: Photo[];
  incoming?: IncomingShareIntent | null;
  onClose: () => void;
  onReceived: (photos: Photo[], grant: GrantV1, sender?: string) => void;
  onRefresh: () => void;
  onRetryPassword?: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useDialogFocus(panel, onClose);
  const [session] = useState(requireVault), [snapshot] = useState(() => new ShareSelection(selection));
  const [linkInput, setLinkInput] = useState(""), [candidate, setCandidate] = useState<AccountCardV1 | undefined>(() => incoming?.pending ? incoming.link.kind === "contact" ? incoming.link.card : incoming.link.senderCard : undefined), [recipient, setRecipient] = useState<AccountCardV1>(), [candidateName, setCandidateName] = useState("");
  const [candidateChecked, setCandidateChecked] = useState(false), [inboxFailed, setInboxFailed] = useState(false);
  const [names, setNames] = useState(new Map<string, string>());
  const [people, setPeople] = useState<AccountCardV1[]>([]), [access, setAccess] = useState<"ongoing" | "temporary">("ongoing");
  const [grants, setGrants] = useState<GrantV1[]>([]), [invitation, setInvitation] = useState<GrantV1>(), [outputLink, setOutputLink] = useState("");
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [working, setWorking] = useState("Opening…"), [identityChanged, setIdentityChanged] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false), running = useRef(false), controller = useRef(new AbortController());
  const current = () => mounted.current && snapshot.current && sameVault(session) && !controller.current.signal.aborted && (!incoming || incoming.current(session));
  const scope = {signal: controller.current.signal, current};
  const run = async (fn: () => Promise<unknown>, message = "Opening…") => {
    if (running.current || !current()) return;
    running.current = true; setWorking(message); setBusy(true); setStatus("");
    try {await fn();}
    catch (error) {if (current()) setStatus(readableShareError(error));}
    finally {running.current = false; if (current()) setBusy(false);}
  };
  const applyContext = (update: ExchangeContextUpdate) => {
    if (update.candidate) setCandidate(update.candidate);
    if (update.candidateChecked !== undefined) setCandidateChecked(update.candidateChecked);
    if (update.candidateName !== undefined) setCandidateName(update.candidateName);
    if (update.identityChanged !== undefined) setIdentityChanged(update.identityChanged);
    if (update.names) setNames(update.names);
    if (update.people) setPeople(update.people);
    if (update.grants) setGrants(update.grants);
    if (update.inboxFailed !== undefined) setInboxFailed(update.inboxFailed);
  };
  const reload = () => loadExchangeContext(session, scope, applyContext);
  useEffect(() => {
    mounted.current = true;
    if (incoming?.pending) incoming.bindInitialVault(session);
    const card = incoming?.pending ? incoming.link.kind === "contact" ? incoming.link.card : incoming.link.senderCard : undefined;
    if (card && incoming?.link.kind === "contact") void reload().catch(error => {if (current()) setStatus(readableShareError(error));});
    void run(() => loadExchangeContext(session, scope, applyContext, card), card ? "Checking sender…" : "Loading shared photos…");
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {mounted.current = false; controller.current.abort(); snapshot.dispose(); window.clearInterval(timer);};
  }, []);
  const inspectLink = () => run(async () => {
    let link: FotoroShareLink;
    try {link = parseShareLink(linkInput.trim());} catch {throw new Error("SHARE_LINK_INVALID");}
    if (link.kind !== "contact") throw new Error("SHARE_LINK_INVALID");
    if (link.card.accountId === session.accountId) throw new Error("SHARE_OWN_ACCOUNT");
    await loadExchangeContext(session, scope, applyContext, link.card);
  }, "Checking contact…");
  const accept = () => run(async () => {
    if (!candidate || !candidateChecked) return;
    if (candidate.accountId === session.accountId && (!incoming || incoming.link.kind === "contact")) throw new Error("SHARE_OWN_ACCOUNT");
    await pinCard(candidate, scope);
    await saveContactName(candidate.accountId, candidateName, scope);
    if (!current()) return;
    setNames(previous => new Map(previous).set(candidate.accountId, candidateName));
    setRecipient(candidate); setPeople(previous => [...previous.filter(person => person.accountId !== candidate.accountId), candidate]);
    if (incoming?.link.kind === "moment") {
      const result = await receive(incoming.link.grantId, scope, candidate);
      if (!current()) {for (const photo of result.photos) photo.metadataKey.fill(0); return;}
      onReceived(result.photos, result.grant, candidateName.trim() || "Fotoro " + result.grant.ownerAccountId.slice(0, 8));
    } else {setCandidate(undefined); setCandidateChecked(false); setLinkInput(""); await reload(); if (current()) setStatus("Contact accepted. You can share photos with this person.");}
  }, incoming?.link.kind === "moment" ? "Opening shared photos…" : "Accepting contact…");
  const copyLink = (value: string) => run(async () => {
    setOutputLink(value);
    if (!navigator.clipboard) throw new Error("SHARE_LINK_COPY_UNAVAILABLE");
    await navigator.clipboard.writeText(value).catch(() => {throw new Error("SHARE_LINK_COPY_UNAVAILABLE");});
    if (current()) setStatus("Link copied.");
  }, "Copying link…");
  const shareLink = (value: string) => {
    if (!current()) return;
    setOutputLink(value);
    if (!navigator.share) {void copyLink(value); return;}
    void run(async () => {
      await navigator.share({url: value});
      if (current()) setStatus("Link shared.");
    }, "Sharing link…");
  };
  const ownLink = createContactLink(session.card);
  const count = snapshot.photos.length;
  const contactLabel = (accountId: string) => names.get(accountId)?.trim() ? names.get(accountId)! : `Fotoro contact ${people.find(person => person.accountId === accountId)?.signingPublicKey.slice(0, 8) ?? accountId.slice(-4)}`;
  const isMoment = incoming?.pending && incoming.link.kind === "moment";
  const received = grants.filter(grant => grant.recipientAccountId === session.accountId);
  const sent = grants.filter(grant => grant.ownerAccountId === session.accountId);
  return <section className="sheet share-sheet" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={isMoment ? "Open shared photos" : count ? "Share photos" : "Shared photos"}>
    <button className="close" onClick={onClose} aria-label="Close sharing"><Icon kind="close" /></button>
    <h2>{isMoment ? "Someone shared photos with you" : count ? `Share ${count} ${count === 1 ? "photo" : "photos"}` : "Shared photos"}</h2>
    {count > 0 && <div className="share-photo-strip" aria-label="Selected photos">{snapshot.photos.slice(0, 5).map(photo => <SharePreview key={photo.manifest.photoId} photo={photo} />)}{count > 5 && <span>+{count - 5}</span>}</div>}
    {isMoment && <p className="hint">Open with the Fotoro password this invitation was sent to. Photos stay here until you choose Save.</p>}
    {candidate ? <div className="identity-confirmation">
      <h3>{identityChanged ? "This person’s identity changed" : isMoment ? "Accept this sender" : "Accept this contact"}</h3>
      <p className="hint">Only accept a contact link sent to you by this person. {identityChanged && "Confirm the new link with them before continuing."}</p>
      <p className="contact-identity">Fotoro {identityLabel(candidate)}</p>
      <label className="contact-name">Their name <input autoComplete="off" disabled={busy || !candidateChecked} value={candidateName} maxLength={80} onChange={event => setCandidateName(event.target.value)} placeholder="Optional" /></label>
      <button className="primary-action" disabled={busy || !candidateChecked} onClick={() => void accept()}>{busy ? !candidateChecked ? "Checking identity…" : isMoment ? "Opening…" : "Accepting…" : isMoment ? "Accept sender and open photos" : identityChanged ? "Accept new identity" : "Accept contact"}</button>
      {!candidateChecked && !busy && status && <button onClick={() => void run(() => loadExchangeContext(session, scope, applyContext, candidate), "Checking sender…")}>Try again</button>}
      {!isMoment && <button disabled={busy} onClick={() => setCandidate(undefined)}>Cancel</button>}
    </div> : !isMoment && <>
      {count > 0 && !invitation && <>
        {people.length > 0 && <div className="share-recipients" role="group" aria-label="Choose a person"><h3>Choose a person</h3>{people.map(person => <button key={person.accountId} disabled={busy} aria-pressed={recipient?.accountId === person.accountId} onClick={() => setRecipient(person)}>{contactLabel(person.accountId)}{recipient?.accountId === person.accountId && <span aria-hidden="true"> ✓</span>}</button>)}</div>}
        <details open={people.length === 0}><summary>{people.length ? "Add a person" : "Connect with a person"}</summary><form onSubmit={event => {event.preventDefault(); void inspectLink();}}><p className="hint">Ask this person to open Shared and send you their contact link. After you connect, send them the photo invitation.</p><label>Recipient’s contact link<input type="url" autoComplete="off" value={linkInput} onChange={event => setLinkInput(event.target.value)} placeholder="https://fotoro.cloud/#contact=…" /></label><button disabled={busy || !linkInput.trim()}>Continue</button></form></details>
        <details><summary>Photo access</summary><label>Access<select value={access} disabled={busy} onChange={event => setAccess(event.target.value as "ongoing" | "temporary")}><option value="ongoing">Until I end access</option><option value="temporary">15 minutes</option></select></label></details>
        <button className="primary-action" disabled={busy || !recipient || count > 100} onClick={() => void run(async () => {
          if (invitation) return;
          const grant = await sharePhotos(snapshot.photos, recipient!, access, scope);
          if (!current()) return;
          setInvitation(grant); setOutputLink(""); await reload();
        }, "Creating invitation…")}>{busy && working === "Creating invitation…" ? "Creating invitation…" : "Share photos"}</button>
      </>}
      {invitation && <div className="invitation-ready"><h3>For {contactLabel(invitation.recipientAccountId)}</h3><div className="actions"><button disabled={busy} className="primary-action" onClick={() => shareLink(createMomentLink(invitation.grantId, session.card))}>Send photos</button><button disabled={busy} onClick={() => {setInvitation(undefined); setOutputLink(""); setRecipient(undefined); setStatus("");}}>Choose another person</button></div><details><summary>More</summary><button disabled={busy} onClick={() => void copyLink(createMomentLink(invitation.grantId, session.card))}>Copy link</button></details></div>}
      {!count && <div className="contact-link"><p className="hint">Your contact link lets someone invite you to photos.</p><div className="actions"><button disabled={busy} onClick={() => shareLink(ownLink)}>Share my contact link</button><button disabled={busy} onClick={() => void copyLink(ownLink)}>Copy my contact link</button></div></div>}
    </>}
    {outputLink && <details className="copy-link"><summary>Link</summary><label>Photo link<input readOnly value={outputLink} onFocus={event => event.target.select()} /></label></details>}
    <p role="status" className="share-status">{busy ? working : status}</p>
    {isMoment && onRetryPassword && <button disabled={busy} onClick={onRetryPassword}>Use another Fotoro password</button>}
    {!isMoment && <details className="share-inbox" open={!count}><summary>{count ? "Shared moments" : "Received and sent"}</summary>
      <div className="share-inbox-heading"><h3>Received photos</h3><button disabled={busy} onClick={() => void run(reload, "Refreshing shared photos…")}>{inboxFailed ? "Try again" : "Refresh"}</button></div>
      {inboxFailed ? <p className="hint">Shared photos couldn’t load. Try again.</p> : !received.length && <p className="hint">Photos shared with you appear here.</p>}
      {received.map(grant => <div className="grant" key={grant.grantId}><p>Photos from {contactLabel(grant.ownerAccountId)}</p><p className="hint">{grantState(grant, now)}</p><button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => void run(async () => {const result = await receive(grant.grantId, scope); if (current()) onReceived(result.photos, result.grant, contactLabel(result.grant.ownerAccountId)); else for (const photo of result.photos) photo.metadataKey.fill(0);}, "Opening shared photos…")}>Open photos</button>{count > 0 && grant.role === "contributor" && <button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => void run(async () => {await contribute(grant, snapshot.photos, scope); if (current()) {setStatus("Photos added."); onRefresh();}}, "Adding selected photos…")}>Add selected photos</button>}</div>)}
      {!count && <form onSubmit={event => {event.preventDefault(); void inspectLink();}}><label>Add someone’s contact link<input type="url" autoComplete="off" value={linkInput} onChange={event => setLinkInput(event.target.value)} placeholder="https://fotoro.cloud/#contact=…" /></label><button disabled={busy || !linkInput.trim()}>Continue</button></form>}
      {sent.length > 0 && <details><summary>Sent photos</summary>{sent.map(grant => <div className="grant" key={grant.grantId}><p>Shared with {contactLabel(grant.recipientAccountId)}</p><p className="hint">{grantState(grant, now)}</p><div className="actions"><button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => shareLink(createMomentLink(grant.grantId, session.card))}>Share invitation</button><button disabled={busy || !!grant.revokedAt} onClick={() => void run(async () => {await api("/v1/grants/" + grant.grantId, undefined, "GrantV1", "DELETE", scope.signal); if (current()) {await reload(); setStatus("Access ended. Copies already saved stay in their library.");}}, "Ending access…")}>End access</button></div></div>)}</details>}
    </details>}
  </section>;
}

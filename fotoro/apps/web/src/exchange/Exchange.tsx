import {useEffect, useRef, useState} from "react";
import type {AccountCardV1, GrantV1} from "@fotoro/contracts";
import {createContactLink, createMomentLink, parseShareLink, type FotoroShareLink} from "@fotoro/contracts/share-links";
import {Icon} from "../library/icons";
import {api} from "./api";
import {mediaURL, requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {photoBytes, type Photo} from "../library/catalog";
import {useDialogFocus} from "../library/dialog-focus";
import {contacts, contactNames, saveContactName, pinCard, receive, sharePhotos, trustedCard, contribute} from "./share-service";
import {grantState, identityLabel, IncomingShareIntent, readableShareError, sameIdentity, ShareSelection} from "./sharing";
export {pinCard, trustedCard, sharePhotos, receive, saveReceivedPhoto, contribute} from "./share-service";

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
  onReceived: (photos: Photo[], grant: GrantV1) => void;
  onRefresh: () => void;
  onRetryPassword?: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useDialogFocus(panel, onClose);
  const [session] = useState(requireVault), [snapshot] = useState(() => new ShareSelection(selection));
  const [linkInput, setLinkInput] = useState(""), [candidate, setCandidate] = useState<AccountCardV1>(), [recipient, setRecipient] = useState<AccountCardV1>(), [candidateName, setCandidateName] = useState("");
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
  const reload = async () => {
    const [inbox, known, storedNames] = await Promise.all([api<{grants: GrantV1[]}>("/v1/grants", undefined, "GrantInboxV1", "GET", scope.signal), contacts(scope), contactNames(scope)]);
    if (!current()) return;
    setGrants(inbox.grants); setPeople(known); setNames(storedNames);
    return storedNames;
  };
  useEffect(() => {
    mounted.current = true;
    if (incoming?.pending) incoming.bindInitialVault(session);
    void run(async () => {
      const storedNames = await reload();
      if (!current() || !incoming?.pending) return;
      const card = incoming.link.kind === "contact" ? incoming.link.card : incoming.link.senderCard;
      setCandidate(card); setCandidateName(storedNames?.get(card.accountId) ?? "");
      try {const known = await trustedCard(card.accountId, session, scope); if (current()) setIdentityChanged(!sameIdentity(card, known));} catch {}
    }, "Loading shared photos…");
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {mounted.current = false; controller.current.abort(); snapshot.dispose(); window.clearInterval(timer);};
  }, []);
  const inspectLink = () => run(async () => {
    let link: FotoroShareLink;
    try {link = parseShareLink(linkInput.trim());} catch {throw new Error("SHARE_LINK_INVALID");}
    if (link.kind !== "contact") throw new Error("SHARE_LINK_INVALID");
    if (link.card.accountId === session.accountId) throw new Error("SHARE_OWN_ACCOUNT");
    setCandidate(link.card); setCandidateName(names.get(link.card.accountId) ?? ""); setIdentityChanged(false);
    try {const known = await trustedCard(link.card.accountId, session, scope); if (current()) setIdentityChanged(!sameIdentity(link.card, known));} catch {}
  }, "Checking contact…");
  const accept = () => run(async () => {
    if (!candidate) return;
    if (candidate.accountId === session.accountId && (!incoming || incoming.link.kind === "contact")) throw new Error("SHARE_OWN_ACCOUNT");
    await pinCard(candidate, scope);
    await saveContactName(candidate.accountId, candidateName, scope);
    if (!current()) return;
    setNames(previous => new Map(previous).set(candidate.accountId, candidateName));
    setRecipient(candidate); setPeople(previous => [...previous.filter(person => person.accountId !== candidate.accountId), candidate]);
    if (incoming?.link.kind === "moment") {
      const result = await receive(incoming.link.grantId, scope, candidate);
      if (!current()) {for (const photo of result.photos) photo.metadataKey.fill(0); return;}
      onReceived(result.photos, result.grant);
    } else {setCandidate(undefined); setLinkInput(""); setStatus("Contact accepted. You can share photos with this person.");}
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
      <label className="contact-name">Their name <input autoComplete="off" disabled={busy} value={candidateName} maxLength={80} onChange={event => setCandidateName(event.target.value)} placeholder="Optional" /></label>
      <button className="primary-action" disabled={busy} onClick={() => void accept()}>{busy ? isMoment ? "Opening…" : "Accepting…" : isMoment ? "Accept sender and open photos" : identityChanged ? "Accept new identity" : "Accept contact"}</button>
      {!isMoment && <button disabled={busy} onClick={() => setCandidate(undefined)}>Cancel</button>}
    </div> : !isMoment && <>
      {count > 0 && <>
        {people.length > 0 && <label>Share with<select value={recipient?.accountId ?? ""} disabled={busy} onChange={event => setRecipient(people.find(person => person.accountId === event.target.value))}><option value="">Choose a person</option>{people.map(person => <option key={person.accountId} value={person.accountId}>{contactLabel(person.accountId)}</option>)}</select></label>}
        <form onSubmit={event => {event.preventDefault(); void inspectLink();}}><label>{people.length ? "Or add a contact link" : "Recipient’s contact link"}<input type="url" autoComplete="off" value={linkInput} onChange={event => setLinkInput(event.target.value)} placeholder="https://fotoro.cloud/#contact=…" /></label><button disabled={busy || !linkInput.trim()}>Continue</button></form>
        <label>Photo access<select value={access} disabled={busy} onChange={event => setAccess(event.target.value as "ongoing" | "temporary")}><option value="ongoing">Until I end access</option><option value="temporary">15 minutes</option></select></label>
        <button className="primary-action" disabled={busy || !recipient || count > 100} onClick={() => void run(async () => {
          const grant = await sharePhotos(snapshot.photos, recipient!, access, scope);
          if (!current()) return;
          setInvitation(grant); setOutputLink(createMomentLink(grant.grantId, session.card)); await reload(); setStatus("Invitation ready.");
        }, "Creating invitation…")}>{busy && working === "Creating invitation…" ? "Creating invitation…" : "Create invitation"}</button>
      </>}
      {invitation && <div className="invitation-ready"><h3>Invitation ready</h3><p className="hint">Only this recipient can open these photos with their Fotoro password.</p><div className="actions"><button disabled={busy} className="primary-action" onClick={() => shareLink(createMomentLink(invitation.grantId, session.card))}>Share invitation</button><button disabled={busy} onClick={() => void copyLink(createMomentLink(invitation.grantId, session.card))}>Copy link</button></div></div>}
      <div className="contact-link"><p className="hint">Your contact link lets someone invite you to photos.</p><div className="actions"><button disabled={busy} onClick={() => shareLink(ownLink)}>Share my contact link</button><button disabled={busy} onClick={() => void copyLink(ownLink)}>Copy my contact link</button></div></div>
    </>}
    {outputLink && <label className="copy-link">Link<input readOnly value={outputLink} onFocus={event => event.target.select()} /></label>}
    <p role="status" className="share-status">{busy ? working : status}</p>
    {isMoment && onRetryPassword && <button disabled={busy} onClick={onRetryPassword}>Use another Fotoro password</button>}
    {!isMoment && <div className="share-inbox">
      <div className="share-inbox-heading"><h3>Received photos</h3><button disabled={busy} onClick={() => void run(reload, "Refreshing shared photos…")}>Refresh</button></div>
      {!received.length && <p className="hint">Photos shared with you appear here.</p>}
      {received.map(grant => <div className="grant" key={grant.grantId}><p>Photos from {contactLabel(grant.ownerAccountId)}</p><p className="hint">{grantState(grant, now)}</p><button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => void run(async () => {const result = await receive(grant.grantId, scope); if (current()) onReceived(result.photos, result.grant); else for (const photo of result.photos) photo.metadataKey.fill(0);}, "Opening shared photos…")}>Open photos</button>{count > 0 && grant.role === "contributor" && <button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => void run(async () => {await contribute(grant, snapshot.photos, scope); if (current()) {setStatus("Photos added."); onRefresh();}}, "Adding selected photos…")}>Add selected photos</button>}</div>)}
      {!count && <form onSubmit={event => {event.preventDefault(); void inspectLink();}}><label>Add someone’s contact link<input type="url" autoComplete="off" value={linkInput} onChange={event => setLinkInput(event.target.value)} placeholder="https://fotoro.cloud/#contact=…" /></label><button disabled={busy || !linkInput.trim()}>Continue</button></form>}
      {sent.length > 0 && <details><summary>Sent photos</summary>{sent.map(grant => <div className="grant" key={grant.grantId}><p>Shared with {contactLabel(grant.recipientAccountId)}</p><p className="hint">{grantState(grant, now)}</p><div className="actions"><button disabled={busy || !!grant.revokedAt || (!!grant.expiresAt && Date.parse(grant.expiresAt) <= now)} onClick={() => shareLink(createMomentLink(grant.grantId, session.card))}>Share invitation</button><button disabled={busy || !!grant.revokedAt} onClick={() => void run(async () => {await api("/v1/grants/" + grant.grantId, undefined, "GrantV1", "DELETE", scope.signal); if (current()) {await reload(); setStatus("Access ended. Copies already saved stay in their library.");}}, "Ending access…")}>End access</button></div></div>)}</details>}
    </div>}
  </section>;
}

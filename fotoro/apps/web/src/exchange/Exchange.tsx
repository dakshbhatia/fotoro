import { useState, useEffect, useRef } from "react";
import type {
  AccountCardV1,
  GrantV1,
  GrantDetailV1,
  PhotoManifestV1,
  SavedPhotoV1,
  WrappedKeyV1,
} from "@fotoro/contracts";
import { validateWire } from "@fotoro/contracts/validate";
import {
  ready,
  sealShareKey,
  openShareKey,
  signPayload,
  verifyPayload,
  utf8,
  unb64,
  wrapKey,
} from "@fotoro/crypto";
import { Icon } from "../library/icons";
import { api } from "./api";
import { get, put } from "./cache";
import { requireVault, encryptPrivate, decryptPrivate } from "../vault/vault";
import { readPhoto, photoBytes, type Photo } from "../library/catalog";
export const MOMENT = "00000000-0000-4000-8000-000000000030";
const pinned = new Map<string, AccountCardV1>();
export async function pinCard(text: string) {
  await ready;
  const card = validateWire<AccountCardV1>("AccountCardV1", JSON.parse(text));
  const v = requireVault();
  await put(
    "settings",
    v.accountId + ":pin:" + card.accountId,
    encryptPrivate(card),
  );
  pinned.set(card.accountId, card);
  return card;
}
export async function trustedCard(id: string) {
  const v = requireVault();
  const cached = await get<WrappedKeyV1>(
    "settings",
    v.accountId + ":pin:" + id,
  );
  if (!cached) throw new Error("PIN_ACCOUNT_CARD_FROM_TRUSTED_CHANNEL");
  return decryptPrivate<AccountCardV1>(cached);
}
export async function sharePhotos(
  photos: Photo[],
  recipient: AccountCardV1,
  access: "ongoing" | "temporary",
) {
  if (!photos.length || photos.length > 100)
    throw new Error("SELECT_1_TO_100_PHOTOS");
  const v = requireVault();
  const grant = await api<GrantV1>(
    "/v1/moments/" + MOMENT + "/grants/options",
    {
      version: 1,
      recipientAccountId: recipient.accountId,
      role: "contributor",
      access,
    },
    "GrantV1",
  );
  const envelopes = photos.map((photo) =>
    sealShareKey(
      photo.metadataKey,
      recipient,
      {
        version: 1,
        grantId: grant.grantId,
        photoId: photo.manifest.photoId,
        senderAccountId: v.accountId,
        recipientAccountId: recipient.accountId,
      },
      v.signingSecretKey,
    ),
  );
  return api<GrantV1>(
    "/v1/moments/" + MOMENT + "/grants",
    {
      version: 1,
      grant,
      envelopes,
      signedPayload: signPayload(
        "grant",
        v.accountId,
        utf8({ grant, envelopes }),
        v.signingSecretKey,
      ),
    },
    "GrantV1",
  );
}
export async function receive(grantId: string) {
  const v = requireVault();
  const detail = await api<GrantDetailV1>(
    "/v1/grants/" + grantId,
    undefined,
    "GrantDetailV1",
  );
  const photos: Photo[] = [];
  for (const payload of detail.manifests) {
    const card = await trustedCard(payload.accountId);
    const supplied = detail.cards.find((c) => c.accountId === card.accountId);
    if (
      !supplied ||
      supplied.boxPublicKey !== card.boxPublicKey ||
      supplied.signingPublicKey !== card.signingPublicKey
    )
      throw new Error("ACCOUNT_KEYS_CHANGED_RENEW_TRUST");
    if (payload.kind !== "photo-manifest")
      throw new Error("INVALID_MANIFEST_KIND");
    const manifest = validateWire<PhotoManifestV1>(
      "PhotoManifestV1",
      JSON.parse(
        new TextDecoder().decode(
          verifyPayload(payload, unb64(card.signingPublicKey)),
        ),
      ),
    );
    if (manifest.ownerAccountId !== card.accountId)
      throw new Error("MANIFEST_OWNER_MISMATCH");
    const envelope = detail.envelopes.find(
      (e) =>
        e.photoId === manifest.photoId && e.recipientAccountId === v.accountId,
    );
    if (!envelope) continue;
    const key = openShareKey(envelope, v.boxSecretKey, card, {
      version: 1,
      grantId,
      photoId: manifest.photoId,
      senderAccountId: card.accountId,
      recipientAccountId: v.accountId,
    });
    photos.push(await readPhoto(manifest, key, grantId));
  }
  await api("/v1/grants/" + grantId + "/viewed", {});
  return { grant: detail.grant, photos };
}
export async function saveReceivedPhoto(
  grantId: string,
  photoId: string,
): Promise<SavedPhotoV1> {
  const v = requireVault(),
    key = v.accountId + ":" + grantId + ":" + photoId;
  let request: any;
  const saved = await get<WrappedKeyV1>("saves", key);
  if (saved) {
    request = decryptPrivate(saved);
  } else {
    const received = await receive(grantId);
    const photo = received.photos.find((p) => p.manifest.photoId === photoId);
    if (!photo) throw new Error("PHOTO_NOT_GRANTED");
    const original = await photoBytes(photo, "original");
    original.fill(0);
    const manifest: PhotoManifestV1 = {
      ...photo.manifest,
      photoId: crypto.randomUUID(),
      ownerAccountId: v.accountId,
      ownerWrappedMetadataKey: wrapKey(photo.metadataKey, v.vaultKey),
    };
    const save: SavedPhotoV1 = {
      version: 1,
      operationId: crypto.randomUUID(),
      photoId: manifest.photoId,
      sourceGrantId: grantId,
      sourcePhotoId: photoId,
      manifest,
      signedPayload: signPayload(
        "photo-manifest",
        v.accountId,
        utf8(manifest),
        v.signingSecretKey,
      ),
    };
    request = {
      version: 1,
      expectedGrantVersion: received.grant.version,
      save,
    };
    await put("saves", key, encryptPrivate(request));
  }
  return api("/v1/saves", request, "SavedPhotoV1");
}
export async function contribute(grant: GrantV1, photos: Photo[]) {
  if (!photos.length || photos.length > 100)
    throw new Error("SELECT_1_TO_100_PHOTOS");
  const v = requireVault();
  const recipientId =
    grant.ownerAccountId === v.accountId
      ? grant.recipientAccountId
      : grant.ownerAccountId;
  const recipient = await trustedCard(recipientId);
  const operationId = crypto.randomUUID();
  const body = {
    version: 1,
    operationId,
    expectedGrantVersion: grant.version,
    manifests: photos.map((p) =>
      signPayload(
        "photo-manifest",
        v.accountId,
        utf8(p.manifest),
        v.signingSecretKey,
      ),
    ),
    envelopes: photos.map((p) =>
      sealShareKey(
        p.metadataKey,
        recipient,
        {
          version: 1,
          grantId: grant.grantId,
          photoId: p.manifest.photoId,
          senderAccountId: v.accountId,
          recipientAccountId: recipient.accountId,
        },
        v.signingSecretKey,
      ),
    ),
  };
  const key =
    v.accountId +
    ":contribution:" +
    grant.grantId +
    ":" +
    photos
      .map((p) => p.manifest.photoId)
      .sort()
      .join(",");
  const stored = await get<WrappedKeyV1>("saves", key);
  const request = stored ? decryptPrivate(stored) : body;
  if (!stored) await put("saves", key, encryptPrivate(body));
  return api("/v1/moments/" + grant.momentId + "/contributions", request);
}
export function Exchange({
  selection,
  onClose,
  onReceived,
  onRefresh,
}: {
  selection: Photo[];
  onClose: () => void;
  onReceived: (photos: Photo[], grant: GrantV1) => void;
  onRefresh: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),textarea,select,input",
          ) ?? [],
        );
        if (e.shiftKey && document.activeElement === controls[0]) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === controls.at(-1)) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const [card, setCard] = useState(""),
    [recipient, setRecipient] = useState<AccountCardV1>(),
    [access, setAccess] = useState<"ongoing" | "temporary">("ongoing"),
    [grants, setGrants] = useState<GrantV1[]>([]),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "EXCHANGE_FAILED");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="sheet"
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Photo exchange"
    >
      <button className="close" onClick={onClose} aria-label="Close exchange">
        <Icon kind="close" />
      </button>
      <h2>Share</h2>
      <p>{selection.length} selected · explicit access to these photos</p>
      <label>
        Account card received through a trusted channel
        <textarea
          value={card}
          onChange={(e) => setCard(e.target.value)}
          placeholder="Paste account card JSON"
        />
      </label>
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            setRecipient(await pinCard(card));
            setStatus("Account card pinned");
          })
        }
      >
        Pin account card
      </button>
      {recipient && <p>Recipient {recipient.accountId}</p>}
      <label>
        Access
        <select
          value={access}
          onChange={(e) => setAccess(e.target.value as any)}
        >
          <option value="ongoing">Ongoing · this moment only</option>
          <option value="temporary">15 minutes</option>
        </select>
      </label>
      <button
        disabled={busy || !recipient || !selection.length}
        onClick={() =>
          run(async () => {
            const grant = await sharePhotos(selection, recipient!, access);
            setStatus("Invited · " + grant.grantId);
          })
        }
      >
        Share selected photos
      </button>
      <hr />
      <button
        disabled={busy}
        onClick={() =>
          run(async () => {
            const data = await api<{ grants: GrantV1[] }>(
              "/v1/grants",
              undefined,
              "GrantInboxV1",
            );
            setGrants(data.grants);
          })
        }
      >
        Refresh exchanges
      </button>
      {grants.map((grant) => (
        <div className="grant" key={grant.grantId}>
          <p>
            {grant.ownerAccountId === requireVault().accountId
              ? "Sent"
              : "Received"}{" "}
            ·{" "}
            {grant.expiresAt
              ? "Expires " + new Date(grant.expiresAt).toLocaleTimeString()
              : "Ongoing"}
          </p>
          <small>
            {grant.grantId}
            {grant.revokedAt ? " · Revoked" : ""}
          </small>
          <div className="actions">
            <button
              disabled={busy || !!grant.revokedAt}
              onClick={() =>
                run(async () => {
                  const result = await receive(grant.grantId);
                  onReceived(result.photos, result.grant);
                  setStatus("Viewed");
                })
              }
            >
              View received
            </button>
            <button
              disabled={busy || !selection.length || !!grant.revokedAt}
              onClick={() =>
                run(async () => {
                  await contribute(grant, selection);
                  setStatus("Contribution accepted");
                  onRefresh();
                })
              }
            >
              Contribute selected
            </button>
            {grant.ownerAccountId === requireVault().accountId && (
              <button
                disabled={busy || !!grant.revokedAt}
                onClick={() =>
                  run(async () => {
                    await api(
                      "/v1/grants/" + grant.grantId,
                      undefined,
                      "GrantV1",
                      "DELETE",
                    );
                    setStatus("Access revoked");
                  })
                }
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      ))}
      <p role="status">{busy ? "Working…" : status}</p>
      <p className="hint">
        Invited, viewed and saved are separate states. A saved copy remains in
        the recipient’s library after access ends.
      </p>
    </section>
  );
}

import type {AccountCardV1, SignedPayloadV1} from "../../contracts/src/models.js";
import type {PhotoLocationV1} from "../../contracts/src/location.js";
import {readAlbumSignedBody} from "../../contracts/src/albums.js";
import {ALBUM_FACTS_KIND, ALBUM_FACTS_MAX_CIPHERTEXT, readAlbumPhotoFacts, validateAlbumPhotoFacts, validateAlbumPhotoFactsContent, type AlbumPhotoFactsContentV1} from "../../contracts/src/album-photo-facts.js";
import {verifyAlbumDefinition, verifyAlbumPhoto} from "./albums.js";
import {b64, unb64, utf8, key32, sodium, CryptoError} from "./common.js";
import {wrapKey, unwrapKey} from "./envelopes.js";
import {signPayload, verifyPayload} from "./signatures.js";

export interface AlbumPhotoFactsSource {
  signedDefinition: SignedPayloadV1; trustedOwner: AccountCardV1;
  entry: SignedPayloadV1; manifest: SignedPayloadV1;
  originalSha256: string; albumKey: Uint8Array;
}
function source(input: AlbumPhotoFactsSource) {
  key32(input.albumKey);
  const definition = verifyAlbumDefinition(input.signedDefinition, input.trustedOwner);
  const {photo} = verifyAlbumPhoto({definition, entry: input.entry, manifest: input.manifest});
  const contributor = definition.members.find(member => member.card.accountId === photo.ownerAccountId)!.card;
  return {version: 1 as const, albumId: definition.albumId, photoId: photo.photoId, ownerAccountId: photo.ownerAccountId,
    definitionSignature: input.signedDefinition.signature, contributor};
}
// The caller supplies the digest from authenticated original metadata and fences
// current membership/vault around network work. These helpers never grant access.
export function makeAlbumPhotoFacts(input: AlbumPhotoFactsSource & {revision: number; people: readonly string[]; location?: PhotoLocationV1; signingSecretKey: Uint8Array}): SignedPayloadV1 {
  const {contributor, ...context} = source(input);
  if (input.signingSecretKey.length !== 64 || b64(sodium.crypto_sign_ed25519_sk_to_pk(input.signingSecretKey)) !== contributor.signingPublicKey) throw new CryptoError("WRONG_ALBUM_SIGNER");
  const content = validateAlbumPhotoFactsContent({...context, revision: input.revision, originalSha256: input.originalSha256,
    people: [...input.people], ...(input.location === undefined ? {} : {location: {...input.location}})});
  const plain = utf8(content);
  try {
    if (plain.length + 16 > ALBUM_FACTS_MAX_CIPHERTEXT) throw new CryptoError("ALBUM_FACTS_TOO_LARGE");
    const outer = validateAlbumPhotoFacts({...context, revision: input.revision, encrypted: wrapKey(plain, input.albumKey)});
    return signPayload(ALBUM_FACTS_KIND, context.ownerAccountId, utf8(outer), input.signingSecretKey);
  } finally {plain.fill(0);}
}
export function openAlbumPhotoFacts(input: AlbumPhotoFactsSource & {signed: SignedPayloadV1}): AlbumPhotoFactsContentV1 {
  const {contributor, ...context} = source(input), outer = readAlbumPhotoFacts(input.signed);
  if (input.signed.accountId !== contributor.accountId || Object.entries(context).some(([key, value]) => outer[key as keyof typeof context] !== value)) throw new CryptoError("WRONG_ALBUM_BINDING");
  const verified = verifyPayload(input.signed, unb64(contributor.signingPublicKey)); verified.fill(0);
  const plain = unwrapKey(outer.encrypted, input.albumKey);
  try {
    // Reuse the bounded structural parser's duplicate-key rejection. Signature
    // authentication above covers the original outer ciphertext, not this parse.
    const content = readAlbumSignedBody({...input.signed, body: b64(plain)}, ALBUM_FACTS_KIND, validateAlbumPhotoFactsContent);
    if (Object.entries(context).some(([key, value]) => content[key as keyof typeof context] !== value) || content.revision !== outer.revision || content.originalSha256 !== input.originalSha256) throw new CryptoError("WRONG_ALBUM_BINDING");
    return content;
  } finally {plain.fill(0);}
}

import type {
  WrappedKeyV1,
  AccountCardV1,
  ShareBindingV1,
  ShareKeyEnvelopeV1,
} from "../../contracts/src/models.js";
import { validateWire } from "../../contracts/src/validate.js";
import { sodium, b64, unb64, utf8, key32, CryptoError } from "./common.js";
export function wrapKey(key: Uint8Array, vaultKey: Uint8Array): WrappedKeyV1 {
  key32(vaultKey);
  const nonce = sodium.randombytes_buf(24);
  return {
    version: 1,
    nonce: b64(nonce),
    ciphertext: b64(sodium.crypto_secretbox_easy(key, nonce, vaultKey)),
  };
}
export function unwrapKey(
  value: WrappedKeyV1,
  vaultKey: Uint8Array,
): Uint8Array {
  validateWire("WrappedKeyV1", value);
  key32(vaultKey);
  return sodium.crypto_secretbox_open_easy(
    unb64(value.ciphertext),
    unb64(value.nonce),
    vaultKey,
  );
}
const signed = (binding: ShareBindingV1, sealed: string) =>
  utf8([
    "fotoro-share-v1",
    binding.grantId,
    binding.photoId,
    binding.senderAccountId,
    binding.recipientAccountId,
    sealed,
  ]);
export function sealShareKey(
  metadataKey: Uint8Array,
  recipient: AccountCardV1,
  binding: ShareBindingV1,
  senderSecretKey: Uint8Array,
): ShareKeyEnvelopeV1 {
  key32(metadataKey);
  validateWire("AccountCardV1", recipient);
  validateWire("ShareBindingV1", binding);
  if (binding.recipientAccountId !== recipient.accountId)
    throw new CryptoError("WRONG_RECIPIENT");
  const sealedMetadataKey = b64(
    sodium.crypto_box_seal(metadataKey, unb64(recipient.boxPublicKey)),
  );
  return {
    ...binding,
    sealedMetadataKey,
    senderSignature: b64(
      sodium.crypto_sign_detached(
        signed(binding, sealedMetadataKey),
        senderSecretKey,
      ),
    ),
  };
}
export function openShareKey(
  envelope: ShareKeyEnvelopeV1,
  recipientSecretKey: Uint8Array,
  senderCard: AccountCardV1,
  expectedBinding: ShareBindingV1,
): Uint8Array {
  validateWire("ShareKeyEnvelopeV1", envelope);
  validateWire("ShareBindingV1", expectedBinding);
  validateWire("AccountCardV1", senderCard);
  for (const k of [
    "version",
    "grantId",
    "photoId",
    "senderAccountId",
    "recipientAccountId",
  ] as const)
    if (envelope[k] !== expectedBinding[k])
      throw new CryptoError("WRONG_BINDING");
  if (senderCard.accountId !== expectedBinding.senderAccountId)
    throw new CryptoError("WRONG_SENDER");
  if (
    !sodium.crypto_sign_verify_detached(
      unb64(envelope.senderSignature),
      signed(envelope, envelope.sealedMetadataKey),
      unb64(senderCard.signingPublicKey),
    )
  )
    throw new CryptoError("BAD_SIGNATURE");
  const key = sodium.crypto_box_seal_open(
    unb64(envelope.sealedMetadataKey),
    sodium.crypto_scalarmult_base(recipientSecretKey),
    recipientSecretKey,
  );
  key32(key);
  return key;
}

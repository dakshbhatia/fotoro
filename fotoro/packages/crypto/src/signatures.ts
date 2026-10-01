import type { SignedPayloadV1 } from "../../contracts/src/models.js";
import { validateWire } from "../../contracts/src/validate.js";
import { sodium, b64, unb64, utf8, CryptoError } from "./common.js";
const tuple = (kind: string, id: string, body: string) =>
  utf8(["fotoro-signed-v1", kind, id, body]);
export function signPayload(
  kind: string,
  accountId: string,
  body: Uint8Array,
  secretKey: Uint8Array,
): SignedPayloadV1 {
  const encoded = b64(body);
  return validateWire("SignedPayloadV1", {
    version: 1,
    kind,
    accountId,
    body: encoded,
    signature: b64(
      sodium.crypto_sign_detached(tuple(kind, accountId, encoded), secretKey),
    ),
  });
}
export function verifyPayload(
  value: SignedPayloadV1,
  publicKey: Uint8Array,
): Uint8Array {
  validateWire("SignedPayloadV1", value);
  if (
    !sodium.crypto_sign_verify_detached(
      unb64(value.signature),
      tuple(value.kind, value.accountId, value.body),
      publicKey,
    )
  )
    throw new CryptoError("BAD_SIGNATURE");
  return unb64(value.body);
}

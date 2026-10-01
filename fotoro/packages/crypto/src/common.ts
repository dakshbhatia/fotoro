import sodium from "libsodium-wrappers-sumo";
export { sodium };
export const ready = sodium.ready;
export class CryptoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const b64 = (v: Uint8Array) =>
  sodium.to_base64(v, sodium.base64_variants.URLSAFE_NO_PADDING);
export function unb64(v: string): Uint8Array {
  const b = sodium.from_base64(v, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (b64(b) !== v) throw new CryptoError("INVALID_ENCODING");
  return b;
}
export const utf8 = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export function key32(v: Uint8Array) {
  if (v.length !== 32) throw new CryptoError("INVALID_KEY");
}

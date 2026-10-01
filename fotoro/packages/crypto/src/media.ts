import type { MediaBinding } from "../../contracts/src/models.js";
import { validateWire } from "../../contracts/src/validate.js";
import { sodium, key32, utf8, CryptoError } from "./common.js";
export const RECORD_BYTES = 4 * 1024 * 1024;
export const mediaAAD = (binding: MediaBinding) => {
  validateWire("MediaBinding", binding);
  return utf8([
    "fotoro-media-v1",
    binding.photoId,
    binding.representationId,
    binding.kind,
  ]);
};
export async function* encryptMedia(
  records: AsyncIterable<Uint8Array>,
  key: Uint8Array,
  binding: MediaBinding,
): AsyncIterable<Uint8Array> {
  await sodium.ready;
  key32(key);
  const aad = mediaAAD(binding),
    { state, header } =
      sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  yield header;
  const iterator = records[Symbol.asyncIterator]();
  let current = await iterator.next();
  if (current.done) current = { done: false, value: new Uint8Array() };
  while (!current.done) {
    if (current.value.length > RECORD_BYTES)
      throw new CryptoError("RECORD_TOO_LARGE");
    const next = await iterator.next();
    const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      current.value,
      aad,
      next.done ? 3 : 0,
    );
    const framed = new Uint8Array(4 + cipher.length);
    new DataView(framed.buffer).setUint32(0, cipher.length, false);
    framed.set(cipher, 4);
    yield framed;
    current = next;
  }
}
/** Chunk boundaries are transport arbitrary. At most one 4 MiB record is buffered. */
export async function* decryptMedia(
  container: AsyncIterable<Uint8Array>,
  key: Uint8Array,
  binding: MediaBinding,
): AsyncIterable<Uint8Array> {
  await sodium.ready;
  key32(key);
  const aad = mediaAAD(binding),
    iterator = container[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(),
    offset = 0;
  async function read(
    size: number,
    optional = false,
  ): Promise<Uint8Array | null> {
    const result = new Uint8Array(size);
    let used = 0;
    while (used < size) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) {
          if (optional && used === 0) return null;
          throw new CryptoError("TRUNCATED");
        }
        chunk = next.value;
        offset = 0;
        if (!chunk.length) continue;
      }
      const take = Math.min(size - used, chunk.length - offset);
      result.set(chunk.subarray(offset, offset + take), used);
      offset += take;
      used += take;
    }
    return result;
  }
  const header = (await read(24))!;
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
    header,
    key,
  );
  let final = false;
  while (!final) {
    const length = (await read(4))!;
    const bytes = new DataView(length.buffer).getUint32(0, false);
    if (bytes < 17 || bytes > RECORD_BYTES + 17)
      throw new CryptoError("INVALID_RECORD_LENGTH");
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      state,
      (await read(bytes))!,
      aad,
    );
    if (!result) throw new CryptoError("AUTHENTICATION_FAILED");
    if (result.tag !== 0 && result.tag !== 3)
      throw new CryptoError("INVALID_TAG");
    final = result.tag === 3;
    if (final && (await read(1, true)) !== null)
      throw new CryptoError("TRAILING_DATA");
    yield result.message;
  }
}

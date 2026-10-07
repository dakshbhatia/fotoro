import { ready, sodium, b64, encryptMedia, wrapKey } from "@fotoro/crypto";
import type { MediaBinding } from "@fotoro/contracts";
import { source, collect, digest } from "../library/catalog";
self.onmessage = async (event) => {
  const {
    id,
    photoId,
    vaultKey,
    files,
    filename,
    mediaType,
    sourceDate,
    dateSource,
  } = event.data;
  try {
    await ready;
    const metadataKey = sodium.randombytes_buf(32);
    const staged = [];
    const keys: Record<string, string> = {};
    let originalDigest = "";
    let originalBytes = 0;
    for (const file of files) {
      const binding: MediaBinding = {
        version: 1,
        photoId,
        representationId: crypto.randomUUID(),
        kind: file.kind,
      };
      const key = sodium.randombytes_buf(32);
      keys[binding.representationId] = b64(key);
      const plain = new Uint8Array(file.bytes);
      if (file.kind === "original") {
        originalDigest = digest(plain);
        originalBytes = plain.length;
      }
      const bytes = await collect(encryptMedia(source(plain), key, binding));
      staged.push({
        binding,
        bytes,
        header: b64(bytes.subarray(0, 24)),
        ciphertextBytes: bytes.length,
        ciphertextSha256: digest(bytes),
      });
      key.fill(0);
      plain.fill(0);
    }
    const metadata = {
      version: 1,
      filename,
      mediaType,
      sourceDate,
      dateSource,
      originalBytes,
      originalSha256: originalDigest,
      representationKeys: keys,
    };
    const binding: MediaBinding = {
      version: 1,
      photoId,
      representationId: crypto.randomUUID(),
      kind: "metadata",
    };
    const bytes = await collect(
      encryptMedia(
        source(new TextEncoder().encode(JSON.stringify(metadata))),
        metadataKey,
        binding,
      ),
    );
    staged.push({
      binding,
      bytes,
      header: b64(bytes.subarray(0, 24)),
      ciphertextBytes: bytes.length,
      ciphertextSha256: digest(bytes),
    });
    const wrapped = wrapKey(metadataKey, new Uint8Array(vaultKey));
    metadataKey.fill(0);
    new Uint8Array(vaultKey).fill(0);
    (
      self as unknown as {
        postMessage: (data: unknown, transfer: Transferable[]) => void;
      }
    ).postMessage(
      { id, staged, wrapped, sourceDigest: originalDigest },
      staged.map((s) => s.bytes.buffer),
    );
  } catch (e) {
    self.postMessage({
      id,
      error: e instanceof Error ? e.message : "ENCRYPTION_FAILED",
    });
  }
};

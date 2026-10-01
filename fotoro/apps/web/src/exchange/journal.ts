import type {
  PhotoManifestV1,
  RepresentationV1,
  UploadCommitV1,
  UploadReservationV1,
  WrappedKeyV1,
} from "@fotoro/contracts";
import { ready, signPayload, utf8 } from "@fotoro/crypto";
import { requireVault, encryptPrivate, decryptPrivate } from "../vault/vault";
import { all, get, atomic, put } from "./cache";
import { api, ApiError, base, fixtureMode, resolveUploadURL } from "./api";
import { digest } from "../library/catalog";
import { captureDate } from "../library/exif";
export interface PendingImport {
  operationId: string;
  photoId: string;
  stagingKeys: string[];
  sourceFilename: string;
  sourceDigest: string;
  state:
    | "staging"
    | "queued"
    | "uploading"
    | "committing"
    | "committed"
    | "failed";
  error?: string;
  parts: Staged[];
  wrapped: WrappedKeyV1;
  manifest?: PhotoManifestV1;
}
interface Staged {
  binding: RepresentationV1["binding"];
  header: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  uploadOperation: string;
  reservation?: UploadReservationV1;
  commit?: UploadCommitV1;
}
export function validateSource(file: Pick<File, "size" | "type">) {
  if (!["image/jpeg", "image/png"].includes(file.type))
    throw new Error("SUPPORTED_ORIGINALS_ARE_JPEG_AND_PNG");
  if (file.size > 50 * 1024 * 1024) throw new Error("ORIGINAL_EXCEEDS_50_MIB");
  if (!file.size) throw new Error("EMPTY_ORIGINAL");
}
export async function sourceMatches(file: File, pending: PendingImport) {
  await ready;
  return (
    digest(new Uint8Array(await file.arrayBuffer())) === pending.sourceDigest
  );
}
async function preview(file: File, max: number) {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PREVIEW_FAILED"))),
        "image/jpeg",
        0.85,
      ),
    );
    return blob.arrayBuffer();
  } finally {
    image.close();
  }
}
export async function stageImport(
  file: File,
  reselect?: PendingImport,
): Promise<PendingImport> {
  validateSource(file);
  if (reselect && !(await sourceMatches(file, reselect)))
    throw new Error("SOURCE_MISMATCH");
  const v = requireVault(),
    operationId = reselect?.operationId ?? crypto.randomUUID(),
    photoId = reselect?.photoId ?? crypto.randomUUID();
  const original = await file.arrayBuffer();
  const signature = new Uint8Array(original);
  if (
    file.type === "image/jpeg"
      ? signature[0] !== 255 || signature[1] !== 216
      : ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => signature[i] === n)
  )
    throw new Error("SOURCE_FORMAT_MISMATCH");
  const exifDate = captureDate(new Uint8Array(original));
  const thumb = await preview(file, 256),
    medium = await preview(file, 1600);
  const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), {
    type: "module",
  });
  const result: any = await new Promise((resolve, reject) => {
    worker.onmessage = (e) =>
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    worker.onerror = () => reject(new Error("CRYPTO_WORKER_FAILED"));
    worker.postMessage(
      {
        id: operationId,
        photoId,
        accountId: v.accountId,
        vaultKey: new Uint8Array(v.vaultKey),
        filename: file.name,
        mediaType: file.type,
        sourceDate: exifDate ?? new Date().toISOString(),
        dateSource: exifDate ? "exif" : "import",
        files: [
          { kind: "original", bytes: original },
          { kind: "thumbnail", bytes: thumb },
          { kind: "preview", bytes: medium },
        ],
      },
      [original, thumb, medium],
    );
  }).finally(() => worker.terminate());
  const stagingKeys = result.staged.map(
    (part: any) =>
      v.accountId + ":" + operationId + ":" + part.binding.representationId,
  );
  const pending: PendingImport = {
    operationId,
    photoId,
    stagingKeys,
    sourceFilename: file.name,
    sourceDigest: result.sourceDigest,
    state: "queued",
    parts: result.staged.map(({ bytes, ...part }: any) => ({
      ...part,
      uploadOperation: crypto.randomUUID(),
    })),
    wrapped: result.wrapped,
  };
  await atomic([
    ...(reselect?.stagingKeys ?? []).map((key) => ({
      store: "staging" as const,
      key,
    })),
    ...result.staged.map((p: any, i: number) => ({
      store: "staging" as const,
      key: stagingKeys[i],
      value: p.bytes,
    })),
    {
      store: "journal",
      key: v.accountId + ":" + operationId,
      value: encryptPrivate(pending),
    },
  ]);
  return pending;
}
export async function pendingImports() {
  const id = requireVault().accountId;
  return (await all<WrappedKeyV1>("journal"))
    .filter(([key]) => key.startsWith(id + ":"))
    .map(([, value]) => decryptPrivate<PendingImport>(value));
}
export async function resumePendingImports() {
  const v = requireVault();
  for (const pending of await pendingImports()) {
    if (pending.state === "committed") continue;
    const journalKey = v.accountId + ":" + pending.operationId;
    const persist = () => put("journal", journalKey, encryptPrivate(pending));
    try {
      for (let i = 0; i < pending.parts.length; i++) {
        const part = pending.parts[i];
        if (part.commit) continue;
        if (part.reservation) {
          try {
            part.commit = await api(
              "/v1/uploads/" + part.reservation.uploadId + "/commit",
              {},
              "UploadCommitV1",
            );
            if (
              part.commit!.ciphertextBytes !== part.ciphertextBytes ||
              part.commit!.ciphertextSha256 !== part.ciphertextSha256
            )
              throw new Error("COMMIT_DIGEST_MISMATCH");
            await persist();
            continue;
          } catch (e) {
            if (!(e instanceof ApiError) || e.code !== "UPLOAD_INCOMPLETE")
              throw e;
            if (Date.parse(part.reservation.expiresAt) <= Date.now()) {
              part.reservation = undefined;
              await persist();
            }
          }
        }
        const bytes = await get<Uint8Array>("staging", pending.stagingKeys[i]);
        if (!bytes || digest(bytes) !== part.ciphertextSha256)
          throw new Error("STAGING_MISSING_RESELECT_ORIGINAL");
        pending.state = "uploading";
        await persist();
        part.reservation ??= await api(
          "/v1/uploads/reserve",
          {
            version: 1,
            binding: part.binding,
            ciphertextBytes: part.ciphertextBytes,
            ciphertextSha256: part.ciphertextSha256,
            operationId: part.uploadOperation,
          },
          "UploadReservationV1",
        );
        await persist();
        const url = resolveUploadURL(
          part.reservation!.stagingUrl,
          location.origin,
          import.meta.env?.DEV === true
            ? (import.meta.env?.VITE_FOTORO_API ??
                (fixtureMode ? "http://127.0.0.1:8790" : undefined))
            : undefined,
        );
        const response = await fetch(url, {
          method: "PUT",
          body: new Uint8Array(bytes),
          credentials: "include",
          headers: fixtureMode
            ? { "x-fotoro-fixture-account": v.accountId }
            : {},
        });
        if (!response.ok) throw new Error("UPLOAD_FAILED");
        pending.state = "committing";
        await persist();
        part.commit = await api(
          "/v1/uploads/" + part.reservation!.uploadId + "/commit",
          {},
          "UploadCommitV1",
        );
        if (
          part.commit!.ciphertextBytes !== part.ciphertextBytes ||
          part.commit!.ciphertextSha256 !== part.ciphertextSha256
        )
          throw new Error("COMMIT_DIGEST_MISMATCH");
        await persist();
      }
      const reps = pending.parts.map((p) => ({
        binding: p.binding,
        objectId: p.commit!.objectId,
        header: p.header,
        ciphertextBytes: p.ciphertextBytes,
        ciphertextSha256: p.ciphertextSha256,
      }));
      const manifest: PhotoManifestV1 = {
        version: 1,
        photoId: pending.photoId,
        ownerAccountId: v.accountId,
        representations: reps.filter((r) => r.binding.kind !== "metadata"),
        metadataRepresentation: reps.find(
          (r) => r.binding.kind === "metadata",
        )!,
        ownerWrappedMetadataKey: pending.wrapped,
      };
      pending.manifest = manifest;
      await persist();
      await api(
        "/v1/photos",
        signPayload(
          "photo-manifest",
          v.accountId,
          utf8(manifest),
          v.signingSecretKey,
        ),
        "PhotoManifestV1",
      );
      pending.state = "committed";
      pending.error = undefined;
      await atomic([
        { store: "journal", key: journalKey, value: encryptPrivate(pending) },
        ...pending.stagingKeys.map((key) => ({
          store: "staging" as const,
          key,
        })),
      ]);
    } catch (e) {
      pending.state = "failed";
      pending.error = e instanceof Error ? e.message : "IMPORT_FAILED";
      await persist();
    }
  }
}

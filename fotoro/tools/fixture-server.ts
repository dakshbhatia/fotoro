import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import accounts from "../fixtures/accounts.json";
import { validateWire } from "../packages/contracts/src/validate.js";
import type {
  PhotoManifestV1,
  GrantV1,
  SignedPayloadV1,
  ChangeV1,
  UploadCommitV1,
} from "../packages/contracts/src/models.js";
import {
  ready,
  b64,
  unb64,
  encryptMedia,
  wrapKey,
  signPayload,
  verifyPayload,
  utf8,
} from "../packages/crypto/src/index.js";
const A = accounts.accounts[0].accountId,
  B = accounts.accounts[1].accountId;
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("base64url");
const allowedOrigins = new Set([
  "http://localhost:4310",
  "http://127.0.0.1:4310",
]);
export function createFixtureServer(
  options: { host?: string; production?: boolean } = {},
) {
  if (options.production || process.env.NODE_ENV === "production")
    throw new Error("FIXTURES_DISABLED");
  if (options.host && !["127.0.0.1", "localhost", "::1"].includes(options.host))
    throw new Error("LOOPBACK_ONLY");
  const objects = new Map<
      string,
      { bytes: Uint8Array; owners: Set<string>; photoId: string }
    >(),
    photos = new Map<
      string,
      { manifest: PhotoManifestV1; signed: SignedPayloadV1 }
    >(),
    grants = new Map<string, GrantV1>(),
    grantReservations = new Map<string, { grant: GrantV1; expires: number }>(),
    grantDetails = new Map<
      string,
      { envelopes: any[]; manifests: SignedPayloadV1[] }
    >(),
    contributions = new Map<string, any>(),
    changes = new Map<string, ChangeV1[]>([
      [A, []],
      [B, []],
    ]),
    reservations = new Map<string, any>(),
    saves = new Map<string, any>(),
    viewed = new Set<string>();
  let seq = 0;
  const addChange = (
    owner: string,
    photo: PhotoManifestV1,
    signed: SignedPayloadV1,
  ) => {
    const list = changes.get(owner)!;
    list.push({
      cursor: String(++seq),
      entity: "photo",
      entityId: photo.photoId,
      deleted: false,
      payload: signed,
    });
  };
  const initialization = (async () => {
    await ready;
    const bytes = await readFile(
        new URL("../fixtures/media/singapore.jpg", import.meta.url),
      ),
      metaKey = new Uint8Array(32).fill(11),
      repKey = new Uint8Array(32).fill(12);
    async function encode(
      plaintext: Uint8Array,
      key: Uint8Array,
      kind: "original" | "preview" | "thumbnail" | "metadata",
      repId: string,
    ) {
      const binding = {
        version: 1 as const,
        photoId: id(10),
        representationId: repId,
        kind,
      };
      async function* records() {
        for (let offset = 0; offset < plaintext.length; offset += 4194304)
          yield plaintext.subarray(offset, offset + 4194304);
      }
      const chunks = [];
      for await (const c of encryptMedia(records(), key, binding))
        chunks.push(c);
      const container = Buffer.concat(chunks),
        objectId = id(Number(repId.slice(-12)) + 100);
      objects.set(objectId, {
        bytes: container,
        owners: new Set([A]),
        photoId: id(10),
      });
      return {
        binding,
        objectId,
        header: b64(chunks[0]),
        ciphertextBytes: container.length,
        ciphertextSha256: sha(container),
      };
    }
    const original = await encode(bytes, repKey, "original", id(11));
    const previewKey = new Uint8Array(32).fill(13),
      thumbnailKey = new Uint8Array(32).fill(14);
    const preview = await encode(
      await readFile(new URL("../fixtures/media/preview.jpg", import.meta.url)),
      previewKey,
      "preview",
      id(12),
    );
    const thumbnail = await encode(
      await readFile(
        new URL("../fixtures/media/thumbnail.jpg", import.meta.url),
      ),
      thumbnailKey,
      "thumbnail",
      id(13),
    );
    const metadata = {
      version: 1,
      filename: "singapore.jpg",
      mediaType: "image/jpeg",
      sourceDate: "2026-10-01T12:00:00Z",
      dateSource: "import",
      originalBytes: bytes.length,
      originalSha256: sha(bytes),
      representationKeys: {
        [id(11)]: b64(repKey),
        [id(12)]: b64(previewKey),
        [id(13)]: b64(thumbnailKey),
      },
    };
    const metadataRepresentation = await encode(
      utf8(metadata),
      metaKey,
      "metadata",
      id(14),
    );
    const manifest: PhotoManifestV1 = {
      version: 1,
      photoId: id(10),
      ownerAccountId: A,
      representations: [original, preview, thumbnail],
      metadataRepresentation,
      ownerWrappedMetadataKey: wrapKey(
        metaKey,
        unb64(accounts.testSecrets[0].vaultKey),
      ),
    };
    const signed = signPayload(
      "photo-manifest",
      A,
      utf8(manifest),
      unb64(accounts.testSecrets[0].signingSecretKey),
    );
    photos.set(manifest.photoId, { manifest, signed });
    addChange(A, manifest, signed);
  })();
  const authorized = (actor: string, photoId: string) =>
    photos.get(photoId)?.manifest.ownerAccountId === actor ||
    [...grants.values()].some(
      (g) =>
        [g.recipientAccountId, g.ownerAccountId].includes(actor) &&
        !g.revokedAt &&
        (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()) &&
        grantDetails
          .get(g.grantId)
          ?.envelopes.some(
            (e) => e.photoId === photoId && e.recipientAccountId === actor,
          ),
    );
  const server = createServer(async (req, res) => {
    try {
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        )
      )
        return send(res, 403, { code: "LOOPBACK_ONLY" });
      const origin = req.headers.origin;
      if (origin) {
        if (!allowedOrigins.has(origin))
          return send(res, 403, { code: "ORIGIN_DENIED" });
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      }
      res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type,x-fotoro-fixture-account,authorization",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
      );
      if (req.method === "OPTIONS") return send(res, 204, null);
      await initialization;
      const url = new URL(req.url!, "http://localhost"),
        path = url.pathname;
      if (path === "/__fixtures/accounts") return send(res, 200, accounts);
      const actor = String(req.headers["x-fotoro-fixture-account"] ?? "");
      if (![A, B].includes(actor)) return error(res, 401, "UNAUTHENTICATED");
      const method = req.method;
      if (path === "/v1/changes" && method === "GET") {
        const limit = Math.max(
          1,
          Math.min(100, Number(url.searchParams.get("limit") ?? 100)),
        );
        const list = (changes.get(actor) ?? []).filter(
          (c) => Number(c.cursor) > Number(url.searchParams.get("cursor") ?? 0),
        );
        const page = list.slice(0, limit);
        return send(res, 200, {
          version: 1,
          changes: page,
          nextCursor: page.at(-1)?.cursor ?? url.searchParams.get("cursor"),
          hasMore: list.length > limit,
        });
      }
      const object = path.match(/^\/v1\/objects\/([^/]+)$/);
      if (object && method === "GET") {
        const entry = objects.get(object[1]);
        if (!entry) return error(res, 404, "NOT_FOUND");
        if (!entry.owners.has(actor) && !authorized(actor, entry.photoId))
          return error(res, 403, "FORBIDDEN");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": entry.bytes.length,
        });
        return res.end(entry.bytes);
      }
      if (path === "/v1/uploads/reserve" && method === "POST") {
        const input = validateWire<any>("ReserveUploadV1", await json(req));
        const previous = [...reservations.values()].find(
          (r) => r.actor === actor && r.input.operationId === input.operationId,
        );
        if (previous) return send(res, 200, previous.wire);
        const uploadId = randomUUID(),
          port = (server.address() as any).port;
        const wire = {
          version: 1,
          uploadId,
          photoId: input.binding.photoId,
          representationId: input.binding.representationId,
          stagingUrl: `http://127.0.0.1:${port}/__fixtures/staging/${uploadId}`,
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        };
        reservations.set(uploadId, { actor, input, wire });
        return send(res, 200, wire);
      }
      const staging = path.match(/^\/__fixtures\/staging\/([^/]+)$/);
      if (staging && method === "PUT") {
        const reservation = reservations.get(staging[1]);
        if (!reservation || reservation.actor !== actor)
          return error(res, 403, "FORBIDDEN");
        reservation.bytes = await body(req);
        return send(res, 200, { version: 1 });
      }
      const commit = path.match(/^\/v1\/uploads\/([^/]+)\/commit$/);
      if (commit && method === "POST") {
        const r = reservations.get(commit[1]);
        if (!r || r.actor !== actor) return error(res, 403, "FORBIDDEN");
        if (r.commit) return send(res, 200, r.commit);
        if (!r.bytes) return error(res, 409, "UPLOAD_INCOMPLETE");
        if (
          r.bytes.length !== r.input.ciphertextBytes ||
          sha(r.bytes) !== r.input.ciphertextSha256
        )
          return error(res, 422, "DIGEST_MISMATCH");
        const objectId = randomUUID();
        objects.set(objectId, {
          bytes: new Uint8Array(r.bytes),
          owners: new Set([actor]),
          photoId: r.input.binding.photoId,
        });
        r.commit = {
          version: 1,
          uploadId: r.wire.uploadId,
          objectId,
          ciphertextBytes: r.bytes.length,
          ciphertextSha256: sha(r.bytes),
        } satisfies UploadCommitV1;
        return send(res, 200, r.commit);
      }
      if (path === "/v1/photos" && method === "POST") {
        const signed = validateWire<SignedPayloadV1>(
          "SignedPayloadV1",
          await json(req),
        );
        const card = accounts.accounts.find((a) => a.accountId === actor)!;
        if (signed.accountId !== actor || signed.kind !== "photo-manifest")
          return error(res, 403, "FORBIDDEN");
        const manifest = validateWire<PhotoManifestV1>(
          "PhotoManifestV1",
          JSON.parse(
            new TextDecoder().decode(
              verifyPayload(signed, unb64(card.signingPublicKey)),
            ),
          ),
        );
        if (manifest.ownerAccountId !== actor)
          return error(res, 403, "FORBIDDEN");
        for (const r of [
          ...manifest.representations,
          manifest.metadataRepresentation,
        ])
          if (!objects.get(r.objectId)?.owners.has(actor))
            return error(res, 403, "FORBIDDEN");
        photos.set(manifest.photoId, { manifest, signed });
        addChange(actor, manifest, signed);
        return send(res, 200, manifest);
      }
      const grantOptions = path.match(
        /^\/v1\/moments\/([^/]+)\/grants\/options$/,
      );
      if (grantOptions && method === "POST") {
        const input = validateWire<any>(
          "GrantOptionsRequestV1",
          await json(req),
        );
        if (
          input.recipientAccountId === actor ||
          ![A, B].includes(input.recipientAccountId)
        )
          return error(res, 400, "INVALID_RECIPIENT");
        const grant: GrantV1 = {
          grantId: randomUUID(),
          momentId: grantOptions[1],
          ownerAccountId: actor,
          recipientAccountId: input.recipientAccountId,
          role: input.role,
          expiresAt:
            input.access === "temporary"
              ? new Date(Date.now() + 900000).toISOString()
              : null,
          revokedAt: null,
          version: 1,
        };
        grantReservations.set(grant.grantId, {
          grant,
          expires: Date.now() + 300000,
        });
        return send(res, 200, grant);
      }
      const grantCreate = path.match(/^\/v1\/moments\/([^/]+)\/grants$/);
      if (grantCreate && method === "POST") {
        const input = validateWire<any>("CreateGrantV1", await json(req));
        const grant = validateWire<GrantV1>("GrantV1", input.grant);
        if (grant.ownerAccountId !== actor || grant.momentId !== grantCreate[1])
          return error(res, 403, "FORBIDDEN");
        const signedBody = JSON.parse(
          new TextDecoder().decode(
            verifyPayload(
              input.signedPayload,
              unb64(
                accounts.accounts.find((a) => a.accountId === actor)!
                  .signingPublicKey,
              ),
            ),
          ),
        );
        if (
          input.signedPayload.kind !== "grant" ||
          input.signedPayload.accountId !== actor ||
          !isDeepStrictEqual(signedBody, { grant, envelopes: input.envelopes })
        )
          return error(res, 400, "BODY_MISMATCH");
        const reserved = grantReservations.get(grant.grantId);
        if (
          !reserved ||
          reserved.expires <= Date.now() ||
          !isDeepStrictEqual(reserved.grant, grant)
        )
          return error(res, 409, "GRANT_RESERVATION_INVALID");
        for (const e of input.envelopes) {
          if (
            e.grantId !== grant.grantId ||
            e.senderAccountId !== actor ||
            e.recipientAccountId !== grant.recipientAccountId ||
            photos.get(e.photoId)?.manifest.ownerAccountId !== actor
          )
            return error(res, 403, "FORBIDDEN");
        }
        grants.set(grant.grantId, grant);
        grantDetails.set(grant.grantId, {
          envelopes: input.envelopes,
          manifests: input.envelopes.map(
            (e: any) => photos.get(e.photoId)!.signed,
          ),
        });
        for (const e of input.envelopes) {
          const photo = photos.get(e.photoId)!;
          addChange(grant.recipientAccountId, photo.manifest, photo.signed);
        }
        return send(res, 200, grant);
      }
      if (path === "/v1/grants" && method === "GET")
        return send(res, 200, {
          version: 1,
          grants: [...grants.values()].filter(
            (g) => g.ownerAccountId === actor || g.recipientAccountId === actor,
          ),
        });
      const grantGet = path.match(/^\/v1\/grants\/([^/]+)$/);
      if (grantGet && method === "GET") {
        const grant = grants.get(grantGet[1]);
        if (
          !grant ||
          ![grant.ownerAccountId, grant.recipientAccountId].includes(actor)
        )
          return error(res, 403, "FORBIDDEN");
        if (
          grant.revokedAt ||
          (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
        )
          return error(res, 403, "GRANT_INACTIVE");
        const detail = grantDetails.get(grant.grantId)!;
        return send(res, 200, {
          version: 1,
          grant,
          ...detail,
          cards: accounts.accounts.filter((a) =>
            [grant.ownerAccountId, grant.recipientAccountId].includes(
              a.accountId,
            ),
          ),
        });
      }
      const revoke = path.match(/^\/v1\/grants\/([^/]+)$/);
      if (revoke && method === "DELETE") {
        const grant = grants.get(revoke[1]);
        if (!grant || grant.ownerAccountId !== actor)
          return error(res, 403, "FORBIDDEN");
        grant.revokedAt = new Date().toISOString();
        grant.version++;
        return send(res, 200, grant);
      }
      const view = path.match(/^\/v1\/grants\/([^/]+)\/viewed$/);
      if (view && method === "POST") {
        const grant = grants.get(view[1]);
        if (
          !grant ||
          grant.recipientAccountId !== actor ||
          grant.revokedAt ||
          (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
        )
          return error(res, 403, "GRANT_INACTIVE");
        viewed.add(view[1]);
        return send(res, 200, {
          version: 1,
          grantId: view[1],
          viewedAt: new Date().toISOString(),
        });
      }
      if (path === "/v1/saves" && method === "POST") {
        const input = validateWire<any>("SaveRequestV1", await json(req)),
          save = validateWire<any>("SavedPhotoV1", input.save);
        const operation = actor + ":" + save.operationId;
        if (saves.has(operation)) {
          if (!isDeepStrictEqual(saves.get(operation), save))
            return error(res, 409, "IDEMPOTENCY_CONFLICT");
          return send(res, 200, saves.get(operation));
        }
        const grant = grants.get(save.sourceGrantId);
        if (
          !grant ||
          grant.recipientAccountId !== actor ||
          grant.revokedAt ||
          (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
        )
          return error(res, 403, "GRANT_INACTIVE");
        if (input.expectedGrantVersion !== grant.version)
          return error(res, 409, "VERSION_CONFLICT");
        if (save.manifest.ownerAccountId !== actor)
          return error(res, 403, "FORBIDDEN");
        const verified = verifyPayload(
          save.signedPayload,
          unb64(
            accounts.accounts.find((a) => a.accountId === actor)!
              .signingPublicKey,
          ),
        );
        if (
          save.signedPayload.accountId !== actor ||
          save.signedPayload.kind !== "photo-manifest" ||
          !isDeepStrictEqual(
            JSON.parse(new TextDecoder().decode(verified)),
            save.manifest,
          ) ||
          save.photoId !== save.manifest.photoId
        )
          return error(res, 400, "BODY_MISMATCH");
        if (
          !grantDetails
            .get(grant.grantId)
            ?.envelopes.some((e) => e.photoId === save.sourcePhotoId)
        )
          return error(res, 403, "FORBIDDEN");
        const source = photos.get(save.sourcePhotoId);
        if (
          !source ||
          !isDeepStrictEqual(
            source.manifest.representations,
            save.manifest.representations,
          ) ||
          !isDeepStrictEqual(
            source.manifest.metadataRepresentation,
            save.manifest.metadataRepresentation,
          )
        )
          return error(res, 400, "SOURCE_MISMATCH");
        for (const r of [
          ...save.manifest.representations,
          save.manifest.metadataRepresentation,
        ]) {
          const object = objects.get(r.objectId);
          if (!object || !authorized(actor, object.photoId))
            return error(res, 403, "FORBIDDEN");
        }
        for (const r of [
          ...save.manifest.representations,
          save.manifest.metadataRepresentation,
        ])
          objects.get(r.objectId)!.owners.add(actor);
        photos.set(save.photoId, {
          manifest: save.manifest,
          signed: save.signedPayload,
        });
        addChange(actor, save.manifest, save.signedPayload);
        saves.set(operation, save);
        return send(res, 200, save);
      }
      const contribution = path.match(
        /^\/v1\/moments\/([^/]+)\/contributions$/,
      );
      if (contribution && method === "POST") {
        const input = await json(req);
        const grant = [...grants.values()].find(
          (g) =>
            g.momentId === contribution[1] &&
            [g.recipientAccountId, g.ownerAccountId].includes(actor) &&
            g.role === "contributor" &&
            !g.revokedAt &&
            (!g.expiresAt || Date.parse(g.expiresAt) > Date.now()),
        );
        if (!grant) return error(res, 403, "GRANT_INACTIVE");
        if (input.expectedGrantVersion !== grant.version)
          return error(res, 409, "VERSION_CONFLICT");
        validateWire("ContributionV1", input);
        const operation = actor + ":" + input.operationId;
        if (contributions.has(operation))
          return send(res, 200, contributions.get(operation));
        const additions = [];
        for (const signed of input.manifests) {
          const manifest = validateWire<PhotoManifestV1>(
            "PhotoManifestV1",
            JSON.parse(
              new TextDecoder().decode(
                verifyPayload(
                  validateWire("SignedPayloadV1", signed),
                  unb64(
                    accounts.accounts.find((a) => a.accountId === actor)!
                      .signingPublicKey,
                  ),
                ),
              ),
            ),
          );
          if (
            signed.accountId !== actor ||
            signed.kind !== "photo-manifest" ||
            manifest.ownerAccountId !== actor
          )
            return error(res, 403, "FORBIDDEN");
          if (
            !input.envelopes.some(
              (e: any) =>
                e.photoId === manifest.photoId &&
                e.senderAccountId === actor &&
                e.recipientAccountId === grant.ownerAccountId &&
                e.grantId === grant.grantId,
            )
          )
            return error(res, 400, "MISSING_ENVELOPE");
          for (const rep of [
            ...manifest.representations,
            manifest.metadataRepresentation,
          ])
            if (!objects.get(rep.objectId)?.owners.has(actor))
              return error(res, 403, "FORBIDDEN");
          additions.push({ manifest, signed });
        }
        for (const photo of additions) {
          photos.set(photo.manifest.photoId, photo);
          addChange(grant.ownerAccountId, photo.manifest, photo.signed);
        }
        const detail = grantDetails.get(grant.grantId)!;
        detail.envelopes.push(...input.envelopes);
        detail.manifests.push(...input.manifests);
        const result = {
          version: 1,
          operationId: input.operationId,
          accepted: input.manifests.length,
        };
        contributions.set(operation, result);
        return send(res, 200, result);
      }
      if (path === "/v1/vault" && method === "GET") {
        const secrets = accounts.testSecrets.find(
          (a) => a.accountId === actor,
        )!;
        return send(res, 200, {
          version: 1,
          accountCard: accounts.accounts.find((a) => a.accountId === actor),
          wrappers: [
            {
              version: 1,
              wrapperId: id(actor === A ? 40 : 41),
              kind: "recovery",
              credentialId: null,
              prfSalt: null,
              wrappedBundle: secrets.encryptedBundle,
              verified: true,
            },
          ],
        });
      }
      if (/^\/v1\/(auth|devices|credentials|vault\/wrappers)/.test(path))
        return error(res, 501, "REAL_AUTH_REQUIRED");
      return error(res, 404, "NOT_FOUND");
    } catch (e) {
      return error(
        res,
        400,
        e instanceof Error ? e.message : "INVALID_REQUEST",
      );
    }
  });
  return server;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(value === null ? "" : JSON.stringify(value));
}
function error(res: ServerResponse, status: number, code: string) {
  return send(res, status, {
    version: 1,
    code,
    retryable: false,
    requestId: randomUUID(),
  });
}
async function body(req: IncomingMessage) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 55 * 1024 * 1024) throw new Error("TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage) {
  return JSON.parse((await body(req)).toString());
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createFixtureServer({ host: "127.0.0.1" });
  server.listen(8790, "127.0.0.1", () =>
    console.log("Public test fixtures: http://127.0.0.1:8790"),
  );
}

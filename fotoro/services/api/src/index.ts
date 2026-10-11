import { Hono } from "hono";
import { ApiError, type Env, type Actor, fail } from "./errors";
import * as auth from "./auth";
import * as storage from "./storage";
import * as catalog from "./catalog";
import * as devices from "./devices";
import * as grants from "./grants";
import * as albums from "./albums";
import * as albumPhotoFacts from "./album-photo-facts";
import { savePhoto } from "./saves";
import * as annotations from "./annotations";
import * as contacts from "./contacts";
import * as peopleLinks from "./people-links";
import * as intelligence from "./intelligence";
import {beginDiagnostic, diagnosticFailure, finalDiagnostic, type RequestDiagnostic} from "./diagnostics";
import { readJson } from "./requests";
import {accountStorage, throttleAuth} from "./limits";
const app = new Hono<{ Bindings: Env; Variables: { actor: Actor; requestDiagnostic: RequestDiagnostic } }>();
app.use("/v1/*", async (c, next) => {
  const diagnostic = beginDiagnostic(c.req.header("X-Fotoro-Trace-Id"));
  c.set("requestDiagnostic", diagnostic);
  await next();
  c.header("X-Request-Id", diagnostic.requestId);
  const record = finalDiagnostic(diagnostic, c.req.method, c.req.path, c.res.status);
  const text = JSON.stringify(record);
  if (c.res.status >= 500) console.error(text);
  else if (c.res.status >= 400) console.warn(text);
  else console.info(text);
});
app.onError((error, c) => {
  const e =
    error instanceof ApiError
      ? error
      : new ApiError(
          (error as any).code === "INVALID_WIRE" || error instanceof SyntaxError
            ? "INVALID_WIRE"
            : "INTERNAL_ERROR",
          (error as any).code === "INVALID_WIRE" || error instanceof SyntaxError
            ? 400
            : 500,
        );
  const diagnostic = c.get("requestDiagnostic");
  const requestId = diagnostic?.requestId ?? crypto.randomUUID();
  if (diagnostic) diagnostic.failure = diagnosticFailure(e.code, e.status, c.req.path, e.diagnostic);
  if (e.retryAfterSeconds) c.header("Retry-After", String(e.retryAfterSeconds));
  return c.json(
    {
      version: 1,
      code: e.code,
      retryable: e.retryable,
      requestId,
    },
    e.status as any,
  );
});
app.get("/.well-known/apple-app-site-association", (c) => {
  const apps = [...new Set((c.env.APPLE_APP_IDS ?? "").split(",").map(value => value.trim()))];
  if (!apps.length || apps.some(value => !/^[A-Z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value))) {
    c.header("Cache-Control", "no-store");
    return c.json({error: "ASSOCIATION_NOT_CONFIGURED"}, 503);
  }
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    webcredentials: {apps},
    applinks: {details: [{
      appIDs: apps,
      components: [
        {"/": "/", "#": "contact=*"},
        {"/": "/", "#": "moment=*"},
        {"/": "/", "#": "album=*"},
      ],
    }]},
  });
});
app.use("/v1/*", async (c, next) => {
  if (c.req.header("x-fotoro-fixture-account")) fail("UNAUTHENTICATED", 401);
  const o = c.req.header("origin");
  if (o && !auth.config(c.env).origins.includes(o)) fail("ORIGIN_DENIED", 403);
  if (o) {
    c.header("Access-Control-Allow-Origin", o);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Expose-Headers", "X-Request-Id");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Fotoro-Account-Id,X-Fotoro-Trace-Id");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    return c.body(null, 204);
  }
  const backgroundUpload = c.req.method === "PUT" && /^\/v1\/background\/uploads\/[^/]+\/staging$/.test(c.req.path);
  if (!c.req.path.startsWith("/v1/auth/") && !backgroundUpload) {
    if (c.req.method !== "GET") auth.origin(c.env, c.req.raw);
    const actor = await auth.actorFor(c.env, c.req.raw);
    const expectations = [c.req.header("x-fotoro-account-id"), c.req.query("expectedAlbumAccountId")];
    if (expectations.some(expected => expected !== undefined && expected !== actor.accountId)) fail("ACCOUNT_MISMATCH", 403);
    c.set("actor", actor);
  }
  if (c.req.method === "POST" && (c.req.path.startsWith("/v1/auth/") && c.req.path !== "/v1/auth/logout" || c.req.path === "/v1/devices/enroll")) {
    auth.origin(c.env, c.req.raw);
    await throttleAuth(c.env, c.req.raw,
      /^\/v1\/auth\/(start|register)\/options$/.test(c.req.path) || c.req.path === "/v1/devices/enroll",
      c.req.path === "/v1/devices/enroll" ? c.get("actor").accountId : undefined);
  }
  await next();
});
for (const kind of ["register", "login", "recovery", "start"]) {
  app.post(`/v1/auth/${kind}/options`, async (c) =>
    c.json(await auth.options(c.env, c.req.raw, kind, await readJson<any>(c.req.raw))),
  );
  app.post(`/v1/auth/${kind}/verify`, async (c) => {
    const s = await auth.verify(c.env, c.req.raw, kind, await readJson<any>(c.req.raw));
    if (s.cookie) c.header("Set-Cookie", s.cookie);
    return c.json(s.body);
  });
}
app.post("/v1/auth/logout", async (c) => {
  const result = await auth.logout(c.env, c.req.raw);
  c.header(
    "Set-Cookie",
    "fotoro_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
  return c.json(result);
});
app.get("/v1/vault", async (c) =>
  c.json(await auth.vault(c.env, c.get("actor").accountId)),
);
app.get("/v1/storage", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await accountStorage(c.env, c.get("actor")));
});
app.get("/v1/intelligence/capabilities", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await intelligence.capabilities(c.env, c.get("actor"), c.req.query("expectedAccountId")));
});
app.post("/v1/intelligence/observe", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await intelligence.observe(c.env, c.get("actor"), c.req.raw));
});
app.put("/v1/vault/wrappers/:id", async (c) =>
  c.json(
    await auth.putWrapper(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.delete("/v1/credentials/:id", async (c) =>
  c.json(await auth.removeCredential(c.env, c.get("actor"), c.req.param("id"))),
);
app.post("/v1/devices/enroll", async (c) =>
  c.json(
    await devices.enroll(c.env, c.get("actor"), c.req.raw, await readJson<any>(c.req.raw)),
  ),
);
app.post("/v1/devices/enroll/:id/approve", async (c) =>
  c.json(
    await devices.approve(
      c.env,
      c.get("actor"),
      c.req.raw,
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.post("/v1/devices/enroll/:id/complete", async (c) =>
  c.json(
    await devices.complete(
      c.env,
      c.get("actor"),
      c.req.raw,
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.post("/v1/uploads/reserve", async (c) =>
  c.json(
    await storage.reserveUpload(
      c.env,
      c.get("actor"),
      await readJson<any>(c.req.raw),
      new URL(c.req.url).origin,
    ),
  ),
);
app.put("/v1/uploads/:id/staging", async (c) =>
  c.json(
    await storage.putStaging(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      c.req.query("cap") || "",
      c.req.raw,
    ),
  ),
);
app.put("/v1/background/uploads/:id/staging", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.json(await storage.putBackgroundStaging(c.env, c.req.param("id"), c.req.query("cap") || "", c.req.raw));
});
app.post("/v1/uploads/:id/commit", async (c) =>
  c.json(await storage.commitUpload(c.env, c.get("actor"), c.req.param("id"))),
);
app.get("/v1/objects/:id", (c) =>
  storage.getObject(c.env, c.get("actor"), c.req.param("id")),
);
app.post("/v1/photos", async (c) =>
  c.json(await catalog.addPhoto(c.env, c.get("actor"), await readJson<any>(c.req.raw))),
);
app.get("/v1/photos/:id/manifest", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await catalog.ownedManifest(c.env, c.get("actor"), c.req.param("id")));});
app.get("/v1/photos/:id/annotations", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await annotations.getAnnotations(c.env, c.get("actor"), c.req.param("id")));
});
app.put("/v1/photos/:id/annotations", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await annotations.putAnnotations(c.env, c.get("actor"), c.req.param("id"), await annotations.readAnnotationRequest(c.req.raw)));
});
app.get("/v1/contacts", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await contacts.getContacts(c.env, c.get("actor")));
});
app.put("/v1/contacts", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await contacts.putContacts(c.env, c.get("actor"), await contacts.readContactsRequest(c.req.raw)));
});
app.get("/v1/people-links", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await peopleLinks.getPeopleLinks(c.env, c.get("actor")));
});
app.put("/v1/people-links", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await peopleLinks.putPeopleLinks(c.env, c.get("actor"), await peopleLinks.readPeopleLinksRequest(c.req.raw)));
});
app.get("/v1/changes", async (c) =>
  c.json(
    await catalog.changes(
      c.env,
      c.get("actor"),
      c.req.query("cursor") || null,
      Number(c.req.query("limit") || 100),
      c.req.query("media") === "1",
    ),
  ),
);
app.post("/v1/moments/:id/grants/options", async (c) =>
  c.json(
    await grants.grantOptions(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.post("/v1/moments/:id/grants", async (c) =>
  c.json(
    await grants.createGrant(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.get("/v1/album-photo-facts/capabilities", (c) => {c.header("Cache-Control", "no-store"); return c.json(albumPhotoFacts.capabilities());});
app.get("/v1/albums/:id/photo-facts", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albumPhotoFacts.list(c.env, c.get("actor"), c.req.param("id"), c.req.query("cursor")));});
app.get("/v1/albums/:id/photo-facts/:photoId", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albumPhotoFacts.get(c.env, c.get("actor"), c.req.param("id"), c.req.param("photoId")));});
app.put("/v1/albums/:id/photo-facts/:photoId", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albumPhotoFacts.put(c.env, c.get("actor"), c.req.param("id"), c.req.param("photoId"), await readJson(c.req.raw, 32 * 1024)));});
app.get("/v1/albums/capabilities", (c) => {c.header("Cache-Control", "no-store"); return c.json(albums.capabilities());});
app.post("/v1/albums", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.create(c.env, c.get("actor"), await readJson(c.req.raw)));});
app.get("/v1/albums", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.inbox(c.env, c.get("actor")));});
app.get("/v1/albums/:id/access", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.access(c.env, c.get("actor"), c.req.param("id")));});
app.get("/v1/albums/:id", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.detail(c.env, c.get("actor"), c.req.param("id"), c.req.query("cursor")));});
app.post("/v1/albums/:id/accept", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.accept(c.env, c.get("actor"), c.req.param("id"), await readJson(c.req.raw)));});
app.post("/v1/albums/:id/end", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.end(c.env, c.get("actor"), c.req.param("id"), await readJson(c.req.raw)));});
app.post("/v1/albums/:id/photos", async (c) => {c.header("Cache-Control", "no-store"); return c.json(await albums.append(c.env, c.get("actor"), c.req.param("id"), await readJson(c.req.raw)));});
app.get("/v1/grants", async (c) =>
  c.json(await grants.inbox(c.env, c.get("actor"))),
);
app.get("/v1/grants/:id", async (c) =>
  c.json(await grants.detail(c.env, c.get("actor"), c.req.param("id"), c.req.query("media") === "1")),
);
app.delete("/v1/grants/:id", async (c) =>
  c.json(await grants.revoke(c.env, c.get("actor"), c.req.param("id"))),
);
app.post("/v1/grants/:id/viewed", async (c) =>
  c.json(await grants.viewed(c.env, c.get("actor"), c.req.param("id"))),
);
app.post("/v1/saves", async (c) =>
  c.json(await savePhoto(c.env, c.get("actor"), await readJson<any>(c.req.raw))),
);
app.post("/v1/moments/:id/contributions", async (c) =>
  c.json(
    await grants.contribute(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      await readJson<any>(c.req.raw),
    ),
  ),
);
app.notFound(async (c) => {
  if (
    c.env.ASSETS &&
    !c.req.path.startsWith("/v1/") &&
    !c.req.path.startsWith("/__fixtures")
  )
    return c.env.ASSETS.fetch(c.req.raw);
  return c.json(
    {
      version: 1,
      code: "NOT_FOUND",
      retryable: false,
      requestId: c.get("requestDiagnostic")?.requestId ?? crypto.randomUUID(),
    },
    404,
  );
});
export default app;

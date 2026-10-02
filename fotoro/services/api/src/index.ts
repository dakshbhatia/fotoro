import { Hono } from "hono";
import { ApiError, type Env, type Actor, fail } from "./errors";
import * as auth from "./auth";
import * as storage from "./storage";
import * as catalog from "./catalog";
import * as devices from "./devices";
import * as grants from "./grants";
import { savePhoto } from "./saves";
import * as annotations from "./annotations";
import {diagnosticMethod, diagnosticPhase, diagnosticErrorClass} from "./diagnostics";
import { readJson } from "./requests";
const app = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();
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
  const requestId = crypto.randomUUID();
  const method = diagnosticMethod(c.req.method);
  const phase = e.diagnostic?.phase ?? diagnosticPhase(c.req.path);
  const errorClass = e.diagnostic?.errorClass ?? diagnosticErrorClass(e.code, e.status);
  const diagnostic = JSON.stringify({event: "api.error", requestId, method, status: e.status, code: e.code, phase, errorClass});
  if (e.status >= 500) console.error(diagnostic);
  else console.warn(diagnostic);
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
  return c.json({webcredentials: {apps}});
});
app.use("/v1/*", async (c, next) => {
  if (c.req.header("x-fotoro-fixture-account")) fail("UNAUTHENTICATED", 401);
  const o = c.req.header("origin");
  if (o && !auth.config(c.env).origins.includes(o)) fail("ORIGIN_DENIED", 403);
  if (o) {
    c.header("Access-Control-Allow-Origin", o);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    return c.body(null, 204);
  }
  const backgroundUpload = c.req.method === "PUT" && /^\/v1\/background\/uploads\/[^/]+\/staging$/.test(c.req.path);
  if (!c.req.path.startsWith("/v1/auth/") && !backgroundUpload) {
    if (c.req.method !== "GET") auth.origin(c.env, c.req.raw);
    c.set("actor", await auth.actorFor(c.env, c.req.raw));
  }
  await next();
});
for (const kind of ["register", "login", "recovery"]) {
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
app.get("/v1/photos/:id/annotations", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await annotations.getAnnotations(c.env, c.get("actor"), c.req.param("id")));
});
app.put("/v1/photos/:id/annotations", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(await annotations.putAnnotations(c.env, c.get("actor"), c.req.param("id"), await annotations.readAnnotationRequest(c.req.raw)));
});
app.get("/v1/changes", async (c) =>
  c.json(
    await catalog.changes(
      c.env,
      c.get("actor"),
      c.req.query("cursor") || null,
      Number(c.req.query("limit") || 100),
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
app.get("/v1/grants", async (c) =>
  c.json(await grants.inbox(c.env, c.get("actor"))),
);
app.get("/v1/grants/:id", async (c) =>
  c.json(await grants.detail(c.env, c.get("actor"), c.req.param("id"))),
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
      requestId: crypto.randomUUID(),
    },
    404,
  );
});
export default app;

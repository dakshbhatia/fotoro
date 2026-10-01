import { env } from "cloudflare:test";
import schema from "../migrations/0001_catalog.sql?raw";
import accounts from "../migrations/0002_accounts_grants.sql?raw";
import origin from "../migrations/0003_origin_and_views.sql?raw";
import { beforeAll } from "vitest";
beforeAll(async () => {
  await env.DB.exec(schema.replace(/\n/g, " "));
  await env.DB.exec(accounts.replace(/\n/g, " "));
  await env.DB.exec(origin.replace(/\n/g, " "));
});

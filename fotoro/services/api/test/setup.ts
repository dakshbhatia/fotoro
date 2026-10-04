import { env } from "cloudflare:test";
import schema from "../migrations/0001_catalog.sql?raw";
import accounts from "../migrations/0002_accounts_grants.sql?raw";
import origin from "../migrations/0003_origin_and_views.sql?raw";
import annotations from "../migrations/0004_private_annotations.sql?raw";
import indexes from "../migrations/0005_account_catalog_indexes.sql?raw";
import limits from "../migrations/0006_storage_and_auth_limits.sql?raw";
import { beforeAll } from "vitest";
beforeAll(async () => {
  await env.DB.exec(schema.replace(/\n/g, " "));
  await env.DB.exec(accounts.replace(/\n/g, " "));
  await env.DB.exec(origin.replace(/\n/g, " "));
  await env.DB.exec(annotations.replace(/\n/g, " "));
  await env.DB.exec(indexes.replace(/\n/g, " "));
  await env.DB.exec(limits.replace(/\n/g, " "));
});

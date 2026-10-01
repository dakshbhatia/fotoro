# Cloudflare deployment

The new Fotoro web and API build is developed in `fotoro/`. The upstream Ente runtime is a separate reference and does not deploy through this configuration.

## Target

- React/Vite static assets and `/v1/*` API served on one origin.
- Hono Worker with private R2 media and D1 account/grant/catalog records.
- Clients generate encrypted originals, previews and thumbnails before upload.
- Development fixture auth is restricted to loopback and never included in production.
- No AI provider is needed to build or run this first slice.

## Release order

1. Complete local contract, crypto, API, web and native checks; use generated/public fixture data.
2. Log in to the intended Cloudflare account through Wrangler's normal OAuth flow. Do not paste tokens into chat or commit credentials.
3. Create separate preview D1/R2 resources and apply migrations. Deploy a preview with explicit allowed origin/RP settings, never localhost fixture settings.
4. Exercise real passkey sessions, recovery, two-account exchange, upload reconciliation, revocation and independent save against that preview.
5. Build production with distinct bindings, production RP `fotoro.cloud`, allowed origin `https://fotoro.cloud`, secure cookies and authenticated media delivery.
6. Verify the deployment URL before changing domain routing. Attach `fotoro.cloud` only after checks pass; retain a rollback target.
7. Configure Apple associated domains and signing; test passkeys, background transfer and original restore on physical devices before TestFlight release.

A Worker preview with a different RP creates different passkey credentials. Do not assume those credentials migrate to the production RP.

## Current state

October 1, 2026: the active checkout is `/Users/dakshbhatia/Documents/GitHub/Fotoro`.
The native/web/API development build runs locally, with the web preview at 4310,
real local API at 8787 and public fixtures at 8790. Production D1/R2 bindings,
Cloudflare access and Apple signing are still required. No public Fotoro service
or TestFlight release is claimed. See [verification](verification.md).

Foreground Photos sync is implemented locally. On a deployed/signed build:
create or unlock one account on iPhone, save its recovery code, then start
Sync last 30 days. Open the same HTTPS service in Safari and sign in or recover
that account to load committed photos. Keep the iPhone app open during backup.
Background scheduling and a personal physical-device acceptance run remain release
gates; localhost on this Mac is not an installable iPhone service.

Production web assets and Worker bundling pass a Wrangler `--dry-run`. Wrangler
reports missing production D1/R2 bindings: those bindings are not inherited from
the local environment. Add the real resource identifiers before deployment;
the dry-run is not a provisioned or usable service.

References: [Workers static assets](https://developers.cloudflare.com/workers/static-assets/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

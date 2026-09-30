# Fotoro product direction

September 30, 2026. The user selected **Fotoro**, with **fotoro.cloud** as the
intended domain, and emphasized sharing photos with family and friends. The
scope and sequence below are proposed next work, not implemented capabilities.

## Product goal

A fast, private photo library that makes exchanging photos with family and
friends effortless. Open your photos immediately, keep originals safe across
devices, find shared moments, and send the right photos to the right people.
Local indexing improves search in the background; cloud enrichment is optional.

## First beta: one complete exchange

With two test accounts and public fixtures:

1. Add a small set of photos to an authenticated library.
2. Reopen the app and see the same library; confirm originals were uploaded.
3. Select photos and invite a specific family member or friend.
4. The recipient opens the invitation in Fotoro on iPhone or web, accepts it,
   views the photos, and explicitly saves a copy to their library.
5. Both people can reopen their libraries and find those photos. Verify restored
   original digests, invitation revocation, and interrupted-transfer recovery.

This target uses deliberate selection and Ente's existing encrypted album,
account, and key-sharing machinery. Automatic face-based sharing is not part of
the first exchange. Shared access and a recipient-owned saved copy must be
distinguishable. Revocation cannot erase a copy already received.

## Build sequence

| Slice | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 1. Durable library | Connect the photo-first canvas to the real Ente account catalog, encrypted originals, and reconstructible thumbnail/index cache. | Refresh, sign out/in, reopen on a second device, and restore the same originals. No backup claim until upload verification succeeds. |
| 2. Family exchange | Select, invite a known recipient, accept, view, and save. Reuse private album sharing and member removal. | Two-account exchange works on native and web; an unrelated account cannot access the album. Saved copies survive removal from the shared album. |
| 3. Friend window | A server-enforced 15-minute grant to receive the selected photos, with clear expiry and delivery state. | Late requests are denied; pending/partial transfers and retries have defined behavior; already received copies remain. Use relay delivery before adding nearby transport. |
| 4. Useful search | Incremental metadata/OCR search, local face groups with corrections, and semantic retrieval using a permitted model. Optional Gemini 3.8 descriptions enrich the encrypted index. | A fixed set of date/person/text/scene queries works; browsing remains responsive while indexing; web and native retrieve the same synced index. |
| 5. Launch experience | Primary passkey sign-in plus encrypted-library unlock and recovery; native photo-first UI; safe duplicate cleanup; nearby exchange where supported. | Real-device recovery, background transfers, native gestures, and signed beta builds pass their individual acceptance flows. |

Each slice needs a short design and reviewable implementation plan before its
code work starts. Keep separate acceptance evidence for each capability; a
working preview or inherited Ente feature does not prove the whole beta.

## Deploy and iterate

Code is on GitHub. The current custom experience is a local, session-only web
preview; the native build uses upstream onboarding. The first deployable demo
can be a clearly marked static preview. The beta needs Museum/Postgres, private
object storage, authenticated sharing, a tested database/configuration backup,
and a successful clean restore.

Use Cloudflare for the web exports and private R2 objects; use a small Hetzner
VM for Museum/Postgres. See [deployment.md](deployment.md). Domain and provider
access are still needed. Do not assume `fotoro.cloud` is registered or live.

Continue using `node scripts/ai-photos.mjs` for the development loop. Keep
upstream licensing and service identifiers intact while branding the Fotoro
surfaces; do not broadly replace `ente` across crypto, URLs, or package names.

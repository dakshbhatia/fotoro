# Fotoro consumer sync

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../../fotoro/docs/product.md),
> [the only active queue](../../../fotoro/docs/product-backlog.md),
> [architecture](../../../fotoro/docs/foundation.md) and
> [current evidence](../../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

The user has authorized building a simple consumer flow now. Open Photos works without an account. Sync photos introduces an account and one recovery-code step; its status explains progress, pending work, and the next action.

Account-private labels, captions, supplied facts and completed OCR travel with each original through a separate encrypted annotation record. This keeps media manifests immutable and personal annotations out of sharing grants. Search choices and pins stay local. Both clients verify the owner's signature, account, photo ID and original digest before displaying or indexing annotations.

An update signs `photo-annotations` with `{version:1,photoId,revision,encrypted}`. `encrypted` is a secretbox under the account vault key; its plaintext is `PhotoAnnotationsV1`. Initial revision is 1 and subsequent writes compare the previous revision atomically. Identical current retries succeed without a duplicate change. A conflict preserves the pending edit until reconciled. An owner-only GET and account change events allow other devices to hydrate the latest version. Bounded ciphertext and plaintext schemas prevent unrestricted annotation payloads.

iOS may transfer ciphertext that was staged while the app was unlocked through a background URLSession. It reconnects durable task identities after relaunch. It does not scan or encrypt an unbounded Photos library while closed; final catalog signing waits for the vault to unlock. Account changes, cancellation, credential origins and redirects are fenced. Only ciphertext may use after-first-unlock protection.

The service provides the Apple webcredentials association document from explicitly configured app identifiers. Deployment requires authenticated Cloudflare access, real D1/R2 bindings, an app-specific Apple profile, and a physical-device run; preparation must not pretend those external resources exist.

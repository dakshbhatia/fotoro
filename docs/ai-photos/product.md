# Fotoro product

Fotoro is a private photo app for scrolling, finding, syncing and sharing photos
without managing folders. Install, allow Photos, enjoy the library, and choose
Turn on sync once. Open the same Fotoro password on another device to see Saved.

- **Photos:** the permitted phone library, including older photos. Browsing works
  before account setup and does not upload anything.
- **Picks:** suggestions from recent photos and Best shots within Find results.
  Originals and All matches remain available.
- **Saved:** encrypted originals kept in Fotoro across devices. Manual Save
  preserves a chosen set; opted-in native sync covers supported permitted stills.
- **Find:** capture dates, supplied labels, recognized text and conservative native
  scene categories. It does not yet understand arbitrary people or visual meaning.
- **Share:** deliberate original sharing or a chosen Fotoro moment. Recipients can
  save an independent copy; revocation does not delete that owned copy.

The app uses SwiftUI/PhotoKit/Vision/GRDB on iPhone, React/Vite in the browser,
and a Cloudflare Worker with D1 and private R2. It lives in `fotoro/`; the Ente
fork remains a separate reference. Local intelligence requires no cloud model.

Automatic preparation requires the native app open and unlocked. iOS can finish
already scheduled encrypted uploads. The browser never scans the iPhone library.
Current originals are supported still photos up to 50 MiB; complete Live Photos,
videos, People and cleanup remain unfinished.

The [active product and roadmap](../../fotoro/docs/product-backlog.md) owns the
build queue. [Verification](../../fotoro/docs/verification.md) distinguishes
implemented behavior, public acceptance, physical-device checks and release
availability. [Deployment](../../fotoro/docs/deployment.md) records the live
service and Apple build status. Earlier Ente deployment/model plans are retained
in Git history and do not define the current product.

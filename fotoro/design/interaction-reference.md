# Fotoro screen and interaction rules

The job is to open, find and send a useful photo while opted-in sync keeps
supported originals available. [Product](../docs/product.md) owns that loop;
[verification](../docs/verification.md) distinguishes implemented behavior from
physical acceptance. These rules guide iteration; they are not a claim that every
accessibility or device case has passed.

## Screen journey

| Screen/state | Current main action | Presentation rule |
| --- | --- | --- |
| Fresh iPhone | Open Photos → system permission → personal library. Open Saved is available without a local grant. | Put personal photos ahead of storage setup. Ask for access at the action that uses it. |
| Fresh browser | Open Saved photos, or open selected device files for local browsing. | The browser cannot enumerate the iPhone library. Local selection does not upload it. |
| First Sync | Turn on sync → account entry if needed → retain the explicit choice. | Avoid a second enable choice after sign-in. New native accounts use Get started → Continue with password details disclosed. Web creation displays its password before Open Fotoro. |
| Returning account | Remembered native access or Open Fotoro; use another account when needed. | Preserve the user’s pending action, exact sources and account identity. Honor manual lock and failed reauthentication. |
| Library | Compact Photos/Picks/Saved menu, visible Search and contextual Sync/selection. | Photos dominate. Healthy sync stays quiet; incomplete sync has a clear route to its actual state. |
| Search/Picks | Type, inspect a match, optionally review Best shots, choose a set. | Show evidence and useful alternatives only when relevant. Current-query results, unfinished indexing and unavailable sources have distinct states. |
| Viewer | Swipe, zoom, Share; Info on request. | Keep the original uncropped and navigation in the opening result set. Omit inactive arrows and single-photo counts. Return to the prior context. |
| Sync sheet | Pause/Resume or a useful recovery action; View synced photos. | Keep Pause accessible. Put format details and disable under How sync works. Never report complete when originals were skipped. |
| System Share | Prepare the selected originals, then use the system handoff; browser downloads when file sharing is unavailable. | Preserve the exact set and respect the browser’s required user activation after async preparation. |
| Private Fotoro Share | Choose an accepted person → prepare invitation → Send photos. | Once prepared, bind the recipient and photos. Choose another person explicitly resets preparation. Rare access/link controls sit under disclosures. |
| Receiving | Accept a new sender’s identity → browse thumbnails → open full screen → explicitly Save a copy. | Show ended access accurately. Recipient-owned saved copies survive later sender revocation. |
| Another device | Open Saved with the same Fotoro password. | Read the verified catalog before showing originals; opening/refreshing does not upload unrelated pending work. |

Photos is the browsing surface. Picks suggests highlights. Saved holds Fotoro
originals for other-device access. They are views; the user should not need to
organize the same photo separately in each.

## Native Liquid Glass and web surfaces

The active iPhone app uses SwiftUI system glass controls on iOS 26+:
native toolbars, a persistent bottom Search field, glass/glassProminent actions
and native sheets. The browse toolbar contains the current photo scope and Sync;
Settings stays inside the scope menu. Photo viewers open full screen, with Done
and contextual controls. Owned Saved photos expose Save to Photos and Share;
Info stays under More. Receiving uses a thumbnail grid, with explicit Save in
the full-screen viewer. Info and sharing retain their own sheets. Selection
actions appear after an actual selection, not as a disabled instruction panel.
The active browser uses React/Vite, CSS translucent controls and its current viewer.
The older Ente MUI/PhotoSwipe experiment is historical; it does not define this app.

Keep the grid plain and let photos set the visual character. Glass belongs on
navigation and contextual controls. Use system typography, clear contrast,
safe-area spacing and large touch targets. Native actions are at least 44 pt;
verify browser controls at least 44 CSS px. A primary action should stand out
without a repeated title, subtitle, count and explanatory card around it.

Reduced motion/transparency, Dynamic Type, VoiceOver, keyboard/focus and touch
behavior are acceptance requirements to qualify. Use system support where
available and opaque readable fallbacks for browser surfaces. Screenshots alone
do not establish accessibility, scrolling smoothness or physical share completion.

## Reusable type and surface rules

Use the existing system font; do not download a font to distinguish photo screens.
Pair a text role with its layout instead of shrinking text to preserve one row:

| Role | Native | Browser |
| --- | --- | --- |
| Screen or section title | System navigation title or `.headline` | Existing heading hierarchy |
| Filename or main content | `.body`, wrapping at enlarged sizes | `--font-body`, intrinsic height |
| Action or filter | System control label | `--font-control`, `--control-target` minimum height |
| Evidence or secondary status | `.caption` or `.subheadline` | `--font-caption`, readable secondary color |

Keep layout flexible when labels grow. At accessibility text sizes, photo rows
and competing title/actions may stack; filenames and evidence must remain readable.
Use `--photo-*` semantic colors for content, surfaces, borders, selection and focus.
Accent text and selected indicators use `--photo-accent`; filled actions use
`--photo-action` with `--photo-on-action`. One blue cannot serve both contrast jobs.
Place opaque reduced-transparency and unsupported-blur rules after theme rules
so later translucent declarations cannot restore the effect. Keep motion opt-outs.

References checked October 12, 2026: [Radix typography and paired type tokens](https://www.radix-ui.com/themes/docs/theme/typography),
[Radix open-source token implementation](https://raw.githubusercontent.com/radix-ui/themes/main/packages/radix-ui-themes/src/styles/tokens/typography.css),
and [Apple's Liquid Glass adoption guidance](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).
These guide small native and CSS changes; they do not require importing a library
or restyling the photo canvas. Qualify enlarged text, keyboard focus and display
preferences on the actual supported surfaces before claiming accessibility.

## Quiet, accurate states

Account setup belongs to the action requiring it. Healthy state needs no banner.
A busy state shows relevant progress; an incomplete state shows one useful next
action. Raw API codes, model identities and support references belong in Details,
not the photo canvas. Retain real failure evidence for diagnostics.

Selection survives view, query and account navigation within the same verified
source context. Withdrawn permissions or changed original revisions remove
ineligible sources visibly. Suggestions never become a Save or sharing intent.
Clearing Search keeps editing active. Compact selection controls wrap only when
content needs the space; preserve full labels and touch targets at enlarged text.
Account entry owns its inline error instead of also showing a Sync alert.
Another-device access starts with Copy password and confirms the copy; Save and
the website link are secondary. Opening the website never substitutes for
transferring the password to the intended device.
Closing a viewer restores context; modal surfaces keep background interaction
inert and restore focus when dismissed. These are behaviors to test, not an excuse
to add another screen or gesture engine.

## Qualify the whole loop

Use public media and disposable accounts for automated QA. Test fresh and
remembered entry, Photos denial/limited access, small/large text, reduced motion,
search during indexing, selecting through sign-in, Pause/Resume, interrupted
restore, system sharing, a private recipient and reopening. Record actual
failures in the [active queue](../docs/product-backlog.md). UI fixtures are test
data, never fake personal-library content in a release.

## Photo organization

Info starts with recorded date/place, useful filename and Tags. Technical details
holds original filename, dimensions, size and camera evidence. A proposed filename
stays in its editor until Apply name; its original extension is preserved. Tags
accept Enter and have separate Remove controls. Save changes is available from
an owned photo’s current Photos viewer as well as Saved.

Photos/Saved filters expose Screenshots and Fotoro Trash. A screenshot correction
is an explicit toggle, independent of dimensions. Trash has a Restore action and
uses the ordinary pending-changes/conflict flow. Review cleanup opens a bounded
preview review, explains each suggestion and never preselects removals. Its copy
states that device Photos and storage use are unchanged. Opening a different
photo after a Save starts that photo’s own viewer selection.

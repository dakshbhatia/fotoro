# Core photo acceptance

The product loop is open photos → browse → find → review names/screenshots or
cleanup → explicitly Save → see reviewed changes on another device. Original
files stay unchanged. Cleanup affects Fotoro only and supports Restore.

This pass keeps existing source, account, permission and revision fences. It
adds no model, provider, permission or upload consent. Heavy automatic analysis
still starts with the latest ten calendar days.

## Ten core checks

| Flow | Code and verification in this pass |
| --- | --- |
| Correct photo identity | Device and Saved interactions are revision-scoped; source replacement cancels web touch sessions. Existing bounded presentation checks remain. |
| Smooth photo work | Native per-frame zoom/pan observation belongs to the image, with a separate mode boundary for toolbar updates; 1,000 drag samples do not notify parent mode observation. This is structural evidence, not a frame-rate measurement. |
| Fast search | A disposed index now invalidates both populated and empty async results; stale results cannot stay current after index replacement. |
| Complete indexing/status | Web Photos and Saved expose loaded-scope OCR coverage, readable-text counts, unavailable evidence and existing visual-search progress. Unchecked does not mean queued. Existing Latest 10 days admission and Saved continuation remain. |
| Screenshots | Web cleanup groups known screenshots by existing tags or current readable text, with explicit individual review. No dimensions or filename guesses classify screenshots. Changing source text preserves a newer account screenshot correction. |
| Consistent filenames | Web selection and native Saved selection support preview, collision-safe Apply and guarded name-only Undo. Without naming evidence, the original filename is retained. Native reservation scans yield every 200 photos; originals stay unchanged. |
| Recoverable cleanup | Native and web reviews continue in explicit batches of 200 over the loaded session snapshot. Counts distinguish scanned, remaining and unassessed photos; no unloaded-library coverage is claimed. Trash stays Fotoro-only with Restore. |
| Cross-device convergence | Supplied text, organization, People and observation categories merge independently into the latest account facts; unchanged stale categories cannot replace them. |
| Interrupted/offline edits | After a successful online installation, the web shell can cold-start offline at Photos and Saved entry routes. Only public built JS/CSS and static shell HTML are cached here, never API replies or photo data. Existing encrypted data/offline-edit rules remain. |
| Truthful status | Local diagnostics summarize successful logical-action median/p95 timings, failures and cancellation over the retained sample. This is not production aggregation or frame-rate measurement. No log records private photo text, query text or coordinates. |

Native Places can explicitly keep a looked-up approximate area name on an owned
Saved photo. The reviewed label follows existing encrypted annotation sync;
coordinates, source and accuracy remain unchanged. Existing names are preserved.

## Ten gesture checks

| Interaction | Implementation and proof boundary |
| --- | --- |
| Horizontal paging | Native system pager remains; web direction lock pages only horizontally and clamps endpoints. |
| Pull down to close | Native fitted still photos follow a direction-locked vertical pull; web closes details before dismissing the viewer. |
| Swipe up for info | Uses existing native sheets and browser details, without introducing an independent metadata pipeline. |
| Pinch zoom | Native scale is finite and bounded; pinch cancels dismissal. Browser preserves native pinch zoom and cancels its navigation session on multitouch. |
| Double-tap zoom | Native zoom preserves the tapped point within fitted-image bounds; web double-click applies only to the image. |
| Pan a zoomed photo | Pan owns movement while zoomed; actual decoded or PhotoKit dimensions prevent panning letterboxed images into blank space. |
| Drag selection | Native horizontal drags in Select mode paint visible tiles once, selecting or deselecting from the starting tile. Vertical drags remain with scrolling. Fast paths include crossed tiles; changed tile tokens are rejected. No automatic edge scrolling is added. |
| Press feedback | Native device/Saved tiles use bounded opacity/scale feedback without changing layout or hit rectangles. |
| Cancel and return | Axis locks, source replacement, pinch, zoom, VoiceOver and gesture cancellation reject pending dismissal. Pulls settle back; paging resets zoom. Existing grid presentation remains mounted behind the viewer. |
| Accessible motion/feedback | Native Reduce Motion removes added animation/press scaling, VoiceOver retains explicit controls, and haptics occur on settled page changes. Web keyboard navigation excludes text editing and zoom, and viewer CSS respects reduced motion. |

## Verification

`pnpm check` qualifies browser, API, contract and release checks. Both generic
iOS SDK targets compile. `pnpm test:ios:host` covers existing host scenarios and
the added actual-production gesture policy/zoom observation checks. The new
runner compiles the production zoom declaration and gesture policy directly.

Browser acceptance uses the actual LocalViewer and LocalResources with public
Singapore fixture pixels. Synthetic DOM touch probes exercise next photo, info,
details-first dismissal and final dismissal; rendered checks verify the intended
photo, editable keyboard exclusion, zoom navigation exclusion and clean console.
Desktop and mobile viewport screenshots are saved outside the repository.
The browser does not support native CDP touch dispatch; synthetic touch probes
do not establish browser gesture-engine arbitration or native physical feel.

No phone or Simulator was used, as requested. Native frame pacing, thermal/battery
behavior and physical gesture recognition remain unmeasured. These checks also
do not establish held-out human search relevance or a new authenticated
production cross-device journey.

October 17 browser acceptance exercised selected-photo Preview → Apply → Undo,
an explicitly tagged/corrected screenshot review group, and a cold reload plus
Saved entry with the local preview server stopped. The installed worker served
the app with a clean warning/error console. Public fixture data and screenshots
remain outside Git. A first visit while already offline cannot install the shell.
Native Device Photos batch naming, durable library-wide cleanup history, edge
auto-scroll selection and physical performance acceptance remain open.

Interaction reference: [Apple's continuous animation guidance](https://developer.apple.com/videos/play/wwdc2024/10145/).

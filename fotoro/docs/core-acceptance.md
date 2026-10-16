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
| Complete indexing/status | Existing Latest 10 days admission, Saved continuation, durable retries and truthful result totals remain; host regression suite passes. Recognition accuracy is not established by these tests. |
| Screenshots | Changing source text preserves a newer account screenshot correction; an explicit correction change/removal still applies. |
| Consistent filenames | Source text edits preserve the latest reviewed account name instead of overwriting it with a stale local name. |
| Recoverable cleanup | Source text edits cannot resurrect stale Trash after another device restored the photo. |
| Cross-device convergence | Supplied text, organization, People and observation categories merge independently into the latest account facts; unchanged stale categories cannot replace them. |
| Interrupted/offline edits | Reverting an offline edit drops that field from local intent, preventing a false conflict with a remote edit. |
| Truthful status | Search freshness includes empty results; background status, source and account checks remain. No log records private photo text, query text or coordinates. |

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

`pnpm check` passes, including 865 browser tests and 129 API tests. Both generic
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

Interaction reference: [Apple's continuous animation guidance](https://developer.apple.com/videos/play/wwdc2024/10145/).

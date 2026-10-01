# What Fotoro reuses

The repository is an Ente fork. The active `fotoro/` application is a separate
SwiftUI/React client and Hono service; it does not currently run Ente's backend,
sync engine or machine-learning pipeline. Existing repository licensing remains
in place.

| Need | Current foundation |
| --- | --- |
| iPhone navigation, contextual controls and sheets | SwiftUI system components and native Liquid Glass on iOS 26+ |
| Photos permission, asset metadata, HEIC/still previews and thumbnails | PhotoKit, `PHAsset`, `PHCachingImageManager` and Apple's decoder |
| Original-file sharing | `PHAssetResourceManager` and `UIActivityViewController`; browser Web Share or download |
| Browser grid and previews | React, the existing virtualized layout and a bounded sequential image cache |
| Encrypted exchange | The existing Fotoro protocol, libsodium, GRDB, Hono, D1 and private R2; loaded/opened explicitly from Backup & sharing |

Apple Photos provides the interaction reference. Apple's
[Liquid Glass adoption guide](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
and [Landmarks example](https://developer.apple.com/videos/play/wwdc2025/323/)
provide the platform patterns. Glass belongs on controls over the photo content;
the photo grid stays plain. We use system components before custom effects.

This simplification adds no new package dependency. OCR, semantic search, face
grouping, trips and automatic cleanup are not implemented or simulated. The
local browser and encrypted catalog remain separate stores until a deliberate
backup/import operation exists; opening Backup does not transfer local selections.

# What Fotoro reuses

The repository is an Ente fork. The active `fotoro/` application is a separate
SwiftUI/React client and Hono service; it does not currently run Ente's backend,
sync engine or machine-learning pipeline. Existing repository licensing remains
in place.

| Need                                                                  | Current foundation                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone navigation, contextual controls and sheets                     | SwiftUI system components and native Liquid Glass on iOS 26+                                                                                      |
| Photos permission, asset metadata, HEIC/still previews and thumbnails | PhotoKit, `PHAsset`, `PHCachingImageManager` and Apple's decoder                                                                                  |
| Original-file sharing                                                 | `PHAssetResourceManager` and `UIActivityViewController`; browser Web Share or download                                                            |
| Browser grid and previews                                             | React, the existing virtualized layout and a bounded sequential image cache                                                                       |
| Encrypted saving and exchange                                         | The existing Fotoro protocol, libsodium, GRDB, Hono, D1 and private R2; one-password accounts and explicit manual saves                             |
| Resumable Photos backup                                               | Account-scoped PhotoKit source checkpoints, atomic GRDB source/catalog/transfer insertion, sequential encrypted upload and receipt reconciliation |
| Local text search and photo picks                                     | Apple's Vision OCR and bounded on-device image analysis; browser OCR and preview analysis use same-origin assets                                  |

Apple Photos provides the interaction reference. Apple's
[Liquid Glass adoption guide](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
and [Landmarks example](https://developer.apple.com/videos/play/wwdc2025/323/)
provide the platform patterns. Glass belongs on controls over the photo content;
the photo grid stays plain. We use system components before custom effects.

The local browser and encrypted catalog remain separate stores. Opening account
setup keeps the selected photos and uploads nothing; an explicit save starts the
batch. Local OCR, metadata search and preview-based picks are implemented.
Semantic visual search, named face recognition, trips and automatic cleanup
remain outside this build.

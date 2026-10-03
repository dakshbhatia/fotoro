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

## Intelligence wiring — October 2026

Find resolves eligible photos through the existing index. Best shots applies the
versioned `quality-picks-v1` policy to that matching subset before grouping or
computing a quota. Suggestions carry measured reasons and never become a Save
intent or replace a user's selection. Preview work is serial and cancellable;
query, source revision, permission and account changes invalidate the result.
The fixed `picks-v1.json` checks compose retrieval with shortlisting in CI.
Synthetic policy checks do not qualify real-photo ranking or model accuracy.

The next native image representation to evaluate is Apple's
[Vision feature print](https://developer.apple.com/documentation/vision/analyzing-image-similarity-with-feature-print)
for image-to-image similarity. It can improve reviewed similar-shot diversity;
it does not supply text embeddings or identify named people. Store any qualified
representation in the existing revision-bound intelligence index, with request
revision and processor version in its identity. Do not add a second index.

For broader text/image retrieval, Google's published
[SigLIP 2 model card](https://huggingface.co/google/siglip2-base-patch16-224)
lists Apache-2.0 and image-text retrieval, making it a candidate for evaluation.
It is not bundled: qualify a pinned converted artifact, tokenizer/preprocessing,
size, memory, cold/warm latency and negative-query behavior on actual iPhone and
Safari before selecting it. Apple's published
[MobileCLIP2 model license](https://raw.githubusercontent.com/apple-aiml-research/ml-mobileclip/main/LICENSE_MODELS)
excludes product development from its research grant, so those weights are not
selected for this app. Cloud inference still requires explicit opt-in and a
spending bound; ordinary browsing and local intelligence upload nothing.

# Photo app baseline — October 1, 2026

Fotoro is a working development build, not yet a better general photo library
than Apple Photos or Google Photos. These are five useful product benchmarks;
they are not a claim about the current top-five App Store chart.

| Product | Established capability relevant to Fotoro |
| --- | --- |
| [Apple Photos](https://www.apple.com/ie/newsroom/2026/09/next-generation-of-apple-intelligence-available-today/) | Integrated iPhone library and current intelligent editing: Spatial Reframing, Extend and upgraded Clean Up on eligible devices |
| [Google Photos](https://blog.google/products-and-platforms/products/photos/updates-ask-photos-search/) | Ask Photos combines conventional fast retrieval and more contextual questions; availability depends on rollout and eligibility |
| [Ente Photos](https://ente.com/features/) | Encrypted backup, on-device face recognition and natural-language image search, encrypted index sync, sharing and memories |
| [Amazon Photos](https://apps.apple.com/us/app/amazon-photos-photo-video/id621574163) | Automatic full-resolution backup, date/location retrieval and family sharing; unlimited photo storage is a Prime benefit in eligible markets |
| [Mylio Photos](https://mylio.com/features/ai-photo-search/) | Private local indexing across metadata, OCR, faces and AI SmartTags for objects, activities and visual traits |

Google's [September 2026 announcement](https://blog.google/products-and-platforms/products/photos/google-photos-updates/)
also includes Photos in Gemini Spark, Wardrobe, new Remix templates and Moods.
These have different country, subscription and platform requirements: Moods is
announced for Android, while Wardrobe and the new Remix templates include iOS in
eligible markets. Do not imply every announced feature is available on every iPhone.

Privacy and account-free local browsing are not unique advantages:
[Ente Gallery](https://ente.photos/help/photos/getting-started/gallery-mode)
already offers mobile local browsing with on-device faces and natural-language
search without an account. The upstream Ente code is a reference in this
repository; the running Fotoro clients and service are a separate implementation.
Their existence does not mean Fotoro inherits Ente's complete feature set.

## What Fotoro currently demonstrates

- Native recent-photo browsing, all-age permitted local still-photo search,
  previews, EXIF/date/location metadata and local text recognition.
- Browser selection, retained bounded previews and local English OCR.
- Retrieval using verified metadata, supplied labels and recognized text.
- Immutable encrypted originals and smaller viewing copies; resumable journals
  and continuation of an already scheduled native ciphertext upload.
- Owner-only encrypted annotations with durable retry, revision conflicts and
  preserved unrelated edits across native/browser account catalogs.

It does not yet implement visual semantic embeddings, inferred people/face
groups, AI image editing, duplicate cleanup, video intelligence or Live Photo
motion backup. Using PhotoKit, Vision and native controls does not establish
feature parity with Apple's or Google's apps.

## Next evidence to earn

First complete physical iPhone-to-Safari onboarding, recovery and interrupted
backup against the deployed service. Then measure receipt, screenshot,
boarding-pass and document retrieval on a held-out corpus against the relevant
products: time to the right photo, unsuccessful searches, corrections, setup
steps, scrolling smoothness and battery cost. Add visual/people search only with
a defined user task, consent model, bounded local indexing and quality evidence.

No comparative latency, accuracy or usability claim has been earned yet.

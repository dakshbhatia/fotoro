# Fotoro: Sync, Search, Share

Fotoro helps someone keep their photos available, find the shot they mean, and
send a chosen moment. The first audience is a person who wants their family
photos to work without managing accounts, albums or an AI tool. The owner’s mom
is the acceptance case.

## The pain and the promise

Photos pile up. Finding one takes too much scrolling. Backup status is unclear.
Sending a useful set takes too many steps. Fotoro earns a place by making these
ordinary jobs easier. A larger feature list does not establish that advantage.

The first useful result is seeing your own photos. The next is finding a photo
or sending it. Sync protects that value across devices after one explicit choice.

## One loop

Open → see your photos → find or enjoy a moment → share → come back.

Sync runs alongside this loop after opt-in. An account is needed for Fotoro
storage and private invitations; local browsing and original-file sharing work
before it. Opening Saved reads the account library and does not start a Save.

- **Sync:** turn on once, preserve Pause, show an actionable incomplete state,
  and open the same saved originals on another device.
- **Search:** one visible field; dates, supplied labels, recognized text and
  local visual matches help reach the right photo. Browsing stays usable while
  intelligence prepares. Reviewed People filters support any selected person or
  everyone in the same photo, combined with the query. Separate portraits across
  trips can satisfy Any; they do not establish that everyone visited a place.
  Arbitrary landmark recognition and retrieval quality remain open.
- **Share:** select a moment and use the system share sheet. Private Fotoro
  invitations are an additional route with accepted recipient identity and
  recipient-owned Save. A live album has a fixed invited roster: accepted members
  can add chosen Saved originals over time, and the owner can end access.
  First-contact friction still needs qualification.

Photos is the browsing surface; Picks suggests useful shots; Saved is the
other-device library. These are views, not three separate collections to organize.

## First use, repeat use, natural sharing

First use shows personal value before asking for storage setup. Turn on sync
carries the chosen action through account entry. The current account uses one
Fotoro password or a compatible passkey; returning iPhone access is remembered
securely. Returning browsers with a matching cached account and PRF wrapper can
sign in and unlock through one passkey request. Fresh-browser discovery still
needs a second selected-credential request to unlock encrypted keys. Unsupported
PRF keeps the password path. Sign in with Apple is not delivered.

Reasons to return are concrete: new permitted photos available after sync,
a useful shot found quickly, a highlight worth opening, or photos someone shared.
These are product hypotheses to qualify on real libraries. An onboarding
carousel, daily streak or forced invitation is not part of this journey.

Sharing should finish the user’s existing intent. A recipient gets a useful set,
can open it, and can deliberately keep a copy. Measure that journey before adding
invitation campaigns or contact import.

Live albums reuse encrypted Saved originals without sending private annotation
or reviewed People facts. Album search uses filenames, capture dates and explicitly shared reviewed names
and locations. Private annotations and OCR remain in the account's own finder.
Original files retain their existing embedded metadata. Albums allow 12 fixed
members, 1,000 photos and 50 accepted active albums per account. Invitations need
explicit acceptance, and downloaded originals cannot be recalled by ending
access. These functional bounds do not establish cross-device acceptance.

## What we measure next

Record first-use and returning-use tasks on the agreed iPhone/Safari baseline:

| Question | Evidence |
| --- | --- |
| Did first value arrive? | Time and actions from open to a visible personal photo, then first successful Find or Share. |
| Is Sync trusted? | Supported originals restored on another device, visible exclusions, interruption recovery and preserved Pause. |
| Does Search help? | Time to the intended photo, failed queries and corrections on a held-out corpus. Separate cold model preparation from warm search. |
| Does sharing finish? | Sender preparation, OS handoff or private recipient opening, and explicit recipient Save. |
| Is there a reason to return? | Successful repeat tasks and voluntarily shared moments; distinguish completed actions from merely opening a screen. |

Establish the baseline before setting improvement targets. No comparative
10× claim, calibrated retrieval accuracy or physical battery claim is earned yet.
Operational logs are not a product funnel. Future product events must avoid
photos, query text, recognized text, locations, passwords and recipient identities.

The [roadmap](product-backlog.md) is the only active queue. The [screen rules](../design/interaction-reference.md)
own presentation; [foundation](foundation.md) owns architecture;
[verification](verification.md) owns shipped proof and limits.

## Organizing photos: ten decisions (October 15, 2026)

The core organizing jobs are finding, naming, reviewing clutter, handling
screenshots, and keeping deliberate changes on other devices.

| Decision | Result |
| --- | --- |
| 1. Show the useful name in Info. | An editable Fotoro filename is prominent; the original camera filename is in Technical details. |
| 2. Suggest a consistent filename from evidence. | Recorded UTC capture date, known place, up to two distinct supplied tags, and a stable original-digest suffix. Without supplied tags, a current validated scene can describe a photo; screenshots use a short readable OCR line. Text is a fallback for other photos without a scene. Repeated words are skipped. Missing dates and places stay missing. |
| 3. Preview before applying a name. | Suggest name fills the editor; Apply name makes the deliberate change. Original bytes and camera-library names remain unchanged. Exported copies use the chosen name. |
| 4. Separate names from captions. | Private name records never replace user captions, tags, OCR or original metadata. |
| 5. Review cleanup before removing anything. | A bounded review shows reasons for identical originals, possible soft shots or very little detail. An explicit favorite is retained as the representative of an identical original. Nothing is selected automatically; unknown previews stay unassessed. |
| 6. Use Fotoro-only Trash with Restore. | Normal library/search excludes trashed saved photos. Restore preserves names, tags and evidence. This release does not empty Trash, free storage, delete device Photos or revoke earlier shared copies. |
| 7. Give screenshots an explicit view. | Trusted Photos subtype evidence and deliberate corrections drive Screenshots. Screenshots remain searchable; only favorited screenshots enter Picks. Dimensions and suggestive filenames do not establish screenshot status. |
| 8. Put useful words ahead of technical facts. | Place names and tags such as BTS are visible. Coordinates, camera settings, dimensions, source and accuracy remain available under disclosures. A typed place tag never invents GPS. |
| 9. Make tag entry quick and hard to mis-tap. | Enter adds a tag; normalized duplicates are refused; removal has a separate labeled control. Exact-tag search is explicit. |
| 10. Keep one private correction per photo across devices. | Names, screenshot corrections and Trash use existing encrypted owner/digest-bound annotations, conflict review and explicit Save changes/Sync. Search covers available dates while ordinary browsing starts at 30 days. |

Current clients implement these organization records. Older clients preserve the
reserved records but do not provide the new naming, screenshot or Trash behavior.
Quality hints are review suggestions, not a calibrated judgment of a photo’s value.

### Connecting analysis to finding and naming (October 16, 2026)

Explicit leading requests such as `photos of dog` or `show me pictures of beach
last month` retrieve the same supported subject as the shorter query. A literal
name such as `Photo Booth` stays intact, including alongside a date. This is a
bounded grammar, not unrestricted natural-language understanding.

Owned Saved photos can be missing OCR even when a decrypted preview exists.
Settings now offers an explicit local text check for up to 25 loaded photos in
the current browser filters. Native Settings checks one owned catalog page of
at most 25 rows, with an explicit next batch. Both use cached previews only;
missing previews are reported without downloading originals. JPEG, PNG, HEIC
and the still preview of a Live Photo qualify; video does not. It requires
consent, reports progress and retries, and
stops when its scope, consent, account or source changes. It fills only missing
OCR through the existing serialized encrypted annotation writer. Existing text
and concurrent corrections are preserved; Save changes carries kept text to
other devices. Received photos are excluded. This does not expand automatic
analysis beyond the existing Latest 10 days policy.

When no direct word, phrase or filename meaning matches, browser search can
find separated words in the same OCR, caption, keyword or filename field, in
either order. It reuses indexed tokens and yields during longer checks. Numeric
identifiers remain exact; separate fields do not become invented joint evidence.
This is text retrieval, not general semantic understanding.

Filename previews use completed, source-bound analysis only. OCR naming accepts
known processors and a confidence gate of 0.8, considers at most the first 12
lines of a bounded text prefix, and skips numeric identifiers, addresses with
email/URL syntax, long paragraphs and unsupported scenes. These are conservative
engineering gates, not calibrated accuracy scores. Supplied tags retain priority;
previewing never changes the saved name or original. Scene publication remains
disabled pending installed-reader qualification, so locally inferred scene-based
suggestions can differ between devices until a reviewed name is saved.
Cleanup covers at most 200 currently loaded previews per review; load further
Saved pages deliberately. Its reasons refresh from current metadata after
favorite, screenshot or Trash changes using the measurements already collected.
Removing a duplicate keeper withdraws the remaining copy's duplicate warning;
new or changed preview sources remain unassessed until a fresh review.
Personal-library retrieval, physical battery and frame
pacing acceptance remain separate from functional source and simulator tests.

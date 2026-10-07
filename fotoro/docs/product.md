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
or reviewed People facts. Album search currently uses filenames and dates;
private People, OCR and location search remain in the account's own finder.
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

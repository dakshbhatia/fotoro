# Shortening the path to a useful photo

October 1, 2026. Product hypotheses for Fotoro, prompted by the user's request
for minimal magic and useful insights. These need validation with real families
and friends; the current fixture library proves interaction behavior only.

## Design around intent

| Situation | What the person wants | Fastest useful result | Helpful insight |
| --- | --- | --- | --- |
| Just after a shared day | Get the photos other people took | A known person receives the chosen moment | Candidate event boundaries and missing contributions, when actual shared-library data supports them |
| Someone asks for a photo | Find and send that specific picture | Search, inspect, explicitly send | Person/date/place/OCR matches with visible photos, rather than an AI chat response |
| Showing someone in person | Tell the story without handling the UI | Tap a thumbnail, swipe originals, tap to hide controls | Chronological order; optional context in Info |
| Revisiting a memory | Enjoy or recognize a familiar day | Open the photos immediately | A coherent moment, with user-correctable grouping |
| Running out of space | Remove redundant files without losing a memory | Review confirmed duplicates and choose what to remove | Exact hashes first; similar shots presented as suggestions |
| Worried about losing photos | Know originals are safe | Verified backup and useful failure recovery | Actual transfer/restore state; healthy sync can stay quiet |

The primary acquisition loop is the first row: one sender and one recipient,
sharing an actual moment. Retrieval and pleasant browsing make the app useful
between exchanges. Avoid mandatory contact import, album naming or AI setup
before that exchange.

## Three layers, one photo canvas

1. **Photos** are the stable source: encrypted originals and reconstructible
   thumbnails, with explicit ownership and actual transfer state.
2. **Moments** are lightweight views over photos, initially date/time-based.
   Later local place/person evidence can improve the suggestions. Grouping must
   be reversible; it does not move or duplicate originals.
3. **People** are explicit sharing relationships. Face groups can help find
   photos, but a face match must never silently become a sharing permission.

AI, OCR, EXIF, face embeddings, sync and object storage sit beneath these layers.
Expose their results where they help someone choose a photo or finish an action.
Avoid adding an intelligence destination just to expose those systems.

An insight earns screen space when it removes a decision or saves an action.
Examples for later work: narrow search to a person, group a day's photos, identify
exact duplicate bytes, or show which original needs a retry. Show uncertain
groupings as suggestions and make correction cheap. Do not generate sentimental
claims about people or claim delivery from a sent invitation alone.

## Current implementation and next evidence

- Implemented: date-grouped encrypted library, direct original viewing, compact
  glass controls, expandable local metadata search, and real transfer errors.
- Proposed: richer moment grouping, person/place/OCR retrieval in this canvas,
  and the complete recipient exchange. No new semantic-search or face-model
  capability is implied by the visual redesign.
- First exchange acceptance: two accounts; sender chooses real photos; recipient
  opens, accepts and saves; received originals match digests after a clean restore.
- Validate with a pair of friends after an actual shared outing. Observe the
  photos they ask for, how they recognize them, and where the handoff stalls.
  Measure time to first received/viewed photo and repeat exchanges, not the
  number of AI actions. Keep photo contents and identities out of analytics.

## Research grounding

[Rodden and Wood, CHI 2003](https://web.mit.edu/21w.789/www/spring2006/papers/rodden2003.pdf)
found simple browsing particularly useful in a six-month study with 13 people.
Its small, historical sample helps motivate a hypothesis about recognition and
chronology; it cannot establish present-day consumer behavior.

[Apple's materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials)
places Liquid Glass in controls and navigation above content. Fotoro's web
treatment follows that separation using CSS; it is not Apple's native material.

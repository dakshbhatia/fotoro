# Photo-first interaction

The library helps someone find and view a photo. Backup truth, sharing and
duplicate review serve that job; managing a model does not.

Visual references are `outputs/photo-library-concept.png` and
`outputs/photo-viewer-concept.png` in the parent workspace. These are design
references, not UI assets or a source of fake personal photos. Implementation
uses the existing React app, CSS modules, MUI's setup dialog, and PhotoSwipe
5.4.4 already used by Ente. It adds no second gesture engine.

## System

- White library canvas; near-black full-screen viewer. No tinted photo overlays.
- System typography: 34px mobile / 44px desktop title, 16px search, 13px controls.
- Three columns on mobile, more columns on wider screens. Three-pixel gutters
  and four-pixel corners give the images space without framing every photo.
- One floating search/import control: 58px high, 29px radius, maximum width
  540px. Neutral translucent surface, white edge, soft shadow and 20px backdrop
  blur. A solid readable fallback remains if backdrop filtering is unavailable.
- Outlined 22px symbols; 44px minimum targets. Glass belongs on controls over
  content, never on each photo. Safe-area insets protect the bottom controls.
- 180ms opacity/transform feedback. Reduced motion removes animation;
  reduced transparency uses opaque control surfaces.

## States and purpose

The empty library has a title and one add action. After import, images dominate
and the floating search/import control becomes available. Duplicate review
appears only if exact copies exist. It identifies copies; it does not delete
original files or claim to reclaim device storage.

Opening a photo keeps it uncropped in a full-screen viewer. Share appears only
when the browser can share the original file. Previous/next operate within the
current result set. Details are disclosed on demand. Closing restores the
originating thumbnail's focus and leaves the library's scroll position intact.

The session-only preview must state that it is not backed up. Developer cloud
setup is reachable through `/intelligence?setup=1`, never the routine toolbar.
Explicit opt-in starts indexing in the background; importing and browsing stay
available. Pause, resume and error recovery remain visible when relevant.

The generated reference uses example photography. QA uses repository images
and synthetic files rather than private user photos. Different image counts,
conditional sharing and truthful preview state are intentional differences.

## Boundary

This design pass does not complete encrypted index persistence, account sync,
passkey unlock, semantic search or trusted-contact grants. Those remain in the
build plan. A clean screen cannot substitute for those working flows.

## Twenty experience decisions

These are implementation choices, not a claim that every physical-device case
has passed. Browser and build evidence is recorded in `verification.md`.

1. Photos occupy the primary canvas.
2. One reachable control combines search and import.
3. Empty state presents one next action.
4. Duplicate review appears only when an exact copy exists.
5. Thumbnail-to-viewer zoom preserves visual continuity.
6. Original images remain uncropped in the viewer.
7. Horizontal drag/swipe uses PhotoSwipe's existing gesture engine.
8. Pinch and double-tap zoom use the same engine, without conflicting handlers.
9. Vertical dismissal and Escape return to the library.
10. Buttons and arrow keys offer alternatives to gestures.
11. Viewer navigation stays in the opening result set; indexing cannot reorder it.
12. Details open on demand and close when advancing to another image.
13. Native file sharing is exposed only when supported, using the original file.
14. Interactive targets are at least 44px.
15. Focus stays in the viewer; background is inert and focus returns on close.
16. Reduced motion disables animated transitions.
17. Reduced transparency and missing backdrop support get opaque fallbacks.
18. Safe-area insets protect fixed controls.
19. Dynamic import and adjacent-image preload keep the main library light.
20. Backup truth and explicit cloud consent stay honest; indexing does not block
    import or browsing and stops on a failed paid request.

References: [Apple Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass),
[PhotoSwipe gestures and transitions](https://photoswipe.com/),
[PhotoSwipe options](https://photoswipe.com/options/).

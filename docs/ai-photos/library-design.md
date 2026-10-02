# Library design — October 1, 2026

Requested direction: simplify the library itself, with purposeful liquid-glass
controls and an effortless consumer experience. This pass changes presentation
and search interaction while retaining the encrypted account library.

## Working visual specification

Image Gen library reference: `outputs/fotoro-library-concept-v2.png` in the parent
workspace. `outputs/fotoro-viewer-concept-v2.png` uses the same control family on
a black canvas. The generated viewer includes a redundant pair of arrows over
the image; omit that pair and keep only the specified bottom navigation.
These are references, never raster app UI or additional seeded library data.

- Canvas: true white library, true black viewer, unchanged original photographs.
- Compact Fotoro header: 25px system type, weight 600, tracking -0.04em; 20px
  horizontal inset and 78px total height. Quiet 13px date labels.
- Account: 44px circular glass control. Healthy sync stays available to assistive
  technology; loading, transfer, offline and error states remain visible.
- Photo grid: 6px outer inset, 3px gutters, 6px corners, three mobile columns.
  Existing virtualized responsive layout stays intact.
- Idle dock: centered Search capsule 138×56 plus a 56px Add circle, 8px apart;
  bottom inset 24px or device safe area. Search text 15px, outlined symbols 20px.
- Search: the dock expands to the existing full-width input on demand. Clear
  resets the query; Close or Escape resets and returns focus to Search. Enter
  dismisses the input keyboard without discarding results. No query is uploaded.
- Viewer: original remains uncropped. Small counter above, circular Close at
  top right, Favorite/Info/More in a 160×52 bottom capsule, Previous/Next in
  separate circles on the same baseline. Keep inherited encrypted media loading,
  zoom, swiping, metadata and file actions.
- Glass: neutral translucent fill, backdrop blur 24px, subtle highlight edge and
  soft shadow. No color wash on photographs or decorative glass panels.
- Touch: controls at least 44px; restrained 160–180ms press/focus transitions.
  Honor reduced motion and reduced transparency; provide opaque blur fallback.
- Access: named thumbnail controls, keyboard opening, visible focus and normal
  viewer return focus. Selection and long-press semantics remain available.

## Implementation and acceptance

1. Update only Fotoro chrome and its scoped CSS; preserve original Gallery UI.
2. Pass an optional Fotoro appearance through the existing viewer to scope glass.
3. Make Fotoro thumbnails accessible without changing other app presentations.
4. Check idle → search → filtered photo → viewer → next/info → close, plus
   search clear/Escape, account access, and Add opening the real uploader.
5. Compare references and rendered desktop/mobile screenshots; check long-grid
   virtualization and scrolling, console, TypeScript, lint, tests and export.

Public fixture photos remain exactly the existing three. No recipient exchange,
paid AI request, private photo upload, credential change or native UI is part of
this design pass. Real iPhone keyboard and multi-touch still need device checks.

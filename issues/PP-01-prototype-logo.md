# [PP-01] Prototype: Logo and README header

## Type
Prototype (visual only)

## Description
BYOS has no screens, but it still needs its own mark before the repo goes public: the GitHub social preview, the npm page and the README header all show it, and a framework placeholder or no mark at all reads as unfinished. This is the first design round of the project. The idea the mark has to carry: your files, in your own storage, with BYOS as the thin layer that connects an app to it.

## Visual Elements
- Three logo directions, each described in one sentence and tied to what BYOS does (for example: a key entering a cloud, a box with an arrow going to a drive, a monogram "b" shaped as a folder).
- Each direction drawn as SVG in the primary color on the dark scheme background.
- Each direction shown at small size (60 pt, avatar/favicon scale) and at 1024 px.
- After the owner picks one: `docs/header.png`, the 1200×630 README header in the portfolio header style (dark background with a subtle grid, a two-line title, one new accent color for this project, a monospace tagline, stack pills, and a theme visual such as files flowing from a device into a drive).

## Layout Notes
- The chosen SVG is the single source; any PNG (GitHub social preview, header) is produced from it by a reproducible script in `scripts/`.
- The header is rendered at 2x with headless Chrome and downscaled to 1200×630.
- No web fonts.

## Mock Data
- Title "BYOS", subtitle "Bring Your Own Storage", tagline along the lines of "your app's files, in your user's Drive".
- Stack pills: TypeScript, Node, Google Drive.

## Acceptance Criteria
- [ ] Three directions are presented side by side at 60 pt and 1024 px, in the dark scheme.
- [ ] The owner's verdict (which direction and why) is recorded in this issue.
- [ ] The chosen mark exists as `docs/logo.svg`.
- [ ] `docs/header.png` (1200×630) and a GitHub social preview PNG are produced by a script from the SVG.
- [ ] The README's first line references `docs/header.png`.

## Dependencies
- FN-00 (repo layout exists).

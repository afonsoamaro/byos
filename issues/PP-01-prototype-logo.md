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

## Verdict
- 2026-11-19: the owner chose **direction A, "key to your cloud"** (a cloud with a keyhole). Of the three it reads best at 60 px, the keyhole stays visible at avatar size, and it carries the core promise: the storage is the user's, and the user holds the key. B was too close to a generic download icon; C was the most distinctive but lost its folder tab at 60 px.
- On a light background the lime mark loses contrast in all three directions; any avatar or icon made from `docs/logo.svg` sits on a dark tile.
- Comparison sheet: `docs/brand/directions.png` (sources in `docs/brand/directions/`).

---

# Implementation Plan

## Prerequisites
- FN-00 and FN-00b done (repo layout, `pnpm check`, CI, ruleset on `main`).
- Branch `feat/PP-01-logo` from an up-to-date `main` before the first file is written.
- Local tools, already present on the maintainer machine: Google Chrome (headless screenshot) and ImageMagick 7 (`magick`). `rsvg-convert` and `cairosvg` are not available, so SVG is rasterized through Chrome only.
- Node 26 for `pnpm check`: `source ~/.nvm/nvm.sh && nvm use 26`.

## Reusable Code Found
- No brand, image or script assets exist yet: `docs/` holds only `docs/history/`, and there is no `scripts/` folder.
- `README.md:1` holds the placeholder comment `<!-- header image: added with the logo round -->`, which this issue replaces.
- `package.json` `lint` runs `prettier --check .`: any new `.html` file is format-checked (SVG and PNG are not, Prettier has no parser for them). `.prettierignore` already skips `issues` and `*.md`.

## Knowledge Registry
- The 1200×630 header layout used across the maintainer's READMEs (background `#0a0e1a`, 40 px grid with radial mask, accent glow in one corner, two-line 82 px title at weight 800, `FIG. 01` label and monospace tagline in `#6b7488`, theme visual, ~344 px spec panel with a hero value, stack pills, footer) and the exact Chrome plus `magick` command. Read it before writing `docs/brand/header.html` and `scripts/render-brand.sh`.
- `env bash` is bash 3.2 on macOS: the render script must not use `mapfile`, `declare -A` or other bash 4 features.

## Architecture Decisions
- **Accent color: `#a3e635` (lime).** The portfolio rule is one new accent per project; every header surveyed already uses cyan, teal, sky, indigo, violet, purple, pink, rose, red, orange, amber, yellow and green tones, and lime is unused. It is also the logo's primary color, since BYOS has no UI theme of its own. Secondary text colors come from the header recipe (`#e8ecf2`, `#6b7488`, `#8b93a7`).
- **The three directions** (fixed, the implementer draws them, does not invent new ones):
  - A, "key to your cloud": a cloud outline with a keyhole cut in it. Your storage, and you hold the key.
  - B, "into your drive": an open box (the app) with a downward arrow landing in a drive tray. Files leave the app and land in the user's drive.
  - C, "b folder": a lowercase `b` whose bowl is a folder with a tab. The monogram is the file container.
- **SVG rules, so the mark survives 60 px:** `viewBox="0 0 1024 1024"`, a single fill or stroke color `#a3e635`, transparent background, strokes at least 72 units wide (about 7% of the box), no text elements, no gradients, no filters, at most ~6 paths. Hand-written SVG, no editor metadata.
- **Where the directions live:** `docs/brand/directions/{a-key-cloud,b-box-drive,c-b-folder}.svg` plus `docs/brand/directions.html` (the comparison sheet). They stay versioned after the verdict: a recorded prototype verdict is part of the portfolio, and they are small. The chosen one is copied, not moved, to `docs/logo.svg`.
- **The SVG is the single source.** `header.html` and `social-preview.html` embed it with `<img src="../logo.svg">` (relative `file://` load works in headless Chrome), never an inline copy, so editing the logo and rerunning the script updates every PNG.
- **One script renders everything:** `scripts/render-brand.sh` in bash, renders each HTML at 2x with headless Chrome and downsizes with `magick`, as in the registry recipe. The comparison sheet is rendered by the same script (`directions` target) so the owner sees a PNG, not a raw HTML file.
- **GitHub social preview size is 1280×640** (GitHub's recommended size; the header is 1200×630, the Open Graph size). Uploading it to the repository settings is a manual step in the web UI: the REST API has no endpoint for it. It is not part of this issue's automation.
- **Owner gate in the middle.** Steps 1 to 3 produce the comparison sheet, then execution stops and asks the owner (AskUserQuestion, one option per direction) before anything depends on the choice. The verdict goes into this issue before step 5.

## Files to Create
| File | Purpose |
|------|---------|
| `scripts/render-brand.sh` | Renders `docs/brand/*.html` to PNG with headless Chrome at 2x and `magick` downscale |
| `docs/brand/directions/a-key-cloud.svg` | Direction A |
| `docs/brand/directions/b-box-drive.svg` | Direction B |
| `docs/brand/directions/c-b-folder.svg` | Direction C |
| `docs/brand/directions.html` | Comparison sheet, three columns, each at 1024 view (shown at 320 px), 120 px (60 pt @2x) and 60 px |
| `docs/brand/directions.png` | Rendered sheet, shown to the owner, kept as the record |
| `docs/logo.svg` | The chosen mark, single source |
| `docs/brand/header.html` | README header source, 1200×630 |
| `docs/header.png` | Rendered README header |
| `docs/brand/social-preview.html` | GitHub social preview source, 1280×640 |
| `docs/social-preview.png` | Rendered social preview |

### scripts/render-brand.sh
- `#!/usr/bin/env bash`, `set -euo pipefail`, bash 3.2 compatible. Resolve the repo root from the script's own path (`cd "$(dirname "$0")/.."`), so it runs from any cwd.
- `CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"`; fail with a clear message if it is not executable or if `magick` is missing.
- A function `render <html> <png> <width> <height>`: headless Chrome with `--headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=<w>,<h> --screenshot=<tmp@2x.png> "file://$PWD/<html>"`, then `magick <tmp@2x.png> -resize <w>x<h>! -strip -define png:compression-level=9 <png>`, temp file in `$(mktemp -d)` removed by a `trap`. Silence Chrome's stderr noise (`2>/dev/null`) but keep the exit status.
- Targets by argument, default `all`: `directions` → `docs/brand/directions.html` to `docs/brand/directions.png` at 1600×900; `header` → `docs/brand/header.html` to `docs/header.png` at 1200×630; `social` → `docs/brand/social-preview.html` to `docs/social-preview.png` at 1280×640; `all` runs the three, skipping a target whose HTML does not exist yet, with a message.
- After each render, print the result of `magick identify -format '%f %wx%h\n'` so the size is visible.
- `chmod +x`.

### docs/brand/directions.html
- Copy the `:root` tokens, background grid and font stacks from the registry recipe (no web fonts). `--accent:#a3e635`.
- Page 1600×900. Three equal columns, one per direction, each with: the letter and the one-sentence rationale (from Architecture Decisions) in monospace `#8b93a7`; the SVG at 320 px on a `#0a0e1a` rounded tile; and below it a row with the SVG at 120 px and 60 px on dark tiles and at 60 px on a light `#f6f8fa` tile (the GitHub and npm pages are light, so the small mark must also read there; on light, a CSS `filter` is not allowed, show it as is and let the owner judge contrast).
- Load each SVG with `<img src="directions/<name>.svg">`.
- Run `pnpm format` on it before committing, since `prettier --check` covers HTML.

### docs/brand/header.html
- Follow the registry recipe layout exactly. Content:
  - `FIG. 01 · ` followed by a short caption such as `files → your drive`, monospace.
  - Title line 1 `BYOS` in `#e8ecf2`, line 2 `Bring Your Own Storage` in the accent (shrink the second line's font size if it would wrap; the title must stay two lines).
  - Tagline in monospace: `your app's files, in your user's Drive`.
  - Theme visual on the left card: three file rows (a photo `IMG_2041.HEIC`, `IMG_2042.HEIC` and a `notes.md`), each with a status dot, flowing by an arrow into a drive box labeled `My Drive / BYOS`; built from HTML and CSS boxes, no images besides the logo.
  - Spec panel on the right (~344 px) with the logo (`<img src="../logo.svg">`, 96 px) at the top, then a hero value `drive.file` with the label `the only scope it asks for`, then two smaller lines: `one-way backup` and `never deletes`.
  - Stack pills: `TypeScript`, `Node`, `Google Drive`.
  - Footer right: `afonsoamaro.dev / byos`.
- No real file names from the maintainer's machine, no personal email or account name: mock data only.

### docs/brand/social-preview.html
- 1280×640. Same tokens and grid. Centered: the logo at 280 px, `BYOS` at 96 px weight 800 under it, `Bring Your Own Storage` in the accent in monospace below. Keep content inside the central 1200×600 (GitHub crops edges on some surfaces).

## Files to Modify
| File | Changes |
|------|---------|
| `README.md` | Line 1: replace the placeholder comment with `![BYOS: Bring Your Own Storage](docs/header.png)` |
| `issues/PP-01-prototype-logo.md` | Add a `## Verdict` section with the chosen direction and the owner's reason, then the Execution Record |
| `issues/_index.md` | PP-01 status `planned` → `done` at the end |

Do not touch `docs/history/`, any `packages/` file or the CI workflow.

## Data Requirements
- None.

## Testing Strategy
- No unit test: the deliverable is images and a shell script, and the check has no image step. Coverage is the render itself plus a size assertion in Verification.
- The script's failure paths are checked by hand once: `CHROME=/nonexistent scripts/render-brand.sh header` must exit non-zero with the message.
- `pnpm check` must stay green, mostly to prove the new HTML passes `prettier --check`.

## Implementation Order
1. **Riskiest first, the render pipeline.** Write `scripts/render-brand.sh` and a throwaway `docs/brand/directions.html` with one placeholder tile, run `scripts/render-brand.sh directions`, and confirm a 1600×900 PNG with the SVG visible. If Chrome does not load the relative `<img>` under `file://`, stop and fix there (fallback: pass `--allow-file-access-from-files`), before drawing anything.
2. Draw the three SVGs following the SVG rules.
3. Finish `directions.html`, render `directions.png`, open it (`open docs/brand/directions.png`) and send it to the owner.
4. **Owner gate:** ask which direction (A, B or C, one option each, no recommendation unless one clearly fails at 60 px, in which case say so). Optionally, one round of tweaks on the chosen one. Record the verdict in `## Verdict` in this issue.
5. Copy the chosen SVG to `docs/logo.svg`.
6. Write `header.html` and `social-preview.html`, run `scripts/render-brand.sh` (all), look at both PNGs.
7. Edit `README.md` line 1.
8. `pnpm format`, then `pnpm check`.
9. Commit on `feat/PP-01-logo` (confirmation first), push, PR, merge commit after CI.

## Security Considerations
- Public repo: the header and the sheet carry mock data only. No real photo names, paths, account names or the maintainer's email in any image or HTML.
- The images are committed binaries: CI `gitleaks` scans them too; nothing secret goes in.

## Pattern to Copy
- The header layout and command come from the registry recipe above (described there in full; no file from another repository is copied or named in this repo).
- `docs/brand/social-preview.html` and `directions.html` copy the `:root` tokens, `.bg-grid` and font stacks from `docs/brand/header.html` (or the reverse, whichever is written first). Shared CSS is small and stays duplicated across these three standalone pages, each with a comment pointing at `header.html` as the original.

## Verification
- Command: `scripts/render-brand.sh && magick identify -format '%f %wx%h\n' docs/brand/directions.png docs/header.png docs/social-preview.png` (prints `1600x900`, `1200x630` and `1280x640`).
- Command: `head -1 README.md` (prints `![BYOS: Bring Your Own Storage](docs/header.png)`).
- Command: `pnpm check` (build, lint with prettier, typecheck and tests green).
- Manual: open `docs/header.png` and `docs/social-preview.png`; the logo is the chosen direction and nothing is cut off. After merge, the README on GitHub shows the header.

## Out of Scope
- Uploading the social preview to GitHub settings (manual, owner's choice; the PNG is the deliverable).
- Favicon, npm package icon, CLI banner, ASCII art: none exist in v1.
- The README body (FN-18) and the CLI output prototype (PP-02).
- Adding `docs/` assets to any package's `files` or the npm page (FN-19).
- An SVG optimizer, a Node render script or a new dependency: the bash script with Chrome and `magick` is the decided pipeline.
- Wiring the render into `pnpm check` or CI (Chrome is not on the CI runner and the images are committed).

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/PP-01-logo`, executed 2026-11-19.
- Step 1 (riskiest) passed on the first try: headless Chrome loads a relative `<img src="directions/...svg">` under `file://` without `--allow-file-access-from-files`.
- Owner gate: direction A chosen (see Verdict). Direction C was redrawn once before the gate (wider stem and a larger counter) so its bowl read as a `b` at 120 px.
- Deviations from the plan:
  - Direction B is drawn as an arrow landing in a drive tray, without a separate app box on top; the box made the mark unreadable at 60 px. The sheet's rationale says so.
  - The header spec panel has a third line, `runs in Node, browser and React Native`, taken from the README's description of `@byos/core`.
  - `scripts/render-brand.sh` runs Chrome with a throwaway `--user-data-dir`: one run exited with code 2 and no screenshot while a regular Chrome window was open, silently, because stderr was discarded. The script now keeps Chrome's log and prints its tail on failure. Three consecutive `all` renders after the change were clean.
- Failure path checked: `CHROME=/nonexistent scripts/render-brand.sh header` exits 1 with `Chrome not found at '/nonexistent'`.
- Outputs: `docs/brand/directions.png` 1600x900, `docs/header.png` 1200x630, `docs/social-preview.png` 1280x640.
- `pnpm check`: build, lint (ESLint 0 warnings, Prettier clean including the three new HTML files), typecheck and tests (8 passed in 4 files) green.
- Not done here, by design: uploading `docs/social-preview.png` to the repository's social preview setting (manual, GitHub web UI).

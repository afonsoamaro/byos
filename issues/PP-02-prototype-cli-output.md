# [PP-02] Prototype: CLI output

## Type
Prototype (visual only)

## Description
The CLI's terminal output is the only interface BYOS has. Before any real command exists, this issue mocks what the user will see for the main flows, so wording, layout and the human-vs-JSON split are decided once instead of inside each command implementation. The result is a static reference (a script that prints mocked output plus a Markdown page with the captured output), not working commands.

## Visual Elements
- `byos auth`: "opening browser" message with the URL fallback for when no browser opens, waiting state, success line with the connected Google account email and granted scopes.
- `byos auth status`: account, scopes, consent date, token age; a warning line when the token is older than 6 days and the consent screen may be in Testing.
- `byos doctor`: a checklist with pass/warn/fail per check (client JSON, client type Desktop, Drive API reachable, scopes, token valid, Testing-mode warning), each failure followed by the exact fix step.
- `byos backup <folder>`: scan summary (files found, unchanged, to upload, total bytes), live progress (files done/total, bytes, current file, rate), a per-file failure line, and a final summary with exit status.
- `byos backup --dry-run`: the list of what would upload, without progress.
- An interrupted run (Ctrl+C) message that says the next run resumes.
- Error output in human mode and the same error under `--json`: `{ "code": "...", "message": "..." }` on stderr.
- `byos ls --json` and `byos put --json` success shapes.

## Layout Notes
- Must read well in Windows Terminal, PowerShell and macOS Terminal; only colors and symbols that render in all three (check how the default Windows console renders the symbols).
- Respect `NO_COLOR` and non-TTY output (no progress redraw when stdout is piped).
- Paths in output are shown in the platform's native form; remote paths always use `/`.

## Mock Data
- Account `owner@example.com`, scopes `drive.file`.
- A folder `C:\Users\me\Pictures` with 12,431 files, 11,980 unchanged, 451 to upload (38.2 GB, including a 3.1 GB `.mp4`).
- One failure: `RATE_LIMITED` resolved by retry, one `QUOTA_EXCEEDED` hard stop.

## Acceptance Criteria
- [ ] A script prints every mocked output above without touching the network or the file system.
- [ ] `docs/cli-output.md` captures each output, including the JSON shapes.
- [ ] The error `code` list used in the mocks matches the error codes listed in FN-01 (or FN-01 is updated).
- [ ] The owner has approved the output in this issue; the verdict is recorded here.
- [ ] No real API calls or business logic.

## Dependencies
- FN-00.

## Verdict
- 2026-11-19: the owner approved the output in `docs/cli-output.md` as the reference for FN-09, FN-10, FN-11 and FN-13, with no wording changes.

---

# Implementation Plan

## Prerequisites
- FN-00 done (workspace, `pnpm check`). PP-01 done (root `scripts/` folder exists).
- Branch `feat/PP-02-cli-output` from an up-to-date `main`.
- Node 26 (`source ~/.nvm/nvm.sh && nvm use 26`): the mock is a `.ts` file run directly by Node's built-in type stripping, no build step.

## Reusable Code Found
- `packages/cli/src/program.ts`: the commander program, name `byos`, only `--version` today. The mock does not touch it.
- `tests/portability.test.ts`: the pattern for a root-level cross-package test (vitest, `fileURLToPath(new URL(..., import.meta.url))` for paths). The new root test copies its layout.
- `vitest.config.ts` (root) already includes `tests/**/*.test.ts`; `tsconfig.json` (root) has `types: ["node"]` and includes `tests`.
- Error codes are fixed in `issues/FN-01-core-contract.md` (Requirements): `NOT_FOUND`, `CONFLICT`, `PERMISSION_DENIED`, `AUTH_FAILED` (reasons `invalid-grant`, `testing-mode-expiry-suspected`, `missing-token`, `scope-missing`), `RATE_LIMITED`, `QUOTA_EXCEEDED`, `PROVIDER_ERROR`, `UPLOAD_SESSION_EXPIRED`. Exit codes are fixed in `issues/FN-11-cli-file-commands.md`: 0 success, 2 usage, 3 not found, 4 conflict, 5 auth, 6 quota, 7 rate limited after retries, 1 anything else; Ctrl+C in backup exits 130 (`issues/FN-13-backup-upload.md`). The mock uses exactly these; FN-01 needs no change.
- `put --json` shape is fixed in FN-11: `{ "id", "name", "sha256", "size", "path" }` on stdout.

## Knowledge Registry
- Nothing in the global or portfolio registry covers terminal output, `styleText` or Windows console symbols. Researched here, by running it on Node 26.13.1:
  - `util.styleText(format, text, { stream })` already returns plain text when `stream` is not a TTY or `NO_COLOR` is set, and colors when `FORCE_COLOR=1`. Verified: piped → `"ok"`, `NO_COLOR=1` → `"ok"`, `FORCE_COLOR=1` → `"\u001b[32mok\u001b[39m"`.
  - Node 26 runs a `.ts` file directly (type stripping), so the mock needs no build. Only erasable syntax works: no `enum`, no `namespace`, no parameter properties.
- A `.ts` file outside every tsconfig breaks type-aware lint. That's why the plan adds `scripts` to the root `tsconfig.json` `include`.

## Architecture Decisions
- **Colors come from `node:util` `styleText` with `{ stream }`, with no dependency.** It honors `NO_COLOR`, `FORCE_COLOR` and non-TTY by itself, which is the issue's Layout rule. Chalk/picocolors are not added. Each line is styled against the stream it goes to (`process.stdout` or `process.stderr`).
- **Palette, limited to colors every target terminal renders:** green for success, yellow for warnings, red for failures, cyan for URLs and paths, and `dim` for secondary detail. No bold-only meaning and no 256-color codes. Meaning never depends on color alone, because every status line also has a symbol.
- **Symbols, with a fallback:**
  - Unicode set: `✓` ok, `!` warn, `✗` fail, `›` step, `…` waiting.
  - ASCII-safe fallback, used on Windows outside Windows Terminal or VS Code: `√`, `!`, `×`, `>`, `...`. The fallback characters exist in the legacy console's code page 437.
  - Rule: unicode unless `process.platform === 'win32'` and neither `WT_SESSION` nor `TERM_PROGRAM === 'vscode'` is set.
  - The mock also accepts `--ascii` to force the fallback, so it can be previewed on macOS.
- **Human output goes to stdout; diagnostics and errors go to stderr.** Under `--json`, stdout carries exactly one JSON document on success, stderr carries exactly one `{ "code", "message" }` on failure, and nothing else is printed (no color, no progress).
- **Progress has two modes:**
  - On a TTY (and not `--json`), one line is redrawn in place with `\r` plus a clear-to-end-of-line `\x1b[K`.
  - When stdout is not a TTY, nothing is redrawn: a plain line prints at every 10% step and at the end.
  - The mock shows the TTY mode by redrawing about 8 frames over about 1.5 s. The captured doc uses the non-TTY mode, so it is stable text.
- **Paths:** local paths print in the platform's native form. The mock data uses the Windows form from the issue (`C:\Users\me\Pictures`) on every platform, because it is mock data. Remote paths always use `/`.
- **Numbers:** sizes in binary units with one decimal (`38.2 GB` meaning GiB displayed as GB, like Windows Explorer), counts with `,` thousands separators (`Intl.NumberFormat('en-US')`). The CLI output is English-only in v1 (SPECS, i18n `[assumed]`).
- **Where it lives:** `scripts/cli-output-mock.ts`, a standalone prototype, run with `node scripts/cli-output-mock.ts <scenario>`.
  - It is not part of `@byos/cli`. It is a throwaway mock that FN-09, FN-10, FN-11 and FN-13 follow, but none of them imports it.
  - The real output helpers are written in FN-09, the first command that prints, which copies the palette, symbol and stream decisions from `docs/cli-output.md`.
  - The mock imports only `node:util` and `node:process`, with no `node:fs`, `node:net`, `node:http` or `fetch`, which proves "no network and no file system". The test asserts this.
- **`docs/cli-output.md` is generated, not hand-written.** `node scripts/cli-output-mock.ts --markdown > docs/cli-output.md` writes the page:
  - an intro;
  - the symbols, palette and stream rules;
  - the exit-code table;
  - one section per scenario, with the captured non-TTY, no-color output in a fenced block, and the stdout and stderr of the JSON cases labeled.
  - A test compares the committed file with a fresh `--markdown` run, so the doc can't drift from the mock.
- **Owner gate:** after the doc is generated, the owner reads it, and optionally runs `node scripts/cli-output-mock.ts all` in Windows Terminal and PowerShell on the Windows machine. The verdict (approved, or a list of wording changes applied in one round) is recorded in `## Verdict` in this issue.

## Files to Create
| File | Purpose |
|------|---------|
| `scripts/cli-output-mock.ts` | Prints every mocked output; `--markdown` writes the doc; `--ascii` forces the symbol fallback |
| `docs/cli-output.md` | Generated reference of every output, the JSON shapes, symbols, palette and exit codes |
| `tests/cli-output-mock.test.ts` | Runs the mock as a child process and checks streams, JSON shapes, no color when piped, imports and doc drift |

### scripts/cli-output-mock.ts
- Header comment: prototype for PP-02, the real CLI follows `docs/cli-output.md`, and nothing imports this file.
- Imports: `import { styleText } from 'node:util';` and `import process from 'node:process';`. Nothing else.
- Small helpers at the top:
  - `symbols(ascii: boolean)`, which returns the set from Architecture Decisions;
  - `paint(format, text, stream)`, a thin wrapper over `styleText(format, text, { stream })`;
  - `formatBytes(n)`, in binary units with one decimal;
  - `formatCount(n)`, with `Intl.NumberFormat('en-US')`.
- One function per scenario. Each writes to `process.stdout` / `process.stderr` and returns the exit code it would use. Scenarios and their content:
  - `auth`:
    - `› Opening your browser to sign in to Google…`;
    - the fallback line `If no browser opened, visit:` plus a mock URL `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&scope=drive.file&code_challenge=…`, shortened with `…` (no real client id and no `state`);
    - `… Waiting for Google (times out in 5 minutes)`;
    - `✓ Connected as owner@example.com`, with `scopes: drive.file`.
    - Exit 0.
  - `auth-status`:
    - `account owner@example.com`, `scopes drive.file`, `consented 2026-11-12 (7 days ago)` and `token refreshed 2 hours ago` as aligned key/value rows;
    - a warning: `! Consent is 7 days old. If your Google Cloud consent screen is in Testing, Google expires the refresh token after 7 days. Publish the app (OAuth consent screen › Publish app) or run byos auth again.`
    - Exit 0.
  - `doctor`: six checks, each `✓`, `!` or `✗` plus a label, and every non-pass followed by an indented `fix:` line with the exact step.
    - `✓ Client file found` (`%APPDATA%\byos\config.json` points to `C:\Users\me\byos\client_secret.json`);
    - `✓ Client type is Desktop`;
    - `✓ Drive API reachable`;
    - `✓ Scopes: drive.file`;
    - `✗ Token valid`, with `fix: run byos auth`;
    - `! Consent screen may be in Testing`, with `fix: Google Cloud console › APIs & Services › OAuth consent screen › Publish app`.
    - Last line: `1 failed, 1 warning`. Exit 5 (auth).
  - `backup-dry-run`: the scan summary, then `Would upload 451 files (38.2 GB):` and about 6 example relative paths with sizes, including `2026/11/VID_0412.mp4  3.1 GB`, then `… and 445 more`. Exit 0.
  - `backup`:
    - the scan summary:
      - `Scanning C:\Users\me\Pictures`;
      - `12,431 files`;
      - `11,980 unchanged`;
      - `451 to upload, 38.2 GB`;
      - `remote BYOS Backup/DESKTOP-01/Pictures`;
    - progress, with the format `[ 214/451 ]  17.9 GB / 38.2 GB  12.4 MB/s  2026/11/VID_0412.mp4`;
    - one retry line in dim: `› RATE_LIMITED on IMG_3001.HEIC, retrying in 4 s`;
    - then the hard stop on stderr:
      - `✗ QUOTA_EXCEEDED: your Google Drive is full. 214 of 451 files were uploaded and recorded.`
      - `Free up space or upgrade storage, then run the same command: it resumes where it stopped.`
    - Final summary: `uploaded 214, skipped 11,980, failed 0, remaining 237`. Exit 6.
    - The mock also shows a single per-file failure line before the stop: `✗ 2026/10/IMG_2990.HEIC: PERMISSION_DENIED (file skipped, run continues)`.
  - `backup-interrupted`: a progress line, then `Interrupted. 37 files were uploaded and recorded; 2 partial uploads were saved.` and `Run the same command to resume.` Exit 130.
  - `error`: human error for `byos stat "Bills/2026-11/missing.pdf"`, on stderr: `✗ NOT_FOUND: no file at Bills/2026-11/missing.pdf`. Exit 3.
  - `error-json`: the same with `--json`, stderr only: `{"code":"NOT_FOUND","message":"no file at Bills/2026-11/missing.pdf"}`. Exit 3.
  - `ls-json`: stdout, one JSON document, an array of 3 entries with `{ id, name, path, kind: "file"|"folder", size?, modifiedTime, sha256? }`, using obviously fake ids (`1AbC…mock`) and `Bills/2026-11/...` names. Exit 0.
  - `put-json`: stdout `{ "id", "name": "statement.pdf", "sha256", "size": 123456, "path": "Bills/2026-11/statement.pdf" }` (the FN-11 shape). Exit 0.
- Argument handling, written by hand from `process.argv` (commander is not used in the mock):
  - the first positional is the scenario, or `all`, which runs every scenario in order with a dim `── <scenario> ──` divider;
  - `--ascii` forces the fallback symbols;
  - `--markdown` prints the doc (see below) and ignores TTY;
  - an unknown scenario prints the list to stderr and exits 2.
- `--markdown`: run every scenario with captured writers instead of `process.stdout/stderr`, with a fake non-TTY stream so `styleText` emits no color and progress uses the non-TTY mode. Then print the doc:
  - the title `# CLI output`;
  - the intro;
  - `## Conventions` (streams, `--json`, `NO_COLOR` and non-TTY, symbols with the fallback, palette, paths, numbers);
  - `## Exit codes` (a table);
  - `## Error codes` (the FN-01 list, one line each);
  - then one `## <command>` section per scenario, with `stdout` and `stderr` in separate fenced `text` (or `json`) blocks, and the exit code.
  - To keep the doc stable, the TTY redraw is skipped and no timestamp or `Date.now()` value is printed.
- Keep it under ~350 lines. It is a prototype, but it still passes `strictTypeChecked` lint, so no `any`.

### tests/cli-output-mock.test.ts
- Copy the layout of `tests/portability.test.ts`. Resolve `scripts/cli-output-mock.ts` with `fileURLToPath(new URL('../scripts/cli-output-mock.ts', import.meta.url))`.
- Run with `spawnSync(process.execPath, [script, scenario], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '' } })`. Each assertion uses piped stdio, which is non-TTY by default.
- Cases:
  1. For every scenario, piped output contains no `\x1b[` sequence.
  2. `error-json` writes empty stdout, stderr parses as JSON equal to `{ code: 'NOT_FOUND', message: expect.any(String) }`, and the exit status is 3.
  3. `put-json` writes stdout that parses as an object with exactly the keys `id, name, sha256, size, path`, empty stderr, and exit status 0.
  4. `ls-json` writes stdout that parses as an array.
  5. `backup` exits 6, and its stderr contains `QUOTA_EXCEEDED`.
  6. `backup-interrupted` exits 130.
  7. An unknown scenario exits 2.
  8. `--ascii` output contains none of `✓ ✗ › …`.
  9. Doc drift: `docs/cli-output.md` equals a fresh `--markdown` stdout, byte for byte. The test reads the file with `readFileSync`, which is fine in a test.
  10. Imports: the script's source matches no `from 'node:(?!util|process)` import and no `fetch(` call, which proves no network and no file system.
  11. Every code that appears as `"code":"..."` or `✗ <CODE>:` in the `--markdown` output is in the FN-01 list, hardcoded in the test as the expected array.
- Use the `NO_COLOR: ''` env only where needed. Piping alone already disables color, and case 1 also covers a run without `NO_COLOR`.

## Files to Modify
| File | Changes |
|------|---------|
| `tsconfig.json` (root) | `include`: add `"scripts"`; `compilerOptions`: add `"erasableSyntaxOnly": true` so the typecheck rejects syntax Node can't strip; update the top comment to mention the scripts |
| `issues/PP-02-prototype-cli-output.md` | `## Verdict` after the owner reads the doc; Execution Record at the end |
| `issues/_index.md` | PP-02 `todo` → `planned` now (this planning step); `done` only by verify-it |

Do not touch `packages/cli/src/*`, FN-01 or any other issue file: the codes already match.

## Data Requirements
- None.

## Testing Strategy
- Covered by `tests/cli-output-mock.test.ts` above. It runs inside `pnpm test` (root `vitest run`).
- Manual check: `node scripts/cli-output-mock.ts backup` in a real terminal shows the redraw, and `node scripts/cli-output-mock.ts backup | cat` shows plain step lines.

## Implementation Order
1. **Riskiest first:** add `scripts` and `erasableSyntaxOnly` to the root `tsconfig.json`. Then write a 10-line version of the mock with one scenario and run all three of these before writing the rest:
   - `node scripts/cli-output-mock.ts auth`, which must run without a build;
   - `pnpm typecheck`;
   - `pnpm exec eslint scripts`, which proves the type-aware lint sees the file.
   If the lint reports the file is not in a project, stop and fix the include, not the lint config.
2. Write the helpers and all scenarios.
3. Write `--markdown` and generate `docs/cli-output.md`.
4. Write the test.
5. Owner gate: show the owner `docs/cli-output.md` (and offer the Windows run). Apply one round of wording changes if asked, regenerate the doc, and record the verdict.
6. `pnpm format`, then `pnpm check`.

## Security Considerations
- Mock data only. `owner@example.com`, fake Drive ids, a shortened mock OAuth URL without a real `client_id`, `state` or `code`. No token, authorization code or real account in any output: this is the same rule the real CLI follows (SPECS, "tokens, codes and URLs carrying them are never logged"), and the auth mock shows the shape without the secret parts.
- No real photo names. `Bills/2026-11/statement.pdf` is generic: don't use a bank name.

## Pattern to Copy
- `tests/portability.test.ts` for the root test layout and path resolution.
- The output wording follows SPECS (`byos doctor` prints "the exact console step to fix it", and the Testing-mode warning names the 7-day expiry) and FN-11 and FN-13 (exit codes, quota stop, resume message).

## Verification
- Command: `node scripts/cli-output-mock.ts all | cat` (prints every scenario with no escape codes and exits 0; the last scenario's own exit code is not propagated in `all`).
- Command: `node scripts/cli-output-mock.ts --markdown | diff - docs/cli-output.md` (no output: the doc matches the mock).
- Command: `pnpm check` (build, lint, typecheck and tests green, including the 11 new cases).
- Manual: the owner reads `docs/cli-output.md` and the verdict is recorded in this issue.

## Out of Scope
- Any real command, or any change to `packages/cli/src/*` (FN-09 onwards).
- An output library inside `@byos/cli` (FN-09 writes it from the decisions here).
- Adding chalk, picocolors, ora, cli-progress or any dependency.
- Spinners and animation beyond the short progress redraw.
- Localization of CLI output (English only in v1).
- Changing FN-01's error codes or FN-11's exit codes.

## Checkpoint
- `Checkpoint: nao`

---

# Execution Record

- Branch `feat/PP-02-cli-output`, executed 2026-11-19.
- Step 1 (riskiest) passed on the first try: with `scripts` in the root `tsconfig.json` and `erasableSyntaxOnly`, `node scripts/cli-output-mock.ts`, `tsc --noEmit -p tsconfig.json` and `eslint scripts` all succeeded.
- Owner gate: approved with no wording changes (see Verdict).
- Deviations from the plan:
  - Backup summary reads `failed 1, remaining 236` instead of `failed 0, remaining 237`, so it agrees with the per-file `PERMISSION_DENIED` line the same scenario prints.
  - `PERMISSION_DENIED` is listed under exit code 1 in the doc's exit-code table; FN-11's table has no dedicated code for it, so it falls in "anything else".
  - The script is ~550 lines after Prettier instead of the ~350 the plan estimated: ten scenarios plus the doc generator.
  - The test runs every invocation once, in parallel, in a `beforeAll` (120 s deadline) and the cases only read the results. The first version spawned a process per case and 9 of 21 cases hit vitest's 5 s timeout with the machine at load 285 (a Node start took 3.6 s). After the change, 21 of 21 passed in 18 s under the same load.
  - A `FORCE_COLOR=1` case was added to prove the piped no-color assertion is meaningful (it fails if color never turns on).
- First `pnpm check` failed on lint with 3 errors in the new files (an unused destructured `out`, a non-`Error` promise rejection, an `expect.any` assignment typed `any`). All three were fixed, then `pnpm check` passed.
- `pnpm check`: build, lint (ESLint 0 errors and 0 warnings, Prettier clean), typecheck and tests green: 29 passed (24 in the root suite, 21 of them new, plus 5 in the packages).

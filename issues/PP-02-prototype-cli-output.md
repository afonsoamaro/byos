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

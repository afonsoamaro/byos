# Design history

The two files in this folder are the original design handoff for BYOS, kept for the record.

`SPECS.md` at the repository root supersedes them. Where they disagree, `SPECS.md` wins.

Their sync design (two-way sync and conflict handling) was cut on purpose: v1 is a one-way, append-only backup, and sync is explicitly out of scope. Their full-Drive scopes were dropped too: BYOS requests only `drive.file` and `drive.appdata`.

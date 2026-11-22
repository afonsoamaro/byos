# Issues Index

Source: `../SPECS.md` (2026-11-13). Order: FN-00 → FN-00b before anything else; every later issue runs on its own branch and merges through a PR.

BYOS has no screens, so the prototype round is the logo and the CLI's terminal output.

## Prototype Issues
| Issue | Name | Status | Dependencies |
|-------|------|--------|--------------|
| PP-01 | Prototype: Logo and README header | done | FN-00 |
| PP-02 | Prototype: CLI output | done | FN-00 |

## Functional Issues
| Issue | Name | Status | Dependencies | Checkpoint |
|-------|------|--------|--------------|------------|
| FN-00 | Monorepo scaffold, check and CI | done | none | |
| FN-00b | Git init, GitHub repo and issues | done | FN-00 | |
| FN-01 | Core contract: provider interface, types and errors | done | FN-00 | sim |
| FN-02 | Core path resolver | done | FN-01 | |
| FN-03 | Drive OAuth: PKCE, code exchange and refresh | done | FN-01 | sim |
| FN-04 | Drive provider: list, stat, get and error mapping | done | FN-02, FN-03 | |
| FN-05 | Drive provider: mkdir and simple upload | done | FN-04 | |
| FN-06 | Drive provider: resumable upload | done | FN-05 | |
| FN-07 | Drive provider: move, copy and delete | done | FN-05 | |
| FN-08 | CLI encrypted token store | done | FN-01 | sim |
| FN-09 | `byos auth`: loopback OAuth, status and logout | awaiting owner run | FN-03, FN-04, FN-08, PP-02 | sim |
| FN-10 | `byos doctor` | done | FN-09 | |
| FN-11 | CLI file commands with `--json` | done | FN-07, FN-09 | sim |
| FN-12 | `byos backup`: scan, manifest and plan | done | FN-11 | |
| FN-13 | `byos backup`: upload, resume and progress | done | FN-06, FN-12 | |
| FN-14 | `byos backup --verify` | planned | FN-13 | |
| FN-15 | Spike: file visibility across OAuth clients under `drive.file` | planned | FN-09, FN-11 | |
| FN-16 | Windows photo backup smoke (first consumer) | planned | FN-10, FN-13, FN-14 | |
| FN-17 | Headless auth for server consumers (bill tracker integration) | planned | FN-11 | sim |
| FN-18 | README and developer onboarding guide | planned | PP-01, FN-10 | |
| FN-19 | First npm release | planned | FN-16, FN-18 | sim |

## Suggested execution order

1. FN-00, FN-00b
2. PP-01, PP-02 (owner verdicts)
3. FN-01 → FN-02 → FN-03 → FN-04 → FN-05 → FN-06, FN-07
4. FN-08 (can run in parallel with FN-02..FN-07 after FN-01) → FN-09 → FN-10 → FN-11
5. FN-12 → FN-13 → FN-14 → FN-16 (speed gate: if it stalls, do FN-17 first)
6. FN-15, FN-17, FN-18, FN-19

# BYOS — Discovery

2026-09-07 · quick mode · **verdict: go-with-conditions, radically reduced; the ambitious half competes with rclone**

A specification handoff for an open-source "Bring Your Own Storage" library in TypeScript, Google Drive first. No
code yet, and the design is already large.

## Idea

A library letting an application store user data in the user's own cloud storage rather than the developer's,
starting with Google Drive: `@byos/core`, `@byos/drive`, `@byos/cli` and `@byos/nestjs`, with OAuth2, the full file
operation set, path resolution, SHA-256 deduplication, bidirectional and recursive sync, tombstones, Drive Changes
API, local state, metrics, watch mode, concurrency control and app-data-folder state management.

## Scope reality check

Read that list again as an engineering estimate rather than as a feature list. **Bidirectional sync with tombstones
and change feeds is one of the genuinely hard problems in software**, and it is where file-sync libraries go to
die: conflict resolution, partial failure, clock skew, deletion versus never-seen, and rename detection are each a
project.

The design as written is not a library, it is several. That is the central finding.

## Market

| Occupant | What it is |
|---|---|
| **rclone** | "rsync for cloud storage", 70+ providers including Drive, S3, Dropbox, OneDrive, B2. The reference implementation of sync |
| Provider SDKs | Official, per-provider, no abstraction |
| Storage abstraction libraries in the JS ecosystem | Key-value and blob abstractions, generally without user-owned-account semantics |

**Sync is occupied by rclone and competing with it is not a project, it is a career.** What is less occupied is the
narrower thing: a clean TypeScript abstraction for *an application* storing *its user's* data in *that user's*
account, with the OAuth dance handled and framework integration provided. That is a different job from syncing two
directory trees.

**And there is a specific 2026 finding that matters more than the competitive picture.** rclone's shared Google
Drive client_id is being retired and stops working during 2026, with the recommendation now being that each user
create their own. That is the adoption problem for anything in this category: a BYOS library that requires every
developer, or worse every end user, to create a Google Cloud project and configure an OAuth consent screen has a
very small population of willing adopters. The largest project in the space just had to push that cost onto its
users.

This does not kill the idea. It does mean **onboarding is the product's hardest problem, not sync**, and the
specification does not mention it at all.

## Viability

**Technical.** TypeScript, with NestJS integration as one of the packages. No portfolio stack conflict, since a
library is not an application.

**What is genuinely tractable:** the abstraction plus one provider plus the file operations plus path resolution
plus OAuth. That is a real library, useful in the owner's own applications, and finishable.

**What is not tractable as a side project:** bidirectional sync, tombstones, change-feed reconciliation and watch
mode. Each is defensible in isolation and together they are rclone.

**Personal.** The reduced version is small. The specified version is open-ended.

## Verdict

**go-with-conditions, radically reduced.**

**Conditions:**

1. **No sync in version one.** Read, write, list, move, copy, delete, path resolution and OAuth. Sync is removed
   from the scope, not deferred inside it, because a deferred sync shapes the architecture around a feature that
   may never come.
2. **Onboarding is designed before the API.** How a developer, and then a user, gets from nothing to a working
   token is the adoption problem, and the retirement of rclone's shared client shows it is getting harder rather
   than easier. If that flow is not answered, the library has no users regardless of quality.
3. **It earns its existence inside the portfolio first.** One of the owner's own applications should store
   something real through it before it is presented as a general-purpose library. A library with no first consumer
   is a specification with a package name.

**Recommended MVP cut.** `@byos/core` with the interface, `@byos/drive` with OAuth and file operations, and one
application in the portfolio actually using it. The CLI and the framework module come after that, and sync comes
never unless something forces it.

**Differentiators to protect.** User-owned-storage semantics as a first-class concept, and the onboarding flow if
it can be made genuinely simple. Not breadth of providers, which is rclone's ground.

**MVP to product triggers.** Open source has no revenue trigger, but it has an adoption one: a second consumer
outside the owner's own projects is the signal that the abstraction is right.

## Open Questions

1. What the OAuth onboarding looks like end to end after the shared-client retirement. This is the gating design
   question.
2. Whether app-data-folder or a visible user folder is the default. App-data hides the files from the user, which
   contradicts part of the point of BYOS; a visible folder invites users to move things and break state.
3. Which of the owner's applications is the first consumer.
4. Whether a second provider is added before or after the first real consumer. After, almost certainly: two
   providers before one user is how abstractions get designed wrong.

## Handoff

`/specs` can skip: market, the sync decision, and the scope reduction.

`/specs` must add:

- The onboarding and OAuth flow, as the first design artifact.
- The core interface, designed against one provider and one real consumer.
- An explicit statement that sync is out of scope, so it does not creep back in through the architecture.

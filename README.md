<!-- header image: added with the logo round -->

# BYOS: Bring Your Own Storage

BYOS lets an app keep a user's files in that user's own cloud storage instead of the app's servers. It's a TypeScript library plus a CLI, starting with Google Drive.

## Status

Pre-alpha. Nothing usable yet: this repository holds the scaffold and the plan.

## What it will do

- `@byos/core`: a provider-agnostic storage contract that runs on Node, in the browser and in React Native.
- `@byos/drive`: a Google Drive provider built on `fetch` and the Drive REST API.
- `@byos/cli`: a Node CLI with OAuth sign-in, a `doctor` command, file operations and `byos backup <folder>`, a one-way, append-only backup.

## What it won't do

- Sync. Backup goes one way and never deletes anything in your Drive.
- Ask for full access to your Drive. BYOS only requests `drive.file`, so it sees the files it created and nothing else.

## Development

Requires Node 26 and pnpm 12.

```sh
pnpm install
pnpm check   # build, lint, typecheck and test for every package
```

## License

MIT, see [LICENSE](LICENSE).

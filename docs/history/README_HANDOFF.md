# BYOS Storage Library (Google Drive First)

This package is a project handoff/specification for an open-source BYOS (Bring Your Own Storage)
library written in TypeScript/NestJS.

Implemented in the design:
- @byos/core
- @byos/drive
- @byos/cli
- @byos/nestjs
- OAuth2 Google Drive integration
- Upload/download/list/move/copy/delete
- Path resolver
- SHA256 deduplication
- Bidirectional sync
- Recursive sync
- Tombstones
- Drive Changes API integration
- Local state persistence
- Metrics/progress tracking
- Watch mode
- Concurrency control
- AppDataFolder state management

Next phase:
- Additional providers (OneDrive, Dropbox, WebDAV, Box, pCloud, etc.)
- Test suite
- GitHub Actions
- Packaging and publishing

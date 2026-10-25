# Project entry points

- `src/extension.ts` registers the VS Code custom editor and owns host clipboard, export destinations, and the webview boundary. `src/SqliteDocument.ts` owns document lifecycle, request serialization, native save, and recovery.
- `src/SqliteDatabase.ts` owns schema inspection, lossless typed values, queries, staged editing, transactions, conflict checks, and consistent database snapshots. Cross-layer values and requests are defined in `src/protocol.ts`.
- `src/webview/grid.ts` mounts the browser interface. Other webview modules own table navigation, editing, and styling.
- Ordinary edits remain staged until Ctrl/Cmd+S commits all pending changes in one transaction. Table switching preserves pending changes. Undo/Redo cover the current unsaved editing session; Save and Revert establish a new baseline. Data sorting and displayed column order never rewrite database structure.
- Preserve integer precision, NULL versus empty strings, read-only generated/BLOB cells, view/virtual-table restrictions, and optimistic conflict detection. Never use displayed row numbers as database identities.
- Run `npm run typecheck`, `npm test`, and `npm run build` after implementation changes. UI changes also require `npm run test:ui`, with Chromium Headless Shell installed through `npx playwright install chromium --only-shell`.
- `npm run package` creates a VSIX for the current OS and architecture and includes the SQLite Node-API binary. Validate native dependency inclusion before distribution. Build each platform's package on its matching platform.
- `npm run sample` creates a local database at `examples/sample.sqlite`. Existing sample databases are never overwritten by generation. Examples are excluded from packages.
- Use headless checks only. Do not start, display, focus, activate, reload, close, or reopen desktop VS Code, extension host, or browser windows during automation. Install updates through the background CLI; the user chooses when to reload. A desktop session needs explicit authorization.
- English is the default for interface text, documentation, source comments, and examples. Simplified Chinese remains an optional interface/documentation language; preserve intentional Unicode fixtures and translation dictionaries.
- Keep LICENSE, package metadata, and English/Chinese README license statements consistent with AGPL-3.0-only.

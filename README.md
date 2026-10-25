# Neat SQLite

English | [简体中文](README.zh-CN.md)

Browse and edit local SQLite databases inside VS Code. Switch tables from a searchable sidebar, collapse it into a table selector, and edit records in a compact spreadsheet interface.

- Browse tables and read-only views with natural/ascending/descending order, independent column filters, and paged loading.
- Build Text, Regular expression, Values, Number, Empty, Not empty, or Custom WHERE filters with a live SQL preview; column conditions combine with AND.
- Select rows, columns, or disjoint cells. Clipboard operations require a complete rectangular selection.
- Inspect columns, keys, indexes, foreign keys, and SQL definitions.
- Stage value changes, inserts, and deletes; save all pending changes in one transaction with Ctrl/Cmd+S.
- Keep 64-bit integers exact and distinguish NULL from empty text.
- Copy and paste tabular data, export CSV, and create consistent database snapshots.
- Use light or dark themes and English or Simplified Chinese interface text.

## Install and use

Build a platform-specific VSIX with `npm run package`, then choose **Extensions → Install from VSIX…** in VS Code. Open a `.sqlite`, `.sqlite3`, `.db`, or `.db3` file, or run **Neat SQLite: Open Database**.

Edits remain pending when switching tables. Ctrl/Cmd+S commits them together. Constraint failures and external changes stop the save and preserve pending edits. Undo and Redo cover changes since the last save or revert. Views, virtual tables, generated columns, and BLOB values are read-only. SQLCipher and remote files are unsupported.

**Save Database Snapshot** copies the committed database using SQLite's backup API; pending edits remain in the editor. **Save As** writes a database copy including pending edits. CSV export uses the selected table and current query; NULL and empty text both export as empty CSV fields.

Regular expressions use budgeted RE2 matching in the backend after SQLite applies native conditions and ordering, before matching-page slicing. Other filter modes execute in SQLite; Custom accepts a restricted WHERE expression, with SQL statements and external access unavailable. Value enumeration covers the full column and pending edits, with explicit limits.

## Development

Use Node.js 20.17 or newer and npm:

```sh
npm install
npm run typecheck
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:ui
npm run package
```

The VSIX is written to `release/` for the current platform and architecture. Its native SQLite binary requires a matching target platform. `npm run sample` creates `examples/sample.sqlite` for manual exploration.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

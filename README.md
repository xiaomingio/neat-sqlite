<img src="assets/icon.png" width="96" height="96" alt="Neat SQLite logo">

# Neat SQLite

English | [简体中文](README.zh-CN.md)

Browse, query, and edit local SQLite databases inside VS Code. Work with related tables in a compact spreadsheet, run SQL with typed results, and import or export CSV.

## Features

- Browse tables and read-only views page by page, with column filters and multi-column sorting.
- Sort by several columns at once. Columns added first take priority; the sort panel lists every key, lets you reverse or reorder them, shows the generated `ORDER BY`, and resets all sorting.
- Build Text, Regular expression, Values, Number, Empty, Not empty, or Custom WHERE filters with a live SQL preview; conditions on different columns combine with AND.
- Select rows, columns, or disjoint cells. Copy and paste require a complete rectangle. The status bar shows the sum, average, minimum, and maximum of selected numbers.
- Stage value changes, inserts, deletes, CSV imports, and text replacements across tables, then save them in one transaction with Ctrl/Cmd+S.
- Find with Ctrl/Cmd+F or replace with Ctrl/Cmd+R in one compact panel that stays open while you keep working in the grid or SQL editor. Replace matches one at a time, skipping any you want to keep, or replace all. Search the whole table or an exact selection, with optional regular expressions and capture-group replacement.
- Fill selections, fill down, duplicate records, and edit complete records with multiline text and JSON. Follow foreign keys to related records.
- Run SQL with syntax highlighting, table/column completion, cancellation, query history, saved queries, and CSV result export.
- Create tables, add, rename, or drop columns, manage indexes and views, and run immediate SQL writes.
- Check database integrity and foreign keys, inspect database size, and reclaim free space with VACUUM.
- Keep 64-bit integers exact and distinguish NULL from empty text.
- Inspect columns, keys, indexes, foreign keys, and SQL definitions.
- Import CSV with column mapping, explicit types, NULL markers, and defaults. Export the current filtered table or SQL results as CSV; create consistent database snapshots.
- Follow the VS Code light or dark theme, or choose one; English or Simplified Chinese interface.

## Working with the table

- Each column header shows the name, then the type and primary key. Active sort and filter buttons stay visible with an orange background. Hover or focus a header to reveal all four tools; the three-dot menu provides sorting, filtering, pinning, and visibility options.
- The toolbar shows a tip for the control under the pointer or with keyboard focus.
- Navigate with arrow keys, Home/End, Ctrl/Cmd+Home/End, and Page Up/Down; arrows continue onto the adjacent page. Press Enter or F2 to edit.
- Use the footer to move between pages, choose rows per page, or jump to a page. Sorting and filtering apply to the complete query before pagination.
- Drag a column edge to resize it, or double-click the edge to fit its content.
- Multiline text appears on one grid line with `↵` at line breaks, including SQL results. Editing, copying, saving, and exporting preserve the original text.

**Display layout never changes the database.** Sorting, column order, width, pinning, and hidden columns only affect the editor view. Dragging a column does not reorder columns in the database file: SQLite can change column order only by rebuilding the table, which risks constraints, triggers, views, and programs that rely on column positions.

Right-click a row number for Add record, Copy, Copy with headers, Edit record, Duplicate selected records, and Delete selected records. Right-clicking a fully selected row keeps the complete selected rows; otherwise, it selects that row. Keyboard users can focus a row number and press Context Menu or Shift+F10. Add record is also available in the Data menu.

## Find and replace

Shortcuts and Edit menu actions open a compact, non-modal panel at the top right of the editor, like the VS Code find widget. You can keep selecting cells or editing SQL while it is open; a new selection updates the **Selection** scope. The panel moves to the bottom when it would cover a located match. It follows the active tab. Escape or the close button closes it. In **SQL Query**, Find and Replace edit the SQL source text; query results stay read-only. Replacing SQL text edits the draft and executes no SQL. Choose **Whole query** or **Selection** (the text selected when search opened), and use the editor’s Undo to revert replacements. In **Data**, press Ctrl/Cmd+F to open table search, or Ctrl/Cmd+R to open it with **Replace** checked. Checking **Replace** reveals the replacement field and actions; leaving it unchecked performs read-only Find. Search all columns or choose one, and toggle **Aa** (Match case, Alt+C) or **.\*** (regular expression, Alt+R) beside the search field. Enter finds all matches; pressing Enter again steps to the next match and Shift+Enter to the previous one. Results highlight the first match in each value.

**Whole table** searches every page, includes pending edits, and ignores the current table filters. **Selection** uses the exact cells selected on the loaded page when search opens, including disconnected selections. Select cells before opening search; expired or changed selections require reselection. Whole table is the initial scope; an explicit scope choice can be remembered.

Regular expressions (**.\***) are off initially. Enable it for RE2 expressions and use `$1`, `$2`, and subsequent numbered groups in replacements. Unsupported or invalid expressions show an error. With regular expressions off, replacement text such as `$1` stays literal. Find searches text and numeric display values, including generated fields, while keeping exact integers; NULL and BLOB values are excluded. Replace changes editable text cells only, previews the result, and stages changes until Ctrl/Cmd+S. **Replace** (Ctrl/Cmd+Shift+1, or Enter in the replacement field) replaces only the current match and moves to the next one; **Next match** skips a match without changing it; **Replace all** replaces every previewed match. Changed search settings or matching data require a fresh preview. Open a match or use Previous/Next to locate its cell; **Restore view** restores the original filters, sorting, and page.

## SQL and CSV

The SQL Query tab runs one selected or current SQL statement with Ctrl/Cmd+Enter. SELECT, WITH, and VALUES read committed database data; save pending table edits to include them. Results preserve SQLite types and exact 64-bit integers. Read queries have a five-second budget, an 8 MiB result budget, and a configurable limit of up to 10,000 rows. A reached result limit is reported explicitly. **Export displayed results as CSV** exports the exact rows shown, including when a result limit was reached; it does not rerun the query.

Column menus offer add, rename, and drop dialogs with a SQL preview. **Execute** applies the statement; opening the dialog or editing its fields does not change the database. SQLite handles these operations with native ALTER TABLE. Dropping a column rewrites table content internally and can fail when schema objects depend on the column.

SQL writes and structure changes commit immediately in a transaction and require all pending table edits to be saved or discarded. They cannot be undone in the table editor. Use a database snapshot before experimenting with structure changes.

Foreign-key navigation uses SQLite’s comparison rules to locate a committed parent record and then shows its pending edits. Save newly inserted parent records or new referenced key values before following them. A parent pending deletion cannot be opened.

CSV import requires a header row and supports files of up to 8 MiB and 10,000 records. Map source columns to fields, choose storage types, and specify whether empty fields mean empty text, NULL, or an omitted default. A NULL token can distinguish NULL from empty text. Imports remain pending until Ctrl/Cmd+S; database constraints are checked when saving.

## Saving and safety

Edits remain pending when switching tables. Ctrl/Cmd+S commits them together. Constraint failures and external changes stop the save and preserve pending edits. Undo and Redo cover changes since the last save or revert. Views, virtual tables, generated columns, and BLOB values are read-only. SQLCipher and remote files are unsupported.

**Save Database Snapshot** copies the committed database using SQLite's backup API; pending edits remain in the editor. **Save As** writes a database copy including pending edits. CSV export uses the selected table and current query; NULL and empty text both export as empty CSV fields.

Regular expressions use budgeted RE2 matching in the backend after SQLite applies native conditions and ordering, before page slicing. Other filter modes execute in SQLite. Custom filters accept a restricted WHERE expression; use the SQL Query tab for complete SQL statements. Value enumeration covers the full column and pending edits, with explicit limits.

## Install

Build a platform-specific VSIX with `npm run package`, then choose **Extensions → Install from VSIX…** in VS Code. Open a `.sqlite`, `.sqlite3`, `.db`, or `.db3` file, or run **Neat SQLite: Open Database**.

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

The VSIX is written to `release/` for the current platform and architecture; its native SQLite binary requires a matching target platform. `npm run sample` creates `examples/sample-workbench.sqlite` with 12,000 orders, 24,000 line items, related tables, views, and typed edge cases. Existing databases are preserved. See the [sample guide](examples/README.md) for pagination exercises, SQL queries, and CSV import files. `npm run icon` renders `assets/icon.svg` to `assets/icon.png`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

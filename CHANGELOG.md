# Changelog

## 0.3.2

- Restore Find and Replace to one centered modal dialog, with Escape and Close returning focus to the opener. Searching leaves the table layout unchanged.
- Replace the upper-right Add record button with a row-number context menu for adding, copying, editing, duplicating, and deleting records. Complete selected rows are preserved; keyboard row menus support Context Menu and Shift+F10.

## 0.3.1

- Route Find and Replace through the active tab: table cells in Data, SQL source text in SQL Query. Query results remain read-only, and Add record is shown only in Data.
- Add nearby column menu actions for add, rename, and drop. Simple dialogs show native ALTER TABLE SQL and execute only after the explicit Execute action. Dependent schema objects can prevent column removal.

- Show multiline table and SQL-result text on one line with `↵` markers, preserving the original text for editing, clipboard operations, saves, and CSV exports.

- Add Find (Ctrl/Cmd+F) and Replace (Ctrl/Cmd+R) shortcuts to one search panel. A Replace checkbox reveals the replacement field and actions; unchecked search is read-only.
- Search Whole table across every page and independently of current filters, or search the exact selected cells, including disconnected selections.
- Add optional RE2 regular expressions, case matching, and numbered capture-group replacements such as `$1` and `$2`.
- Find text and numeric display values, preserve exact integers, and include generated fields. Replace only editable text cells, with a fresh preview required after search settings or matching data change.
- Navigate to individual matching cells, move between results, clear results, and restore the original table view. Validate page snapshots and matching record values before applying or locating results.

## 0.3.0

- Add a SQL workspace with syntax highlighting, schema completion, current-statement execution, cancellation, typed results, query history, saved queries, and CSV export.
- Import CSV with a preview, column mapping, explicit types, NULL markers, and omitted defaults; keep imports staged until save.
- Find and replace text across the filtered table, fill selections, fill down, duplicate records, edit record details, and follow foreign keys.
- Create tables, add or rename columns, manage indexes and views, and execute transactional SQL writes. Structure and SQL writes commit immediately after pending table edits are resolved.
- Inspect database size, run integrity and foreign-key checks, and reclaim free pages with VACUUM.
- Make pagination visible with record ranges, previous/next controls, page jumping, and selectable page sizes.
- Provide a comprehensive sample with 12,000 orders, 24,000 line items, related tables, constraints, views, a trigger, typed edge cases, executable queries, and CSV import exercises. Preserve existing sample databases.

## 0.2.0

- Sort by several columns at once. Header sort buttons add a column, then switch ascending, descending, and off; the sort panel (right-click a sort button or View → Sort order…) reorders keys, shows the generated `ORDER BY`, and resets all sorting. Column option menus no longer repeat sort commands.
- Two-line column headers: the name uses the full width, with type, primary key, and active sort/filter marks below. Sort, filter, drag, and option buttons appear on hover or keyboard focus.
- First-open column widths fit the column name; double-click a column edge to fit its content.
- The toolbar tip now follows the hovered or focused control. The drag handle tip states that the database column order is not changed.
- Column moves show a dimmed source column, the drop side, and a column preview.
- Consistent stroke icons across the toolbar, headers, and panels; header labels and row numbers have no hover fill.
- Follow the VS Code light/dark theme until a theme is chosen; high-contrast selection colors.
- Keyboard: Home/End, Ctrl/Cmd+Home/End, Page Up/Down, F2, and arrows that continue onto adjacent pages. Focus stays in the grid after edits and page loads.
- Menus disable unavailable commands and support Left/Right between menus.
- Selection statistics show sum, average, minimum, and maximum, with exact 64-bit integer sums.
- Faster rendering and editing: cached column layout, delegated cell events, frame-batched selection painting, in-place column resizing, and indexed pending edits in the engine.
- Parameterized interface messages keep correct word order in Simplified Chinese; IME Enter no longer submits dialogs.
- Add the Neat SQLite icon.

## 0.1.x

- Local SQLite browsing with searchable, collapsible table navigation, Data and Structure tabs, and paged loading.
- Typed, staged edits across tables committed in one conflict-checked transaction; Undo, Redo, recovery, and Save As.
- Column filters including Values, Number, RE2 regular expressions, and restricted Custom WHERE conditions with a live SQL preview.
- CSV export of the current view, WAL-consistent database snapshots, English and Simplified Chinese interface.

# Sample workbench

Run `npm run sample`, then open `examples/sample-workbench.sqlite` with Neat SQLite. Generation preserves existing databases, including an older `sample.sqlite`. Rename or remove `sample-workbench.sqlite` when you want a fresh copy.

The sample is synthetic and can be used for editing, CSV import, SQL writes, and schema experiments. Copy it with **Save Database Snapshot** to keep a baseline. Examples are excluded from VSIX packages.

| Object | Records | Try |
| --- | ---: | --- |
| `orders` | 12,000 | Pagination, status filters, multi-column sorting, foreign keys, update trigger |
| `order_items` | 24,000 | More pages, generated totals, links to orders and products |
| `customers` | 500 | Several pages, search/replace, JSON preferences, NULL and empty notes |
| `products` / `categories` | 80 / 8 | Related records, unique values, numeric checks |
| `inventory` | 160 | Composite primary key in a WITHOUT ROWID table |
| `values_demo` | 6 | Exact 64-bit integers, NULL, empty text, literal `NULL`, Unicode, multiline text, BLOBs, generated fields |
| `import_contacts` | 0 | CSV import into an empty table; unique and numeric constraints |
| `scratch_notes` | 3 | Duplicate records, fill values, edit long text, staged edits across tables |
| `audit_log` | 1 | Observe a real trigger firing when a saved order status changes |
| `order_totals` / `customer_totals` / `schema_objects` | Views | Read-only browsing and SQL queries |

## Pagination

Select `orders` in the Data tab. At 200 rows per page, the table has 60 pages. Natural row order starts with IDs 1–200, then 201–400, and ends with 11,801–12,000. Orders 1, 200, 201, 400, 401, and 12,000 have a `Pagination marker` note. Keep sorting and filters cleared to compare these boundaries.

`order_items` has 120 pages at that page size; `customers` has three. Sorting and filters cover the complete table before pagination. Editing a record, moving to another page or table, and returning preserves the staged change. Ctrl/Cmd+S saves pending changes across all tables.

## Queries

Open [queries.sql](queries.sql) and copy a statement into the SQL Query tab. The file includes counts, page boundaries, JOINs, aggregates, CTEs, window functions, JSON, exact integer examples, composite keys, and trigger output. Execute one statement at a time. SQL queries read committed database data; save table edits to include them in query results.

## Find and replace

These exercises use **Data**. In **SQL Query**, the same shortcuts search or replace the SQL source text; choose **Whole query** or a captured SQL text **Selection**. Replacements edit the draft without executing SQL, support editor Undo, and leave results read-only.

1. Open `orders`, filter `status` to `shipped`, and press Ctrl/Cmd+F. Search all columns for `Pagination marker:` with **Whole table** scope. The six marker records are searchable across all pages, including orders hidden by the current filter.
2. Open `customers`, clear filters and sorting, and select only the `notes` cells for IDs 2 and 7 with Ctrl/Cmd+click. Press Ctrl/Cmd+F and choose **Selection** to search for `Line`. The unselected cell for ID 12 has the same text and must stay outside the search scope.
3. Keep that selection, press Ctrl/Cmd+R, and preview replacing `Line` with `Entry` in **Selection**. Apply to stage changes, then inspect ID 12 to confirm it is unchanged. Undo restores the two selected cells before saving.
4. In `customers`, choose **Whole table**, search the `name` column, enable **Use regular expression**, and preview `Customer ([0-9]+)` → `Client $1`. The capture group preserves each customer number. Leave the checkbox off for literal text search. Undo after applying if you want to keep the sample names.
5. In `values_demo`, use Find to locate `9223372036854775807`. Find includes numeric display values without rounding. Actual NULL and BLOB values are excluded from text search; generated fields can be searched. Replace changes editable text cells and preserves numeric, NULL, BLOB, and generated values.

Ctrl/Cmd+F opens one search panel with **Replace** unchecked; Ctrl/Cmd+R opens it checked. Toggle the checkbox to show or hide replacement controls. **Whole table** includes pending edits and ignores the table’s filters; **Selection** uses the exact cells selected on the loaded page, including disconnected cells. Replace previews changes and stages them until Ctrl/Cmd+S.

## CSV import and export

Import [contacts.csv](contacts.csv) into `import_contacts`. Map names to matching columns; use `integer` for `age`, `real` for `balance`, and `text` for the other fields. Set the NULL token to `\N`. Keep empty text as text. Leave `id` and `active` unmapped so SQLite supplies the primary key and default active value. The file includes multiline text, a quoted comma, escaped quotes, Unicode, NULL, and empty text.

[contacts-constraint-error.csv](contacts-constraint-error.csv) contains duplicate email addresses with valid field types. A save must reject the UNIQUE violation atomically and keep pending changes available for correction or discard. Import it into a fresh sample or clear existing contact changes to observe the error in isolation.

Import [orders-import.csv](orders-import.csv) into `orders`, mapping `customer_id` as `integer` and the remaining columns as `text`. Leave `id` unmapped. These rows reference existing customers; follow their foreign keys after saving.

Export a filtered table or query result to CSV and inspect the quoted fields. CSV represents both NULL and empty text as empty fields; use the database snapshot when you need to preserve SQLite types exactly.

## Editing and constraints

- Edit `scratch_notes` and `customers` before saving to exercise one save across two tables. Undo and Redo cover pending edits.
- After resolving pending edits, use a `scratch_notes` column menu to add a temporary TEXT field, rename it, then drop it. Inspect each SQL preview and click **Execute** to apply it. The native DROP COLUMN operation can reject columns referenced by constraints, indexes, or views.
- Add a contact while omitting `active`; saving applies its default of 1. Explicit NULL differs from omitting a field.
- Set a negative product price or duplicate customer email to exercise constraint errors.
- Change an order's `status`, save, and inspect `audit_log`. Removing a customer with orders must fail its foreign-key constraint.
- Follow an order’s `customer_id` to its customer and use **Back** to restore the original table and view. Navigation locates a committed parent using SQLite’s affinity and collation, then displays its staged edits. Save a newly inserted parent or a new referenced key before following it; a parent pending deletion cannot be opened.
- Edit one warehouse row in `inventory` to check that its complete composite key identifies the record.
- Inspect `values_demo`: generated fields and BLOB cells are read-only; editing another field preserves them. ID 5 has multiline text: its grid cell and SQL result show `↵` inline, while the editor, copy, and CSV export preserve the actual newline.

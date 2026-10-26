/*
Purpose: Own CSV mapping, schema actions and database maintenance dialogs.
*/
import type { Column, CsvMapping, Query, Table } from '../protocol';
import { quoteIdentifier } from '../ColumnFilter';
import { HostClient } from './HostClient';
import { Locale } from './Locale';
import { Dialog, button, element } from './Dialog';
type Context = { table?: Table; query: Query };
export class DatabaseTools {
  constructor(private readonly host: HostClient, private readonly locale: Locale, private readonly context: () => Context, private readonly refresh: (schema?: boolean) => Promise<void>, private readonly reportError: (error: unknown) => void) {}
  private t(text: string, params?: Record<string, string | number>): string { return this.locale.t(text, params); }
  private field(label: string, input: HTMLElement): HTMLLabelElement { const field = element('label', 'tool-field', this.t(label)); field.append(input); return field; }
  private input(label: string, value = ''): HTMLInputElement { const input = element('input'); input.value = value; input.setAttribute('aria-label', this.t(label)); return input; }
  private select(label: string, values: { value: string; label: string }[]): HTMLSelectElement { const select = element('select'); select.setAttribute('aria-label', this.t(label)); for (const entry of values) { const option = element('option', '', this.t(entry.label)); option.value = entry.value; select.append(option); } return select; }
  async importCsv(): Promise<void> {
    try { const { table } = this.context(); if (!table?.editable) throw new Error(this.t('The selected table is read-only.')); const text = (await this.host.request({ type: 'csvRead' })).text; if (text === undefined) return;
      const csv = (await this.host.request({ type: 'csvPreview', text })).csv; if (!csv) return;
      const dialog = new Dialog(this.t('Import CSV…'), this.locale); dialog.body.classList.add('csv-import');
      dialog.body.append(element('p', '', this.t('Import {count} records into {table}. Changes remain pending until you save.', { count: csv.total, table: table.name })), element('p', 'muted', this.t('The first CSV row contains column names. Skip a destination column to use its default. Integer values preserve all 64 bits.')));
      const token = this.input('NULL token', '\\N'); dialog.body.append(this.field('NULL token', token));
      const mapping: { column: string; source: HTMLSelectElement; type: HTMLSelectElement; empty: HTMLSelectElement }[] = [];
      const mappings = element('div', 'csv-mappings');
      for (const column of table.columns.filter(column => !column.generated)) {
        const row = element('div', 'csv-mapping'); const source = this.select(`${column.name} ${this.t("CSV source")}`, [{ value: '-1', label: 'Skip / use default' }, ...csv.headers.map((header, index) => ({ value: String(index), label: `${index + 1}. ${header}` }))]); const match = csv.headers.findIndex(header => header === column.name); source.value = String(match);
        const type = this.select(`${column.name} ${this.t("Type")}`, ['auto', 'text', 'integer', 'real'].map(value => ({ value, label: value.toUpperCase() }))); type.value = 'text';
        const empty = this.select(`${column.name} ${this.t("Empty fields")}`, [{ value: 'text', label: 'Empty text' }, { value: 'null', label: 'NULL' }, { value: 'default', label: 'Use default' }]);
        row.append(element('strong', '', column.name), this.field('CSV source', source), this.field('Type', type), this.field('Empty fields', empty)); mappings.append(row); mapping.push({ column: column.name, source, type, empty });
      }
      dialog.body.append(mappings, element('h3', '', this.t('CSV preview'))); const preview = element('div', 'csv-preview'); const grid = element('table', 'structure-table'); const head = element('tr'); for (const header of csv.headers) head.append(element('th', '', header)); grid.append(head); for (const values of csv.rows.slice(0, 8)) { const row = element('tr'); for (const value of values) row.append(element('td', '', value)); grid.append(row); } preview.append(grid); dialog.body.append(preview);
      dialog.show(this.t('Stage import'), async () => { const selected: CsvMapping[] = mapping.filter(entry => entry.source.value !== '-1').map(entry => ({ source: Number(entry.source.value), column: entry.column, type: entry.type.value as CsvMapping['type'], empty: entry.empty.value as CsvMapping['empty'] })); if (!selected.length) throw new Error(this.t('Map at least one CSV column.')); await this.host.request({ type: 'csvImport', table: table.name, text, mapping: selected, nullToken: token.value }); await this.refresh(); });
    } catch (error) { this.reportError(error); }
  }
  column(action: 'add' | 'rename' | 'delete', column?: Column): void {
    const table = this.context().table;
    if (!table || table.kind !== 'table') { this.reportError(new Error(this.t('Choose a table to edit its columns.'))); return; }
    if (action !== 'add' && !column) { this.reportError(new Error(this.t('Choose a column.'))); return; }
    const titles = { add: 'Add column…', rename: 'Rename column…', delete: 'Delete column…' };
    const dialog = new Dialog(this.t(titles[action]), this.locale);
    const name = this.input(action === 'rename' ? 'New name' : 'Column name', action === 'rename' ? column!.name : '');
    const type = this.select('Type', ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'].map(value => ({ value, label: value })));
    const quote = (value: string): string => { if (!value.trim()) throw new Error(this.t('Enter a name.')); return quoteIdentifier(value); };
    const statement = () => action === 'add' ? `ALTER TABLE ${quote(table.name)} ADD COLUMN ${quote(name.value)} ${type.value}` : action === 'rename' ? `ALTER TABLE ${quote(table.name)} RENAME COLUMN ${quote(column!.name)} TO ${quote(name.value)}` : `ALTER TABLE ${quote(table.name)} DROP COLUMN ${quote(column!.name)}`;
    const preview = element('pre', 'sql-preview'); preview.setAttribute('aria-label', this.t('SQL preview'));
    const update = () => { try { preview.textContent = `${statement()};`; } catch { preview.textContent = ''; } };
    name.oninput = update; type.onchange = update;
    dialog.body.append(element('p', 'muted', this.t('Structure changes apply immediately. Save or discard pending edits first.')));
    if (action === 'delete') {
      dialog.body.append(element('strong', '', column!.name), element('p', '', this.t('Deleting a column permanently removes its values. SQLite rewrites the table data. Indexes, keys, and views can prevent this change.')));
    } else { if (action === 'rename') dialog.body.append(element('p', 'muted', column!.name)); dialog.body.append(this.field(action === 'rename' ? 'New name' : 'Column name', name)); if (action === 'add') dialog.body.append(this.field('Type', type)); }
    dialog.body.append(preview); update();
    dialog.show(this.t('Execute'), async () => { await this.host.request({ type: 'sqlWrite', sql: statement() }); await this.refresh(true); });
    if (action !== 'delete') { name.focus(); name.select(); }
  }
  schema(initial: 'table' | 'column'): void {
    const table = this.context().table; const dialog = new Dialog(this.t('Edit database structure'), this.locale);
    const operation = this.select('Operation', [{ value: 'table', label: 'Create table' }, ...(table?.kind === 'table' ? [{ value: 'column', label: 'Add column' }, { value: 'rename', label: 'Rename column' }, { value: 'dropColumn', label: 'Delete column' }, { value: 'index', label: 'Create index' }, { value: 'dropIndex', label: 'Drop index' }] : []), { value: 'view', label: 'Create view' }, { value: 'dropView', label: 'Drop view' }]); operation.value = initial === 'column' && table?.kind !== 'table' ? 'view' : initial;
    const fields = element('div', 'tool-fields'); const preview = element('pre', 'sql-preview'); let statement = () => '';
    const quote = (value: string): string => { if (!value.trim()) throw new Error(this.t('Enter a name.')); return `"${value.replaceAll('"', '""')}"`; };
    const render = () => {
      fields.replaceChildren(); const name = this.input('Name'); const definition = element('textarea'); definition.rows = 5; definition.onkeydown = event => { if (event.key === 'Enter') event.stopPropagation(); }; definition.setAttribute('aria-label', this.t('SQL definition')); const column = this.select('Column', (table?.columns ?? []).map(column => ({ value: column.name, label: column.name }))); const type = this.select('Type', ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'].map(value => ({ value, label: value })));
      const unique = element('input'); unique.type = 'checkbox'; const uniqueLabel = element('label', 'checkbox-field'); uniqueLabel.append(unique, document.createTextNode(this.t('Unique index')));
      switch (operation.value) {
        case 'table': name.value = 'new_table'; definition.value = 'id INTEGER PRIMARY KEY,\nname TEXT NOT NULL'; fields.append(this.field('Table name', name), this.field('Column definitions', definition)); statement = () => `CREATE TABLE ${quote(name.value)} (${definition.value})`; break;
        case 'column': name.value = 'new_column'; fields.append(this.field('Column name', name), this.field('Type', type)); statement = () => `ALTER TABLE ${quote(table!.name)} ADD COLUMN ${quote(name.value)} ${type.value}`; break;
        case 'rename': fields.append(this.field('Column', column), this.field('New name', name)); statement = () => `ALTER TABLE ${quote(table!.name)} RENAME COLUMN ${quote(column.value)} TO ${quote(name.value)}`; break;
        case 'dropColumn': fields.append(this.field('Column', column), element('p', '', this.t('Deleting a column permanently removes its values. SQLite rewrites the table data. Indexes, keys, and views can prevent this change.'))); statement = () => `ALTER TABLE ${quote(table!.name)} DROP COLUMN ${quote(column.value)}`; break;
        case 'index': name.value = `${table!.name}_index`; fields.append(this.field('Index name', name), this.field('Column', column), uniqueLabel); statement = () => `CREATE ${unique.checked ? 'UNIQUE ' : ''}INDEX ${quote(name.value)} ON ${quote(table!.name)} (${quote(column.value)})`; break;
        case 'dropIndex': { const indexes = (table!.indexes as { name: string; origin: string }[]).filter(index => index.origin === 'c'); const selected = this.select('Index', indexes.map(index => ({ value: index.name, label: index.name }))); fields.append(this.field('Index', selected)); statement = () => `DROP INDEX ${quote(selected.value)}`; break; }
        case 'view': name.value = 'new_view'; definition.value = table ? `SELECT * FROM ${quote(table.name)}` : 'SELECT 1 AS value'; fields.append(this.field('View name', name), this.field('SELECT statement', definition)); statement = () => `CREATE VIEW ${quote(name.value)} AS ${definition.value}`; break;
        case 'dropView': fields.append(this.field('View name', name)); if (table?.kind === 'view') name.value = table.name; statement = () => `DROP VIEW ${quote(name.value)}`; break;
      }
      const update = () => { try { preview.textContent = `${statement()};`; } catch { preview.textContent = ''; } }; fields.oninput = update; fields.onchange = update; update();
    };
    operation.onchange = render; render(); const confirm = element('input'); confirm.type = 'checkbox'; const agreement = element('label', 'checkbox-field'); agreement.append(confirm, document.createTextNode(this.t('Apply immediately. This change cannot be undone here.')));
    dialog.body.append(element('p', 'muted', this.t('Structure changes commit immediately. Save or discard pending table edits first. Create a database snapshot before changing structure.')), this.field('Operation', operation), fields, preview, agreement);
    dialog.show(this.t('Apply structure change'), async () => { if (!confirm.checked) throw new Error(this.t('Confirm the immediate structure change.')); await this.host.request({ type: 'sqlWrite', sql: statement() }); await this.refresh(true); });
  }
  maintenance(): void {
    const dialog = new Dialog(this.t('Database maintenance…'), this.locale); const output = element('pre', 'maintenance-report'); output.setAttribute('role', 'status'); const run = async (operation: 'check' | 'vacuum') => { const report = (await this.host.request({ type: 'maintenance', operation })).report; if (!report) return; output.textContent = [this.t('Database size: {bytes} bytes', { bytes: report.bytes.toLocaleString() }), this.t('Pages: {count}', { count: report.pageCount }), this.t('Free pages: {count}', { count: report.freePages }), '', this.t('Integrity check'), ...report.integrity, '', this.t('Foreign key violations: {count}', { count: report.foreignKeys.length }), ...report.foreignKeys.map(row => JSON.stringify(row))].join('\n'); };
    const check = button(this.t('Run integrity and foreign key checks'), () => { check.disabled = true; void run('check').catch(error => dialog.showError(String(error))).finally(() => { check.disabled = false; }); });
    const vacuum = button(this.t('VACUUM database…'), () => { const confirm = new Dialog(this.t('VACUUM database?'), this.locale); confirm.body.append(element('p', '', this.t('VACUUM rebuilds the database to reclaim free space. Save or discard pending edits first. Other connections may block this operation.'))); confirm.show(this.t('Run VACUUM'), async () => { await run('vacuum'); await this.refresh(true); }); });
    dialog.body.append(check, vacuum, output); dialog.show(this.t('Close'), () => {});
  }
}

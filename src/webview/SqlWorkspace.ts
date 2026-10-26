/*
Purpose: Provide a SQL editor, saved queries, cancellable execution and typed result browsing.
*/
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { sql, SQLite } from '@codemirror/lang-sql';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { SqlResult, Status, Table } from '../protocol';
import { SqlTextSearch } from './SqlTextSearch';
import { renderCellText } from './CellText';
import { HostClient } from './HostClient';
import { Locale } from './Locale';
import { Dialog, button, element } from './Dialog';
export type SqlPreferences = { draft?: string; history?: string[]; saved?: { name: string; sql: string }[] };
export class SqlWorkspace {
  readonly root = element('section', 'sql-workspace');
  private readonly editor: EditorView;
  private readonly language = new Compartment();
  private readonly results = element('div', 'sql-results');
  private readonly message = element('p', 'query-status');
  private readonly historySelect = element('select');
  private readonly savedSelect = element('select');
  private readonly limit = element('select');
  private readonly run: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly write: HTMLInputElement;
  private running = false;
  private result?: SqlResult;
  private resultSql = '';
  private resultLimit = 1000;
  constructor(private readonly host: HostClient, private readonly locale: Locale, tables: () => Table[], private readonly status: () => Status, private readonly refresh: () => Promise<void>, private readonly preferences: SqlPreferences = {}, private readonly persist: () => void = () => {}, private readonly historyChanged: () => void = () => {}) {
    const t = (text: string) => this.locale.t(text);
    const actions = element('div', 'query-actions');
    this.run = button(t('Run query'), () => void this.execute(), 'primary'); this.run.title = t('Ctrl/Cmd+Enter: run selection or current statement');
    this.stop = button(t('Cancel query'), () => void this.cancel()); this.stop.disabled = true;
    this.exportButton = button(t('Export displayed results as CSV…'), () => void this.exportResults()); this.exportButton.disabled = true;
    this.limit.setAttribute('aria-label', t('Result limit')); for (const count of [100, 1000, 10000]) { const option = element('option', '', `${count.toLocaleString()} ${t('rows')}`); option.value = String(count); this.limit.append(option); } this.limit.value = '1000';
    const mode = element('label', 'checkbox-field'); this.write = element('input'); this.write.type = 'checkbox'; mode.append(this.write, document.createTextNode(t('Execute writes immediately')));
    actions.append(this.run, this.stop, this.exportButton, this.limit, mode);
    const library = element('div', 'query-library'); this.historySelect.setAttribute('aria-label', t('Query history')); this.savedSelect.setAttribute('aria-label', t('Saved queries'));
    this.historySelect.onchange = () => { if (this.historySelect.value) this.setSql(this.historySelect.value); };
    this.savedSelect.onchange = () => { const entry = this.preferences.saved?.[Number(this.savedSelect.value)]; if (entry) this.setSql(entry.sql); };
    library.append(this.historySelect, this.savedSelect, button(t('Save query…'), () => this.saveQuery()), button(t('Delete saved query'), () => { const index = Number(this.savedSelect.value); if (this.savedSelect.value !== '' && this.preferences.saved?.[index]) { this.preferences.saved.splice(index, 1); this.persist(); this.renderLibrary(); } })); this.renderLibrary();
    const mount = element('div', 'sql-editor'); const schema: Record<string, string[]> = Object.create(null); for (const table of tables()) schema[table.name] = table.columns.map(column => column.name);
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
    this.editor = new EditorView({ parent: mount, state: EditorState.create({ doc: this.preferences.draft ?? (tables()[0] ? `SELECT * FROM "${tables()[0]!.name.replaceAll('"', '""')}";` : 'SELECT sqlite_version();'), extensions: [lineNumbers(), highlightActiveLine(), history(), this.language.of(sql({ dialect: SQLite, schema, upperCaseKeywords: true })), autocompletion(), syntaxHighlighting(HighlightStyle.define([{ tag: tags.keyword, color: 'var(--sql-keyword)' }, { tag: [tags.string, tags.special(tags.string)], color: 'var(--sql-string)' }, { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-number)' }, { tag: tags.comment, color: 'var(--muted)' }, { tag: tags.operator, color: 'var(--fg)' }])), keymap.of([{ key: 'Mod-Enter', run: () => { void this.execute(); return true; } }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]), EditorView.cspNonce.of(nonce), EditorView.contentAttributes.of({ 'aria-label': t('SQL editor') }), EditorView.domEventHandlers({ beforeinput: (event, view) => { const input = event as InputEvent; if (input.inputType !== 'insertText' || input.isComposing || input.data === null) return false; view.dispatch({ ...view.state.replaceSelection(input.data), scrollIntoView: true, userEvent: 'input.type' }); return true; } }), EditorView.updateListener.of(update => { if (update.docChanged) { this.preferences.draft = update.state.doc.toString(); this.persist(); } this.historyChanged(); })] }) });
    this.message.setAttribute('role', 'status'); this.message.textContent = t('Queries read committed data. Save table edits to include them.');
    // Native selection remains in charge; copy its raw DOM text before nowrap normalizes line breaks.
    this.results.addEventListener('copy', event => {
      const selection = window.getSelection(); if (!selection || selection.isCollapsed || !event.clipboardData || !selection.rangeCount) return;
      const range = selection.getRangeAt(0); if (!this.results.contains(range.startContainer) || !this.results.contains(range.endContainer)) return;
      const fragment = range.cloneContents(); const rows = [...fragment.querySelectorAll('tr')]; const cells = [...fragment.querySelectorAll('td, th')];
      const text = rows.length ? rows.map(row => [...row.querySelectorAll('td, th')].map(cell => cell.textContent ?? '').join('\t')).join('\n') : cells.length ? cells.map(cell => cell.textContent ?? '').join('\t') : fragment.textContent ?? '';
      event.clipboardData.setData('text/plain', text); event.preventDefault();
    });
    this.results.append(element('p', 'empty-state', t('Run a query to view its results.'))); this.root.append(actions, library, mount, this.message, this.results);
  }
  get canUndo(): boolean { return undoDepth(this.editor.state) > 0; }
  get canRedo(): boolean { return redoDepth(this.editor.state) > 0; }
  undo(): void { undo(this.editor); }
  redo(): void { redo(this.editor); }
  searchTarget(): SqlTextSearch { return new SqlTextSearch(this.editor); }
  focus(): void { this.editor.focus(); }
  updateTables(tables: Table[]): void { const schema: Record<string, string[]> = Object.create(null); for (const table of tables) schema[table.name] = table.columns.map(column => column.name); this.editor.dispatch({ effects: this.language.reconfigure(sql({ dialect: SQLite, schema, upperCaseKeywords: true })) }); }
  dispose(): void { this.editor.destroy(); }
  private setSql(sql: string): void { this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: sql } }); this.editor.focus(); }
  private renderLibrary(): void {
    const fill = (select: HTMLSelectElement, label: string, entries: { value: string; text: string }[]) => { select.replaceChildren(); const placeholder = element('option', '', this.locale.t(label)); placeholder.value = ''; select.append(placeholder); for (const entry of entries) { const option = element('option', '', entry.text); option.value = entry.value; select.append(option); } };
    fill(this.historySelect, 'Query history', (this.preferences.history ?? []).map(sql => ({ value: sql, text: sql.slice(0, 100) })));
    fill(this.savedSelect, 'Saved queries', (this.preferences.saved ?? []).map((entry, index) => ({ value: String(index), text: entry.name })));
  }
  /** Semicolons inside quoted identifiers, strings and comments do not end a statement. */
  private statement(): string {
    const state = this.editor.state; const selection = state.selection.main; if (!selection.empty) return state.sliceDoc(selection.from, selection.to).trim();
    const text = state.doc.toString(); let start = 0; let previous = ''; let quote = ''; let comment = ''; let index = 0;
    while (index < text.length) { const char = text[index]!; const next = text[index + 1];
      if (comment === '--') { if (char === '\n') comment = ''; }
      else if (comment === '/*') { if (char === '*' && next === '/') { comment = ''; index++; } }
      else if (quote) { if (char === quote) { if (next === quote && quote !== ']') index++; else quote = ''; } }
      else if (char === '-' && next === '-') { comment = '--'; index++; }
      else if (char === '/' && next === '*') { comment = '/*'; index++; }
      else if (["'", '"', '`', '['].includes(char)) quote = char === '[' ? ']' : char;
      else if (char === ';') { if (text.slice(start, index).trim()) previous = text.slice(start, index + 1).trim(); if (selection.head <= index + 1 && text.slice(start, index).trim()) return text.slice(start, index + 1).trim(); start = index + 1; }
      index++;
    }
    return text.slice(start).trim() || previous;
  }
  private async execute(): Promise<void> {
    if (this.running) return; const sql = this.statement(); if (!sql) { this.message.textContent = this.locale.t('Enter a SQL statement.'); return; }
    if (this.write.checked) { const dialog = new Dialog(this.locale.t('Execute SQL write?'), this.locale); dialog.body.append(element('p', '', this.locale.t('This statement commits immediately and cannot be undone in the table editor. Save or discard pending table edits first.')), element('pre', 'sql-preview', sql)); dialog.show(this.locale.t('Execute'), () => this.runSql(sql, true)); return; }
    await this.runSql(sql, false);
  }
  private async runSql(sql: string, write: boolean): Promise<void> {
    const limit = Number(this.limit.value); this.running = true; this.exportButton.disabled = true; this.result = undefined; this.results.replaceChildren(); this.run.disabled = true; this.stop.disabled = write; this.message.classList.remove('query-error'); this.message.textContent = this.locale.t('Running query…');
    try { const response = await this.host.request(write ? { type: 'sqlWrite', sql } : { type: 'sqlQuery', sql, limit });
      this.preferences.history = [sql, ...(this.preferences.history ?? []).filter(previous => previous !== sql)].slice(0, 50); this.persist(); this.renderLibrary();
      if (write) { this.result = undefined; this.exportButton.disabled = true; this.results.replaceChildren(); this.message.textContent = this.locale.t('Committed. Affected rows: {count}', { count: response.changes ?? 0 }); await this.refresh(); }
      else { this.result = response.sql; this.resultSql = sql; this.resultLimit = limit; this.renderResults(); }
    } catch (error) { this.message.classList.add('query-error'); this.message.textContent = this.locale.t(error instanceof Error ? error.message : String(error)); }
    finally { this.running = false; this.run.disabled = false; this.stop.disabled = true; }
  }
  private renderResults(): void {
    this.results.replaceChildren(); const result = this.result; if (!result) return;
    this.message.textContent = this.locale.t('{count} rows · {time} ms', { count: result.rows.length, time: Math.round(result.elapsedMs) }) + (result.truncated ? ` · ${this.locale.t('Result limit reached. Increase the limit or narrow the query.')}` : '') + (this.status().pending ? ` · ${this.locale.t('Pending table edits are not included.')}` : '');
    this.exportButton.disabled = false; const table = element('table', 'query-result-table'); const head = element('thead'); const row = element('tr'); for (const column of result.columns) row.append(element('th', '', column)); head.append(row); table.append(head); const body = element('tbody');
    for (const values of result.rows) { const row = element('tr'); for (const value of values) { const cell = element('td', value.type === 'null' || value.type === 'blob' ? 'special-value' : ''); renderCellText(cell, value.type === 'null' ? 'NULL' : value.type === 'blob' ? `BLOB · ${value.value.length / 2} B` : value.value); cell.title = value.value; row.append(cell); } body.append(row); } table.append(body); this.results.append(table); if (!result.rows.length) this.results.append(element('p', 'empty-state', this.locale.t('No records')));
  }
  private async cancel(): Promise<void> { try { await this.host.request({ type: 'sqlCancel' }); } catch (error) { this.message.textContent = String(error); } }
  private async exportResults(): Promise<void> { try { await this.host.request({ type: 'sqlExport', sql: this.resultSql, limit: this.resultLimit }); } catch (error) { this.message.textContent = String(error); } }
  private saveQuery(): void { const dialog = new Dialog(this.locale.t('Save query…'), this.locale); const name = element('input'); name.setAttribute('aria-label', this.locale.t('Query name')); dialog.body.append(name); dialog.show(this.locale.t('Save'), () => { if (!name.value.trim()) throw new Error(this.locale.t('Enter a name.')); this.preferences.saved ??= []; this.preferences.saved.push({ name: name.value.trim(), sql: this.editor.state.doc.toString() }); this.persist(); this.renderLibrary(); }); }
}

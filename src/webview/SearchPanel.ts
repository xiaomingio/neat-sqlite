/*
Purpose: Own shared Find and Replace controls, exact search scopes and identity-based result navigation.
*/
import type { SearchHit, SearchResult, SearchScope, Table } from '../protocol';
import { SqlTextSearch, type SqlSearchOptions } from './SqlTextSearch';
import { renderCellText } from './CellText';
import { HostClient } from './HostClient';
import { Locale } from './Locale';
import { button, element } from './Dialog';
export type SearchPreferences = { scope?: 'table' | 'selection'; matchCase?: boolean; regex?: boolean; search?: string; replacement?: string };
export type SearchContext = { table?: Table; selection?: Extract<SearchScope, { type: 'selection' }>; selectionError?: string; sql?: SqlTextSearch };
export class SearchPanel {
  readonly root = element('dialog', 'editor-dialog search-panel');
  private opener?: HTMLElement;
  private mode: 'find' | 'replace' = 'find';
  private context?: SearchContext;
  private readonly heading = element('div', 'search-heading');
  private readonly term = element('input');
  private readonly replacement = element('input');
  private readonly scope = element('select');
  private readonly columns = element('select');
  private readonly matchCase = element('input');
  private readonly regex = element('input');
  private readonly replacementField: HTMLLabelElement;
  private readonly columnField: HTMLLabelElement;
  private readonly note = element('p', 'search-note');
  private readonly status = element('p', 'search-status');
  private readonly error = element('p', 'search-error');
  private readonly results = element('div', 'search-results');
  private readonly searchButton: HTMLButtonElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly clear: HTMLButtonElement;
  private result?: SearchResult;
  private validated = '';
  private selected = -1;
  private busy = false;
  constructor(private readonly host: HostClient, private readonly locale: Locale, private readonly preferences: SearchPreferences, private readonly persist: () => void, private readonly locate: (token: string, hit: SearchHit) => Promise<void>, private readonly refresh: () => Promise<void>, private readonly restore: () => Promise<void>, private readonly closed: () => void) {
    this.root.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.root.addEventListener('close', () => { const opener = this.opener; if (opener?.isConnected) opener.focus({ preventScroll: true }); else this.closed(); });
    this.root.setAttribute('aria-label', this.t('Table search')); this.status.setAttribute('role', 'status'); this.error.setAttribute('role', 'alert'); this.results.setAttribute('role', 'listbox'); this.results.setAttribute('aria-label', this.t('Search matches'));
    this.term.type = 'search'; this.term.value = this.preferences.search ?? ''; this.term.setAttribute('aria-label', this.t('Find text'));
    this.replacement.value = this.preferences.replacement ?? ''; this.replacement.setAttribute('aria-label', this.t('Replace with'));
    this.scope.setAttribute('aria-label', this.t('Search scope')); for (const [value, label] of [['table', 'Whole table'], ['selection', 'Selection']] as const) { const option = element('option', '', this.t(label)); option.value = value; this.scope.append(option); }
    this.columns.setAttribute('aria-label', this.t('Search column')); this.matchCase.type = 'checkbox'; this.matchCase.checked = this.preferences.matchCase ?? true;
    this.regex.type = 'checkbox'; this.regex.checked = this.preferences.regex ?? false; const regex = element('label', 'checkbox-field'); regex.append(this.regex, document.createTextNode(this.t('Use regular expression')));
    const fields = element('div', 'search-fields'); const match = element('label', 'checkbox-field'); match.append(this.matchCase, document.createTextNode(this.t('Match case'))); this.replacementField = this.field('Replace with', this.replacement);
    this.columnField = this.field('Search column', this.columns); fields.append(this.field('Find text', this.term), this.replacementField, this.columnField, match, regex);
    const actions = element('div', 'search-actions'); this.searchButton = button(this.t('Find all'), () => void this.search()); this.applyButton = button(this.t('Replace all matches'), () => void this.apply(), 'primary');
    this.previous = button(this.t('Previous match'), () => void this.move(-1)); this.next = button(this.t('Next match'), () => void this.move(1)); this.clear = button(this.t('Clear results'), () => this.invalidate());
    actions.append(this.searchButton, this.applyButton, this.previous, this.next, this.clear, button(this.t('Return to original view'), () => { void (this.context?.sql ? this.context.sql.restore() : this.restore()).catch(error => this.showError(error)); }));
    this.root.append(this.heading, fields, this.note, actions, this.status, this.error, this.results);
    this.term.oninput = () => { this.preferences.search = this.term.value; this.persist(); this.invalidate(); }; this.replacement.oninput = () => { this.preferences.replacement = this.replacement.value; this.persist(); this.invalidate(); };
    this.scope.onchange = () => { this.preferences.scope = this.scope.value as SearchPreferences['scope']; this.persist(); this.invalidate(); this.renderNote(); };
    this.regex.onchange = () => { this.preferences.regex = this.regex.checked; this.persist(); this.invalidate(); }; this.columns.onchange = () => this.invalidate(); this.matchCase.onchange = () => { this.preferences.matchCase = this.matchCase.checked; this.persist(); this.invalidate(); };
    this.root.onkeydown = event => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); this.setMode(event.key.toLowerCase() === 'f' ? 'find' : 'replace'); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      if (event.key === 'Enter' && event.target === this.term && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void this.search(); }
    };
    this.invalidate();
  }
  private t(text: string, params?: Record<string, string | number>): string { return this.locale.t(text, params); }
  private field(label: string, input: HTMLElement): HTMLLabelElement { const root = element('label', 'tool-field', this.t(label)); root.append(input); return root; }
  private get selectionAvailable(): boolean { return !!(this.context?.sql ? this.context.sql.selectionSize : this.context?.selection?.cells.length); }
  get open(): boolean { return this.root.open; }
  show(mode: 'find' | 'replace', context: SearchContext): void {
    this.context = context; const option = this.scope.querySelector<HTMLOptionElement>('option[value="selection"]')!; option.disabled = !this.selectionAvailable; option.textContent = this.t(context.sql ? 'Captured text selection' : 'Selection'); this.root.setAttribute('aria-label', this.t(context.sql ? 'SQL text search' : 'Table search')); this.scope.querySelector<HTMLOptionElement>('option[value="table"]')!.textContent = this.t(context.sql ? 'Whole query' : 'Whole table'); this.columnField.hidden = !!context.sql;
    this.scope.value = this.preferences.scope === 'selection' ? 'selection' : 'table';
    this.columns.replaceChildren(); const all = element('option', '', this.t('All columns')); all.value = ''; this.columns.append(all); for (const column of context.table?.columns ?? []) { const option = element('option', '', column.name); option.value = column.name; this.columns.append(option); }
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!this.root.isConnected) document.body.append(this.root); this.root.showModal(); this.invalidate(); this.setMode(mode); this.renderNote();
  }
  switchMode(mode: 'find' | 'replace'): void { this.setMode(mode); }
  close(): void { if (this.root.open) this.root.close(); }
  private setMode(mode: 'find' | 'replace'): void {
    this.mode = mode; this.replacementField.hidden = mode !== 'replace'; this.applyButton.hidden = mode !== 'replace'; this.searchButton.textContent = this.t(mode === 'find' ? 'Find all' : 'Preview replacement');
    this.heading.replaceChildren(); const replaceMode = element('input'); replaceMode.type = 'checkbox'; replaceMode.checked = mode === 'replace'; replaceMode.setAttribute('aria-label', this.t('Replace')); replaceMode.onchange = () => this.setMode(replaceMode.checked ? 'replace' : 'find'); const toggle = element('label', 'checkbox-field'); toggle.append(replaceMode, document.createTextNode(this.t('Replace')));
    const close = button(this.t('Close search'), () => this.close()); this.heading.append(element('strong', '', this.t('Find')), toggle, element('strong', 'search-table', this.context?.sql ? this.t('SQL text') : this.context?.table?.name ?? ''), this.field('Search scope', this.scope), close); this.invalidate(); this.renderNote(); this.term.focus();
  }
  private renderNote(): void {
    const scoped = this.scope.value === 'selection';
    if (this.context?.sql) { this.note.textContent = scoped ? this.selectionAvailable ? this.t('Search the captured SQL text selection.') : this.t('Select SQL text, or choose Whole query explicitly.') : this.t('Search all SQL text in the query editor. Query results are read-only.'); if (this.mode === 'replace') this.note.textContent += ` ${this.t('Replace edits SQL text only. It does not execute SQL or change database records.')}`; return; }
    this.note.textContent = scoped && !this.context?.selection ? this.t('Selection is unavailable. Select cells in Data, or choose Whole table explicitly.') : scoped ? this.t('Search the {count} captured cells exactly, including disconnected selections.', { count: this.context?.selection?.cells.length ?? 0 }) : this.t('Search every record in this table, across all pages. Current filters are ignored.');
    if (!this.context?.selection?.cells.length) this.note.textContent += ` ${this.context?.selectionError ?? this.t('Select cells in Data to enable Selection.')}`;
    if (this.mode === 'replace') this.note.textContent += ` ${this.t('Only editable text cells are replaced. Changes stay pending until saved.')}`;
  }
  private options(): SqlSearchOptions { return { scope: this.scope.value as 'table' | 'selection', search: this.term.value, replacement: this.mode === 'replace' ? this.replacement.value : undefined, matchCase: this.matchCase.checked, regex: this.regex.checked }; }
  private request(): { table: string; scope: SearchScope; column?: string; search: string; replacement?: string; matchCase: boolean; regex: boolean } {
    if (!this.context?.table) throw new Error(this.t('Select a table to search.')); if (this.scope.value === 'selection' && !this.context.selection) throw new Error(this.t('Selection is unavailable. Select cells in Data, or choose Whole table explicitly.'));
    return { table: this.context.table!.name, scope: this.scope.value === 'selection' && this.context.selection ? this.context.selection : { type: 'table' }, column: this.columns.value || undefined, search: this.term.value, replacement: this.mode === 'replace' ? this.replacement.value : undefined, matchCase: this.matchCase.checked, regex: this.regex.checked };
  }
  private signature(): string { return JSON.stringify(this.context?.sql ? this.options() : this.request()); }
  private invalidate(): void { this.result = undefined; this.validated = ''; this.selected = -1; this.results.replaceChildren(); this.status.textContent = ''; this.error.textContent = ''; this.searchButton.disabled = this.busy || this.scope.value === 'selection' && !this.selectionAvailable; this.applyButton.disabled = true; this.previous.disabled = this.next.disabled = this.clear.disabled = true; }
  private setBusy(busy: boolean): void { this.busy = busy; this.searchButton.disabled = busy || this.scope.value === 'selection' && !this.selectionAvailable; for (const input of [this.term, this.replacement, this.scope, this.columns, this.matchCase, this.regex]) input.disabled = busy; this.applyButton.disabled = busy || !this.validated || !(this.context?.sql || this.context?.table?.editable); this.previous.disabled = this.next.disabled = busy || !this.result?.samples.length; }
  private showError(error: unknown): void { this.error.textContent = this.t(error instanceof Error ? error.message : String(error)); }
  private async search(): Promise<void> {
    if (this.busy) return; if (this.scope.value === 'selection' && !this.selectionAvailable) { this.showError(new Error(this.t('Selection is unavailable. Select cells in Data, or choose Whole table explicitly.'))); return; } const signature = this.signature(); this.invalidate(); this.setBusy(true); this.status.textContent = this.t('Searching…');
    try { const result = this.context?.sql ? await this.context.sql.search(this.options()) : (await this.host.request({ type: this.mode === 'find' ? 'find' : 'replacePreview', ...this.request() })).search; if (this.signature() !== signature || !this.open) return; if (!result) throw new Error(this.t('The editor received an empty response.')); this.result = result; this.validated = signature; this.renderResults(); }
    catch (error) { this.status.textContent = ''; this.showError(error); }
    finally { this.setBusy(false); }
  }
  private renderResults(): void {
    this.results.replaceChildren(); const result = this.result; if (!result) return; this.status.textContent = this.t(this.context?.sql ? '{count} matches' : '{count} matching cells', { count: result.count }) + (result.count > result.samples.length ? ` · ${this.t('Showing the first {count} matches. Narrow the search for more.', { count: result.samples.length })}` : '');
    for (const [index, hit] of result.samples.entries()) { const item = button('', () => void this.navigate(index), 'search-hit'); item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(this.selected === index)); const title = element('span', 'search-hit-label', `${this.t(this.context?.sql ? 'Line {number}' : 'Row {number}', { number: hit.offset + 1 })} · ${hit.column}`); const before = element('span', 'search-hit-value'); renderCellText(before, hit.before); item.append(title, before); if (this.mode === 'replace' && hit.after !== undefined) { const after = element('span', 'search-hit-after'); renderCellText(after, `→ ${hit.after}`); item.append(after); } this.results.append(item); }
    this.clear.disabled = !result.samples.length;
  }
  private async navigate(index: number): Promise<void> { const hit = this.result?.samples[index]; if (!hit || this.busy) return; this.setBusy(true); try { if (this.context?.sql) await this.context.sql.locate(this.result!.token, hit); else await this.locate(this.result!.token, hit); this.selected = index; this.results.querySelectorAll<HTMLElement>('[role="option"]').forEach((node, item) => node.setAttribute('aria-selected', String(index === item))); this.results.children[index]?.scrollIntoView({ block: 'nearest' }); } catch (error) { this.showError(error); } finally { this.setBusy(false); } }
  private async move(direction: 1 | -1): Promise<void> { const length = this.result?.samples.length ?? 0; if (!length) return; await this.navigate(this.selected < 0 ? (direction === 1 ? 0 : length - 1) : (this.selected + direction + length) % length); }
  private async apply(): Promise<void> {
    if (this.busy) return; if (!this.validated || this.validated !== this.signature()) { this.showError(new Error(this.t('Preview the current replacement before applying it.'))); return; } this.setBusy(true);
    try { const sql = this.context?.sql; const count = sql ? await sql.apply(this.options(), this.result!.token) : (await this.host.request({ type: 'replaceApply', ...this.request(), preview: this.result!.token })).search?.changes ?? 0; if (!sql) await this.refresh(); this.invalidate(); this.status.textContent = this.t(sql ? 'Replaced {count} occurrences in SQL text. SQL was not executed.' : 'Replaced {count} cells. Save to commit, or Undo to revert.', { count }); }
    catch (error) { this.showError(error); }
    finally { this.setBusy(false); }
  }
}

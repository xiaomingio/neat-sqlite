/*
Purpose: Own shared Find and Replace controls, exact search scopes and identity-based result navigation.
*/
import type { SearchHit, SearchResult, SearchScope, Table } from '../protocol';
import { SqlTextSearch, type SqlSearchOptions } from './SqlTextSearch';
import { renderCellText } from './CellText';
import { HostClient } from './HostClient';
import { Locale } from './Locale';
import { button, element } from './Dialog';
import { setIcon } from './Icons';
export type SearchPreferences = { scope?: 'table' | 'selection'; matchCase?: boolean; regex?: boolean; search?: string; replacement?: string };
export type SearchContext = { table?: Table; selection?: Extract<SearchScope, { type: 'selection' }>; selectionError?: string; sql?: SqlTextSearch };
/** Resolves to the on-screen rectangle of the located match, so the panel can move out of its way. */
export type LocateTarget = () => DOMRect | undefined;
export class SearchPanel {
  readonly root = element('dialog', 'editor-dialog search-panel');
  private opener?: HTMLElement;
  private mode: 'find' | 'replace' = 'find';
  private context?: SearchContext;
  private readonly title = element('strong', 'search-title');
  private readonly target = element('span', 'search-target');
  private readonly replaceMode = element('input');
  private readonly term = element('input');
  private readonly replacement = element('input');
  private readonly scope = element('select');
  private readonly columns = element('select');
  private readonly matchCase: HTMLInputElement;
  private readonly regex: HTMLInputElement;
  private readonly replaceRow = element('div', 'search-row');
  private readonly note = element('p', 'search-note');
  private readonly status = element('p', 'search-status');
  private readonly error = element('p', 'search-error');
  private readonly results = element('div', 'search-results');
  private readonly searchButton: HTMLButtonElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly replaceOneButton: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly restoreButton: HTMLButtonElement;
  private result?: SearchResult;
  private validated = '';
  private selected = -1;
  private busy = false;
  constructor(private readonly host: HostClient, private readonly locale: Locale, private readonly preferences: SearchPreferences, private readonly persist: () => void, private readonly locate: (token: string, hit: SearchHit) => Promise<LocateTarget | undefined>, private readonly refresh: () => Promise<void>, private readonly restore: () => Promise<void>, private readonly closed: () => void) {
    // Non-modal, like the VS Code find widget: the grid and SQL editor stay usable while it is open.
    this.root.addEventListener('close', () => { const opener = this.opener; if (this.root.contains(document.activeElement) || document.activeElement === document.body) { if (opener?.isConnected) opener.focus({ preventScroll: true }); else this.closed(); } });
    this.status.setAttribute('role', 'status'); this.error.setAttribute('role', 'alert'); this.results.setAttribute('role', 'listbox'); this.results.setAttribute('aria-label', this.t('Search matches'));
    this.term.type = 'search'; this.term.value = this.preferences.search ?? ''; this.term.placeholder = this.t('Find'); this.term.setAttribute('aria-label', this.t('Find text')); this.term.spellcheck = false;
    this.replacement.value = this.preferences.replacement ?? ''; this.replacement.placeholder = this.t('Replace'); this.replacement.setAttribute('aria-label', this.t('Replace with')); this.replacement.spellcheck = false;
    this.scope.setAttribute('aria-label', this.t('Search scope')); for (const value of ['table', 'selection']) { const option = element('option'); option.value = value; this.scope.append(option); }
    this.columns.setAttribute('aria-label', this.t('Search column'));
    const findBox = element('div', 'search-box'); this.matchCase = this.toggle(findBox, 'Aa', 'Match case', 'Alt+C', this.preferences.matchCase ?? true); this.regex = this.toggle(findBox, '.*', 'Use regular expression', 'Alt+R', this.preferences.regex ?? false); findBox.prepend(this.term);
    const replaceBox = element('div', 'search-box'); replaceBox.append(this.replacement);
    // Heading: mode, target, Replace switch and an icon-only Close.
    this.replaceMode.type = 'checkbox'; this.replaceMode.setAttribute('aria-label', this.t('Replace')); this.replaceMode.onchange = () => this.setMode(this.replaceMode.checked ? 'replace' : 'find');
    const replaceToggle = element('label', 'checkbox-field search-replace-toggle'); replaceToggle.append(this.replaceMode, document.createTextNode(this.t('Replace')));
    const close = button('', () => this.close(), 'icon-button search-close'); setIcon(close, 'close'); close.setAttribute('aria-label', this.t('Close search')); close.title = this.t('Close (Esc)');
    const heading = element('header', 'search-heading'); const filters = element('div', 'search-filters'); filters.append(this.scope, this.columns); heading.append(this.title, this.target, filters, replaceToggle, close);
    this.searchButton = button(this.t('Find all'), () => void this.search());
    this.replaceOneButton = button(this.t('Replace'), () => void this.replaceOne()); this.replaceOneButton.setAttribute('aria-label', this.t('Replace this match')); this.replaceOneButton.title = this.t('Replace this match and go to the next (Ctrl/Cmd+Shift+1)');
    this.applyButton = button(this.t('Replace all'), () => void this.apply(), 'primary'); this.applyButton.setAttribute('aria-label', this.t('Replace all matches'));
    const findRow = element('div', 'search-row'); findRow.append(findBox, this.searchButton);
    this.replaceRow.append(replaceBox, this.replaceOneButton, this.applyButton);
    // Status line: result count, match navigation and view restore.
    this.previous = this.iconButton('chevronUp', 'Previous match', 'Shift+Enter', () => void this.move(-1));
    this.next = this.iconButton('chevronDown', 'Next match', 'Enter', () => void this.move(1)); this.next.title = this.t('Next match, skipping this one (Enter)');
    this.restoreButton = button(this.t('Restore view'), () => { void (this.context?.sql ? this.context.sql.restore() : this.restore()).then(() => { this.restoreButton.hidden = true; }, error => this.showError(error)); }, 'search-restore'); this.restoreButton.title = this.t('Return to the view before searching');
    const footer = element('div', 'search-footer'); footer.append(this.status, this.previous, this.next, this.restoreButton);
    this.root.append(heading, findRow, this.replaceRow, this.note, this.error, footer, this.results);
    this.term.oninput = () => { this.preferences.search = this.term.value; this.persist(); this.invalidate(); }; this.replacement.oninput = () => { this.preferences.replacement = this.replacement.value; this.persist(); this.invalidate(); };
    this.scope.onchange = () => { this.preferences.scope = this.scope.value as SearchPreferences['scope']; this.persist(); this.invalidate(); };
    this.regex.onchange = () => { this.preferences.regex = this.regex.checked; this.persist(); this.invalidate(); }; this.columns.onchange = () => this.invalidate(); this.matchCase.onchange = () => { this.preferences.matchCase = this.matchCase.checked; this.persist(); this.invalidate(); };
    this.results.onkeydown = event => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault(); void this.move(event.key === 'ArrowDown' ? 1 : -1, true); };
    this.root.onkeydown = event => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'f' || key === 'r')) { event.preventDefault(); event.stopPropagation(); this.setMode(key === 'f' ? 'find' : 'replace'); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Digit1') { event.preventDefault(); event.stopPropagation(); void this.replaceOne(); return; }
      if (event.altKey && (event.code === 'KeyC' || event.code === 'KeyR')) { event.preventDefault(); const control = event.code === 'KeyC' ? this.matchCase : this.regex; control.checked = !control.checked; control.dispatchEvent(new Event('change')); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      // Enter searches; once the results match the current fields it steps through them instead of searching again.
      if (event.key === 'Enter' && (event.target === this.term || event.target === this.replacement) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); if (event.target === this.replacement && !event.shiftKey && this.mode === 'replace' && this.validated && this.validated === this.signatureOrEmpty() && this.result?.samples.length) void this.replaceOne(); else if (this.validated && this.validated === this.signatureOrEmpty() && this.result?.samples.length) void this.move(event.shiftKey ? -1 : 1); else void this.search(); }
    };
    this.invalidate();
  }
  private t(text: string, params?: Record<string, string | number>): string { return this.locale.t(text, params); }
  /** A compact option toggle; the checkbox covers the glyph, so it stays the native, labelled control. */
  private toggle(parent: HTMLElement, glyph: string, label: string, shortcut: string, checked: boolean): HTMLInputElement {
    const root = element('label', 'search-toggle'); const input = element('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', this.t(label)); root.title = `${this.t(label)} (${shortcut})`;
    const text = element('span', '', glyph); text.setAttribute('aria-hidden', 'true'); root.append(input, text); parent.append(root); return input;
  }
  private iconButton(icon: 'chevronUp' | 'chevronDown', label: string, shortcut: string, action: () => void): HTMLButtonElement { const control = button('', action, 'icon-button'); setIcon(control, icon); control.setAttribute('aria-label', this.t(label)); control.title = `${this.t(label)} (${shortcut})`; return control; }
  private get selectionAvailable(): boolean { return !!(this.context?.sql ? this.context.sql.selectionSize : this.context?.selection?.cells.length); }
  private get writable(): boolean { return !!(this.context?.sql || this.context?.table?.editable); }
  get open(): boolean { return this.root.open; }
  show(mode: 'find' | 'replace', context: SearchContext): void {
    this.context = context; const sql = !!context.sql; this.applyContext();
    this.scope.value = this.preferences.scope === 'selection' ? 'selection' : 'table'; this.columns.hidden = sql;
    this.columns.replaceChildren(); const all = element('option', '', this.t('All columns')); all.value = ''; this.columns.append(all); for (const column of context.table?.columns ?? []) { const option = element('option', '', column.name); option.value = column.name; this.columns.append(option); }
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; this.restoreButton.hidden = true; this.root.classList.remove('docked-bottom');
    if (!this.root.isConnected) document.body.append(this.root); if (!this.root.open) this.root.show(); this.setMode(mode); this.term.select();
  }
  switchMode(mode: 'find' | 'replace'): void { this.setMode(mode); this.term.select(); }
  /** Selection changes made while search stays open update the Selection scope; Whole-table results stay valid. */
  updateSelection(context: Pick<SearchContext, 'selection' | 'selectionError'>): void {
    if (!this.open || this.context?.sql || !this.context?.table) return;
    this.context = { ...this.context, ...context }; this.applyContext(); if (this.scope.value === 'selection') this.invalidate(); else this.renderNote();
  }
  /** SQL editor edits and selections made while search stays open. */
  sqlChanged(change: 'doc' | 'selection'): void { if (!this.open || !this.context?.sql) return; this.applyContext(); if (change === 'doc' || this.scope.value === 'selection') this.invalidate(); else this.updateControls(); }
  private applyContext(): void {
    const context = this.context; if (!context) return; const sql = !!context.sql;
    this.root.setAttribute('aria-label', this.t(sql ? 'SQL text search' : 'Table search')); this.target.textContent = sql ? this.t('SQL text') : context.table?.name ?? ''; this.target.title = this.target.textContent;
    const [whole, selection] = [...this.scope.options] as [HTMLOptionElement, HTMLOptionElement];
    whole.textContent = this.t(sql ? 'Whole query' : 'Whole table'); selection.disabled = !this.selectionAvailable;
    selection.textContent = sql || !context.selection ? this.t('Selection') : this.t('Selection ({count})', { count: context.selection.cells.length.toLocaleString() });
    this.scope.title = sql ? '' : this.t('Whole table searches every page and ignores current filters.');
  }
  close(): void { if (this.root.open) this.root.close(); }
  private setMode(mode: 'find' | 'replace'): void {
    this.mode = mode; this.replaceMode.checked = mode === 'replace'; this.replaceRow.hidden = mode !== 'replace'; this.root.classList.toggle('replace-mode', mode === 'replace');
    this.title.textContent = this.t(mode === 'find' ? 'Find' : 'Replace'); this.searchButton.textContent = this.t(mode === 'find' ? 'Find all' : 'Preview'); this.searchButton.setAttribute('aria-label', this.t(mode === 'find' ? 'Find all' : 'Preview replacement'));
    this.invalidate(); this.term.focus();
  }
  /** One short line, shown only when the current choices need it. */
  private renderNote(): void {
    const sql = !!this.context?.sql; const unavailable = this.scope.value === 'selection' && !this.selectionAvailable;
    this.note.classList.toggle('warning', unavailable || this.mode === 'replace' && !this.writable);
    if (unavailable) this.note.textContent = sql ? this.t('Select SQL text, or choose Whole query explicitly.') : this.context?.selectionError ?? this.t('Selection is unavailable. Select cells in Data, or choose Whole table explicitly.');
    else if (this.mode !== 'replace') this.note.textContent = '';
    else if (!this.writable) this.note.textContent = this.t(this.context?.table?.reason ?? 'The selected table is read-only.');
    else this.note.textContent = this.t(sql ? 'Edits SQL text only. Nothing is executed.' : 'Replaces editable text cells. Changes stay pending until saved.');
  }
  private options(): SqlSearchOptions { return { scope: this.scope.value as 'table' | 'selection', search: this.term.value, replacement: this.mode === 'replace' ? this.replacement.value : undefined, matchCase: this.matchCase.checked, regex: this.regex.checked }; }
  private request(): { table: string; scope: SearchScope; column?: string; search: string; replacement?: string; matchCase: boolean; regex: boolean } {
    if (!this.context?.table) throw new Error(this.t('Select a table to search.')); if (this.scope.value === 'selection' && !this.context.selection) throw new Error(this.t('Selection is unavailable. Select cells in Data, or choose Whole table explicitly.'));
    return { table: this.context.table!.name, scope: this.scope.value === 'selection' && this.context.selection ? this.context.selection : { type: 'table' }, column: this.columns.value || undefined, search: this.term.value, replacement: this.mode === 'replace' ? this.replacement.value : undefined, matchCase: this.matchCase.checked, regex: this.regex.checked };
  }
  private signature(): string { return JSON.stringify(this.context?.sql ? this.options() : this.request()); }
  private signatureOrEmpty(): string { try { return this.signature(); } catch { return ''; } }
  private invalidate(): void { this.result = undefined; this.validated = ''; this.selected = -1; this.results.replaceChildren(); this.status.textContent = ''; this.error.textContent = ''; this.renderNote(); this.updateControls(); }
  /** Controls stay enabled while busy so keyboard focus never drops out of the dialog; actions check `busy` instead. */
  private updateControls(): void {
    const blocked = this.scope.value === 'selection' && !this.selectionAvailable;
    this.searchButton.disabled = blocked || this.mode === 'replace' && !this.writable; this.applyButton.disabled = !this.validated || !this.writable;
    this.previous.disabled = this.next.disabled = !this.result?.samples.length; this.replaceOneButton.disabled = this.applyButton.disabled; this.root.setAttribute('aria-busy', String(this.busy));
  }
  private setBusy(busy: boolean): void { this.busy = busy; this.updateControls(); }
  private showError(error: unknown): void { this.error.textContent = this.t(error instanceof Error ? error.message : String(error)); }
  private async search(): Promise<void> {
    if (this.busy || this.searchButton.disabled) { if (!this.busy) this.renderNote(); return; } const signature = this.signature(); this.invalidate(); this.setBusy(true); this.status.textContent = this.t('Searching…');
    try { const result = this.context?.sql ? await this.context.sql.search(this.options()) : (await this.host.request({ type: this.mode === 'find' ? 'find' : 'replacePreview', ...this.request() })).search; if (this.signature() !== signature || !this.open) return; if (!result) throw new Error(this.t('The editor received an empty response.')); this.result = result; this.validated = signature; this.renderResults(); }
    catch (error) { if (this.signatureOrEmpty() === signature) { this.status.textContent = ''; this.showError(error); } }
    finally { this.setBusy(false); }
  }
  private countText(count: number): string { const sql = !!this.context?.sql; return count === 1 ? this.t(sql ? '{count} match' : '{count} matching cell', { count }) : this.t(sql ? '{count} matches' : '{count} matching cells', { count: count.toLocaleString() }); }
  private renderStatus(): void {
    const result = this.result; if (!result) return; let text = this.countText(result.count);
    if (this.selected >= 0) text = `${this.selected + 1} / ${result.count.toLocaleString()}`;
    if (result.count > result.samples.length) text += ` · ${this.t('Showing the first {count}', { count: result.samples.length.toLocaleString() })}`;
    this.status.textContent = text;
  }
  private renderResults(): void {
    this.results.replaceChildren(); const result = this.result; if (!result) return; this.renderStatus(); const replacing = this.mode === 'replace';
    const fragment = document.createDocumentFragment();
    for (const [index, hit] of result.samples.entries()) {
      const item = button('', () => void this.navigate(index), 'search-hit'); item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false'); item.tabIndex = -1;
      const label = element('span', 'search-hit-label', this.context?.sql ? this.t('Line {number}', { number: hit.offset + 1 }) : `${this.t('Row {number}', { number: hit.offset + 1 })} · ${hit.column}`); label.title = label.textContent!;
      const before = element('span', 'search-hit-value'); this.renderHighlighted(before, hit.before, hit.match); item.append(label, before);
      if (replacing) { const after = element('span', 'search-hit-after'); renderCellText(after, hit.after); item.append(after); }
      fragment.append(item);
    }
    this.results.append(fragment); (this.results.firstElementChild as HTMLElement | null)?.setAttribute('tabindex', '0');
  }
  private renderHighlighted(target: HTMLElement, text: string, match?: [number, number]): void {
    if (!match || match[1] <= match[0]) { renderCellText(target, text); return; }
    const [start, end] = match; const head = element('span'); const mark = element('mark', 'search-mark'); const tail = element('span');
    renderCellText(head, text.slice(0, start)); renderCellText(mark, text.slice(start, end)); renderCellText(tail, text.slice(end)); target.replaceChildren(head, mark, tail);
  }
  private async navigate(index: number, focusList = false): Promise<void> {
    const hit = this.result?.samples[index]; const token = this.result?.token; if (!hit || !token || this.busy) return; this.setBusy(true);
    try {
      const target = this.context?.sql ? await this.context.sql.locate(token, hit) : await this.locate(token, hit); if (this.result?.token !== token) return;
      this.selected = index; this.restoreButton.hidden = false; this.error.textContent = '';
      for (const [item, node] of [...this.results.children].entries()) { node.setAttribute('aria-selected', String(item === index)); node.setAttribute('tabindex', item === index ? '0' : '-1'); }
      const option = this.results.children[index] as HTMLElement | undefined; option?.scrollIntoView({ block: 'nearest' }); if (focusList) option?.focus(); this.renderStatus();
      if (target) this.dodge(target);
    } catch (error) { this.showError(error); } finally { this.setBusy(false); }
  }
  /** Move the panel to the other edge when it would hide the located match, after the editor finishes scrolling. */
  private dodge(target: LocateTarget): void {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = target(); if (!rect || !this.open) return; const overlaps = (box: DOMRect) => rect.bottom > box.top && rect.top < box.bottom && rect.right > box.left && rect.left < box.right;
      if (!overlaps(this.root.getBoundingClientRect())) return; this.root.classList.toggle('docked-bottom');
      if (overlaps(this.root.getBoundingClientRect())) this.root.classList.toggle('docked-bottom');
    }));
  }
  private async move(direction: 1 | -1, focusList = false): Promise<void> { const length = this.result?.samples.length ?? 0; if (!length) return; await this.navigate(this.selected < 0 ? (direction === 1 ? 0 : length - 1) : (this.selected + direction + length) % length, focusList); }
  /** Replace the current match only (the first if none is current), then preview again and move to the following match. */
  private async replaceOne(): Promise<void> {
    if (this.busy || this.mode !== 'replace') return; if (!this.validated || this.validated !== this.signatureOrEmpty() || !this.result) { this.showError(new Error(this.t('Preview the current replacement before applying it.'))); return; }
    const result = this.result; const index = Math.max(0, this.selected); const hit = result.samples[index]; if (!hit) return; this.setBusy(true); let after: number | undefined; let replaced = false;
    try {
      const sql = this.context?.sql;
      if (sql) after = await sql.replaceOne(this.options(), result.token, hit);
      else { const response = await this.host.request({ type: 'replaceOne', ...this.request(), preview: result.token, target: { key: hit.key, column: hit.column } }); if (response.snapshot && this.context?.selection) this.context = { ...this.context, selection: { ...this.context.selection, snapshot: response.snapshot } }; await this.refresh(); }
      replaced = true;
    } catch (error) { this.showError(error); }
    finally { this.setBusy(false); }
    if (!replaced) return;
    // A fresh preview keeps counts and tokens exact. The replaced cell drops out unless it still matches, so the next match is at the same index, or just after it.
    await this.search(); const samples = this.result?.samples ?? [];
    if (!samples.length) { this.status.textContent = this.t('All matches replaced.'); this.term.focus(); return; }
    let next = index;
    if (after !== undefined) next = samples.findIndex(item => Number(item.key.split(':')[0]) >= after!);
    else { const same = samples.findIndex(item => item.key === hit.key && item.column === hit.column); if (same >= 0) next = same + 1; }
    await this.navigate(next < 0 || next >= samples.length ? 0 : next); this.replacement.focus();
  }
  private async apply(): Promise<void> {
    if (this.busy) return; if (!this.validated || this.validated !== this.signatureOrEmpty()) { this.showError(new Error(this.t('Preview the current replacement before applying it.'))); return; } this.setBusy(true);
    try { const sql = this.context?.sql; const count = sql ? await sql.apply(this.options(), this.result!.token) : (await this.host.request({ type: 'replaceApply', ...this.request(), preview: this.result!.token })).search?.changes ?? 0; if (!sql) await this.refresh(); this.invalidate(); this.status.textContent = this.t(sql ? 'Replaced {count} occurrences in SQL text. SQL was not executed.' : 'Replaced {count} cells. Save to commit, or Undo to revert.', { count }); }
    catch (error) { this.showError(error); }
    finally { this.setBusy(false); this.term.focus(); }
  }
}

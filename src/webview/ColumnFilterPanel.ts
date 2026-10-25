/*
Purpose: Build typed per-column filters and preview their shared SQL compilation before applying.
*/
import type { ColumnFilter, DistinctValue, Query, Table, Value } from '../protocol';
import { compileFilters } from '../ColumnFilter';
import { button, element } from './Dialog';
import type { HostClient } from './HostClient';
import type { Locale } from './Locale';
type Mode = ColumnFilter['mode'];
export class ColumnFilterPanel {
  readonly root = element('div', 'column-filter-panel');
  private readonly mode = element('select');
  private readonly controls = element('div', 'filter-controls');
  private readonly preview = element('pre', 'sql-preview');
  private readonly error = element('p', 'filter-error');
  private readonly note = element('p', 'filter-note muted');
  private readonly drafts = new Map<Mode, ColumnFilter>();
  private readonly apply: HTMLButtonElement;
  private values?: DistinctValue[];
  private valueFailure = '';
  private loadingValues = false;
  private generation = 0;
  constructor(private readonly table: Table, private readonly column: string, private readonly query: Query, private readonly host: HostClient, private readonly locale: Locale, private readonly change: (filter?: ColumnFilter) => Promise<void>, close: () => void) {
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-label', `${this.t('Column filter')} · ${column}`);
    this.error.setAttribute('role', 'alert'); const active = query.filters?.find(filter => filter.column === column); if (active) this.drafts.set(active.mode, structuredClone(active));
    this.mode.setAttribute('aria-label', this.t('Filter type'));
    for (const [value, text] of [['text', 'Text'], ['regex', 'Regular expression'], ['values', 'Values'], ['number', 'Number'], ['empty', 'Empty'], ['notEmpty', 'Not empty'], ['custom', 'Custom']]) { const option = element('option', '', this.t(text!)); option.value = value!; this.mode.append(option); }
    this.mode.value = active?.mode ?? 'text'; this.mode.onchange = () => { this.error.textContent = ''; this.draw(); };
    const heading = element('header', 'filter-heading'); heading.append(element('strong', '', `${this.t('Column filter')} · ${column}`), button('×', close, 'icon-button'));
    (heading.lastElementChild as HTMLButtonElement).setAttribute('aria-label', this.t('Close'));
    const typeLabel = element('label', 'filter-field', this.t('Filter')); typeLabel.append(this.mode);
    const previewHeading = element('strong', '', this.t('Generated SQL')); this.preview.setAttribute('aria-label', this.t('Generated SQL'));
    const actions = element('footer', 'filter-actions');
    const reset = button(this.t('Reset'), () => this.submit(undefined, close));
    this.apply = button(this.t('Apply'), () => this.submit(this.draft, close), 'primary'); actions.append(reset, this.apply);
    this.root.append(heading, typeLabel, this.controls, previewHeading, this.preview, this.note, this.error, actions);
    this.draw();
    this.root.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } else if (event.key === 'Enter' && !event.shiftKey && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); this.apply.click(); } };
  }
  private t(text: string): string { return this.locale.t(text); }
  private get draft(): ColumnFilter {
    const mode = this.mode.value as Mode; let draft = this.drafts.get(mode); if (draft) return draft;
    switch (mode) {
      case 'text': case 'regex': draft = { column: this.column, mode, text: '' }; break;
      case 'values': draft = { column: this.column, mode, values: [] }; break;
      case 'number': draft = { column: this.column, mode, operator: 'eq', value: '' }; break;
      case 'custom': draft = { column: this.column, mode, sql: '' }; break;
      default: draft = { column: this.column, mode }; break;
    }
    this.drafts.set(mode, draft!); return draft!;
  }
  private draw(): void {
    const draft = this.draft; this.controls.replaceChildren(); this.note.textContent = ''; this.apply.disabled = false;
    if (draft.mode === 'text' || draft.mode === 'regex') {
      const input = element('input'); input.value = draft.text; input.placeholder = this.t(draft.mode === 'regex' ? 'Pattern…' : 'Contains…'); input.setAttribute('aria-label', this.t(draft.mode === 'regex' ? 'Filter column by regular expression' : 'Filter column by text'));
      input.oninput = () => { draft.text = input.value; this.updatePreview(); }; this.controls.append(input);
    } else if (draft.mode === 'number') {
      const operator = element('select'); operator.setAttribute('aria-label', this.t('Number comparison'));
      for (const [value, label] of [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'Between']]) { const option = element('option', '', this.t(label!)); option.value = value!; operator.append(option); } operator.value = draft.operator;
      const minimum = element('input'); minimum.inputMode = 'decimal'; minimum.value = draft.value; minimum.setAttribute('aria-label', this.t('Filter number')); minimum.placeholder = this.t('Value');
      const maximum = element('input'); maximum.inputMode = 'decimal'; maximum.value = draft.max ?? ''; maximum.setAttribute('aria-label', this.t('Filter maximum')); maximum.placeholder = this.t('Maximum'); maximum.hidden = draft.operator !== 'between';
      operator.onchange = () => { draft.operator = operator.value as typeof draft.operator; maximum.hidden = draft.operator !== 'between'; this.updatePreview(); };
      minimum.oninput = () => { draft.value = minimum.value; this.updatePreview(); }; maximum.oninput = () => { draft.max = maximum.value; this.updatePreview(); }; this.controls.append(operator, minimum, maximum, element('p', 'muted', this.t('Matches numeric SQLite values (INTEGER and REAL).')));
    } else if (draft.mode === 'values') this.drawValues(draft);
    else if (draft.mode === 'custom') {
      const input = element('textarea'); input.rows = 4; input.value = draft.sql; input.spellcheck = false; input.placeholder = `${this.quote(this.column)} IS NOT NULL`; input.setAttribute('aria-label', this.t('Custom SQL predicate'));
      const label = element('label', 'value-field', this.t('WHERE condition')); label.append(input);
      input.oninput = () => { draft.sql = input.value; this.error.textContent = ''; this.updatePreview(); }; this.controls.append(element('p', 'muted', this.t('Enter only the condition after WHERE. All column conditions are combined with AND.')), label);
    } else this.controls.append(element('p', 'muted', this.t(draft.mode === 'empty' ? 'Matches NULL and whitespace-only text.' : 'Excludes NULL and whitespace-only text.')));
    this.updatePreview();
  }
  private drawValues(draft: Extract<ColumnFilter, { mode: 'values' }>): void {
    const search = element('input'); search.type = 'search'; search.placeholder = this.t('Search values…'); search.setAttribute('aria-label', this.t('Search values'));
    const actions = element('div', 'filter-value-actions'); const list = element('div', 'filter-value-list'); list.setAttribute('aria-label', this.t('Column values')); const status = element('p', 'muted'); status.setAttribute('role', 'status');
    const token = (value: Value) => JSON.stringify(value);
    const draw = () => {
      list.replaceChildren(); const selected = new Set(draft.values.map(token));
      for (const choice of this.values ?? []) {
        if (!`${choice.value.type} ${choice.value.value}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue;
        const label = element('label', 'filter-value'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(token(choice.value)); const name = choice.value.type === 'null' ? 'NULL' : choice.value.value === '' ? this.t('(Empty text)') : choice.value.value;
        checkbox.setAttribute('aria-label', `${name} · ${choice.value.type}`); checkbox.onchange = () => { const key = token(choice.value); draft.values = checkbox.checked ? [...draft.values, choice.value] : draft.values.filter(value => token(value) !== key); this.updatePreview(); };
        label.append(checkbox, element('span', 'value-label', name), element('small', 'value-type', choice.value.type), element('small', '', choice.count.toLocaleString())); list.append(label);
      }
      status.textContent = this.loadingValues ? this.t('Loading values…') : this.valueFailure || `${this.values?.length ?? 0} ${this.t('unique values')}`;
      this.apply.disabled = this.loadingValues || !this.values;
    };
    actions.append(button(this.t('Select all'), () => { draft.values = (this.values ?? []).map(choice => choice.value); draw(); this.updatePreview(); }), button(this.t('Clear'), () => { draft.values = []; draw(); this.updatePreview(); }));
    search.oninput = draw; this.controls.append(search, actions, status, list); draw();
    if (!this.values && !this.loadingValues && !this.valueFailure) {
      this.loadingValues = true; draw(); const generation = ++this.generation;
      void this.host.request({ type: 'distinct', table: this.table.name, column: this.column }).then(result => {
        if (generation !== this.generation) return; this.values = result.distinct ?? []; if (!draft.values.length && !this.query.filters?.some(filter => filter.column === this.column && filter.mode === 'values')) draft.values = this.values.map(choice => choice.value);
      }, error => { if (generation === this.generation) this.valueFailure = error instanceof Error ? error.message : String(error); }).finally(() => { if (generation !== this.generation) return; this.loadingValues = false; if (this.root.isConnected && this.mode.value === 'values') { this.draw(); } });
    }
  }
  private quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
  private updatePreview(): void {
    const filters = [...(this.query.filters ?? []).filter(filter => filter.column !== this.column), this.draft];
    try {
      const compiled = compileFilters(filters, this.table.columns.map(column => column.name), this.table.name);
      const order = this.query.sort ? ` ORDER BY ${this.quote(this.query.sort.column)} ${this.query.sort.direction}` : '';
      this.preview.textContent = `SELECT * FROM ${this.quote(this.table.name)} WHERE ${compiled.preview}${order};`;
      this.note.textContent = this.draft.mode === 'regex' || compiled.regex.length ? this.t('SQL preview shows the prefilter. RE2 regular expressions are evaluated by the editor after SQL, before pagination.') : '';
    } catch (error) { this.preview.textContent = error instanceof Error ? error.message : String(error); }
  }
  private submit(filter: ColumnFilter | undefined, close: () => void): void {
    this.error.textContent = ''; this.apply.disabled = true;
    void this.change(filter ? structuredClone(filter) : undefined).then(close, error => { this.error.textContent = error instanceof Error ? error.message : String(error); }).finally(() => { this.apply.disabled = false; });
  }
}

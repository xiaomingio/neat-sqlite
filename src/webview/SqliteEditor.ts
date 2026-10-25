/*
Purpose: Own SQLite table navigation, typed editing, selection, view preferences and editor commands.
*/
import type { Action, Column, ColumnFilter, Edit, Page, Query, Row, Status, Table, Value } from '../protocol';
import { HostClient } from './HostClient';
import { Dialog, button, element } from './Dialog';
import { Locale } from './Locale';
import { ColumnFilterPanel } from './ColumnFilterPanel';
import { CellSelection } from './CellSelection';
type Point = { row: number; column: number };
type ViewState = { offset: number; sort?: Query['sort']; filters?: ColumnFilter[]; widths: Record<string, number>; hidden: string[]; pinned: string[]; order: string[]; scrollTop: number; scrollLeft: number };
type Preferences = { language: 'en' | 'zh-CN'; theme?: 'light' | 'dark'; collapsed: boolean; sidebarWidth: number; table?: string; views: Record<string, ViewState> };
export class SqliteEditor {
  private readonly preferences: Preferences;
  private readonly locale: Locale;
  private tables: Table[] = [];
  private table?: Table;
  private page: Page = { rows: [], hasMore: false, offset: 0 };
  private status: Status = { pending: 0, tables: [], canUndo: false, canRedo: false, readOnly: false };
  private readonly toolbar = element('nav', 'toolbar');
  private readonly workspace = element('div', 'workspace');
  private readonly sidebar = element('aside', 'sidebar');
  private readonly main = element('main', 'main');
  private readonly context = element('header', 'context-bar');
  private readonly viewport = element('div', 'viewport');
  private readonly footer = element('footer', 'statusbar');
  private readonly notice = element('div', 'notice');
  private readonly search = element('input', 'table-search');
  private readonly list = element('nav', 'table-list');
  private readonly splitter = element('div', 'sidebar-splitter');
  private readonly errorText = element('span');
  private error = '';
  private tab: 'data' | 'structure' = 'data';
  private readonly selection = new CellSelection();
  private dragAxis?: 'rows' | 'columns';
  private dragging = false;
  private loading = false;
  private generation = 0;
  private activeMenu?: HTMLElement;
  private tableSearch = '';
  private retry?: () => Promise<void>;
  private readonly narrow = matchMedia('(max-width: 650px)');
  private activeFlush?: () => Promise<void>;
  private busy = false;
  private readonly queryVersions = new WeakMap<ViewState, number>();
  constructor(private readonly root: HTMLElement, private readonly host: HostClient) {
    const saved = host.getState<Partial<Preferences>>();
    this.preferences = { language: saved?.language === 'zh-CN' ? 'zh-CN' : 'en', theme: saved?.theme, collapsed: saved?.collapsed ?? false, sidebarWidth: saved?.sidebarWidth ?? 200, table: saved?.table, views: saved?.views ?? {} };
    this.locale = new Locale(this.preferences.language);
    this.host.onStatus = (status, external) => { const refresh = external || this.status.pending > 0 && status.pending === 0; this.status = status; this.renderStatus(); this.renderList(); if (refresh && !this.busy) void this.perform(() => this.loadPage()); };
    this.host.onFlush = async () => { await this.activeFlush?.(); };
    this.root.className = 'sqlite-editor'; this.workspace.append(this.sidebar, this.splitter, this.main);
    this.main.append(this.context, this.notice, this.viewport); this.root.append(this.toolbar, this.workspace, this.footer);
    this.notice.setAttribute('role', 'alert'); this.notice.hidden = true; this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'Database records'); this.footer.setAttribute('role', 'status');
    this.search.type = 'search'; this.search.oninput = () => { this.tableSearch = this.search.value; this.renderList(); };
    this.narrow.addEventListener('change', () => { this.root.classList.remove('sidebar-overlay'); this.closeMenu(); this.renderLayout(); this.renderContext(); this.renderToolbar(); });
    this.splitter.tabIndex = 0; this.splitter.setAttribute('role', 'separator'); this.splitter.setAttribute('aria-orientation', 'vertical'); this.splitter.setAttribute('aria-label', 'Resize table list');
    this.splitter.onpointerdown = event => {
      event.preventDefault(); const start = event.clientX; const width = this.preferences.sidebarWidth;
      this.splitter.setPointerCapture(event.pointerId);
      this.splitter.onpointermove = move => { this.preferences.sidebarWidth = Math.max(150, Math.min(400, width + move.clientX - start)); this.renderLayout(); };
      this.splitter.onpointerup = () => { this.splitter.onpointermove = null; this.persist(); };
    };
    this.splitter.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.preferences.sidebarWidth = Math.max(150, Math.min(400, this.preferences.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10))); this.renderLayout(); this.persist(); } };
    this.viewport.onscroll = () => { if (this.table) { this.view.scrollTop = this.viewport.scrollTop; this.view.scrollLeft = this.viewport.scrollLeft; this.persist(); } };
    window.addEventListener('pointerup', () => { this.dragging = false; this.dragAxis = undefined; });
    document.addEventListener('pointerdown', event => { if (this.activeMenu && !this.activeMenu.contains(event.target as Node) && !(event.target as Element).closest('.menu-button, .table-chooser, .column-filter-button')) this.closeMenu(); });
    document.addEventListener('keydown', event => this.keydown(event));
    this.applyTheme(); this.renderShell();
  }
  async start(): Promise<void> { await this.perform(async () => { const result = await this.host.request({ type: 'metadata' }); this.tables = result.tables ?? []; await this.selectTable(this.preferences.table ?? this.tables[0]?.name); }); }
  private t(text: string): string { return this.locale.t(text); }
  private persist(): void { this.host.setState(this.preferences); }
  private get view(): ViewState {
    const name = this.table?.name ?? '';
    if (!Object.hasOwn(this.preferences.views, name)) Object.defineProperty(this.preferences.views, name, { value: { offset: 0, widths: Object.create(null), hidden: [], pinned: [], order: [], scrollLeft: 0, scrollTop: 0 }, writable: true, enumerable: true });
    const view = this.preferences.views[name]!;
    if (Object.getPrototypeOf(view.widths) !== null) view.widths = Object.assign(Object.create(null), view.widths);
    return view;
  }
  private get query(): Query { return { table: this.table?.name ?? '', offset: this.view.offset, limit: 200, sort: this.view.sort, filters: this.view.filters }; }
  private get columns(): Column[] {
    if (!this.table) return [];
    const order = this.view.order; const columns = this.table.columns.filter(column => !this.view.hidden.includes(column.name));
    return columns.sort((a, b) => Number(this.view.pinned.includes(b.name)) - Number(this.view.pinned.includes(a.name)) || (order.indexOf(a.name) < 0 ? 10000 + this.table!.columns.indexOf(a) : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 10000 + this.table!.columns.indexOf(b) : order.indexOf(b.name)));
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    try { await action(); this.showError(''); } catch (error) { this.retry = action; this.showError(error instanceof Error ? error.message : String(error)); }
  }
  private showError(error: string): void {
    this.error = error; this.notice.hidden = !error;
    this.errorText.textContent = error;
    this.notice.replaceChildren(this.errorText, button(this.t('Retry'), () => void this.perform(this.retry ?? (() => this.loadPage()))), button('×', () => this.showError('')));
    (this.notice.lastElementChild as HTMLButtonElement).setAttribute('aria-label', this.t('Dismiss error'));
  }
  private renderShell(): void {
    this.renderToolbar(); this.renderSidebar(); this.renderLayout(); this.renderContext(); this.renderStatus();
  }
  private renderToolbar(): void {
    this.toolbar.replaceChildren(); this.toolbar.setAttribute('aria-label', 'Editor menu');
    const commands: [string, [string, () => void, string?][]][] = [
      ['File', [['Save changes', () => void this.run({ type: 'save' }), '⌘/Ctrl S'], ['Export current view…', () => void this.run({ type: 'export', query: this.query })], ['Save database snapshot…', () => this.backupDialog()], ['Refresh database', () => void this.run({ type: 'refresh' })]]],
      ['View', [[this.collapsed ? 'Show table list' : 'Hide table list', () => this.toggleSidebar()], ['Choose columns…', () => this.chooseColumns()], ['Reset sorting', () => this.changeQuery({ sort: undefined })]]],
      ['Edit', [['Undo', () => void this.run({ type: 'undo' }), '⌘/Ctrl Z'], ['Redo', () => void this.run({ type: 'redo' }), '⇧⌘/Ctrl Z'], ['Copy', () => void this.perform(() => this.copy(false)), '⌘/Ctrl C'], ['Copy with headers', () => void this.perform(() => this.copy(true))], ['Paste', () => void this.perform(() => this.paste()), '⌘/Ctrl V'], ['Edit cell…', () => this.editCell()], ['Set to NULL', () => void this.setSelected({ type: 'null', value: '' })], ['Set to empty text', () => void this.setSelected({ type: 'text', value: '' })], ['Discard all changes…', () => this.confirmDiscard()]]],
      ['Data', [['Add record…', () => this.addRecord()], ['Delete selected records…', () => this.deleteRecords()], ['Filter…', () => this.filterDialog()]]],
      ['Settings', [['Language', () => {}]]]
    ];
    for (const [label, items] of commands) {
      const control = button(this.t(label), () => this.openMenu(control, items), 'menu-button');
      control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false');
      control.onmouseenter = () => { if (this.toolbar.querySelector('[aria-expanded="true"]')) this.openMenu(control, items); };
      this.toolbar.append(control);
    }
    const undo = button('↶', () => void this.run({ type: 'undo' }), 'undo-button icon-button'); undo.title = this.t('Undo'); undo.setAttribute('aria-label', this.t('Undo'));
    const redo = button('↷', () => void this.run({ type: 'redo' }), 'redo-button icon-button'); redo.title = this.t('Redo'); redo.setAttribute('aria-label', this.t('Redo'));
    const hint = element('span', 'toolbar-hint', this.t('Double-click or Enter to edit · Ctrl/Cmd+S to save'));
    const help = button('?', () => this.help(), 'icon-button'); help.setAttribute('aria-label', this.t('Help')); help.title = this.t('Quick guide');
    const theme = button('◐', () => { this.preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; this.applyTheme(); this.persist(); }, 'icon-button'); theme.setAttribute('aria-label', this.t('Toggle theme'));
    this.toolbar.append(undo, redo, hint, help, theme);
  }
  private openMenu(control: HTMLButtonElement, items: [string, () => void, string?][]): void {
    if (control.getAttribute('aria-expanded') === 'true') { this.closeMenu(); return; }
    this.closeMenu(); const menu = element('div', 'command-menu'); menu.setAttribute('role', 'menu');
    for (const [label, action, shortcut] of items) {
      const item = button('', () => { this.closeMenu(); action(); }); item.setAttribute('role', 'menuitem');
      item.append(element('span', '', this.t(label))); if (shortcut) item.append(element('span', 'shortcut', shortcut)); menu.append(item);
    }
    if (items.some(item => item[0] === 'Language')) this.languageSubmenu(menu, menu.querySelector('button')!);
    document.body.append(menu); this.activeMenu = menu; control.setAttribute('aria-expanded', 'true');
    const rect = control.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${rect.bottom}px`;
    (menu.firstElementChild as HTMLElement)?.focus();
    menu.onkeydown = event => {
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>(':scope > button')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
      if (event.key === 'Escape') { this.closeMenu(); control.focus(); }
    };
  }
  private closeMenu(): void { this.activeMenu?.remove(); this.activeMenu = undefined; this.root.querySelectorAll('[aria-expanded]').forEach(node => node.setAttribute('aria-expanded', 'false')); }
  private applyTheme(): void { const theme = this.preferences.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }
  private get collapsed(): boolean { return this.preferences.collapsed || this.narrow.matches; }
  private toggleSidebar(): void { this.preferences.collapsed = !this.collapsed; if (this.narrow.matches && !this.preferences.collapsed) this.root.classList.toggle('sidebar-overlay'); this.renderLayout(); this.renderToolbar(); this.renderContext(); this.persist(); }
  private renderLayout(): void { const visible = !this.collapsed || this.root.classList.contains('sidebar-overlay'); this.sidebar.hidden = !visible; this.splitter.hidden = !visible || this.narrow.matches; this.root.style.setProperty('--sidebar-width', `${this.preferences.sidebarWidth}px`); }
  private renderSidebar(): void {
    const heading = element('header', 'sidebar-heading'); heading.append(element('strong', '', this.t('Tables')));
    const collapse = button('◀', () => { this.root.classList.remove('sidebar-overlay'); this.preferences.collapsed = true; this.renderLayout(); this.renderContext(); this.persist(); }, 'icon-button'); collapse.title = this.t('Hide table list'); collapse.setAttribute('aria-label', this.t('Hide table list'));
    heading.append(collapse); this.search.placeholder = this.t('Search tables…'); this.search.setAttribute('aria-label', this.t('Search tables…')); this.sidebar.replaceChildren(heading, this.search, this.list); this.renderList();
  }
  private renderList(): void {
    this.list.replaceChildren(); let count = 0;
    for (const kind of ['table', 'view'] as const) {
      const tables = this.tables.filter(table => table.kind === kind && table.name.toLocaleLowerCase().includes(this.tableSearch.toLocaleLowerCase()));
      if (!tables.length) continue; count += tables.length;
      this.list.append(element('div', 'list-group', this.t(kind === 'table' ? 'Tables' : 'Views')));
      for (const table of tables) {
        const item = button('', () => void this.perform(() => this.selectTable(table.name)), 'table-item');
        item.append(element('span', 'table-icon', kind === 'table' ? '▦' : '▤'), element('span', 'table-name', table.name));
        if (this.status.tables.includes(table.name)) item.append(element('span', 'pending-dot', '●'));
        item.setAttribute('aria-current', String(table.name === this.table?.name)); item.title = table.name; this.list.append(item);
      }
    }
    if (!count) this.list.append(element('p', 'empty-note', this.t('No matching tables')));
  }
  private renderContext(): void {
    this.context.replaceChildren();
    if (this.collapsed) {
      const expand = button('▶', () => this.toggleSidebar(), 'icon-button'); expand.setAttribute('aria-label', this.t('Show table list')); this.context.append(expand);
      const chooser = button(this.table?.name ?? this.t('Select table'), () => this.tableChooser(), 'table-chooser'); chooser.append(element('span', '', ' ▾')); chooser.setAttribute('aria-label', this.t('Select table')); chooser.setAttribute('aria-haspopup', 'dialog'); chooser.setAttribute('aria-expanded', 'false'); chooser.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); this.tableChooser(); } }; this.context.append(chooser);
    } else this.context.append(element('strong', 'current-table', this.table?.name ?? this.t('Tables')));
    const tabs = element('nav', 'tabs'); tabs.setAttribute('aria-label', 'Table view');
    for (const [tab, label] of [['data', 'Data'], ['structure', 'Structure']] as const) { const item = button(this.t(label), () => { this.tab = tab; this.renderContext(); this.renderContent(); }, 'tab'); item.setAttribute('aria-pressed', String(this.tab === tab)); tabs.append(item); }
    const actions = element('div', 'table-actions');
    const add = button('+', () => this.addRecord(), 'icon-button'); add.title = this.t('Add record…'); add.setAttribute('aria-label', this.t('Add record…')); add.disabled = !this.editable;
    actions.append(add); this.context.append(tabs, actions);
  }
  private tableChooser(): void {
    const control = this.context.querySelector<HTMLButtonElement>('.table-chooser'); if (!control) return;
    if (control.getAttribute('aria-expanded') === 'true') { this.closeMenu(); return; }
    this.closeMenu(); const popup = element('div', 'command-menu table-dropdown'); popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', this.t('Select table'));
    const input = element('input'); input.type = 'search'; input.placeholder = this.t('Search tables…'); input.setAttribute('aria-label', this.t('Search tables…'));
    const list = element('div', 'chooser-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', this.t('Tables'));
    const choose = (name: string) => { this.closeMenu(); void this.perform(() => this.selectTable(name)); control.focus(); };
    const render = () => { list.replaceChildren(); for (const table of this.tables.filter(table => table.name.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()))) {
      const choice = button(`${table.kind === 'view' ? '▤' : '▦'} ${table.name}${this.status.tables.includes(table.name) ? ' ●' : ''}`, () => choose(table.name)); choice.setAttribute('role', 'option'); choice.setAttribute('aria-selected', String(table.name === this.table?.name)); list.append(choice);
    } if (!list.childElementCount) list.append(element('p', 'empty-note', this.t('No matching tables'))); };
    input.oninput = render; popup.append(input, list); render(); document.body.append(popup); this.activeMenu = popup; control.setAttribute('aria-expanded', 'true');
    const rect = control.getBoundingClientRect(); popup.style.width = `${Math.max(240, Math.min(360, innerWidth - 8))}px`; popup.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - popup.offsetWidth - 4))}px`; popup.style.top = `${rect.bottom + 3}px`; popup.style.maxHeight = `${Math.max(100, innerHeight - rect.bottom - 12)}px`; input.focus();
    popup.onkeydown = event => { const options = Array.from(list.querySelectorAll<HTMLButtonElement>('button')); const index = options.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1) + options.length) % options.length]?.focus(); }
      if (event.key === 'Enter' && event.target === input) { event.preventDefault(); options[0]?.click(); }
      if (event.key === 'Escape') { event.preventDefault(); this.closeMenu(); control.focus(); }
    };
  }
  private async selectTable(name?: string): Promise<void> {
    const table = this.tables.find(table => table.name === name) ?? this.tables[0]; if (table !== this.table) this.page = { rows: [], hasMore: false, offset: 0 }; this.table = table; this.preferences.table = table?.name; this.selection.clear(); this.root.classList.remove('sidebar-overlay'); this.persist(); this.renderShell(); this.renderContent(); await this.loadPage();
  }
  private async loadPage(): Promise<void> {
    const generation = ++this.generation; const table = this.table; if (!table) { this.renderContent(); return; }
    this.loading = true; this.viewport.inert = true; this.renderStatus(); this.viewport.setAttribute('aria-busy', 'true');
    try { const result = await this.host.request({ type: 'page', query: this.query }); if (generation !== this.generation || table !== this.table) return; const next = result.page ?? { rows: [], hasMore: false, offset: 0 }; const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected && (selected.columns.some(column => column >= this.columns.length) || selected.ranges.some(range => Array.from({ length: range.count }, (_, index) => range.start + index).some(row => !next.rows[row] || this.page.rows[row]?.key !== next.rows[row]?.key)))) this.selection.clear(); this.page = next; this.renderContent(); }
    finally { if (generation === this.generation) { this.loading = false; this.viewport.inert = false; this.viewport.setAttribute('aria-busy', 'false'); this.renderStatus(); } }
  }
  private renderContent(): void {
    this.viewport.replaceChildren();
    if (!this.table) { this.viewport.append(element('p', 'empty-state', this.t('Select a table to view its records.'))); return; }
    if (this.tab === 'structure') { this.renderStructure(); return; }
    const grid = element('table', 'data-grid'); grid.style.width = `${48 + this.columns.reduce((sum, column) => sum + (this.view.widths[column.name] ?? 180), 0)}px`; grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', this.table.name); const head = element('thead'); const headings = element('tr');
    const corner = element('th', 'row-number'); const all = button('#', () => { if (this.page.rows.length && this.columns.length) { this.selection.selectAll(); this.renderSelection(); } }); all.setAttribute('aria-label', this.t('Select all loaded cells')); corner.append(all); headings.append(corner);
    let pinnedLeft = 48;
    for (const [columnIndex, column] of this.columns.entries()) {
      const th = element('th'); th.dataset.headerColumn = String(columnIndex); const width = this.view.widths[column.name] ?? 180; th.style.width = `${width}px`; th.style.minWidth = `${width}px`; th.style.maxWidth = `${width}px`;
      th.ondragover = event => event.preventDefault(); th.ondrop = event => { event.preventDefault(); const source = event.dataTransfer?.getData('text/plain'); if (!source || !this.table!.columns.some(item => item.name === source)) return; const order = this.columns.map(item => item.name).filter(name => name !== source); order.splice(order.indexOf(column.name), 0, source); this.view.order = order; this.selection.clear(); this.persist(); this.renderContent(); };
      const label = button(`${column.pk ? '⚿ ' : ''}${column.name}`, () => {}, 'column-label'); label.setAttribute('aria-label', `${this.t('Select column')} ${column.name}`); label.title = `${column.name} · ${column.type || 'ANY'}${column.generated ? ' · generated' : ''}`;
      label.onpointerdown = event => this.startAxis(event, 'columns', columnIndex); label.onpointerenter = () => { if (this.dragAxis === 'columns') { this.selection.extendAxis(columnIndex); this.renderSelection(); } }; label.onclick = event => { if (!event.detail) { this.selection.startAxis('columns', columnIndex, event.ctrlKey || event.metaKey, event.shiftKey); this.renderSelection(); } };
      const type = element('span', 'column-type', column.type || 'ANY');
      const sort = button(this.view.sort?.column === column.name ? (this.view.sort.direction === 'ASC' ? '↑' : '↓') : '↕', () => this.changeQuery({ sort: this.view.sort?.column !== column.name ? { column: column.name, direction: 'ASC' } : this.view.sort.direction === 'ASC' ? { column: column.name, direction: 'DESC' } : undefined }), 'sort-button'); sort.title = this.t('Click: cycle original order, ascending, descending | Right-click: sort options'); sort.setAttribute('aria-label', `${this.t('Sort')} ${column.name}`); if (this.view.sort?.column === column.name) sort.classList.add('applied');
      const sortOptions = (event: MouseEvent | KeyboardEvent) => { event.preventDefault(); this.sortMenu(column, sort); }; sort.oncontextmenu = sortOptions; sort.onkeydown = event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) sortOptions(event); };
      const filter = button('', () => this.filterDialog(column.name, filter), 'column-filter-button'); filter.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12L9.5 8v4l-3 1V8z"/></svg>'; filter.title = `${this.t('Filter')} ${column.name}`; filter.setAttribute('aria-label', `${this.t('Filter')} ${column.name}`); if (this.view.filters?.some(item => item.column === column.name)) filter.classList.add('applied');
      const drag = button('⠿', () => {}, 'column-drag-handle'); drag.draggable = true; drag.setAttribute('aria-label', `${this.t('Reorder column')} ${column.name}`); drag.title = this.t('Drag: reorder display columns'); drag.ondragstart = event => { this.dragAxis = undefined; this.dragging = false; event.dataTransfer?.setData('text/plain', column.name); };
      const options = button('⌄', () => this.columnMenu(column, options), 'column-options'); options.setAttribute('aria-label', `${this.t('Column options')} ${column.name}`);
      const content = element('div', 'column-heading'); content.append(label, type, sort, filter, drag, options); th.append(content);
      const resize = element('div', 'column-resize'); resize.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); const x = event.clientX; resize.setPointerCapture(event.pointerId); resize.onpointermove = move => { const next = Math.max(120, Math.min(800, width + move.clientX - x)); this.view.widths[column.name] = next; th.style.width = th.style.minWidth = th.style.maxWidth = `${next}px`; }; resize.onpointerup = () => { resize.onpointermove = null; this.persist(); this.renderContent(); }; }; th.append(resize);
      if (this.view.pinned.includes(column.name)) { th.classList.add('pinned'); th.style.left = `${pinnedLeft}px`; pinnedLeft += width; }
      headings.append(th);
    }
    head.append(headings); grid.append(head); const body = element('tbody');
    this.page.rows.forEach((row, rowIndex) => {
      const tr = element('tr'); if (row.deleted) tr.classList.add('deleted'); if (row.inserted) tr.classList.add('inserted');
      const rowNumber = element('th', 'row-number'); rowNumber.dataset.headerRow = String(rowIndex); const rowButton = button(String(this.page.offset + rowIndex + 1), () => {}); rowButton.onpointerdown = event => this.startAxis(event, 'rows', rowIndex); rowButton.onpointerenter = () => { if (this.dragAxis === 'rows') { this.selection.extendAxis(rowIndex); this.renderSelection(); } }; rowButton.onclick = event => { if (!event.detail) { this.selection.startAxis('rows', rowIndex, event.ctrlKey || event.metaKey, event.shiftKey); this.renderSelection(); } }; rowButton.setAttribute('aria-label', `${this.t('Record')} ${this.page.offset + rowIndex + 1}`); rowNumber.append(rowButton); tr.append(rowNumber); let left = 48;
      this.columns.forEach((column, columnIndex) => {
        const value = row.values[this.table!.columns.indexOf(column)]!; const cell = element('td', '', this.display(value)); cell.dataset.row = String(rowIndex); cell.dataset.column = String(columnIndex); cell.setAttribute('aria-colindex', String(columnIndex + 1)); cell.setAttribute('aria-rowindex', String(rowIndex + 1)); cell.title = `${column.name} · ${value.type}${value.type === 'blob' ? ` · ${Math.floor(value.value.length / 2)} bytes` : ''}`;
        if (value.type === 'null' || value.type === 'blob') cell.classList.add('special-value'); if (row.modified || row.inserted) cell.classList.add('modified');
        if (this.view.pinned.includes(column.name)) { cell.classList.add('pinned'); cell.style.left = `${left}px`; left += this.view.widths[column.name] ?? 180; }
        cell.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); this.dragAxis = undefined;
          if (event.ctrlKey || event.metaKey) { try { this.selection.toggle(rowIndex, columnIndex, this.page.rows.length, this.columns.length); } catch (error) { this.showError(error instanceof Error ? error.message : String(error)); } this.dragging = false; }
          else { if (event.shiftKey) this.selection.extend(rowIndex, columnIndex); else this.selection.start(rowIndex, columnIndex); this.dragging = true; }
          this.viewport.focus({ preventScroll: true }); this.renderSelection(); };
        cell.onpointerenter = () => { if (this.dragging) { this.selection.extend(rowIndex, columnIndex); this.renderSelection(); } };
        cell.ondblclick = () => this.editCell(); cell.oncontextmenu = event => { event.preventDefault(); if (event.ctrlKey || event.metaKey) return; if (!this.selected(rowIndex, columnIndex)) { this.selection.start(rowIndex, columnIndex); this.renderSelection(); } this.cellMenu(event.clientX, event.clientY); }; tr.append(cell);
      }); body.append(tr);
    }); grid.append(body); this.viewport.append(grid);
    if (!this.page.rows.length) this.viewport.append(element('p', 'empty-state', `${this.t('No records')} · ${this.t('Add a record or change the filter.')}`));
    if (!this.table.editable || this.status.readOnly) this.viewport.append(element('p', 'read-only-note', `${this.t('Read-only')}: ${this.table.reason ?? this.t('Read-only database')}`));
    this.viewport.scrollTop = this.view.scrollTop; this.viewport.scrollLeft = this.view.scrollLeft; this.renderSelection();
  }
  private display(value: Value): string { return value.type === 'null' ? 'NULL' : value.type === 'blob' ? `BLOB · ${Math.floor(value.value.length / 2).toLocaleString()} B` : value.value; }
  private renderStructure(): void {
    const panel = element('div', 'structure'); const table = element('table', 'structure-table'); const head = element('tr');
    for (const label of ['Column', 'Type', 'Not null', 'Default', 'Primary key', 'Generated']) head.append(element('th', '', this.t(label))); const thead = element('thead'); thead.append(head); table.append(thead);
    const body = element('tbody'); for (const column of this.table!.columns) { const row = element('tr'); for (const text of [column.name, column.type || 'ANY', column.notNull ? '✓' : '—', column.defaultValue ?? '—', column.pk ? String(column.pk) : '—', column.generated ? '✓' : '—']) row.append(element('td', '', text)); body.append(row); } table.append(body); panel.append(table);
    for (const [title, values, empty] of [['Indexes', this.table!.indexes, 'No indexes'], ['Foreign keys', this.table!.foreignKeys, 'No foreign keys']] as const) { panel.append(element('h3', '', this.t(title)), element('pre', '', values.length ? JSON.stringify(values, null, 2) : this.t(empty))); }
    panel.append(element('h3', '', this.t('Create SQL')), element('pre', '', this.table!.sql)); this.viewport.append(panel);
  }
  private renderStatus(): void {
    this.footer.replaceChildren(); const pending = element('span', 'pending-status', this.status.pending ? `${this.t('Unsaved changes')}: ${this.status.pending}` : this.t('No unsaved changes')); this.footer.append(pending);
    if (this.loading) this.footer.append(element('span', 'muted', this.page.rows.length ? this.t('Updating…') : this.t('Loading…')));
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected) this.footer.append(element('span', 'selection-status', `${this.t('Selected cells')}: ${selected.cells?.length ?? selected.rowCount * selected.columnCount}${this.selectionStatistics()}`));
    const spacer = element('span', 'status-spacer'); const previous = button('‹', () => { this.view.offset = Math.max(0, this.view.offset - 200); this.selection.clear(); this.view.scrollTop = 0; void this.perform(() => this.loadPage()); }); previous.disabled = !this.table || this.view.offset === 0 || this.loading; previous.setAttribute('aria-label', this.t('Previous page'));
    const next = button('›', () => { this.view.offset += 200; this.selection.clear(); this.view.scrollTop = 0; void this.perform(() => this.loadPage()); }); next.disabled = !this.page.hasMore || this.loading; next.setAttribute('aria-label', this.t('Next page'));
    const rows = element('span', 'row-status', `${this.t('Rows')}: ${this.page.rows.length ? this.page.offset + 1 : 0}–${this.page.offset + this.page.rows.length}${this.page.hasMore ? '+' : ''}`); this.footer.append(spacer, previous, rows, next);
    const undo = this.toolbar.querySelector<HTMLButtonElement>('.undo-button'); if (undo) undo.disabled = !this.status.canUndo || this.busy; const redo = this.toolbar.querySelector<HTMLButtonElement>('.redo-button'); if (redo) redo.disabled = !this.status.canRedo || this.busy;
  }
  private get cursor(): Point | undefined { const position = this.selection.position; if (position && this.selected(position.row, position.col)) return { row: position.row, column: position.col }; const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected?.cells?.length) return { row: selected.cells[0]!.row, column: selected.cells[0]!.col }; return selected?.ranges.length && selected.columns.length ? { row: selected.ranges[0]!.start, column: selected.columns[0]! } : undefined; }
  private selectionStatistics(): string {
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected || !this.table || (selected.cells?.length ?? selected.rowCount * selected.columnCount) > 1000) return '';
    const values = this.points().filter(point => this.page.rows[point.row] && this.columns[point.column]).map(point => this.getValue(point)).filter(value => value.type === 'integer' || value.type === 'real');
    if (!values.length) return '';
    if (values.every(value => value.type === 'integer')) return ` · ${this.t('Sum')}: ${values.reduce((sum, value) => sum + BigInt(value.value), 0n)}`;
    if (values.some(value => value.type === 'integer' && !Number.isSafeInteger(Number(value.value)))) return ` · ${this.t('Numeric')}: ${values.length}`;
    const sum = values.reduce((sum, value) => sum + Number(value.value), 0); return Number.isFinite(sum) ? ` · ${this.t('Sum')}: ≈${Number(sum.toPrecision(12))}` : '';
  }
  private selected(row: number, column: number): boolean { return row >= 0 && column >= 0 && row < this.page.rows.length && column < this.columns.length && this.selection.contains(row, column); }
  private startAxis(event: PointerEvent, axis: 'rows' | 'columns', index: number): void {
    if (event.button !== 0) return; event.preventDefault(); this.dragging = false; this.dragAxis = axis; this.selection.startAxis(axis, index, event.ctrlKey || event.metaKey, event.shiftKey); this.viewport.focus({ preventScroll: true }); this.renderSelection();
  }
  private renderSelection(): void {
    const rowCount = this.page.rows.length; const columnCount = this.columns.length; const contains = (row: number, column: number) => row >= 0 && column >= 0 && row < rowCount && column < columnCount && this.selection.contains(row, column);
    this.viewport.querySelectorAll<HTMLTableCellElement>('td[data-row]').forEach(cell => { const row = Number(cell.dataset.row); const column = Number(cell.dataset.column); const selected = contains(row, column); cell.classList.toggle('selected', selected); cell.setAttribute('aria-selected', String(selected)); for (const [edge, selectedNeighbor] of [['top', contains(row - 1, column)], ['bottom', contains(row + 1, column)], ['left', contains(row, column - 1)], ['right', contains(row, column + 1)]] as const) cell.classList.toggle(`selection-${edge}`, selected && !selectedNeighbor); });
    this.viewport.querySelectorAll<HTMLElement>('[data-header-row]').forEach(cell => cell.classList.toggle('axis-selected', this.columns.length > 0 && this.columns.every((_, column) => contains(Number(cell.dataset.headerRow), column))));
    this.viewport.querySelectorAll<HTMLElement>('[data-header-column]').forEach(cell => cell.classList.toggle('axis-selected', this.page.rows.length > 0 && this.page.rows.every((_, row) => contains(row, Number(cell.dataset.headerColumn)))));
    this.renderStatus();
  }
  private get editable(): boolean { return !!this.table?.editable && !this.status.readOnly; }
  private points(): Point[] {
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected) throw new Error(this.t('Select a cell first.'));
    if ((selected.cells?.length ?? selected.rowCount * selected.columnCount) > 10000) throw new Error(this.t('Select at most 10,000 cells.'));
    const result = selected.cells ? selected.cells.map(cell => ({ row: cell.row, column: cell.col })) : selected.ranges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index).flatMap(row => selected.columns.map(column => ({ row, column }))));
    if (result.some(point => !this.page.rows[point.row] || !this.columns[point.column])) throw new Error(this.t('Select a cell first.')); return result;
  }
  private getValue(point: Point): Value { return this.page.rows[point.row]!.values[this.table!.columns.indexOf(this.columns[point.column]!)]!; }
  private checkEditable(point: Point): void { if (!this.editable || this.page.rows[point.row]?.deleted) throw new Error(this.t('The selected table is read-only.')); if (this.columns[point.column]?.generated) throw new Error(this.t('This column is generated by SQLite.')); if (this.getValue(point).type === 'blob') throw new Error(this.t('BLOB values are read-only.')); }
  private async run(action: Action): Promise<void> {
    await this.perform(async () => {
      await this.activeFlush?.(); this.busy = true; this.renderStatus();
      try { await this.host.request(action); if (['refresh', 'save', 'discard'].includes(action.type)) { const result = await this.host.request({ type: 'metadata' }); this.tables = result.tables ?? this.tables; this.table = this.tables.find(table => table.name === this.table?.name) ?? this.tables[0]; }
        if (!['clipboardRead', 'clipboardWrite', 'backup', 'export'].includes(action.type)) await this.loadPage(); this.renderShell();
      } finally { this.busy = false; this.renderStatus(); }
    });
  }
  private editCell(): void {
    void this.perform(async () => {
      if (!this.cursor || !this.table) throw new Error(this.t('Select a cell first.')); const point = this.cursor; this.checkEditable(point); const table = this.table; const row = this.page.rows[point.row]!; const column = this.columns[point.column]!; const value = this.getValue(point);
      const dialog = new Dialog(`${this.t('Edit value')} · ${column.name}`, this.locale); const editor = this.valueEditor(column, value, false); dialog.body.append(editor.root);
      const submit = async () => { const next = editor.read(); if (!next) throw new Error('Choose a value type.'); await this.host.request({ type: 'edit', edits: [{ kind: 'update', table: table.name, key: row.key, column: column.name, value: next }] }); this.activeFlush = undefined; dialog.close(); await this.loadPage(); };
      this.activeFlush = async () => { try { await submit(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } }; dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t('Apply'), submit);
    });
  }
  private valueEditor(column: Column, initial?: Value, useDefault = true): { root: HTMLElement; read: () => Value | undefined } {
    const root = element('div', 'value-field'); const label = element('label', '', column.name); const type = element('select'); type.setAttribute('aria-label', `${column.name} ${this.t('Type')}`);
    const types = useDefault ? ['default', 'text', 'integer', 'real', 'null'] : ['text', 'integer', 'real', 'null']; for (const value of types) { const option = element('option', '', value === 'default' ? `${this.t('Use default')}${column.defaultValue === null ? '' : ` · ${column.defaultValue}`}` : value === 'null' ? 'NULL' : value.toUpperCase()); option.value = value; type.append(option); } type.value = initial?.type ?? 'default';
    const input = element('textarea'); input.rows = useDefault ? 1 : 6; input.value = initial?.value ?? ''; input.setAttribute('aria-label', `${column.name} ${this.t('Value')}`); input.spellcheck = false;
    const update = () => { input.disabled = type.value === 'null' || type.value === 'default'; }; type.onchange = update; update(); label.append(type); root.append(label, input);
    return { root, read: () => { const kind = type.value; if (kind === 'default') return undefined; if (kind === 'integer' && !/^[+-]?\d+$/.test(input.value)) throw new Error(this.t('Integer values must be whole numbers.')); if (kind === 'real' && (!input.value.trim() || !Number.isFinite(Number(input.value)))) throw new Error(this.t('Real values must be finite numbers.')); return { type: kind as Value['type'], value: kind === 'null' ? '' : input.value }; } };
  }
  private addRecord(): void {
    if (!this.editable || !this.table) { this.showError(this.t('The selected table is read-only.')); return; } const table = this.table; const dialog = new Dialog(this.t('Add record'), this.locale); dialog.body.append(element('p', 'muted', this.t('Default values and generated fields are filled when you save.')));
    const fields = table.columns.filter(column => !column.generated).map(column => { const field = this.valueEditor(column); dialog.body.append(field.root); return { column, field }; });
    const submit = async () => { const values: Record<string, Value> = Object.create(null); for (const { column, field } of fields) { const value = field.read(); if (value) values[column.name] = value; } await this.host.request({ type: 'edit', edits: [{ kind: 'insert', table: table.name, values }] }); this.activeFlush = undefined; dialog.close(); this.view.offset = 0; await this.loadPage(); };
    this.activeFlush = async () => { try { await submit(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } }; dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t('Add record'), submit);
  }
  private async setSelected(value: Value): Promise<void> { await this.perform(async () => { const edits = this.points().map(point => { this.checkEditable(point); return { kind: 'update', table: this.table!.name, key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name, value } satisfies Edit; }); await this.host.request({ type: 'edit', edits }); await this.loadPage(); }); }
  private deleteRecords(): void {
    void this.perform(async () => { if (!this.editable || !this.table) throw new Error(this.t('The selected table is read-only.')); const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected) throw new Error(this.t('Select records first.')); const rows = selected.cells ? [...new Set(selected.cells.map(point => point.row))] : selected.ranges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index)); if (rows.length > 10000) throw new Error('Select at most 10,000 records.'); const table = this.table; const edits = rows.filter(index => !this.page.rows[index]!.deleted).map(index => ({ kind: 'delete' as const, table: table.name, key: this.page.rows[index]!.key }));
      const dialog = new Dialog(`${this.t('Delete')} ${edits.length} ${this.t('Rows')}?`, this.locale); dialog.body.append(element('p', '', this.t('Pending deletions are committed when you save.'))); dialog.show(this.t('Delete'), async () => { await this.host.request({ type: 'edit', edits }); await this.loadPage(); });
    });
  }
  private backupDialog(): void { const dialog = new Dialog(this.t('Save database snapshot…'), this.locale); dialog.body.append(element('p', '', this.t('The snapshot contains committed data. Save your changes first to include them.'))); dialog.show(this.t('Save'), () => this.run({ type: 'backup' })); }
  private confirmDiscard(): void { if (!this.status.pending) return; const dialog = new Dialog(this.t('Discard all changes…'), this.locale); dialog.body.append(element('p', '', this.t('Pending changes across all tables will be discarded.'))); dialog.show(this.t('Discard'), () => this.run({ type: 'discard' })); }
  private filterDialog(columnName?: string, control?: HTMLElement): void {
    if (!this.table) return; const column = columnName ?? this.columns[this.cursor?.column ?? 0]?.name; if (!column) return;
    if (this.activeMenu?.dataset.filterColumn === column) { this.closeMenu(); return; }
    this.closeMenu(); const table = this.table;
    const panel = new ColumnFilterPanel(table, column, this.query, this.host, this.locale, async filter => {
      if (this.table !== table) throw new Error('The selected table changed. Reopen this filter.');
      const view = this.view; const revision = (this.queryVersions.get(view) ?? 0) + 1; this.queryVersions.set(view, revision); const old = view.filters; const offset = view.offset;
      view.filters = [...(old ?? []).filter(item => item.column !== column), ...(filter ? [filter] : [])]; view.offset = 0; this.selection.clear();
      try { await this.loadPage(); if (this.queryVersions.get(view) === revision) { this.persist(); this.showError(''); } } catch (error) { if (this.queryVersions.get(view) === revision) { view.filters = old; view.offset = offset; } throw error; }
    }, () => { if (this.activeMenu === panel.root) this.closeMenu(); });
    panel.root.dataset.filterColumn = column; document.body.append(panel.root); this.activeMenu = panel.root;
    const rect = (control ?? this.context).getBoundingClientRect(); panel.root.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - panel.root.offsetWidth - 4))}px`; panel.root.style.top = `${Math.max(4, Math.min(rect.bottom + 3, innerHeight - panel.root.offsetHeight - 4))}px`;
    (panel.root.querySelector('select') as HTMLElement)?.focus();
  }
  private changeQuery(change: Partial<Pick<ViewState, 'sort' | 'filters'>>): void { void this.perform(async () => { const view = this.view; const revision = (this.queryVersions.get(view) ?? 0) + 1; this.queryVersions.set(view, revision); const old = { sort: view.sort, filters: view.filters, offset: view.offset }; Object.assign(view, change, { offset: 0 }); this.selection.clear(); try { await this.loadPage(); if (this.queryVersions.get(view) === revision) { this.persist(); this.renderContext(); } } catch (error) { if (this.queryVersions.get(view) === revision) Object.assign(view, old); throw error; } }); }
  private sortMenu(column: Column, control: HTMLElement): void {
    const rect = control.getBoundingClientRect(); this.floatingMenu(rect.left, rect.bottom, [['Original order', () => this.changeQuery({ sort: undefined })], ['Ascending', () => this.changeQuery({ sort: { column: column.name, direction: 'ASC' } })], ['Descending', () => this.changeQuery({ sort: { column: column.name, direction: 'DESC' } })]]);
    const current = this.view.sort?.column === column.name ? this.view.sort.direction : undefined; this.activeMenu?.querySelectorAll('button').forEach((choice, index) => { choice.setAttribute('aria-pressed', String(index === (current === 'ASC' ? 1 : current === 'DESC' ? 2 : 0))); });
  }
  private columnMenu(column: Column, control: HTMLButtonElement): void {
    const rect = control.getBoundingClientRect(); this.floatingMenu(rect.left, rect.bottom, [
      ['Original order', () => this.changeQuery({ sort: undefined })], ['Ascending', () => this.changeQuery({ sort: { column: column.name, direction: 'ASC' } })], ['Descending', () => this.changeQuery({ sort: { column: column.name, direction: 'DESC' } })], ['Reset sorting', () => this.changeQuery({ sort: undefined })],
      [this.view.pinned.includes(column.name) ? 'Unpin column' : 'Pin column', () => { this.view.pinned = this.view.pinned.includes(column.name) ? this.view.pinned.filter(name => name !== column.name) : [...this.view.pinned, column.name]; this.selection.clear(); this.persist(); this.renderContent(); }],
      ['Hide column', () => { if (this.columns.length < 2) return; this.view.hidden.push(column.name); this.selection.clear(); this.persist(); this.renderContent(); }]
    ]);
  }
  private cellMenu(x: number, y: number): void { this.floatingMenu(x, y, [['Edit cell…', () => this.editCell()], ['Copy', () => void this.perform(() => this.copy(false))], ['Copy with headers', () => void this.perform(() => this.copy(true))], ['Paste', () => void this.perform(() => this.paste())], ['Set to NULL', () => void this.setSelected({ type: 'null', value: '' })], ['Set to empty text', () => void this.setSelected({ type: 'text', value: '' })], ['Delete selected records…', () => this.deleteRecords()]]); }
  private floatingMenu(x: number, y: number, commands: [string, () => void][]): void { this.closeMenu(); const menu = element('div', 'command-menu'); menu.setAttribute('role', 'menu'); for (const [label, action] of commands) { const item = button(this.t(label), () => { this.closeMenu(); action(); }); item.setAttribute('aria-label', this.t(label)); item.setAttribute('role', 'menuitem'); menu.append(item); } document.body.append(menu); this.activeMenu = menu; menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`; (menu.firstElementChild as HTMLElement)?.focus(); }
  private chooseColumns(): void { if (!this.table) return; const dialog = new Dialog(this.t('Choose columns…'), this.locale); const fields = this.table.columns.map(column => { const label = element('label', 'checkbox-field'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = !this.view.hidden.includes(column.name); label.append(checkbox, document.createTextNode(column.name)); dialog.body.append(label); return { column, checkbox }; }); dialog.show(this.t('Apply'), () => { if (!fields.some(field => field.checkbox.checked)) throw new Error('Keep at least one column visible.'); this.view.hidden = fields.filter(field => !field.checkbox.checked).map(field => field.column.name); this.selection.clear(); this.persist(); this.renderContent(); }); }
  private languageSubmenu(parent: HTMLElement, control: HTMLButtonElement): void {
    control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false'); control.setAttribute('aria-label', this.t('Language')); const arrow = element('span', 'submenu-arrow', '›'); arrow.setAttribute('aria-hidden', 'true'); control.append(arrow);
    const submenu = element('div', 'command-menu language-submenu'); submenu.hidden = true; submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', this.t('Language'));
    for (const language of ['en', 'zh-CN'] as const) {
      const choice = button(language === 'en' ? 'English' : '简体中文', () => { this.closeMenu(); this.locale.language = language; this.preferences.language = language; document.documentElement.lang = language; this.persist(); this.renderShell(); this.renderContent(); }, 'menu-choice');
      choice.setAttribute('aria-label', language === 'en' ? 'English' : '简体中文'); choice.setAttribute('role', 'menuitemradio'); choice.setAttribute('aria-checked', String(this.locale.language === language)); submenu.append(choice);
    }
    parent.append(submenu);
    const open = (focus: boolean) => { submenu.hidden = false; control.setAttribute('aria-expanded', 'true'); const rect = control.getBoundingClientRect(); const parentRect = parent.getBoundingClientRect(); submenu.style.left = `${parentRect.right + submenu.offsetWidth < innerWidth - 4 ? parentRect.right : Math.max(4, parentRect.left - submenu.offsetWidth)}px`; submenu.style.top = `${Math.max(4, Math.min(rect.top - 4, innerHeight - submenu.offsetHeight - 4))}px`; if (focus) (submenu.querySelector('[aria-checked="true"]') as HTMLElement)?.focus(); };
    control.onclick = event => { event.stopPropagation(); open(true); }; control.onmouseenter = () => open(false);
    control.onkeydown = event => { if (['ArrowRight', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(true); } };
    submenu.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); submenu.hidden = true; control.setAttribute('aria-expanded', 'false'); control.focus(); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); const items = [...submenu.querySelectorAll('button')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); } };
  }
  private help(): void { const dialog = new Dialog(this.t('Quick guide'), this.locale); const lines = this.locale.language === 'zh-CN' ? ['在左侧选择数据表，折叠列表后通过菜单下方的选择框切换。', '双击单元格或按 Enter 编辑；明确选择文本、整数、浮点数或 NULL。', '修改在所有表之间暂存。Ctrl/Cmd+S 统一提交，保存前可以撤销或放弃。', '选区作用于当前页已加载记录。完整矩形选区可复制，Ctrl/Cmd+V 粘贴到已有的已加载记录。', '点击字段名或行号选择整列或整行，Shift 扩展范围，Ctrl/Cmd 添加或移除；单元格也可分别多选。', '字段旁的排序按钮循环切换原始顺序、升序和降序；漏斗按钮按列筛选，多列条件同时生效。', '筛选类型最后的自定义选项可编辑 WHERE 条件；其他类型通过控件生成 SQL 预览。', '字段下拉箭头提供固定和隐藏选项，拖动独立手柄只调整显示列顺序。', '视图、虚拟表、生成列和 BLOB 仅支持查看。数据库副本不包含未保存修改。'] : ['Choose a table in the sidebar. Collapse the list to switch tables below the menu.', 'Double-click a cell or press Enter to edit. Choose Text, Integer, Real, or NULL explicitly.', 'Edits are staged across tables. Ctrl/Cmd+S commits them together. Undo or discard before saving.', 'Selections apply to loaded records. Copy requires a complete rectangle; Ctrl/Cmd+V pastes into existing loaded records.', 'Click column names or row numbers to select columns or rows. Shift extends a range; Ctrl/Cmd adds or removes items, including individual cells.', 'The sort button cycles original order, ascending and descending. Each funnel filters one column; filters across columns use AND.', 'Custom is the last filter type and accepts a WHERE expression. Other types generate SQL previews from their controls.', 'Column chevrons offer pinning and visibility. Drag the separate handle to change display order.', 'Views, virtual tables, generated columns and BLOB values are read-only. Database copies contain saved data.']; for (const line of lines) dialog.body.append(element('p', '', line)); dialog.show(this.t('Close'), () => {}); }
  private async copy(headers: boolean): Promise<void> {
    const points = this.points(); if (this.selection.snapshot(this.page.rows.length, this.columns.length)?.cells) throw new Error(this.t('The selection must be a rectangle.')); const rows = [...new Set(points.map(point => point.row))].sort((a, b) => a - b); const columns = [...new Set(points.map(point => point.column))].sort((a, b) => a - b); const quote = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const output = rows.map(row => columns.map(column => quote(this.getValue({ row, column }).type === 'null' ? '' : this.getValue({ row, column }).value)).join('\t'));
    if (headers) output.unshift(columns.map(column => quote(this.columns[column]!.name)).join('\t')); const text = output.join('\n'); if (text.length > 8 * 1024 * 1024) throw new Error('Copy is limited to 8 MiB.'); await this.host.request({ type: 'clipboardWrite', text });
  }
  private async paste(): Promise<void> {
    if (!this.cursor || !this.table) throw new Error(this.t('Select a cell first.')); if (this.selection.snapshot(this.page.rows.length, this.columns.length)?.cells) throw new Error(this.t('The selection must be a rectangle.')); const text = (await this.host.request({ type: 'clipboardRead' })).text ?? ''; if (text.length > 8 * 1024 * 1024) throw new Error('Paste is limited to 8 MiB.'); const rows = this.parseTsv(text); const points = this.points(); const start = { row: Math.min(...points.map(point => point.row)), column: Math.min(...points.map(point => point.column)) }; const edits: Edit[] = [];
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r]!.length; c++) { const point = { row: start.row + r, column: start.column + c }; if (point.row >= this.page.rows.length || point.column >= this.columns.length) throw new Error(this.t('Paste exceeds the loaded records or columns. Add records before pasting.')); this.checkEditable(point); const previous = this.getValue(point); const value = rows[r]![c]!; edits.push({ kind: 'update', table: this.table.name, key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name, value: { type: previous.type === 'null' ? 'text' : previous.type, value } }); }
    if (edits.length > 10000) throw new Error(this.t('Select at most 10,000 cells.')); await this.host.request({ type: 'edit', edits }); await this.loadPage();
  }
  private parseTsv(text: string): string[][] {
    const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
    for (let index = 0; index < text.length; index++) { const char = text[index]!; if (char === '"' && (quoted || !field)) { if (quoted && text[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; } else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) { row.push(field); field = ''; if (char !== '\t') { rows.push(row); row = []; if (char === '\r' && text[index + 1] === '\n') index++; } } else field += char; }
    if (quoted) throw new Error('The pasted text has an unfinished quoted field.'); if (field || row.length || !rows.length) { row.push(field); rows.push(row); } return rows;
  }
  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { this.closeMenu(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.run({ type: 'save' }); return; }
    if ((event.target as Element).closest('input, textarea, select, dialog')) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && ['s', 'z', 'y', 'c', 'v', 'a'].includes(event.key.toLowerCase())) {
      event.preventDefault(); const key = event.key.toLowerCase();
      if (key === 's') void this.run({ type: 'save' }); if (key === 'z') void this.run({ type: event.shiftKey ? 'redo' : 'undo' }); if (key === 'y') void this.run({ type: 'redo' }); if (key === 'c') void this.perform(() => this.copy(event.shiftKey)); if (key === 'v') void this.perform(() => this.paste()); if (key === 'a' && this.page.rows.length) { this.selection.selectAll(); this.renderSelection(); } return;
    }
    if (event.target !== this.viewport) return;
    if (event.key === 'Enter') { event.preventDefault(); this.editCell(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void this.setSelected({ type: 'null', value: '' }); return; }
    if (event.key.startsWith('Arrow') && this.page.rows.length && this.columns.length) {
      event.preventDefault(); const point = this.cursor ?? { row: 0, column: 0 }; const next = { row: Math.max(0, Math.min(this.page.rows.length - 1, point.row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))), column: Math.max(0, Math.min(this.columns.length - 1, point.column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) }; if (event.shiftKey) this.selection.extend(next.row, next.column); else this.selection.start(next.row, next.column); this.renderSelection(); this.viewport.querySelector(`td[data-row="${next.row}"][data-column="${next.column}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

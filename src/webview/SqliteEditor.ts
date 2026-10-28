/*
Purpose: Own SQLite table navigation, typed editing, selection, view preferences and editor commands.
*/
import type { Action, Column, ColumnFilter, Edit, Page, Query, Row, SearchHit, SearchScope, SortKey, Status, Table, Value } from '../protocol';
import { Tooltips } from './Tooltips';
import { HostClient } from './HostClient';
import { Dialog, button, element } from './Dialog';
import { Locale } from './Locale';
import { ColumnFilterPanel } from './ColumnFilterPanel';
import { CellSelection } from './CellSelection';
import { setIcon } from './Icons';
import { applyEdits, format as formatJson, parseTree, type ParseError } from 'jsonc-parser';
import { SqlWorkspace, type SqlPreferences } from './SqlWorkspace';
import { singleLineText, renderCellText } from './CellText';
import { SearchPanel, type SearchPreferences } from './SearchPanel';
import { DatabaseTools } from './DatabaseTools';
type Point = { row: number; column: number };
const PAGE_SIZE = 200;
/** Tips keys for the top-level menus. */
const MENU_TIPS: Record<string, string> = { File: 'Click: save, export, snapshot, or refresh', View: 'Click: table list, columns, and sort order', Edit: 'Click: undo, copy, paste, or set values', Data: 'Click: add, delete, or filter records', Settings: 'Click: change the interface language' };
const MIN_COLUMN_WIDTH = 120;
const MAX_COLUMN_WIDTH = 800;
/** Menu entry: label, action, optional shortcut text, and availability (defaults to enabled). */
type Command = [label: string, action: () => void, shortcut?: string, enabled?: boolean];
type ViewState = { offset: number; pageSize?: number; sort?: Query['sort']; filters?: ColumnFilter[]; widths: Record<string, number>; hidden: string[]; pinned: string[]; order: string[]; scrollTop: number; scrollLeft: number };
type Preferences = { language: 'en' | 'zh-CN'; theme?: 'light' | 'dark'; collapsed: boolean; sidebarWidth: number; table?: string; views: Record<string, ViewState>; sql?: SqlPreferences; search?: SearchPreferences };
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
  private readonly pagination = element('nav', 'pagination');
  private readonly notice = element('div', 'notice');
  private readonly search = element('input', 'table-search');
  private readonly list = element('nav', 'table-list');
  private readonly splitter = element('div', 'sidebar-splitter');
  private readonly errorText = element('span');
  private error = '';
  private tab: 'data' | 'structure' | 'sql' = 'data';
  private sqlWorkspace?: SqlWorkspace;
  private searchPanel?: SearchPanel;
  private searchOrigin?: { table: string; view: ViewState };
  /** Set while search moves the grid selection to a match, so that move does not redefine the Selection scope. */
  private locating = false;
  private readonly navigation: { table: string; view: ViewState }[] = [];
  private readonly selection = new CellSelection();
  private dragAxis?: 'rows' | 'columns';
  private dragging = false;
  private loading = false;
  private generation = 0;
  private activeMenu?: HTMLElement;
  private menuAnchor?: string;
  private tableSearch = '';
  private retry?: () => Promise<void>;
  private readonly narrow = matchMedia('(max-width: 650px)');
  private activeFlush?: () => Promise<void>;
  private busy = false;
  /** Visible column order, memoized per table and view layout. `sources` maps display index to value index. */
  private columnCache?: { table: Table; key: string; columns: Column[]; sources: number[] };
  /** Rendered data cells by page row and display column, reused by selection painting. */
  private cells: HTMLTableCellElement[][] = [];
  private selectionFrame = 0;
  private readonly menuOpeners = new Map<HTMLButtonElement, () => Command[]>();
  private restoreFocus = false;
  private draggedColumn?: string;
  private dropAfter = false;
  private dragImage?: HTMLElement;
  private measurer?: CanvasRenderingContext2D | null;
  private readonly defaultWidths = new Map<string, number>();
  private readonly hint = element('span', 'toolbar-hint');
  private readonly tooltips = new Tooltips(this.hint, (text, params) => this.t(text, params));
  /** Selection to apply after a keyboard page change finishes loading. */
  private pendingCursor?: { row: 'first' | 'last'; column: number };
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readonly queryVersions = new WeakMap<ViewState, number>();
  constructor(private readonly root: HTMLElement, private readonly host: HostClient) {
    const saved = host.getState<Partial<Preferences>>();
    this.preferences = { language: saved?.language === 'zh-CN' ? 'zh-CN' : 'en', theme: saved?.theme, collapsed: saved?.collapsed ?? false, sidebarWidth: saved?.sidebarWidth ?? 200, table: saved?.table, views: saved?.views ?? {}, sql: saved?.sql ?? {}, search: saved?.search ?? {} };
    this.locale = new Locale(this.preferences.language);
    this.host.onStatus = (status, external) => { const refresh = external || this.status.pending > 0 && status.pending === 0; this.status = status; this.renderStatus(); this.renderList(); if (refresh && !this.busy) void this.perform(() => this.loadPage()); };
    this.host.onFlush = async () => { await this.activeFlush?.(); };
    this.root.className = 'sqlite-editor'; this.workspace.append(this.sidebar, this.splitter, this.main);
    this.pagination.setAttribute('aria-label', this.t('Pagination')); this.main.append(this.context, this.notice, this.viewport, this.pagination); this.root.append(this.toolbar, this.workspace, this.footer);
    this.notice.setAttribute('role', 'alert'); this.notice.hidden = true; this.viewport.tabIndex = 0;
    this.viewport.setAttribute('aria-label', 'Database records'); this.footer.setAttribute('role', 'status');
    this.search.type = 'search'; this.search.oninput = () => { this.tableSearch = this.search.value; this.renderList(); };
    this.narrow.addEventListener('change', () => { this.root.classList.remove('sidebar-overlay'); this.closeMenu(); this.renderLayout(); this.renderContext(); this.renderToolbar(); });
    this.splitter.tabIndex = 0; this.splitter.setAttribute('role', 'separator'); this.splitter.setAttribute('aria-orientation', 'vertical'); this.splitter.setAttribute('aria-label', 'Resize table list'); this.splitter.dataset.tooltip = 'Drag or use Left/Right arrows: resize the table list';
    this.splitter.onpointerdown = event => {
      event.preventDefault(); const start = event.clientX; const width = this.preferences.sidebarWidth;
      this.splitter.setPointerCapture(event.pointerId);
      this.splitter.onpointermove = move => { this.preferences.sidebarWidth = Math.max(150, Math.min(400, width + move.clientX - start)); this.renderLayout(); };
      this.splitter.onpointerup = () => { this.splitter.onpointermove = null; this.persist(); };
    };
    this.splitter.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.preferences.sidebarWidth = Math.max(150, Math.min(400, this.preferences.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10))); this.renderLayout(); this.persist(); } };
    this.viewport.onscroll = () => { if (this.table) { this.view.scrollTop = this.viewport.scrollTop; this.view.scrollLeft = this.viewport.scrollLeft; this.schedulePersist(); } };
    new MutationObserver(() => { if (!this.preferences.theme) this.applyTheme(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const endDrag = () => { const wasDragging = this.dragging || this.dragAxis; this.dragging = false; this.dragAxis = undefined; if (wasDragging) this.renderSelection(); };
    window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag);
    document.addEventListener('pointerdown', event => { if (this.activeMenu && !this.activeMenu.contains(event.target as Node) && !(event.target as Element).closest('.menu-button, .table-chooser, .column-filter-button')) this.closeMenu(); });
    document.addEventListener('keydown', event => this.keydown(event));
    this.applyTheme(); this.renderShell();
  }
  async start(): Promise<void> { await this.perform(async () => { const result = await this.host.request({ type: 'metadata' }); this.tables = result.tables ?? []; await this.selectTable(this.preferences.table ?? this.tables[0]?.name); }); }
  private t(text: string, params?: Record<string, string | number>): string { return this.locale.t(text, params); }
  private persist(): void { clearTimeout(this.persistTimer); this.persistTimer = undefined; this.host.setState(this.preferences); }
  /** Scrolling fires continuously; store the position after it settles. */
  private schedulePersist(): void { if (this.persistTimer === undefined) this.persistTimer = setTimeout(() => this.persist(), 250); }
  private get view(): ViewState {
    const name = this.table?.name ?? '';
    if (!Object.hasOwn(this.preferences.views, name)) Object.defineProperty(this.preferences.views, name, { value: { offset: 0, widths: Object.create(null), hidden: [], pinned: [], order: [], scrollLeft: 0, scrollTop: 0 }, writable: true, enumerable: true });
    const view = this.preferences.views[name]!;
    if (Object.getPrototypeOf(view.widths) !== null) view.widths = Object.assign(Object.create(null), view.widths);
    // Earlier versions stored a single sort key object.
    if (view.sort && !Array.isArray(view.sort)) view.sort = [view.sort as unknown as SortKey];
    return view;
  }
  private get pageSize(): number { return this.view.pageSize ?? PAGE_SIZE; }
  private get query(): Query { return { table: this.table?.name ?? '', offset: this.view.offset, limit: this.pageSize, sort: this.view.sort, filters: this.view.filters }; }
  private get columns(): Column[] { return this.columnLayout.columns; }
  private get columnLayout(): { columns: Column[]; sources: number[] } {
    const table = this.table; if (!table) return { columns: [], sources: [] };
    const view = this.view; const key = JSON.stringify([view.hidden, view.pinned, view.order]);
    if (this.columnCache?.table === table && this.columnCache.key === key) return this.columnCache;
    const hidden = new Set(view.hidden); const pinned = new Set(view.pinned); const order = new Map(view.order.map((name, index) => [name, index]));
    const rank = (name: string, index: number) => order.get(name) ?? 10000 + index;
    const entries = table.columns.map((column, index) => ({ column, index })).filter(entry => !hidden.has(entry.column.name))
      .sort((a, b) => Number(pinned.has(b.column.name)) - Number(pinned.has(a.column.name)) || rank(a.column.name, a.index) - rank(b.column.name, b.index));
    this.columnCache = { table, key, columns: entries.map(entry => entry.column), sources: entries.map(entry => entry.index) };
    return this.columnCache;
  }
  /** Saved width, or a first-open width that fits the column name and type line (160–320 px). */
  private width(column: Column): number {
    const saved = this.view.widths[column.name]; if (saved !== undefined) return saved;
    const key = `${this.table?.name ?? ''}\u0000${column.name}`; let width = this.defaultWidths.get(key);
    if (width === undefined) { width = Math.round(Math.max(160, Math.min(320, this.headerWidth(column)))); this.defaultWidths.set(key, width); }
    return width;
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    try { await action(); this.showError(''); } catch (error) { this.retry = action; this.showError(error instanceof Error ? error.message : String(error)); }
  }
  private showError(error: string): void {
    this.error = error; this.notice.hidden = !error;
    this.errorText.textContent = this.t(error);
    this.notice.replaceChildren(this.errorText, button(this.t('Retry'), () => void this.perform(this.retry ?? (() => this.loadPage()))), button('', () => this.showError(''), 'icon-button')); setIcon(this.notice.lastElementChild as HTMLButtonElement, 'close');
    (this.notice.lastElementChild as HTMLButtonElement).setAttribute('aria-label', this.t('Dismiss error'));
  }
  private renderShell(): void {
    this.viewport.setAttribute('aria-label', this.t('Database records')); this.splitter.setAttribute('aria-label', this.t('Resize table list'));
    this.renderToolbar(); this.renderSidebar(); this.renderLayout(); this.renderContext(); this.renderStatus();
  }
  private renderToolbar(): void {
    this.toolbar.replaceChildren(); this.menuOpeners.clear(); this.toolbar.setAttribute('aria-label', this.t('Editor menu'));
    // Item availability is evaluated when a menu opens, so it reflects the current status and selection.
    const commands: [string, () => Command[]][] = [
      ['File', () => [['Save changes', () => void this.run({ type: 'save' }), '⌘/Ctrl S', this.status.pending > 0], ['Import CSV…', () => this.databaseTools().importCsv(), undefined, this.editable], ['Export current view…', () => void this.run({ type: 'export', query: this.query }), undefined, !!this.table], ['Save database snapshot…', () => this.backupDialog()], ['Refresh database', () => void this.run({ type: 'refresh' }), undefined, this.status.pending === 0]]],
      ['View', () => [[this.collapsed ? 'Show table list' : 'Hide table list', () => this.toggleSidebar()], ['Choose columns…', () => this.chooseColumns(), undefined, !!this.table], ['Sort order…', () => this.sortPanel(), undefined, !!this.table && this.tab === 'data'], ['Reset all sorting', () => void this.changeQuery({ sort: undefined }), undefined, !!this.view.sort?.length]]],
      ['Edit', () => [['Undo', () => this.undoRedo(false), '⌘/Ctrl Z', this.canUndo], ['Redo', () => this.undoRedo(true), '⇧⌘/Ctrl Z', this.canRedo], ['Find…', () => this.openSearch('find', true), '⌘/Ctrl F', this.tab !== 'structure' && (!!this.table || this.tab === 'sql')], ['Replace…', () => this.openSearch('replace', true), '⌘/Ctrl R', this.tab !== 'structure' && (!!this.table || this.tab === 'sql')], ['Fill selection…', () => this.fillSelection(), undefined, this.editable && this.hasSelection], ['Fill down', () => void this.fillDown(), '⌘/Ctrl D', this.editable && this.hasSelection], ['Edit record…', () => this.editRecord(), undefined, this.hasSelection], ...(() => { const cell = this.cellCommands(); return [cell.copy, cell.copyHeaders, cell.paste, cell.edit, cell.null, cell.empty]; })(), ['Discard all changes…', () => this.confirmDiscard(), undefined, this.status.pending > 0]]],
      ['Data', () => [['Add record…', () => this.addRecord(), undefined, this.editable], ['Delete selected records…', () => this.deleteRecords(), undefined, this.editable && this.hasSelection], ['Filter…', () => this.filterDialog(), undefined, !!this.table && this.tab === 'data'], ['Duplicate selected records…', () => this.duplicateRecords(), undefined, this.editable && this.hasSelection], ['Open related record…', () => this.relatedRecord(), undefined, this.hasSelection], ['Create table…', () => this.databaseTools().schema('table')], ['Edit structure…', () => this.databaseTools().schema('column'), undefined, !!this.table], ['Database maintenance…', () => this.databaseTools().maintenance()]]],
      ['Settings', () => [['Language', () => {}]]]
    ];
    for (const [label, items] of commands) {
      const control = button(this.t(label), () => this.openMenu(control, items()), 'menu-button'); control.dataset.tooltip = MENU_TIPS[label] ?? '';
      control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false');
      control.onmouseenter = () => { if (control.getAttribute('aria-expanded') !== 'true' && this.toolbar.querySelector('[aria-expanded="true"]')) this.openMenu(control, items()); };
      // Left/Right move between top-level menus and keep the menu open if one is already open.
      control.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (control.getAttribute('aria-expanded') !== 'true') this.openMenu(control, items()); } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.adjacentMenu(control, event.key === 'ArrowRight' ? 1 : -1, control.getAttribute('aria-expanded') === 'true'); } };
      this.menuOpeners.set(control, items);
      this.toolbar.append(control);
    }
    const undo = button('', () => this.undoRedo(false), 'undo-button icon-button'); setIcon(undo, 'undo'); undo.dataset.tooltip = 'Click: undo the last unsaved change'; undo.title = this.t('Undo'); undo.setAttribute('aria-label', this.t('Undo'));
    const redo = button('', () => this.undoRedo(true), 'redo-button icon-button'); setIcon(redo, 'redo'); redo.dataset.tooltip = 'Click: redo the undone change'; redo.title = this.t('Redo'); redo.setAttribute('aria-label', this.t('Redo'));
    const hint = this.hint; this.tooltips.refresh();
    const help = button('', () => this.help(), 'icon-button'); setIcon(help, 'help'); help.dataset.tooltip = 'Click: open the quick guide'; help.setAttribute('aria-label', this.t('Help')); help.title = this.t('Quick guide');
    const theme = button('', () => { this.preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; this.applyTheme(); this.persist(); }, 'icon-button theme-button'); theme.dataset.tooltip = 'Click: switch between light and dark themes'; theme.setAttribute('aria-label', this.t('Toggle theme')); theme.title = this.t('Toggle theme');
    setIcon(theme, document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    this.toolbar.append(undo, redo, hint, help, theme);
  }
  private openMenu(control: HTMLButtonElement, items: Command[]): void {
    if (control.getAttribute('aria-expanded') === 'true') { this.closeMenu(); return; }
    this.closeMenu(); const menu = this.commandMenu(items, control);
    if (items.some(item => item[0] === 'Language')) this.languageSubmenu(menu, menu.querySelector('button')!);
    document.body.append(menu); this.activeMenu = menu; control.setAttribute('aria-expanded', 'true');
    const rect = control.getBoundingClientRect(); menu.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${rect.bottom}px`;
    menu.querySelector<HTMLButtonElement>(':scope > button:enabled')?.focus();
    const keys = menu.onkeydown!;
    menu.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); this.adjacentMenu(control, event.key === 'ArrowRight' ? 1 : -1, true); return; } keys.call(menu, event); };
  }
  private adjacentMenu(control: HTMLButtonElement, direction: number, open: boolean): void {
    const controls = [...this.menuOpeners.keys()].filter(item => item.isConnected); const next = controls[(controls.indexOf(control) + direction + controls.length) % controls.length]; if (!next) return;
    this.closeMenu(); next.focus(); if (open) this.openMenu(next, this.menuOpeners.get(next)!());
  }
  /** Build a menu whose keyboard model skips disabled items and returns focus to its opener on Escape. */
  private commandMenu(items: Command[], opener?: HTMLElement): HTMLDivElement {
    const menu = element('div', 'command-menu'); menu.setAttribute('role', 'menu');
    for (const [label, action, shortcut, enabled = true] of items) {
      const item = button('', () => { this.closeMenu(); action(); }); item.setAttribute('role', 'menuitem'); item.setAttribute('aria-label', this.t(label)); item.disabled = !enabled;
      item.append(element('span', '', this.t(label))); if (shortcut) { const hint = element('span', 'shortcut', shortcut); hint.setAttribute('aria-hidden', 'true'); item.append(hint); } menu.append(item);
    }
    menu.onkeydown = event => {
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>(':scope > button:enabled')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length]?.focus(); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeMenu(); (opener ?? this.viewport).focus({ preventScroll: true }); }
      else if (event.key === 'Tab') this.closeMenu();
    };
    // Closing on focus loss keeps Tab and programmatic focus moves from leaving a stale menu open.
    menu.addEventListener('focusout', event => { const next = event.relatedTarget as Node | null; if (next && !menu.contains(next) && this.activeMenu === menu) this.closeMenu(); });
    return menu;
  }
  private closeMenu(): void { this.activeMenu?.remove(); this.activeMenu = undefined; this.menuAnchor = undefined; this.root.querySelectorAll('[aria-expanded]').forEach(node => node.setAttribute('aria-expanded', 'false')); }
  /** Preserve a header opener while its popup is in use, including after a query redraws the grid. */
  private retainMenuAnchor(control?: HTMLElement): void { this.menuAnchor = control?.dataset.menuAnchor; this.updateMenuAnchor(); }
  private updateMenuAnchor(): void {
    this.viewport.querySelectorAll<HTMLElement>('[data-menu-anchor]').forEach(control => control.setAttribute('aria-expanded', String(control.dataset.menuAnchor === this.menuAnchor)));
  }
  /** Follow the VS Code theme class on body unless the user chose a theme; fall back to the system scheme. */
  private applyTheme(): void {
    const classes = document.body.classList;
    const host = classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light') ? 'light' : classes.contains('vscode-dark') || classes.contains('vscode-high-contrast') ? 'dark' : undefined;
    const theme = this.preferences.theme ?? host ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
    // The icon shows the theme the button switches to.
    const control = this.toolbar.querySelector<HTMLButtonElement>('.theme-button'); if (control) setIcon(control, theme === 'dark' ? 'sun' : 'moon');
  }
  private get collapsed(): boolean { return this.preferences.collapsed || this.narrow.matches; }
  private toggleSidebar(): void { this.preferences.collapsed = !this.collapsed; if (this.narrow.matches && !this.preferences.collapsed) this.root.classList.toggle('sidebar-overlay'); this.renderLayout(); this.renderToolbar(); this.renderContext(); this.persist(); }
  private renderLayout(): void { const visible = !this.collapsed || this.root.classList.contains('sidebar-overlay'); this.sidebar.hidden = !visible; this.splitter.hidden = !visible || this.narrow.matches; this.root.style.setProperty('--sidebar-width', `${this.preferences.sidebarWidth}px`); }
  private renderSidebar(): void {
    const heading = element('header', 'sidebar-heading'); heading.append(element('strong', '', this.t('Tables')));
    const collapse = button('', () => { this.root.classList.remove('sidebar-overlay'); this.preferences.collapsed = true; this.renderLayout(); this.renderContext(); this.persist(); }, 'icon-button'); setIcon(collapse, 'chevronLeft'); collapse.dataset.tooltip = 'Click: hide the table list'; collapse.title = this.t('Hide table list'); collapse.setAttribute('aria-label', this.t('Hide table list'));
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
        item.setAttribute('aria-current', String(table.name === this.table?.name)); item.title = table.name; item.dataset.tooltip = 'Click: open this table · Pending changes are kept when switching'; this.list.append(item);
      }
    }
    if (!count) this.list.append(element('p', 'empty-note', this.t('No matching tables')));
  }
  private renderContext(): void {
    this.context.replaceChildren();
    if (this.collapsed) {
      const expand = button('', () => this.toggleSidebar(), 'icon-button'); setIcon(expand, 'chevronRight'); expand.dataset.tooltip = 'Click: show the table list'; expand.title = this.t('Show table list'); expand.setAttribute('aria-label', this.t('Show table list')); this.context.append(expand);
      const chooser = button(this.table?.name ?? this.t('Select table'), () => this.tableChooser(), 'table-chooser'); chooser.append(element('span', '', ' ▾')); chooser.setAttribute('aria-label', this.t('Select table')); chooser.setAttribute('aria-haspopup', 'dialog'); chooser.setAttribute('aria-expanded', 'false'); chooser.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); this.tableChooser(); } }; this.context.append(chooser);
    } else this.context.append(element('strong', 'current-table', this.table?.name ?? this.t('Tables')));
    const tabs = element('nav', 'tabs'); tabs.setAttribute('aria-label', this.t('Table view'));
    for (const [tab, label] of [['data', 'Data'], ['structure', 'Structure'], ['sql', 'SQL Query']] as const) { const item = button(this.t(label), () => { if (this.tab !== tab) this.searchPanel?.close(); this.tab = tab; this.renderContext(); this.renderContent(); this.renderStatus(); }, 'tab'); item.setAttribute('aria-pressed', String(this.tab === tab)); tabs.append(item); }
    const actions = element('div', 'table-actions');
    if (this.navigation.length) actions.append(button(this.t('Back'), () => void this.goBack()));
    this.context.append(tabs, actions);
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
    this.searchPanel?.close(); this.searchOrigin = undefined;
    if (this.tab === 'sql') this.tab = 'data';
    const table = this.tables.find(table => table.name === name) ?? this.tables[0]; if (table !== this.table) this.page = { rows: [], hasMore: false, offset: 0 }; this.table = table; this.preferences.table = table?.name; this.selection.clear(); this.root.classList.remove('sidebar-overlay'); this.persist(); this.renderShell(); this.renderContent(); await this.loadPage();
  }
  private async loadPage(): Promise<void> {
    const generation = ++this.generation; const table = this.table; if (!table) { this.renderContent(); return; }
    // Inert blocks interaction with stale records but drops focus; remember it so keyboard work continues after the load.
    const hadFocus = this.viewport.contains(document.activeElement) || this.restoreFocus; this.restoreFocus = hadFocus;
    this.loading = true; this.viewport.inert = true; this.renderStatus(); this.viewport.setAttribute('aria-busy', 'true');
    try { const result = await this.host.request({ type: 'page', query: this.query }); if (generation !== this.generation || table !== this.table) return; const next = result.page ?? { rows: [], hasMore: false, offset: 0 }; const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected && (selected.columns.some(column => column >= this.columns.length) || selected.ranges.some(range => Array.from({ length: range.count }, (_, index) => range.start + index).some(row => !next.rows[row] || this.page.rows[row]?.key !== next.rows[row]?.key)))) this.selection.clear(); this.page = next;
      const cursor = this.pendingCursor; this.pendingCursor = undefined;
      if (cursor && next.rows.length) { this.selection.clear(); this.selection.start(cursor.row === 'first' ? 0 : next.rows.length - 1, Math.min(cursor.column, this.columns.length - 1)); }
      this.renderContent(); if (cursor) this.revealCursor(); }
    finally {
      if (generation === this.generation) {
        this.loading = false; this.viewport.inert = false; this.viewport.setAttribute('aria-busy', 'false'); this.renderStatus();
        if (this.restoreFocus && (document.activeElement === document.body || !document.activeElement)) this.viewport.focus({ preventScroll: true });
        this.restoreFocus = false;
      }
    }
  }
  private renderContent(): void {
    if (this.tab === 'sql') {
      this.sqlWorkspace ??= new SqlWorkspace(this.host, this.locale, () => this.tables, () => this.status, () => this.refreshMetadata(), this.preferences.sql, () => this.schedulePersist(), () => this.renderStatus());
      this.viewport.replaceChildren(this.sqlWorkspace.root); this.viewport.classList.add('sql-viewport'); return;
    }
    this.viewport.classList.remove('sql-viewport'); this.viewport.replaceChildren(); this.cells = [];
    if (!this.table) { this.viewport.append(element('p', 'empty-state', this.t('Select a table to view its records.'))); return; }
    if (this.tab === 'structure') { this.renderStructure(); return; }
    // Resolve the display layout once per render instead of once per row or cell.
    const { columns, sources } = this.columnLayout; const pinned = new Set(this.view.pinned); const sorts = this.view.sort ?? [];
    const grid = element('table', 'data-grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', this.table.name); const head = element('thead'); const headings = element('tr');
    const corner = element('th', 'row-number'); corner.dataset.tooltip = 'Click: select all loaded cells'; const all = button('#', () => { if (this.page.rows.length && this.columns.length) { this.selection.selectAll(); this.renderSelection(); } }); all.setAttribute('aria-label', this.t('Select all loaded cells')); corner.append(all); headings.append(corner);
    for (const [columnIndex, column] of columns.entries()) {
      const th = element('th'); th.dataset.headerColumn = String(columnIndex); const width = this.width(column); th.style.width = th.style.minWidth = th.style.maxWidth = `${width}px`;
      // Drop targets show which side of the column the dragged column will land on.
      const updateDropTarget = (event: DragEvent) => {
        if (this.draggedColumn === undefined) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        this.viewport.querySelectorAll('th.drop-target').forEach(target => { if (target !== th) target.classList.remove('drop-target', 'drop-before', 'drop-after'); });
        const rect = th.getBoundingClientRect(); this.dropAfter = event.clientX > rect.left + rect.width / 2;
        th.classList.add('drop-target'); th.classList.toggle('drop-before', !this.dropAfter); th.classList.toggle('drop-after', this.dropAfter);
      };
      th.ondragenter = updateDropTarget; th.ondragover = updateDropTarget;
      th.ondragleave = event => { if (event.relatedTarget instanceof Node && th.contains(event.relatedTarget)) return; th.classList.remove('drop-target', 'drop-before', 'drop-after'); };
      th.ondrop = event => {
        event.preventDefault(); const source = this.draggedColumn; const after = this.dropAfter; this.endColumnDrag();
        if (!source || source === column.name || !this.table!.columns.some(item => item.name === source)) return;
        const order = this.columns.map(item => item.name).filter(name => name !== source); order.splice(order.indexOf(column.name) + (after ? 1 : 0), 0, source);
        // Pinned columns stay grouped first, so the display order only changes within the current group.
        this.view.order = order; this.selection.clear(); this.persist(); this.renderContent();
      };
      // Active tools remain visible; hovering or focusing the header reveals every tool.
      const sortIndex = sorts.findIndex(item => item.column === column.name); const sortKey = sorts[sortIndex]; const filtered = !!this.view.filters?.some(item => item.column === column.name);
      const label = button('', () => {}, 'column-label'); label.setAttribute('aria-label', this.t('Select column {column}', { column: column.name })); label.title = `${column.name} · ${column.type || 'ANY'}${column.pk ? ' · PK' : ''}${column.generated ? ` · ${this.t('generated')}` : ''}`;
      label.dataset.tooltip = 'Click: select column · Shift or Ctrl/Cmd: extend or add · Hover: show column tools';
      const meta = element('span', 'column-meta'); if (column.pk) meta.append(element('span', 'column-pk', 'PK')); meta.append(element('span', 'column-type', column.type || 'ANY'));
      label.append(element('span', 'column-name', column.name), meta);
      label.onpointerdown = event => this.startAxis(event, 'columns', columnIndex); label.onpointerenter = () => { if (this.dragAxis === 'columns') { this.selection.extendAxis(columnIndex); this.scheduleSelection(); } }; label.onclick = event => { if (!event.detail) { this.selection.startAxis('columns', columnIndex, event.ctrlKey || event.metaKey, event.shiftKey); this.renderSelection(); } };
      const sort = button('', () => void this.cycleSort(column.name), 'sort-button header-icon'); setIcon(sort, sortKey ? (sortKey.direction === 'ASC' ? 'ascending' : 'descending') : 'sort');
      if (sortKey && sorts.length > 1) sort.append(element('span', 'sort-rank', String(sortIndex + 1)));
      sort.title = this.t('Sort {column}', { column: column.name }); sort.dataset.tooltip = 'Click: add to sort, then ascending, descending, off · Right-click: all sort columns'; sort.setAttribute('aria-label', this.t('Sort {column}', { column: column.name }));
      if (sortKey) { sort.classList.add('applied'); th.setAttribute('aria-sort', sortKey.direction === 'ASC' ? 'ascending' : 'descending'); }
      const sortOptions = (event: MouseEvent | KeyboardEvent) => { event.preventDefault(); this.sortPanel(sort); }; sort.oncontextmenu = sortOptions; sort.onkeydown = event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) sortOptions(event); };
      const filter = button('', () => this.filterDialog(column.name, filter), 'column-filter-button header-icon'); setIcon(filter, 'filter'); filter.title = this.t('Filter {column}', { column: column.name }); filter.dataset.tooltip = 'Click: filter this column · Filters on different columns combine with AND'; filter.setAttribute('aria-label', this.t('Filter {column}', { column: column.name })); if (filtered) filter.classList.add('applied');
      const drag = button('', () => {}, 'column-drag-handle header-icon'); setIcon(drag, 'move'); drag.draggable = true; drag.setAttribute('aria-label', this.t('Reorder column {column}', { column: column.name })); drag.title = this.t('Drag: reorder display columns'); drag.dataset.tooltip = 'Drag: reorder display columns · The column order in the database does not change'; drag.ondragstart = event => this.startColumnDrag(event, column, th, columnIndex); drag.ondragend = () => this.endColumnDrag();
      const options = button('', () => this.columnMenu(column, options), 'column-options header-icon'); setIcon(options, 'more'); options.title = this.t('Column options {column}', { column: column.name }); options.dataset.tooltip = 'Click: sort, filter, pin, or hide this column'; options.setAttribute('aria-label', this.t('Column options {column}', { column: column.name })); options.setAttribute('aria-haspopup', 'menu');
      const tools = element('div', 'column-tools'); tools.append(sort, filter, drag, options);
      for (const [kind, control] of [['sort', sort], ['filter', filter], ['options', options]] as const) {
        control.dataset.menuAnchor = JSON.stringify([this.table.name, column.name, kind]); control.setAttribute('aria-haspopup', kind === 'options' ? 'menu' : 'dialog');
      }
      const content = element('div', 'column-heading'); content.append(label, tools); th.append(content);
      const resize = element('div', 'column-resize'); resize.title = this.t('Drag: resize column · Double-click: fit content'); resize.dataset.tooltip = 'Drag: resize column · Double-click: fit content'; resize.setAttribute('aria-hidden', 'true');
      resize.onpointerdown = event => this.resizeColumn(event, column, th, resize); resize.ondblclick = event => { event.preventDefault(); event.stopPropagation(); this.fitColumns(columnIndex); }; th.append(resize);
      if (pinned.has(column.name)) th.classList.add('pinned');
      headings.append(th);
    }
    head.append(headings); grid.append(head); const body = element('tbody');
    this.page.rows.forEach((row, rowIndex) => {
      const tr = element('tr'); if (row.deleted) tr.classList.add('deleted'); if (row.inserted) tr.classList.add('inserted');
      const number = this.page.offset + rowIndex + 1;
      const rowNumber = element('th', 'row-number'); rowNumber.dataset.headerRow = String(rowIndex); const rowButton = button(String(number), () => {}); rowButton.dataset.tooltip = 'Click: select record · Drag: select records · Shift or Ctrl/Cmd: extend or add'; rowButton.onpointerdown = event => this.startAxis(event, 'rows', rowIndex); rowButton.onpointerenter = () => { if (this.dragAxis === 'rows') { this.selection.extendAxis(rowIndex); this.scheduleSelection(); } }; rowButton.onclick = event => { if (!event.detail) { this.selection.startAxis('rows', rowIndex, event.ctrlKey || event.metaKey, event.shiftKey); this.renderSelection(); } }; rowButton.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); this.rowMenu(rowIndex, event.clientX, event.clientY, rowButton); }; rowButton.onkeydown = event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); const rect = rowButton.getBoundingClientRect(); this.rowMenu(rowIndex, rect.left, rect.bottom, rowButton); } }; rowButton.setAttribute('aria-label', this.t('Record {number}', { number })); rowNumber.append(rowButton); tr.append(rowNumber);
      const cells: HTMLTableCellElement[] = [];
      columns.forEach((column, columnIndex) => {
        const value = row.values[sources[columnIndex]!]!; const cell = element('td'); renderCellText(cell, this.display(value)); cell.dataset.row = String(rowIndex); cell.dataset.column = String(columnIndex); cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(columnIndex + 1)); cell.setAttribute('aria-rowindex', String(rowIndex + 1)); cell.title = `${column.name} · ${value.type}${value.type === 'blob' ? ` · ${this.t('{count} bytes', { count: Math.floor(value.value.length / 2).toLocaleString() })}` : ''}`;
        if (value.type === 'null' || value.type === 'blob') cell.classList.add('special-value'); if (row.modified || row.inserted) cell.classList.add('modified');
        if (pinned.has(column.name)) cell.classList.add('pinned');
        cells.push(cell); tr.append(cell);
      }); this.cells.push(cells); body.append(tr);
    });
    // Delegate cell events to the body: one listener set per render instead of four closures per cell.
    const cellAt = (event: Event): Point | undefined => { const cell = (event.target as Element | null)?.closest?.<HTMLTableCellElement>('td[data-row]'); return cell ? { row: Number(cell.dataset.row), column: Number(cell.dataset.column) } : undefined; };
    body.onpointerdown = event => { const hit = cellAt(event); if (!hit || event.button !== 0) return; event.preventDefault(); this.dragAxis = undefined;
      if (event.ctrlKey || event.metaKey) { try { this.selection.toggle(hit.row, hit.column, this.page.rows.length, this.columns.length); } catch (error) { this.showError(error instanceof Error ? error.message : String(error)); } this.dragging = false; }
      else { if (event.shiftKey) this.selection.extend(hit.row, hit.column); else this.selection.start(hit.row, hit.column); this.dragging = true; }
      this.viewport.focus({ preventScroll: true }); this.renderSelection(); };
    body.onpointerover = event => { if (!this.dragging) return; const hit = cellAt(event); if (hit) { this.selection.extend(hit.row, hit.column); this.scheduleSelection(); } };
    body.ondblclick = event => { if (cellAt(event)) this.editCell(); }; body.dataset.tooltip = 'Click and drag: select cells · Double-click, Enter or F2: edit · Right-click: options';
    body.oncontextmenu = event => { const hit = cellAt(event); if (!hit) return; event.preventDefault(); if (event.ctrlKey || event.metaKey) return; if (!this.selected(hit.row, hit.column)) { this.selection.start(hit.row, hit.column); this.renderSelection(); } this.cellMenu(event.clientX, event.clientY); };
    grid.append(body); this.viewport.append(grid); this.updateMenuAnchor(); this.updateColumnGeometry();
    if (!this.page.rows.length) this.viewport.append(element('p', 'empty-state', `${this.t('No records')} · ${this.t('Add a record or change the filter.')}`));
    if (!this.table.editable || this.status.readOnly) this.viewport.append(element('p', 'read-only-note', this.t('Read-only: {reason}', { reason: this.t(this.table.reason ?? 'Read-only database') })));
    this.viewport.scrollTop = this.view.scrollTop; this.viewport.scrollLeft = this.view.scrollLeft; this.renderSelection();
  }
  /** Start a display-only column move with a ghost of the header and visible cells, like Neat CSV. */
  private startColumnDrag(event: DragEvent, column: Column, heading: HTMLTableCellElement, index: number): void {
    this.dragAxis = undefined; this.dragging = false; this.closeMenu(); this.draggedColumn = column.name;
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', column.name); }
    this.dragImage?.remove();
    const viewport = this.viewport.getBoundingClientRect(); const headingRect = heading.getBoundingClientRect(); const width = headingRect.width;
    const image = element('div', 'column-drag-image'); image.style.width = `${width}px`; image.style.height = `${Math.max(headingRect.height, viewport.bottom - headingRect.top)}px`;
    const header = heading.cloneNode(true) as HTMLElement; header.querySelector('.column-resize')?.remove(); header.classList.remove('pinned', 'axis-selected', 'drop-target', 'drop-before', 'drop-after'); header.removeAttribute('data-header-column'); header.setAttribute('aria-hidden', 'true'); image.setAttribute('aria-hidden', 'true');
    Object.assign(header.style, { position: 'absolute', left: '0', top: '0', width: `${width}px`, height: `${headingRect.height}px` }); image.append(header);
    for (const row of this.cells) {
      const cell = row[index]; if (!cell) continue; const rect = cell.getBoundingClientRect();
      if (rect.bottom <= headingRect.bottom || rect.top >= viewport.bottom) continue;
      const copy = cell.cloneNode(true) as HTMLElement; copy.classList.remove('pinned', 'selected', 'selection-top', 'selection-bottom', 'selection-left', 'selection-right'); copy.removeAttribute('data-row'); copy.removeAttribute('data-column');
      Object.assign(copy.style, { position: 'absolute', left: '0', top: `${rect.top - headingRect.top}px`, width: `${width}px`, height: `${rect.height}px` }); image.append(copy);
    }
    this.root.append(image); this.dragImage = image;
    event.dataTransfer?.setDragImage(image, Math.min(width - 1, Math.max(0, event.clientX - headingRect.left)), Math.max(0, event.clientY - headingRect.top));
    // The source column stays in place, dimmed, until the drop decides its new position.
    requestAnimationFrame(() => { if (this.draggedColumn !== column.name) return; heading.classList.add('dragging'); for (const row of this.cells) row[index]?.classList.add('column-dragging'); });
  }
  private endColumnDrag(): void {
    this.draggedColumn = undefined; this.dropAfter = false; this.dragImage?.remove(); this.dragImage = undefined;
    this.viewport.querySelectorAll('.dragging, .drop-target, .column-dragging').forEach(node => node.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after', 'column-dragging'));
  }
  /** Apply column widths and sticky offsets in place, so resizing does not rebuild the grid. */
  private updateColumnGeometry(): void {
    const grid = this.viewport.querySelector<HTMLTableElement>('table.data-grid'); if (!grid) return;
    const headers = grid.tHead?.rows[0]?.cells; const pinned = new Set(this.view.pinned); let total = 48; let left = 48;
    this.columns.forEach((column, index) => {
      const width = this.width(column); total += width; if (!pinned.has(column.name)) return;
      const offset = `${left}px`; const heading = headers?.[index + 1]; if (heading) heading.style.left = offset;
      for (const row of this.cells) { const cell = row[index]; if (cell) cell.style.left = offset; }
      left += width;
    });
    // Scroll padding keeps keyboard-revealed cells clear of the sticky header and pinned columns.
    grid.style.width = `${total}px`; this.viewport.style.scrollPaddingLeft = `${left}px`;
  }
  private setColumnWidth(column: Column, heading: HTMLTableCellElement, width: number): void {
    const next = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width))); this.view.widths[column.name] = next;
    heading.style.width = heading.style.minWidth = heading.style.maxWidth = `${next}px`; this.updateColumnGeometry();
  }
  private resizeColumn(event: PointerEvent, column: Column, heading: HTMLTableCellElement, handle: HTMLElement): void {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); this.closeMenu();
    const start = event.clientX; const width = this.width(column); let moved = false; handle.setPointerCapture(event.pointerId);
    // A small threshold keeps a double-click (auto-fit) from also nudging the width.
    const move = (next: PointerEvent) => { if (!moved && Math.abs(next.clientX - start) < 3) return; moved = true; this.setColumnWidth(column, heading, width + next.clientX - start); };
    const finish = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish); if (moved) this.persist(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  }
  /** A full-page selection fits all visible columns independently to their content. */
  private fitColumns(index: number): void {
    const columns = this.columns;
    if (this.selection.isAll(this.page.rows.length, columns.length)) columns.forEach((column, columnIndex) => this.fitColumn(column, columnIndex));
    else this.fitColumn(columns[index]!, index);
    this.persist();
  }
  /** Fit a column to its header and the loaded page values, measured with the grid font. */
  private fitColumn(column: Column, index: number): void {
    const heading = this.viewport.querySelector<HTMLTableCellElement>(`th[data-header-column="${index}"]`); const context = this.measureContext(); if (!heading || !context) return;
    const source = this.columnLayout.sources[index]!; context.font = getComputedStyle(this.cells[0]?.[index] ?? heading).font; let width = 0;
    for (const row of this.page.rows) width = Math.max(width, context.measureText(singleLineText(this.display(row.values[source]!)).slice(0, 1000)).width);
    // Tools only appear on hover, so the header needs room for the name and its type line only.
    this.setColumnWidth(column, heading, Math.max(width + 18, this.headerWidth(column)));
  }
  private measureContext(): CanvasRenderingContext2D | null { this.measurer ??= document.createElement('canvas').getContext('2d'); return this.measurer; }
  private headerWidth(column: Column): number {
    const context = this.measureContext(); if (!context) return 160; const font = getComputedStyle(document.body).fontFamily;
    context.font = `600 12px ${font}`; const name = context.measureText(column.name).width;
    context.font = `10px ${font}`; const meta = context.measureText(`${column.pk ? 'PK ' : ''}${column.type || 'ANY'} ↑16`).width;
    return Math.max(name, meta) + 24;
  }
  private display(value: Value): string { return value.type === 'null' ? 'NULL' : value.type === 'blob' ? `BLOB · ${Math.floor(value.value.length / 2).toLocaleString()} B` : value.value; }
  private renderStructure(): void {
    const panel = element('div', 'structure'); const actions = element('div', 'tool-actions');
    const addColumn = button(this.t('Add column…'), () => this.databaseTools().column('add')); addColumn.disabled = !this.table?.editable || this.status.readOnly || this.table?.kind !== 'table'; actions.append(addColumn);
    actions.append(button(this.t('Edit structure…'), () => this.databaseTools().schema('column')), button(this.t('Create table…'), () => this.databaseTools().schema('table'))); panel.append(actions); const table = element('table', 'structure-table'); const head = element('tr');
    for (const label of ['Column', 'Type', 'Not null', 'Default', 'Primary key', 'Generated', 'Actions']) head.append(element('th', '', this.t(label))); const thead = element('thead'); thead.append(head); table.append(thead);
    const body = element('tbody'); for (const column of this.table!.columns) { const row = element('tr'); for (const text of [column.name, column.type || 'ANY', column.notNull ? '✓' : '—', column.defaultValue ?? '—', column.pk ? String(column.pk) : '—', column.generated ? '✓' : '—']) row.append(element('td', '', text)); const controls = element('td'); const rename = button(this.t('Rename…'), () => this.databaseTools().column('rename', column), 'structure-action'); rename.setAttribute('aria-label', this.t('Rename column {column}', { column: column.name })); const remove = button(this.t('Delete…'), () => this.databaseTools().column('delete', column), 'structure-action'); remove.setAttribute('aria-label', this.t('Delete column {column}', { column: column.name })); rename.disabled = remove.disabled = !this.table?.editable || this.status.readOnly || this.table?.kind !== 'table'; controls.append(rename, remove); row.append(controls); body.append(row); } table.append(body); panel.append(table);
    type IndexInfo = { name: string; unique: number; origin: string }; type KeyInfo = { id: number; table: string; from: string; to: string | null; on_update: string; on_delete: string };
    const indexes = (this.table!.indexes as IndexInfo[]).map(index => `${index.name}${index.unique ? ' · UNIQUE' : ''}${index.origin === 'pk' ? ' · PRIMARY KEY' : index.origin === 'u' ? ' · UNIQUE constraint' : ''}`);
    const groups = new Map<number, KeyInfo[]>(); for (const key of this.table!.foreignKeys as KeyInfo[]) groups.set(key.id, [...(groups.get(key.id) ?? []), key]);
    const keys = [...groups.values()].map(group => `(${group.map(key => key.from).join(', ')}) → ${group[0]!.table}(${group.map(key => key.to ?? '').join(', ')})${group[0]!.on_delete && group[0]!.on_delete !== 'NO ACTION' ? ` · ON DELETE ${group[0]!.on_delete}` : ''}${group[0]!.on_update && group[0]!.on_update !== 'NO ACTION' ? ` · ON UPDATE ${group[0]!.on_update}` : ''}`);
    for (const [title, values, empty] of [['Indexes', indexes, 'No indexes'], ['Foreign keys', keys, 'No foreign keys']] as const) { panel.append(element('h3', '', this.t(title))); if (!values.length) { panel.append(element('p', 'muted', this.t(empty))); continue; } const list = element('ul', 'structure-list'); for (const value of values) list.append(element('li', '', value)); panel.append(list); }
    panel.append(element('h3', '', this.t('Create SQL')), element('pre', '', this.table!.sql)); this.viewport.append(panel);
  }
  private renderStatus(): void {
    this.pagination.replaceChildren(); this.pagination.hidden = this.tab !== 'data' || !this.table; this.footer.replaceChildren(); const pending = element('span', 'pending-status', this.status.pending ? this.t('Unsaved changes: {count}', { count: this.status.pending }) : this.t('No unsaved changes')); this.footer.append(pending);
    if (this.loading) this.footer.append(element('span', 'muted', this.page.rows.length ? this.t('Updating…') : this.t('Loading…')));
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected) this.footer.append(element('span', 'selection-status', `${this.t('Selected cells: {count}', { count: (selected.cells?.length ?? selected.rowCount * selected.columnCount).toLocaleString() })}${this.selectionStatistics()}`));
    const spacer = element('span', 'status-spacer'); this.footer.append(spacer);
    if (this.table && this.tab === 'data') {
      const previous = button(this.t('Previous page'), () => this.changePage(-1)); previous.disabled = this.view.offset === 0 || this.loading; previous.dataset.tooltip = 'Click: previous page';
      const next = button(this.t('Next page'), () => this.changePage(1)); next.disabled = !this.page.hasMore || this.loading; next.dataset.tooltip = 'Click: next page · Arrow Down on the last record also continues';
      const rows = element('span', 'row-status', this.t('Rows: {start}–{end}', { start: this.page.rows.length ? this.page.offset + 1 : 0, end: this.page.offset + this.page.rows.length }));
      const page = button(this.t('Page {page}', { page: Math.floor(this.view.offset / this.pageSize) + 1 }), () => this.jumpPage()); page.setAttribute('aria-label', this.t('Go to page…'));
      const size = element('select'); size.setAttribute('aria-label', this.t('Rows per page')); for (const count of [50, 100, 200, 500]) { const option = element('option', '', this.t('{count} / page', { count })); option.value = String(count); size.append(option); } size.value = String(this.pageSize); size.disabled = this.loading; size.onchange = () => { this.view.pageSize = Number(size.value); this.view.offset = 0; this.selection.clear(); this.persist(); void this.perform(() => this.loadPage()); };
      this.pagination.append(rows, previous, page, next, size);
    }
    const undo = this.toolbar.querySelector<HTMLButtonElement>('.undo-button'); if (undo) undo.disabled = !this.canUndo || this.busy; const redo = this.toolbar.querySelector<HTMLButtonElement>('.redo-button'); if (redo) redo.disabled = !this.canRedo || this.busy;
  }
  /** Move one page; `cursor` places the keyboard selection on the new page once it loads. */
  private changePage(direction: 1 | -1, cursor?: { row: 'first' | 'last'; column: number }): void {
    if (this.loading || !this.table || (direction > 0 ? !this.page.hasMore : this.view.offset === 0)) return;
    this.view.offset = Math.max(0, this.view.offset + direction * this.pageSize); this.selection.clear(); this.view.scrollTop = 0; this.pendingCursor = cursor;
    void this.perform(() => this.loadPage());
  }
  private get cursor(): Point | undefined { const position = this.selection.position; if (position && this.selected(position.row, position.col)) return { row: position.row, column: position.col }; const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (selected?.cells?.length) return { row: selected.cells[0]!.row, column: selected.cells[0]!.col }; return selected?.ranges.length && selected.columns.length ? { row: selected.ranges[0]!.start, column: selected.columns[0]! } : undefined; }
  /** Numeric summary for up to 1,000 selected cells; integers use BigInt so 64-bit sums stay exact. */
  private selectionStatistics(): string {
    if (this.dragging || this.dragAxis) return '';
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected || !this.table || (selected.cells?.length ?? selected.rowCount * selected.columnCount) > 1000) return '';
    const values = this.points().filter(point => this.page.rows[point.row] && this.columns[point.column]).map(point => this.getValue(point)).filter(value => value.type === 'integer' || value.type === 'real');
    if (!values.length) return '';
    const approximate = (value: number) => String(Number(value.toPrecision(12)));
    if (values.every(value => value.type === 'integer')) {
      const numbers = values.map(value => BigInt(value.value)); const sum = numbers.reduce((total, value) => total + value, 0n);
      const min = numbers.reduce((low, value) => value < low ? value : low); const max = numbers.reduce((high, value) => value > high ? value : high);
      const average = sum % BigInt(numbers.length) === 0n ? String(sum / BigInt(numbers.length)) : `≈${approximate(Number(sum) / numbers.length)}`;
      return ` · ${[this.t('Sum: {sum}', { sum: String(sum) }), this.t('Average: {value}', { value: average }), this.t('Min: {value}', { value: String(min) }), this.t('Max: {value}', { value: String(max) })].join(' · ')}`;
    }
    if (values.some(value => value.type === 'integer' && !Number.isSafeInteger(Number(value.value)))) return ` · ${this.t('Numeric: {count}', { count: values.length })}`;
    // Min and Max show the stored text of the extreme values, so they are never rounded.
    const numbers = values.map(value => ({ number: Number(value.value), text: value.value })); const sum = numbers.reduce((total, value) => total + value.number, 0);
    const min = numbers.reduce((low, value) => value.number < low.number ? value : low); const max = numbers.reduce((high, value) => value.number > high.number ? value : high);
    if (!Number.isFinite(sum)) return ` · ${this.t('Numeric: {count}', { count: values.length })}`;
    return ` · ${[this.t('Sum: ≈{sum}', { sum: approximate(sum) }), this.t('Average: {value}', { value: `≈${approximate(sum / numbers.length)}` }), this.t('Min: {value}', { value: min.text }), this.t('Max: {value}', { value: max.text })].join(' · ')}`;
  }
  private selected(row: number, column: number): boolean { return row >= 0 && column >= 0 && row < this.page.rows.length && column < this.columns.length && this.selection.contains(row, column); }
  private startAxis(event: PointerEvent, axis: 'rows' | 'columns', index: number): void {
    if (event.button !== 0) return; event.preventDefault(); this.dragging = false; this.dragAxis = axis; this.selection.startAxis(axis, index, event.ctrlKey || event.metaKey, event.shiftKey); this.viewport.focus({ preventScroll: true }); this.renderSelection();
  }
  /** Coalesce selection painting during drags to one update per animation frame. */
  private scheduleSelection(): void {
    if (this.selectionFrame) return;
    this.selectionFrame = requestAnimationFrame(() => { this.selectionFrame = 0; this.renderSelection(); });
  }
  private renderSelection(): void {
    if (this.selectionFrame) { cancelAnimationFrame(this.selectionFrame); this.selectionFrame = 0; }
    const rowCount = this.page.rows.length; const columnCount = this.columns.length;
    // Evaluate membership once per cell, then derive outer edges and full row/column headers from the matrix.
    const matrix = this.cells.map((cells, row) => cells.map((_, column) => row < rowCount && column < columnCount && this.selection.contains(row, column)));
    const at = (row: number, column: number) => matrix[row]?.[column] ?? false;
    const fullRows = matrix.map(row => row.length > 0 && row.every(Boolean)); const fullColumns = Array.from({ length: columnCount }, (_, column) => matrix.length > 0 && matrix.every(row => row[column]));
    this.cells.forEach((cells, row) => cells.forEach((cell, column) => {
      const selected = at(row, column); cell.classList.toggle('selected', selected); cell.setAttribute('aria-selected', String(selected));
      cell.classList.toggle('selection-top', selected && !at(row - 1, column)); cell.classList.toggle('selection-bottom', selected && !at(row + 1, column));
      cell.classList.toggle('selection-left', selected && !at(row, column - 1)); cell.classList.toggle('selection-right', selected && !at(row, column + 1));
    }));
    this.viewport.querySelectorAll<HTMLElement>('[data-header-row]').forEach(cell => cell.classList.toggle('axis-selected', fullRows[Number(cell.dataset.headerRow)] ?? false));
    this.viewport.querySelectorAll<HTMLElement>('[data-header-column]').forEach(cell => cell.classList.toggle('axis-selected', fullColumns[Number(cell.dataset.headerColumn)] ?? false));
    this.renderStatus();
    // Selecting cells while search is open redefines its Selection scope, once a drag settles.
    if (this.searchPanel?.open && !this.locating && !this.loading && !this.dragging && !this.dragAxis) this.searchPanel.updateSelection(this.searchSelection());
  }
  /** Scroll the focused cell into view; scroll padding accounts for sticky headers and pinned columns. */
  private revealCursor(): void {
    const point = this.cursor; if (point) this.cells[point.row]?.[point.column]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  private get canUndo(): boolean { return this.tab === 'sql' ? !!this.sqlWorkspace?.canUndo : this.tab === 'data' && this.status.canUndo; }
  private get canRedo(): boolean { return this.tab === 'sql' ? !!this.sqlWorkspace?.canRedo : this.tab === 'data' && this.status.canRedo; }
  private undoRedo(redo: boolean): void { if (this.tab === 'sql') { if (redo) this.sqlWorkspace?.redo(); else this.sqlWorkspace?.undo(); this.renderStatus(); } else if (this.tab === 'data') void this.run({ type: redo ? 'redo' : 'undo' }); }
  private get editable(): boolean { return this.tab === 'data' && !!this.table?.editable && !this.status.readOnly; }
  private points(): Point[] {
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected) throw new Error(this.t('Select a cell first.'));
    if ((selected.cells?.length ?? selected.rowCount * selected.columnCount) > 10000) throw new Error(this.t('Select at most 10,000 cells.'));
    const result = selected.cells ? selected.cells.map(cell => ({ row: cell.row, column: cell.col })) : selected.ranges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index).flatMap(row => selected.columns.map(column => ({ row, column }))));
    if (result.some(point => !this.page.rows[point.row] || !this.columns[point.column])) throw new Error(this.t('Select a cell first.')); return result;
  }
  private getValue(point: Point): Value { return this.page.rows[point.row]!.values[this.columnLayout.sources[point.column]!]!; }
  private get hasSelection(): boolean { return this.tab === 'data' && Boolean(this.selection.snapshot(this.page.rows.length, this.columns.length)); }
  /** Cell commands shared by the Edit menu and the cell context menu, with availability for the current state. */
  private cellCommands(): Record<'copy' | 'copyHeaders' | 'paste' | 'edit' | 'null' | 'empty' | 'delete', Command> {
    const selected = this.hasSelection; const writable = this.editable && selected;
    return {
      copy: ['Copy', () => void this.perform(() => this.copy(false)), '⌘/Ctrl C', selected], copyHeaders: ['Copy with headers', () => void this.perform(() => this.copy(true)), '⇧⌘/Ctrl C', selected],
      paste: ['Paste', () => void this.perform(() => this.paste()), '⌘/Ctrl V', writable], edit: ['Edit cell…', () => this.editCell(), 'Enter / F2', writable],
      null: ['Set to NULL', () => void this.setSelected({ type: 'null', value: '' }), undefined, writable], empty: ['Set to empty text', () => void this.setSelected({ type: 'text', value: '' }), undefined, writable],
      delete: ['Delete selected records…', () => this.deleteRecords(), undefined, writable]
    };
  }
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
      const dialog = new Dialog(this.t('Edit value · {column}', { column: column.name }), this.locale); const editor = this.valueEditor(column, value, false); dialog.body.append(editor.root, element('p', 'muted dialog-hint', this.t('Enter: apply · Shift+Enter: new line · Esc: cancel')));
      const submit = async () => { const next = editor.read(); if (!next) throw new Error(this.t('Choose a value type.')); await this.host.request({ type: 'edit', edits: [{ kind: 'update', table: table.name, key: row.key, column: column.name, value: next }] }); this.activeFlush = undefined; dialog.close(); await this.loadPage(); };
      this.activeFlush = async () => { try { await submit(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } }; dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t('Apply'), submit);
    });
  }
  private valueEditor(column: Column, initial?: Value, useDefault = true): { root: HTMLElement; read: () => Value | undefined } {
    const root = element('div', 'value-field'); const label = element('label', '', column.name); const type = element('select'); type.setAttribute('aria-label', `${column.name} ${this.t('Type')}`);
    const types = useDefault ? ['default', 'text', 'integer', 'real', 'null'] : ['text', 'integer', 'real', 'null']; for (const value of types) { const option = element('option', '', value === 'default' ? `${this.t('Use default')}${column.defaultValue === null ? '' : ` · ${column.defaultValue}`}` : value === 'null' ? 'NULL' : value.toUpperCase()); option.value = value; type.append(option); } type.value = initial?.type ?? 'default';
    const input = element('textarea'); input.rows = useDefault ? 1 : 6; input.value = initial?.value ?? ''; input.setAttribute('aria-label', `${column.name} ${this.t('Value')}`); input.spellcheck = false; const initialText = input.value;
    const update = () => { input.disabled = type.value === 'null' || type.value === 'default'; }; type.onchange = update; update(); label.append(type); root.append(label, input);
    return { root, read: () => { const kind = type.value; if (kind === 'default') return undefined; if (initial && kind === initial.type && input.value === initialText) return initial; if (kind === 'integer' && !/^[+-]?\d+$/.test(input.value)) throw new Error(this.t('Integer values must be whole numbers.')); if (kind === 'real' && (!input.value.trim() || !Number.isFinite(Number(input.value)))) throw new Error(this.t('Real values must be finite numbers.')); return { type: kind as Value['type'], value: kind === 'null' ? '' : input.value }; } };
  }
  private addRecord(): void {
    if (!this.editable || !this.table) { this.showError(this.t('The selected table is read-only.')); return; } const table = this.table; const dialog = new Dialog(this.t('Add record'), this.locale); dialog.body.append(element('p', 'muted', this.t('Default values and generated fields are filled when you save.')));
    const fields = table.columns.filter(column => !column.generated).map(column => { const field = this.valueEditor(column); dialog.body.append(field.root); return { column, field }; });
    const submit = async () => { const values: Record<string, Value> = Object.create(null); for (const { column, field } of fields) { const value = field.read(); if (value) values[column.name] = value; } await this.host.request({ type: 'edit', edits: [{ kind: 'insert', table: table.name, values }] }); this.activeFlush = undefined; dialog.close(); this.view.offset = 0; await this.loadPage(); };
    this.activeFlush = async () => { try { await submit(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } }; dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t('Add record'), submit);
  }
  private async setSelected(value: Value): Promise<void> { await this.perform(async () => { const edits = this.points().map(point => { this.checkEditable(point); return { kind: 'update', table: this.table!.name, key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name, value } satisfies Edit; }); await this.host.request({ type: 'edit', edits }); await this.loadPage(); }); }
  private deleteRecords(): void {
    void this.perform(async () => { if (!this.editable || !this.table) throw new Error(this.t('The selected table is read-only.')); const selected = this.selection.snapshot(this.page.rows.length, this.columns.length); if (!selected) throw new Error(this.t('Select records first.')); const rows = selected.cells ? [...new Set(selected.cells.map(point => point.row))] : selected.ranges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index)); if (rows.length > 10000) throw new Error(this.t('Select at most 10,000 records.')); const table = this.table; const edits = rows.filter(index => !this.page.rows[index]!.deleted).map(index => ({ kind: 'delete' as const, table: table.name, key: this.page.rows[index]!.key }));
      const dialog = new Dialog(this.t('Delete {count} records?', { count: edits.length.toLocaleString() }), this.locale); dialog.body.append(element('p', '', this.t('Pending deletions are committed when you save.'))); dialog.show(this.t('Delete'), async () => { await this.host.request({ type: 'edit', edits }); await this.loadPage(); });
    });
  }
  private backupDialog(): void { const dialog = new Dialog(this.t('Save database snapshot…'), this.locale); dialog.body.append(element('p', '', this.t('The snapshot contains committed data. Save your changes first to include them.'))); dialog.show(this.t('Save'), () => this.run({ type: 'backup' })); }
  private confirmDiscard(): void { if (!this.status.pending) return; const dialog = new Dialog(this.t('Discard all changes…'), this.locale); dialog.body.append(element('p', '', this.t('Pending changes across all tables will be discarded.'))); dialog.show(this.t('Discard'), () => this.run({ type: 'discard' })); }
  private filterDialog(columnName?: string, control?: HTMLElement): void {
    if (!this.table) return; const column = columnName ?? this.columns[this.cursor?.column ?? 0]?.name; if (!column) return;
    if (this.activeMenu?.dataset.filterColumn === column) { this.closeMenu(); return; }
    this.closeMenu(); const table = this.table;
    const panel = new ColumnFilterPanel(table, column, this.query, this.host, this.locale, async filter => {
      if (this.table !== table) throw new Error(this.t('The selected table changed. Reopen this filter.'));
      const view = this.view; const revision = (this.queryVersions.get(view) ?? 0) + 1; this.queryVersions.set(view, revision); const old = view.filters; const offset = view.offset;
      view.filters = [...(old ?? []).filter(item => item.column !== column), ...(filter ? [filter] : [])]; view.offset = 0; this.selection.clear();
      try { await this.loadPage(); if (this.queryVersions.get(view) === revision) { this.persist(); this.showError(''); } } catch (error) { if (this.queryVersions.get(view) === revision) { view.filters = old; view.offset = offset; } throw error; }
    }, () => { if (this.activeMenu === panel.root) this.closeMenu(); });
    panel.root.dataset.filterColumn = column; document.body.append(panel.root); this.activeMenu = panel.root; this.retainMenuAnchor(control);
    const rect = (control ?? this.context).getBoundingClientRect(); panel.root.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - panel.root.offsetWidth - 4))}px`; panel.root.style.top = `${Math.max(4, Math.min(rect.bottom + 3, innerHeight - panel.root.offsetHeight - 4))}px`;
    (panel.root.querySelector('select') as HTMLElement)?.focus();
  }
  private changeQuery(change: Partial<Pick<ViewState, 'sort' | 'filters'>>): Promise<void> { return this.perform(async () => { const view = this.view; const revision = (this.queryVersions.get(view) ?? 0) + 1; this.queryVersions.set(view, revision); const old = { sort: view.sort, filters: view.filters, offset: view.offset }; Object.assign(view, change, { offset: 0 }); this.selection.clear(); try { await this.loadPage(); if (this.queryVersions.get(view) === revision) { this.persist(); this.renderContext(); } } catch (error) { if (this.queryVersions.get(view) === revision) Object.assign(view, old); throw error; } }); }
  /** Header click: add the column as the last sort key, then switch to descending, then remove it. */
  private cycleSort(name: string): Promise<void> {
    const sorts = this.view.sort ?? []; const index = sorts.findIndex(item => item.column === name);
    const next: SortKey[] = index < 0 ? [...sorts, { column: name, direction: 'ASC' }] : sorts[index]!.direction === 'ASC' ? sorts.map((item, position) => position === index ? { ...item, direction: 'DESC' } : item) : sorts.filter((_, position) => position !== index);
    return this.changeQuery({ sort: next.length ? next : undefined });
  }
  private sortSql(sorts: SortKey[]): string {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    return sorts.length ? `ORDER BY ${sorts.map(item => `${quote(item.column)} ${item.direction}`).join(', ')}` : '';
  }
  /** List every sort key in priority order with direction, reordering, removal, the generated ORDER BY and Reset all. */
  private sortPanel(anchor?: HTMLElement): void {
    if (!this.table) return; if (this.activeMenu?.classList.contains('sort-panel')) { this.closeMenu(); return; }
    this.closeMenu(); const table = this.table; const panel = element('div', 'sort-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', this.t('Sort order'));
    const update = async (sorts: SortKey[], focus?: string) => {
      await this.changeQuery({ sort: sorts.length ? sorts : undefined }); if (this.table !== table || this.activeMenu !== panel) return;
      draw(); (focus ? panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`) : null)?.focus();
    };
    const draw = () => {
      const sorts = this.view.sort ?? []; panel.replaceChildren();
      const heading = element('header', 'filter-heading'); heading.append(element('strong', '', this.t('Sort order')));
      const close = button('', () => { this.closeMenu(); anchor?.focus(); }, 'icon-button'); setIcon(close, 'close'); close.setAttribute('aria-label', this.t('Close')); heading.append(close); panel.append(heading);
      const list = element('ol', 'sort-list'); list.setAttribute('aria-label', this.t('Sort columns'));
      sorts.forEach((sort, index) => {
        const item = element('li', 'sort-item'); item.append(element('span', 'sort-position', String(index + 1)), element('span', 'sort-column', sort.column));
        const direction = button(this.t(sort.direction === 'ASC' ? 'Ascending' : 'Descending'), () => void update(sorts.map((entry, position) => position === index ? { ...entry, direction: entry.direction === 'ASC' ? 'DESC' : 'ASC' } : entry), `direction:${sort.column}`), 'sort-direction');
        direction.dataset.key = `direction:${sort.column}`; direction.setAttribute('aria-label', this.t('{column}: {direction}. Click to reverse', { column: sort.column, direction: this.t(sort.direction === 'ASC' ? 'Ascending' : 'Descending') }));
        const move = (offset: number, icon: 'chevronUp' | 'chevronDown', label: string) => {
          const control = button('', () => { const next = [...sorts]; const [entry] = next.splice(index, 1); next.splice(index + offset, 0, entry!); void update(next, `${label}:${sort.column}`); }, 'icon-button'); setIcon(control, icon);
          control.dataset.key = `${label}:${sort.column}`; control.disabled = index + offset < 0 || index + offset >= sorts.length; control.setAttribute('aria-label', this.t(label === 'up' ? 'Move {column} up' : 'Move {column} down', { column: sort.column })); return control;
        };
        const remove = button('', () => void update(sorts.filter((_, position) => position !== index), 'add'), 'icon-button'); setIcon(remove, 'close'); remove.setAttribute('aria-label', this.t('Remove {column} from sorting', { column: sort.column }));
        item.append(direction, move(-1, 'chevronUp', 'up'), move(1, 'chevronDown', 'down'), remove); list.append(item);
      });
      if (sorts.length) panel.append(list); else panel.append(element('p', 'muted', this.t('No sorting. Records use their natural order.')));
      // Adding a column appends it as the lowest-priority key.
      const available = table.columns.filter(column => !sorts.some(sort => sort.column === column.name));
      const add = element('select'); add.dataset.key = 'add'; add.setAttribute('aria-label', this.t('Add sort column')); add.disabled = !available.length || sorts.length >= 16;
      const placeholder = element('option', '', this.t('Add sort column…')); placeholder.value = ''; add.append(placeholder);
      for (const column of available) { const option = element('option', '', column.name); option.value = column.name; add.append(option); }
      add.onchange = () => { if (add.value) void update([...sorts, { column: add.value, direction: 'ASC' }], 'add'); };
      panel.append(add, element('strong', '', this.t('Generated SQL')));
      const preview = element('pre', 'sql-preview', this.sortSql(sorts) || '—'); preview.setAttribute('aria-label', this.t('Generated SQL')); panel.append(preview);
      panel.append(element('p', 'filter-note muted', this.t('Records with equal values keep their natural order (rowid or primary key). Sorting only changes this view.')));
      const actions = element('footer', 'filter-actions'); const reset = button(this.t('Reset all sorting'), () => void update([], 'add')); reset.disabled = !sorts.length; actions.append(reset); panel.append(actions);
    };
    draw(); document.body.append(panel); this.activeMenu = panel; this.retainMenuAnchor(anchor);
    const rect = (anchor ?? this.context).getBoundingClientRect(); panel.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - panel.offsetWidth - 4))}px`; panel.style.top = `${Math.max(4, Math.min(rect.bottom + 3, innerHeight - panel.offsetHeight - 4))}px`;
    panel.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeMenu(); (anchor ?? this.viewport).focus({ preventScroll: true }); } };
    panel.querySelector<HTMLElement>('.sort-direction, select')?.focus();
  }
  private columnMenu(column: Column, control: HTMLButtonElement): void {
    const sorts = this.view.sort ?? []; const current = sorts.find(item => item.column === column.name);
    const filtered = !!this.view.filters?.some(item => item.column === column.name); const schemaEditable = this.editable && this.table?.kind === 'table';
    const setSort = (direction?: SortKey['direction']) => {
      const next = direction ? current ? sorts.map(item => item.column === column.name ? { ...item, direction } : item) : [...sorts, { column: column.name, direction }] : sorts.filter(item => item.column !== column.name);
      void this.changeQuery({ sort: next.length ? next : undefined });
    };
    const rect = control.getBoundingClientRect(); this.floatingMenu(rect.left, rect.bottom, [
      ['Ascending', () => setSort('ASC'), current?.direction === 'ASC' ? '✓' : undefined],
      ['Descending', () => setSort('DESC'), current?.direction === 'DESC' ? '✓' : undefined],
      ['Remove sorting', () => setSort(), undefined, !!current],
      ['Sort order…', () => this.sortPanel(control)],
      ['Filter…', () => this.filterDialog(column.name, control), filtered ? '✓' : undefined],
      ['Clear filter', () => void this.changeQuery({ filters: this.view.filters?.filter(item => item.column !== column.name) }), undefined, filtered],
      [this.view.pinned.includes(column.name) ? 'Unpin column' : 'Pin column', () => { this.view.pinned = this.view.pinned.includes(column.name) ? this.view.pinned.filter(name => name !== column.name) : [...this.view.pinned, column.name]; this.selection.clear(); this.persist(); this.renderContent(); }],
      ['Rename column…', () => this.databaseTools().column('rename', column), undefined, schemaEditable],
      ['Add column…', () => this.databaseTools().column('add'), undefined, schemaEditable],
      ['Delete column…', () => this.databaseTools().column('delete', column), undefined, schemaEditable],
      ['Hide column', () => { if (this.columns.length < 2) return; this.view.hidden.push(column.name); this.selection.clear(); this.persist(); this.renderContent(); }, undefined, this.columns.length > 1]
    ], control);
  }
  private rowMenu(row: number, x: number, y: number, opener: HTMLButtonElement): void {
    const selected = this.selection.snapshot(this.page.rows.length, this.columns.length);
    const fullRow = selected && !selected.cells && selected.columnCount === this.columns.length && selected.ranges.some(range => row >= range.start && row < range.start + range.count);
    if (!fullRow) this.selection.selectRows([row]); this.renderSelection();
    const cell = this.cellCommands(); this.floatingMenu(x, y, [
      ['Add record…', () => this.addRecord(), undefined, this.editable], cell.copy, cell.copyHeaders,
      ['Edit record…', () => { this.selection.selectRows([row]); this.renderSelection(); this.editRecord(); }, undefined, this.editable],
      ['Duplicate selected records…', () => this.duplicateRecords(), undefined, this.editable], cell.delete
    ], opener);
    if (!this.editable) this.activeMenu?.querySelectorAll<HTMLButtonElement>('button:disabled').forEach(control => { control.title = this.t('Read-only: {reason}', { reason: this.t(this.table?.reason ?? 'Read-only database') }); });
  }
  private cellMenu(x: number, y: number): void { const cell = this.cellCommands(); this.floatingMenu(x, y, [cell.edit, ['Edit record…', () => this.editRecord()], ['Fill selection…', () => this.fillSelection(), undefined, this.editable], ['Fill down', () => void this.fillDown(), undefined, this.editable], ['Duplicate selected records…', () => this.duplicateRecords(), undefined, this.editable], ['Open related record…', () => this.relatedRecord()], cell.copy, cell.copyHeaders, cell.paste, cell.null, cell.empty, cell.delete]); }
  private floatingMenu(x: number, y: number, commands: Command[], opener?: HTMLElement): void {
    const focus = opener ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : this.viewport);
    this.closeMenu(); const menu = this.commandMenu(commands, focus); document.body.append(menu); this.activeMenu = menu; this.retainMenuAnchor(opener);
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`; menu.querySelector<HTMLButtonElement>(':scope > button:enabled')?.focus();
  }
  private chooseColumns(): void { if (!this.table) return; const dialog = new Dialog(this.t('Choose columns…'), this.locale); const fields = this.table.columns.map(column => { const label = element('label', 'checkbox-field'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = !this.view.hidden.includes(column.name); label.append(checkbox, document.createTextNode(column.name)); dialog.body.append(label); return { column, checkbox }; }); dialog.show(this.t('Apply'), () => { if (!fields.some(field => field.checkbox.checked)) throw new Error(this.t('Keep at least one column visible.')); this.view.hidden = fields.filter(field => !field.checkbox.checked).map(field => field.column.name); this.selection.clear(); this.persist(); this.renderContent(); }); }
  private languageSubmenu(parent: HTMLElement, control: HTMLButtonElement): void {
    control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false'); control.setAttribute('aria-label', this.t('Language')); const arrow = element('span', 'submenu-arrow', '›'); arrow.setAttribute('aria-hidden', 'true'); control.append(arrow);
    const submenu = element('div', 'command-menu language-submenu'); submenu.hidden = true; submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', this.t('Language'));
    for (const language of ['en', 'zh-CN'] as const) {
      const choice = button(language === 'en' ? 'English' : '简体中文', () => { this.closeMenu(); this.locale.language = language; this.sqlWorkspace?.dispose(); this.sqlWorkspace = undefined; this.searchPanel?.root.remove(); this.searchPanel = undefined; this.preferences.language = language; document.documentElement.lang = language; this.persist(); this.renderShell(); this.renderContent(); }, 'menu-choice');
      choice.setAttribute('aria-label', language === 'en' ? 'English' : '简体中文'); choice.setAttribute('role', 'menuitemradio'); choice.setAttribute('aria-checked', String(this.locale.language === language)); submenu.append(choice);
    }
    parent.append(submenu);
    const open = (focus: boolean) => { submenu.hidden = false; control.setAttribute('aria-expanded', 'true'); const rect = control.getBoundingClientRect(); const parentRect = parent.getBoundingClientRect(); submenu.style.left = `${parentRect.right + submenu.offsetWidth < innerWidth - 4 ? parentRect.right : Math.max(4, parentRect.left - submenu.offsetWidth)}px`; submenu.style.top = `${Math.max(4, Math.min(rect.top - 4, innerHeight - submenu.offsetHeight - 4))}px`; if (focus) (submenu.querySelector('[aria-checked="true"]') as HTMLElement)?.focus(); };
    control.onclick = event => { event.stopPropagation(); open(true); }; control.onmouseenter = () => open(false);
    control.onkeydown = event => { if (['ArrowRight', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(true); } };
    submenu.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); submenu.hidden = true; control.setAttribute('aria-expanded', 'false'); control.focus(); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); const items = [...submenu.querySelectorAll('button')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); } };
  }
  private databaseTools(): DatabaseTools { return new DatabaseTools(this.host, this.locale, () => ({ table: this.table, query: this.query }), async schema => { if (schema) await this.refreshMetadata(); else await this.loadPage(); }, error => this.showError(error instanceof Error ? error.message : String(error))); }
  private openSearch(mode: 'find' | 'replace', fromMenu = false): void {
    if (this.tab === 'structure' || !this.table && this.tab !== 'sql') return;
    if (this.searchPanel?.open) { this.searchPanel.switchMode(mode); return; }
    if (this.sqlWorkspace) this.sqlWorkspace.onUpdate = undefined;
    if (fromMenu) [...this.menuOpeners.keys()].find(control => control.textContent === this.t('Edit'))?.focus();
    if (this.table) this.searchOrigin = { table: this.table.name, view: structuredClone(this.view) };
    this.preferences.search ??= {};
    this.searchPanel ??= new SearchPanel(this.host, this.locale, this.preferences.search, () => this.persist(), (token, hit) => this.locateSearch(token, hit), () => this.loadPage(), () => this.restoreSearchOrigin(), () => { if (this.tab === 'sql') this.sqlWorkspace?.focus(); else this.viewport.focus({ preventScroll: true }); });
    if (this.tab === 'sql') { this.renderContent(); const sql = this.sqlWorkspace!.searchTarget(); const panel = this.searchPanel; this.sqlWorkspace!.onUpdate = update => { if (!panel.open) return; const change = sql.observe(update); if (change) panel.sqlChanged(change); }; panel.show(mode, { sql }); return; }
    this.searchPanel.show(mode, { table: this.table!, ...this.searchSelection() });
  }
  /** The exact current-page cells for the Selection scope, keyed by record identity. */
  private searchSelection(): { selection?: Extract<SearchScope, { type: 'selection' }>; selectionError?: string } {
    if (this.tab !== 'data' || !this.hasSelection || !this.page.snapshot) return {};
    try { return { selection: { type: 'selection', snapshot: this.page.snapshot, cells: this.points().map(point => ({ key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name })) } }; }
    catch { return { selectionError: this.t('Selection exceeds 10,000 cells. Select fewer cells to search the selection.') }; }
  }
  private async locateSearch(token: string, hit: SearchHit): Promise<(() => DOMRect | undefined) | undefined> {
    const origin = this.searchOrigin; const tableBefore = this.table; const located = (await this.host.request({ type: 'searchLocate', token, key: hit.key, column: hit.column, limit: this.pageSize })).located;
    if (!this.searchPanel?.open || this.searchOrigin !== origin || this.table !== tableBefore) return undefined;
    if (!located) throw new Error(this.t('The search result is unavailable. Search again.'));
    const table = this.tables.find(table => table.name === located.query.table); if (!table) throw new Error(this.t('The selected table is unavailable.'));
    this.table = table; this.preferences.table = table.name; this.tab = 'data'; this.view.offset = located.query.offset; this.view.pageSize = located.query.limit; this.view.sort = located.query.sort; this.view.filters = located.query.filters;
    let column = -1; this.locating = true; try {
    this.view.hidden = this.view.hidden.filter(column => column !== located.column); this.page = located.page; this.columnCache = undefined; this.selection.clear(); column = this.columns.findIndex(column => column.name === located.column); if (column < 0 || !this.page.rows[located.row]) throw new Error(this.t('The search result is unavailable. Search again.')); this.selection.start(located.row, column); this.view.scrollTop = 0; this.persist(); this.renderShell(); this.renderContent(); this.revealCursor();
    } finally { this.locating = false; }
    return () => this.cells[located.row]?.[column]?.getBoundingClientRect();
  }
  private async restoreSearchOrigin(): Promise<void> {
    const origin = this.searchOrigin; if (!origin) return; const table = this.tables.find(table => table.name === origin.table); if (!table) throw new Error(this.t('The selected table is unavailable.'));
    this.table = table; this.preferences.table = table.name; this.preferences.views[table.name] = structuredClone(origin.view); this.tab = 'data'; this.selection.clear(); this.persist(); this.renderShell(); await this.loadPage();
  }
  private async refreshMetadata(): Promise<void> {
    const previous = new Map(this.tables.map(table => [table.name, table])); const result = await this.host.request({ type: 'metadata' }); this.tables = result.tables ?? [];
    for (const table of this.tables) { const old = previous.get(table.name); if (!old || JSON.stringify(old.columns) === JSON.stringify(table.columns)) continue; const view = Object.hasOwn(this.preferences.views, table.name) ? this.preferences.views[table.name] : undefined; if (!view) continue; const names = new Set(table.columns.map(column => column.name)); view.offset = 0; view.filters = view.filters?.filter(filter => names.has(filter.column) && filter.mode !== 'custom'); view.sort = view.sort?.filter(key => names.has(key.column)); view.order = view.order.filter(name => names.has(name)); view.hidden = view.hidden.filter(name => names.has(name)); view.pinned = view.pinned.filter(name => names.has(name)); for (const name of Object.keys(view.widths)) if (!names.has(name)) delete view.widths[name]; }
    this.searchPanel?.close(); this.searchOrigin = undefined; this.sqlWorkspace?.updateTables(this.tables); this.table = this.tables.find(table => table.name === this.table?.name) ?? this.tables[0]; this.columnCache = undefined; this.selection.clear(); this.persist(); this.renderShell(); if (this.tab !== 'sql') await this.loadPage();
  }
  private jumpPage(): void {
    const dialog = new Dialog(this.t('Go to page…'), this.locale); const input = element('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(Math.floor(this.view.offset / this.pageSize) + 1); input.setAttribute('aria-label', this.t('Page number')); dialog.body.append(input, element('p', 'muted', this.t('Page numbers use the current filters and rows per page.')));
    dialog.show(this.t('Go'), async () => { const page = Number(input.value); if (!Number.isSafeInteger(page) || page < 1) throw new Error(this.t('Enter a positive page number.')); const count = (await this.host.request({ type: 'count', query: this.query })).count ?? 0; if (page > Math.max(1, Math.ceil(count / this.pageSize))) throw new Error(this.t('The last page is {page}.', { page: Math.max(1, Math.ceil(count / this.pageSize)) })); this.view.offset = (page - 1) * this.pageSize; this.selection.clear(); this.view.scrollTop = 0; this.persist(); await this.loadPage(); });
  }
  private fillSelection(): void {
    if (!this.cursor) return; const column = this.columns[this.cursor.column]!; const dialog = new Dialog(this.t('Fill selection…'), this.locale); const editor = this.valueEditor(column, this.getValue(this.cursor), false); dialog.body.append(element('p', 'muted', this.t('Apply one typed value to every selected cell on this page.')), editor.root); dialog.show(this.t('Apply'), async () => { const value = editor.read(); if (value) await this.setSelected(value); });
  }
  private async fillDown(): Promise<void> {
    await this.perform(async () => { if (!this.table) return; const points = this.points(); const byColumn = new Map<number, Point[]>(); for (const point of points) { const group = byColumn.get(point.column) ?? []; group.push(point); byColumn.set(point.column, group); } const edits: Edit[] = [];
      for (const group of byColumn.values()) { group.sort((left, right) => left.row - right.row); const value = this.getValue(group[0]!); for (const point of group.slice(1)) { this.checkEditable(point); edits.push({ kind: 'update', table: this.table.name, key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name, value }); } }
      if (edits.length) { await this.host.request({ type: 'edit', edits }); await this.loadPage(); }
    });
  }
  private editRecord(duplicate = false): void {
    void this.perform(async () => { if (!this.cursor || !this.table) throw new Error(this.t('Select a cell first.')); const table = this.table; const row = this.page.rows[this.cursor.row]!; if (duplicate && row.values.some(value => value.type === 'blob')) throw new Error(this.t('Records containing BLOB values cannot be duplicated.')); const dialog = new Dialog(this.t(duplicate ? 'Duplicate record' : 'Edit record…'), this.locale); dialog.body.classList.add('record-fields');
      if (duplicate) dialog.body.append(element('p', 'muted', this.t('Primary keys use defaults. Enter new values for keys without an automatic default.')));
      const fields: { column: Column; read: () => Value | undefined }[] = [];
      for (const [index, column] of table.columns.entries()) { const value = row.values[index]!; if (column.generated || value.type === 'blob' || !table.editable) { const field = element('div', 'value-field'); field.append(element('strong', '', column.name), element('pre', 'sql-preview', this.display(value))); dialog.body.append(field); continue; }
        const editor = this.valueEditor(column, duplicate && column.pk ? undefined : value, duplicate); fields.push({ column, read: editor.read }); const textarea = editor.root.querySelector('textarea')!; textarea.rows = Math.min(10, Math.max(2, value.value.split('\n').length));
        if (value.type === 'text') { const format = button(this.t('Format JSON'), () => { try { const errors: ParseError[] = []; parseTree(textarea.value, errors, { allowTrailingComma: false, disallowComments: true }); if (errors.length) throw new Error('Invalid JSON'); textarea.value = applyEdits(textarea.value, formatJson(textarea.value, undefined, { tabSize: 2, insertSpaces: true, eol: '\n' })); textarea.rows = 8; } catch { dialog.showError(this.t('This value is not valid JSON.')); } }); editor.root.append(format); }
        dialog.body.append(editor.root);
      }
      const submit = async () => { if (!table.editable) return; const edits: Edit[] = []; if (duplicate) { const values: Record<string, Value> = Object.create(null); for (const field of fields) { const value = field.read(); if (value) values[field.column.name] = value; } edits.push({ kind: 'insert', table: table.name, values }); } else for (const field of fields) { const value = field.read(); if (value && JSON.stringify(value) !== JSON.stringify(row.values[table.columns.indexOf(field.column)])) edits.push({ kind: 'update', table: table.name, key: row.key, column: field.column.name, value }); }
        if (edits.length) { await this.host.request({ type: 'edit', edits }); this.selection.clear(); await this.loadPage(); }
      };
      if (table.editable) this.activeFlush = async () => { try { await submit(); this.activeFlush = undefined; dialog.close(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } };
      dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t(table.editable ? 'Apply' : 'Close'), submit);
    });
  }
  private duplicateRecords(): void {
    void this.perform(async () => { if (!this.table) return; const table = this.table; const indexes = [...new Set(this.points().map(point => point.row))].sort((a, b) => a - b); if (indexes.length === 1) { this.editRecord(true); return; }
      if (indexes.some(index => this.page.rows[index]!.values.some(value => value.type === 'blob'))) throw new Error(this.t('Records containing BLOB values cannot be duplicated.'));
      const dialog = new Dialog(this.t('Duplicate selected records…'), this.locale); dialog.body.append(element('p', 'muted', this.t('Duplicate {count} selected records. Supply fresh primary keys or use automatic defaults.', { count: indexes.length })));
      const keys = table.columns.filter(column => column.pk && !column.generated); const entries = indexes.map(index => { const row = this.page.rows[index]!; const group = element('section', 'tool-fields'); group.append(element('strong', '', this.t('Record {number}', { number: this.page.offset + index + 1 }))); const fields = keys.map(column => { const editor = this.valueEditor(column, undefined, true); group.append(editor.root); return { column, read: editor.read }; }); dialog.body.append(group); return { row, fields }; });
      const submit = async () => { const edits: Edit[] = entries.map(({ row, fields }) => { const values: Record<string, Value> = Object.create(null); table.columns.forEach((column, index) => { if (!column.generated && !column.pk) values[column.name] = row.values[index]!; }); for (const field of fields) { const value = field.read(); if (value) values[field.column.name] = value; } return { kind: 'insert', table: table.name, values }; }); await this.host.request({ type: 'edit', edits }); this.selection.clear(); await this.loadPage(); };
      this.activeFlush = async () => { try { await submit(); dialog.close(); } catch (error) { dialog.showError(error instanceof Error ? error.message : String(error)); throw error; } }; dialog.onClose = () => { this.activeFlush = undefined; }; dialog.show(this.t('Stage duplicates'), submit);
    });
  }
  private relatedRecord(): void {
    void this.perform(async () => { if (!this.table || !this.cursor) throw new Error(this.t('Select a cell first.')); const table = this.table; const row = this.page.rows[this.cursor.row]!;
      type ForeignKey = { id: number; seq: number; table: string; from: string; to: string | null };
      const foreignKeys = table.foreignKeys as ForeignKey[]; const groups = new Map<number, ForeignKey[]>(); for (const key of foreignKeys) { const group = groups.get(key.id) ?? []; group.push(key); groups.set(key.id, group); }
      const current = this.columns[this.cursor.column]!.name; const matches = [...groups.values()].filter(group => group.some(key => key.from === current)); const candidates = matches.length ? matches : [...groups.values()]; if (!candidates.length) throw new Error(this.t('This record has no foreign key relationships.'));
      const open = async (group: ForeignKey[]) => {
        const related = (await this.host.request({ type: 'foreignRecord', table: table.name, key: row.key, foreignKey: group[0]!.id })).related;
        if (!related) throw new Error(this.t('The referenced key is unavailable.'));
        this.navigation.push({ table: table.name, view: structuredClone(this.view) }); await this.selectTable(related.table); this.view.filters = related.filters; this.view.offset = 0; this.persist(); await this.loadPage(); this.renderContext();
      };
      if (candidates.length === 1) { await open(candidates[0]!); return; } const dialog = new Dialog(this.t('Open related record…'), this.locale); const select = element('select'); select.setAttribute('aria-label', this.t('Relationship')); candidates.forEach((group, index) => { const option = element('option', '', `${group.map(key => key.from).join(', ')} → ${group[0]!.table}`); option.value = String(index); select.append(option); }); dialog.body.append(select); dialog.show(this.t('Open'), () => open(candidates[Number(select.value)]!));
    });
  }
  private async goBack(): Promise<void> { const entry = this.navigation.pop(); if (!entry) return; await this.perform(async () => { await this.selectTable(entry.table); this.preferences.views[entry.table] = entry.view; this.persist(); await this.loadPage(); this.renderContext(); }); }

  private help(): void {
    const dialog = new Dialog(this.t('Quick guide'), this.locale);
    const lines = this.locale.language === 'zh-CN' ? [
      '在左侧选择数据表；折叠列表后，通过菜单下方的选择框切换。',
      '双击单元格或按 Enter/F2 编辑，并明确选择文本、整数、浮点数或 NULL。方向键、Home/End、Page Up/Down 移动选区，方向键可继续移动到相邻页。',
      '修改在所有表之间暂存，按 Ctrl/Cmd+S 通过一个事务统一提交；保存前可以撤销或放弃。',
      '点击字段名或行号选择整列或整行，Shift 扩展范围，Ctrl/Cmd 添加或移除；单元格也可以分别多选。完整矩形选区可以复制和粘贴。',
      '表头第一行是字段名，第二行是类型和主键。已激活的排序、筛选按钮以橙色背景常驻；悬停或键盘聚焦时显示全部四个工具。省略号菜单集中提供排序、筛选、固定和隐藏操作。',
      '排序按钮会把字段加入排序，再依次切换升序、降序和取消。可以同时按多个字段排序，先添加的字段优先；右键排序按钮或选择 视图 → 排序顺序… 可以调整顺序、查看 ORDER BY 并全部重置。',
      '漏斗按钮按列筛选，不同字段的条件以 AND 组合；自定义类型可直接编辑 WHERE 条件。',
      '拖动列宽调整宽度，双击列边缘适应内容。拖动手柄调整显示列顺序，字段选项可以固定或隐藏列。这些只影响显示，不会修改数据库中的字段顺序或结构。',
      '工具栏会提示鼠标所在或获得焦点的控件的操作方法。',
      '视图、虚拟表、生成列和 BLOB 仅支持查看。数据库快照只包含已保存的数据。'
    ] : [
      'Choose a table in the sidebar. Collapse the list to switch tables from the selector below the menu.',
      'Double-click a cell or press Enter or F2 to edit, choosing Text, Integer, Real, or NULL explicitly. Arrow keys, Home/End and Page Up/Down move the selection; arrows continue onto adjacent pages.',
      'Edits are staged across tables. Ctrl/Cmd+S commits them in one transaction. Undo or discard before saving.',
      'Click column names or row numbers to select columns or rows. Shift extends a range; Ctrl/Cmd adds or removes items, including individual cells. Complete rectangles can be copied and pasted.',
      'Each header shows the column name, then its type and primary key. Active sort and filter buttons stay visible with an orange background. Hover or focus a header to show all four tools; the three-dot menu contains sorting, filtering, pinning, and visibility options.',
      'The sort button adds the column to the sort, then switches ascending, descending, and off. Several columns can sort together; columns added first take priority. Right-click a sort button or choose View → Sort order… to reorder keys, see the ORDER BY clause, or reset all.',
      'Each funnel filters one column; filters on different columns combine with AND. Custom accepts a WHERE expression.',
      'Drag a column edge to resize it, or double-click the edge to fit its content. Drag the handle to change the display order; column options pin or hide columns. These change only the view, never the column order or structure in the database.',
      'The toolbar shows a tip for the control under the pointer or with keyboard focus.',
      'Views, virtual tables, generated columns, and BLOB values are read-only. Database snapshots contain saved data only.'
    ];
    for (const line of lines) dialog.body.append(element('p', '', line)); dialog.show(this.t('Close'), () => {});
  }
  private async copy(headers: boolean): Promise<void> {
    const points = this.points(); if (this.selection.snapshot(this.page.rows.length, this.columns.length)?.cells) throw new Error(this.t('The selection must be a rectangle.')); const rows = [...new Set(points.map(point => point.row))].sort((a, b) => a - b); const columns = [...new Set(points.map(point => point.column))].sort((a, b) => a - b); const quote = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const output = rows.map(row => columns.map(column => quote(this.getValue({ row, column }).type === 'null' ? '' : this.getValue({ row, column }).value)).join('\t'));
    if (headers) output.unshift(columns.map(column => quote(this.columns[column]!.name)).join('\t')); const text = output.join('\n'); if (text.length > 8 * 1024 * 1024) throw new Error(this.t('Copy is limited to 8 MiB.')); await this.host.request({ type: 'clipboardWrite', text });
  }
  private async paste(): Promise<void> {
    if (!this.cursor || !this.table) throw new Error(this.t('Select a cell first.')); if (this.selection.snapshot(this.page.rows.length, this.columns.length)?.cells) throw new Error(this.t('The selection must be a rectangle.')); const text = (await this.host.request({ type: 'clipboardRead' })).text ?? ''; if (text.length > 8 * 1024 * 1024) throw new Error(this.t('Paste is limited to 8 MiB.')); const rows = this.parseTsv(text); const points = this.points(); const start = { row: Math.min(...points.map(point => point.row)), column: Math.min(...points.map(point => point.column)) }; const edits: Edit[] = [];
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r]!.length; c++) { const point = { row: start.row + r, column: start.column + c }; if (point.row >= this.page.rows.length || point.column >= this.columns.length) throw new Error(this.t('Paste exceeds the loaded records or columns. Add records before pasting.')); this.checkEditable(point); const previous = this.getValue(point); const value = rows[r]![c]!; edits.push({ kind: 'update', table: this.table.name, key: this.page.rows[point.row]!.key, column: this.columns[point.column]!.name, value: { type: previous.type === 'null' ? 'text' : previous.type, value } }); }
    if (edits.length > 10000) throw new Error(this.t('Select at most 10,000 cells.')); await this.host.request({ type: 'edit', edits }); await this.loadPage();
  }
  private parseTsv(text: string): string[][] {
    const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
    for (let index = 0; index < text.length; index++) { const char = text[index]!; if (char === '"' && (quoted || !field)) { if (quoted && text[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; } else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) { row.push(field); field = ''; if (char !== '\t') { rows.push(row); row = []; if (char === '\r' && text[index + 1] === '\n') index++; } } else field += char; }
    if (quoted) throw new Error(this.t('The pasted text has an unfinished quoted field.')); if (field || row.length || !rows.length) { row.push(field); rows.push(row); } return rows;
  }
  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { if (this.activeMenu) this.closeMenu(); else if (this.searchPanel?.open && !(event.target as Element).closest('dialog')) this.searchPanel.close(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.run({ type: 'save' }); return; }
    if (this.tab === 'sql' && (event.target as Element).closest('.cm-editor') && (event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) { event.preventDefault(); this.openSearch(event.key.toLowerCase() === 'f' ? 'find' : 'replace'); return; }
    if ((event.target as Element).closest('input, textarea, select, dialog, .cm-editor')) return;
    if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase()) && this.tab !== 'structure') { event.preventDefault(); this.openSearch(event.key.toLowerCase() === 'f' ? 'find' : 'replace'); return; }
    if (this.tab === 'sql' || this.tab === 'structure') { if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); this.undoRedo(event.key.toLowerCase() === 'y' || event.shiftKey); } return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); void this.fillDown(); return; }
    const command = event.metaKey || event.ctrlKey;
    if (command && ['s', 'z', 'y', 'c', 'v', 'a'].includes(event.key.toLowerCase())) {
      event.preventDefault(); const key = event.key.toLowerCase();
      if (key === 's') void this.run({ type: 'save' }); if (key === 'z') void this.run({ type: event.shiftKey ? 'redo' : 'undo' }); if (key === 'y') void this.run({ type: 'redo' }); if (key === 'c') void this.perform(() => this.copy(event.shiftKey)); if (key === 'v') void this.perform(() => this.paste()); if (key === 'a' && this.page.rows.length) { this.selection.selectAll(); this.renderSelection(); } return;
    }
    if (event.target !== this.viewport) return;
    if (this.loading) return;
    if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); this.editCell(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void this.setSelected({ type: 'null', value: '' }); return; }
    if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && this.cursor) { event.preventDefault(); const rect = this.cells[this.cursor.row]?.[this.cursor.column]?.getBoundingClientRect(); if (rect) this.cellMenu(rect.left, rect.bottom); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) && this.page.rows.length && this.columns.length) {
      event.preventDefault(); const point = this.cursor ?? { row: 0, column: 0 }; const lastRow = this.page.rows.length - 1; const lastColumn = this.columns.length - 1;
      const visibleRows = Math.max(1, Math.floor((this.viewport.clientHeight - 42) / 28) - 1); let { row, column } = point;
      switch (event.key) {
        // Moving past the first or last loaded record continues on the adjacent page.
        case 'ArrowUp': if (row === 0 && !event.shiftKey && this.view.offset > 0) { this.changePage(-1, { row: 'last', column }); return; } row--; break;
        case 'ArrowDown': if (row === lastRow && !event.shiftKey && this.page.hasMore) { this.changePage(1, { row: 'first', column }); return; } row++; break;
        case 'ArrowLeft': column--; break;
        case 'ArrowRight': column++; break;
        case 'Home': column = 0; if (command) row = 0; break;
        case 'End': column = lastColumn; if (command) row = lastRow; break;
        case 'PageUp': row -= visibleRows; break;
        case 'PageDown': row += visibleRows; break;
      }
      row = Math.max(0, Math.min(lastRow, row)); column = Math.max(0, Math.min(lastColumn, column));
      if (event.shiftKey) this.selection.extend(row, column); else this.selection.start(row, column); this.renderSelection(); this.revealCursor();
    }
  }
}

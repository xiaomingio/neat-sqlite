/*
Purpose: Verify multi-table navigation, safe staged edits and responsive SQLite editor rendering.
*/
import { test, expect } from '@playwright/test';
import { EditorFixture } from './EditorFixture';
let fixture: EditorFixture;
test.beforeEach(async ({ page }) => { fixture = new EditorFixture(); await fixture.open(page); });
test.afterEach(async () => { await fixture.close(); });
async function selectUsers(page: import('@playwright/test').Page): Promise<void> { await page.getByRole('button', { name: '▦ users', exact: true }).click(); await expect(page.getByRole('grid', { name: 'users', exact: true })).toBeVisible(); }

test('stages typed edits across tables and commits all changes', async ({ page }) => {
  await selectUsers(page);
  await page.getByRole('grid').getByText('Alice', { exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Alicia'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Unsaved changes: 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '▦ orders', exact: true }).click();
  await expect(page.getByRole('grid').getByText('First order')).toBeVisible();
  await page.getByRole('button', { name: '▦ users ●', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Alicia', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alicia', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'File', exact: true }).click(); await page.getByRole('menuitem', { name: 'Save changes' }).click();
  await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/sqlite-desktop.png' });
});

test('folds the sidebar into a searchable selector below menus', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Hide table list', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden(); const selector = page.getByRole('button', { name: 'Select table', exact: true }); await expect(selector).toBeVisible();
  const menuBounds = await page.locator('.toolbar').boundingBox(); const selectorBounds = await selector.boundingBox(); expect(selectorBounds!.y).toBeGreaterThanOrEqual(menuBounds!.y + menuBounds!.height);
  await selector.click(); await page.locator('.table-dropdown').getByRole('searchbox').fill('orders'); await page.locator('.table-dropdown').getByRole('option', { name: '▦ orders', exact: true }).click(); await expect(page.getByRole('grid').getByText('First order')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 700 }); await expect(selector).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Show table list', exact: true }).click(); await expect(page.locator('.sidebar')).toBeVisible(); await page.getByRole('button', { name: 'Hide table list', exact: true }).click(); await expect(page.locator('.sidebar')).toBeHidden();
  await page.screenshot({ path: 'test-results/sqlite-narrow.png' });
});

test('inspects structure and prevents edits to generated fields and views', async ({ page }) => {
  await selectUsers(page); await page.getByRole('grid').getByText('Alice!', { exact: true }).dblclick(); await expect(page.getByRole('alert')).toContainText('generated');
  await page.getByRole('button', { name: 'Structure', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Create SQL', exact: true })).toBeVisible(); await expect(page.locator('.structure')).toContainText('GENERATED ALWAYS');
  await page.getByRole('button', { name: '▤ user_names', exact: true }).click(); await page.getByRole('button', { name: 'Data', exact: true }).last().click(); await expect(page.locator('.read-only-note')).toContainText('Views are read-only');
});

test('supports reserved object-property table names without corrupting preferences', async ({ page }) => {
  await page.getByRole('button', { name: '▦ __proto__', exact: true }).click(); await expect(page.getByRole('grid').getByText('safe', { exact: true })).toBeVisible();
});

test('native save flushes a valid cell editor and rejects invalid input', async ({ page }) => {
  await selectUsers(page); await page.getByRole('grid').getByText('Alice', { exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Native save');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { event: 'flush', id: 700 } })));
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('grid').getByText('Native save', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { flushResult: { type: string; id: number } }).flushResult)).toEqual({ type: 'flushed', id: 700 });
  await page.getByRole('grid').getByText('Native save', { exact: true }).dblclick(); await page.getByRole('combobox', { name: 'name Type', exact: true }).selectOption('integer');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { event: 'flush', id: 701 } })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { flushResult: { id: number } }).flushResult.id)).toBe(701);
  expect(await page.evaluate(() => (window as unknown as { flushResult: { error: string } }).flushResult.error)).toContain('whole numbers');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('pastes copied values atomically and distinguishes NULL from empty text', async ({ page }) => {
  await selectUsers(page);
  await page.getByRole('grid').getByText('Alice', { exact: true }).click();
  await page.keyboard.press('Control+c');
  await page.getByRole('grid').getByText('Bob', { exact: true }).click(); await page.keyboard.press('Control+v');
  await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(2);
  await page.getByRole('grid').getByText('NULL', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('menuitem', { name: 'Set to empty text', exact: true }).click();
  await expect(page.getByRole('grid').getByText('NULL', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('menuitem', { name: 'Set to NULL', exact: true }).click();
  await expect(page.getByRole('grid').getByText('NULL', { exact: true })).toHaveCount(1);
});

test('adds records with defaults, filters and switches language and theme', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Add record…', exact: true }).click();
  await page.getByRole('combobox', { name: 'name Type', exact: true }).selectOption('text'); await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Carol'); await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Carol', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Carol'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0); await expect(page.getByRole('grid').getByText('Carol', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Language', exact: true }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await expect(page.getByRole('button', { name: '文件', exact: true })).toBeVisible(); await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.screenshot({ path: 'test-results/sqlite-dark-chinese.png' });
});

test('saving from the first open cell editor includes its unsubmitted value', async ({ page }) => {
  await selectUsers(page); await page.getByRole('grid').getByText('Alice', { exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('First save'); await page.keyboard.press('Control+s');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('grid').getByText('First save', { exact: true })).toBeVisible(); await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
});

test('does not expose previous table records while the next table loads', async ({ page }) => {
  await selectUsers(page); const release = fixture.holdNextPage('orders');
  await page.getByRole('button', { name: '▦ orders', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0);
  await expect(page.locator('.viewport')).toHaveAttribute('inert', '');
  release(); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible(); await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
});

test('searches and selects a collapsed table from the keyboard', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Hide table list', exact: true }).click(); await page.getByRole('button', { name: 'Select table', exact: true }).click();
  await page.locator('.table-dropdown').getByRole('searchbox').fill('orders'); await page.screenshot({ path: 'test-results/sqlite-table-dropdown.png' }); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.table-dropdown')).toHaveCount(0); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible();
});

test('clears record selection when deleting shifts the remaining records', async ({ page }) => {
  await selectUsers(page); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.getByRole('button', { name: 'Data', exact: true }).first().click(); await page.getByRole('menuitem', { name: 'Delete selected records…', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.locator('td.selected')).toHaveCount(0);
});

test('cycles sorting through original, ascending and descending with explicit checked menu choices', async ({ page }) => {
  await selectUsers(page); const sort = page.getByRole('button', { name: 'Sort name', exact: true }); const names = page.locator('.data-grid tbody td[data-column="1"]');
  await expect(names).toHaveText(['Alice', 'Bob']); await expect(sort).not.toHaveClass(/applied/);
  await sort.click(); await expect(sort).toHaveClass(/applied/); await expect(names).toHaveText(['Alice', 'Bob']);
  await sort.click(); await expect(names).toHaveText(['Bob', 'Alice']); await expect(sort).toHaveClass(/applied/);
  await sort.click(); await expect(names).toHaveText(['Alice', 'Bob']); await expect(sort).not.toHaveClass(/applied/);
  await sort.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Original order', exact: true })).toHaveAttribute('aria-pressed', 'true'); await page.getByRole('menuitem', { name: 'Descending', exact: true }).click(); await expect(names).toHaveText(['Bob', 'Alice']);
});

test('combines independent column filters and resets only the current column', async ({ page }) => {
  await selectUsers(page); const nameFilter = page.getByRole('button', { name: 'Filter name', exact: true }); const emailFilter = page.getByRole('button', { name: 'Filter email', exact: true });
  await nameFilter.click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('o'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(nameFilter).toHaveClass(/applied/);
  await emailFilter.click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty'); const preview = page.getByLabel('Generated SQL', { exact: true }); await expect(preview).toContainText(' AND '); await expect(preview).toContainText('"name"'); await expect(preview).toContainText('"email"'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(0); await expect(emailFilter).toHaveClass(/applied/);
  await emailFilter.click(); await page.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(nameFilter).toHaveClass(/applied/); await expect(emailFilter).not.toHaveClass(/applied/);
});

test('assembles compact SQL from Custom condition fragments and other column filters', async ({ page }) => {
  await selectUsers(page);
  await page.getByRole('button', { name: 'Filter email', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty');
  const preview = page.getByLabel('Generated SQL', { exact: true });
  expect(await preview.textContent()).not.toMatch(/[\t\r\n]/);
  await expect(preview).toContainText('char(9,10');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Filter name', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('custom');
  const fragment = page.getByRole('textbox', { name: 'Custom SQL predicate', exact: true });
  await fragment.fill('  "id" = 1\n OR\t "name" = \'Bob\'  ');
  const sql = await preview.textContent();
  expect(sql).not.toMatch(/[\t\r\n]/);
  expect(sql).toContain('("id" = 1 OR "name" = \'Bob\')');
  expect(sql).toContain(' AND ');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toBeVisible();
  await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter name', exact: true }).click();
  await page.screenshot({ path: 'test-results/sqlite-compact-custom.png' });
});

test('keeps invalid Custom SQL input and the previously applied filter while showing the generated query', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Bob'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Filter name', exact: true }).click(); const modes = page.getByRole('combobox', { name: 'Filter type', exact: true }); expect(await modes.locator('option').last().getAttribute('value')).toBe('custom'); await modes.selectOption('custom');
  const custom = page.getByRole('textbox', { name: 'Custom SQL predicate', exact: true }); await custom.fill('"id" >='); const inputBox = await custom.boundingBox(); const previewBox = await page.getByLabel('Generated SQL', { exact: true }).boundingBox(); expect(inputBox!.y).toBeLessThan(previewBox!.y);
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.filter-error')).not.toBeEmpty(); await expect(custom).toHaveValue('"id" >='); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0);
  await custom.fill('"id" = 1 OR "name" = \'Bob\''); await expect(page.getByLabel('Generated SQL', { exact: true })).toContainText('SELECT * FROM "users"'); await page.screenshot({ path: 'test-results/sqlite-custom-filter.png' }); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(2); await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.screenshot({ path: 'test-results/sqlite-custom-filter-applied.png' }); await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.screenshot({ path: 'test-results/sqlite-custom-filter-dark.png' });
});

test('filters exact typed values with counts and composes numeric ranges and RE2 filters', async ({ page }) => {
  await page.getByRole('button', { name: '▦ filter_values', exact: true }).click(); await page.getByRole('button', { name: 'Filter value', exact: true }).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('values');
  await expect(page.getByRole('checkbox', { name: '0 · integer', exact: true })).toBeVisible(); await expect(page.getByRole('checkbox', { name: '0 · text', exact: true })).toBeVisible(); await expect(page.locator('.filter-value').filter({ has: page.getByRole('checkbox', { name: 'A · text', exact: true }) })).toContainText('2');
  await page.getByRole('button', { name: 'Clear', exact: true }).click(); await page.getByRole('checkbox', { name: '0 · text', exact: true }).check(); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(1);
  await selectUsers(page); await page.getByRole('button', { name: 'Filter score', exact: true }).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('number'); await page.getByRole('combobox', { name: 'Number comparison', exact: true }).selectOption('between'); await page.getByRole('textbox', { name: 'Filter number', exact: true }).fill('1'); await page.getByRole('textbox', { name: 'Filter maximum', exact: true }).fill('2'); await expect(page.getByLabel('Generated SQL', { exact: true })).toContainText('BETWEEN'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('regex'); await page.getByRole('textbox', { name: 'Filter column by regular expression', exact: true }).fill('^A'); await expect(page.locator('.filter-note')).toContainText('RE2'); await expect(page.getByLabel('Generated SQL', { exact: true })).not.toContainText('REGEXP'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toHaveCount(0);
});

test('switches language directly from the checked Settings submenu', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Language', exact: true }).hover(); await expect(page.getByRole('menuitemradio', { name: 'English', exact: true })).toHaveAttribute('aria-checked', 'true'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('menuitem', { name: '语言', exact: true }).click(); await expect(page.getByRole('menuitemradio', { name: '简体中文', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.screenshot({ path: 'test-results/sqlite-language-submenu.png' });
});

test('supports modifier selections for rows and columns with distinct header menu and reorder controls', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Record 1', exact: true }).click(); await page.getByRole('button', { name: 'Record 2', exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(10);
  await page.getByRole('button', { name: 'Record 1', exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(5);
  await page.getByRole('button', { name: 'Select column name', exact: true }).click(); await expect(page.locator('td.selected')).toHaveCount(2); await page.getByRole('button', { name: 'Select column email', exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Select column score', exact: true }).click({ modifiers: ['Shift'] }); await expect(page.locator('td.selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Column options name', exact: true }).click(); await expect(page.getByRole('menuitem', { name: 'Pin column', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Reorder column name', exact: true })).toBeVisible();
});

test('updates sparse selected cells exactly and rejects copying incomplete rectangles', async ({ page }) => {
  await selectUsers(page); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.getByRole('grid').getByText('NULL', { exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(2);
  await page.keyboard.press('Control+c'); await expect(page.getByRole('alert')).toContainText('rectangle'); await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('menuitem', { name: 'Set to empty text', exact: true }).click();
  await expect(page.locator('td[data-row="0"][data-column="1"]')).toHaveText(''); await expect(page.locator('td[data-row="1"][data-column="2"]')).toHaveText(''); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('alice@example.com', { exact: true })).toBeVisible();
});

test('draws one outer border around a rectangle with neutral internal grid edges', async ({ page }) => {
  await selectUsers(page); await page.locator('td[data-row="0"][data-column="1"]').click(); await page.locator('td[data-row="1"][data-column="2"]').click({ modifiers: ['Shift'] }); await expect(page.locator('td.selected')).toHaveCount(4);
  const edge = await page.locator('td[data-row="0"][data-column="1"]').evaluate(node => { const style = getComputedStyle(node); return { top: style.borderTopColor, left: style.borderLeftColor, right: style.borderRightColor, bottom: style.borderBottomColor, outline: style.outlineStyle, fill: style.backgroundColor }; });
  expect(edge.top).toBe('rgb(8, 119, 201)'); expect(edge.left).toBe(edge.top); expect(edge.right).toBe('rgb(226, 226, 226)'); expect(edge.bottom).toBe(edge.right); expect(edge.outline).toBe('none'); expect(await page.locator('.viewport').evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
  await page.screenshot({ path: 'test-results/sqlite-rectangle-selection.png' });
  await page.getByRole('button', { name: 'Select column name', exact: true }).click(); await expect(page.locator('td[data-row="1"][data-column="1"]')).toHaveClass(/selection-bottom/);
  await page.getByRole('button', { name: 'Record 1', exact: true }).click(); await expect(page.locator('td[data-row="0"][data-column="4"]')).toHaveClass(/selection-right/);
  await page.getByRole('button', { name: 'Select all loaded cells', exact: true }).click(); await expect(page.locator('td[data-row="1"][data-column="4"]')).toHaveClass(/selection-bottom/); await expect(page.locator('td[data-row="1"][data-column="4"]')).toHaveClass(/selection-right/);
});

test('does not edit a Ctrl-toggled-off cell when the selection becomes empty', async ({ page }) => {
  await selectUsers(page); const alice = page.getByRole('grid').getByText('Alice', { exact: true }); await alice.click(); await alice.click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(0); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('Select a cell first');
});

test('keeps each table filter state isolated when a delayed Custom query fails after switching tables', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Bob'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Filter name', exact: true }).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('custom'); await page.getByRole('textbox', { name: 'Custom SQL predicate', exact: true }).fill('"id" >='); const release = fixture.holdNextPage('users');
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('button', { name: '▦ orders', exact: true }).click(); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible(); release();
  await expect.poll(() => page.locator('.viewport').getAttribute('aria-busy')).toBe('false');
  await page.getByRole('button', { name: '▦ users', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '▦ orders', exact: true }).click(); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible();
});

test('drags header labels to extend column and row selections while reordering only with the separate handle', async ({ page }) => {
  await selectUsers(page); const first = await page.getByRole('button', { name: 'Select column name', exact: true }).boundingBox(); const last = await page.getByRole('button', { name: 'Select column score', exact: true }).boundingBox();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2); await page.mouse.down(); await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 8 }); await page.mouse.up(); await expect(page.locator('td.selected')).toHaveCount(6);
  const row1 = await page.getByRole('button', { name: 'Record 1', exact: true }).boundingBox(); const row2 = await page.getByRole('button', { name: 'Record 2', exact: true }).boundingBox(); await page.mouse.move(row1!.x + row1!.width / 2, row1!.y + row1!.height / 2); await page.mouse.down(); await page.mouse.move(row2!.x + row2!.width / 2, row2!.y + row2!.height / 2, { steps: 4 }); await page.mouse.up(); await expect(page.locator('td.selected')).toHaveCount(10);
  await page.getByRole('button', { name: 'Reorder column name', exact: true }).dragTo(page.getByRole('button', { name: 'Select column id', exact: true })); await expect(page.locator('.data-grid thead th').nth(1).getByRole('button', { name: 'Select column name', exact: true })).toBeVisible(); await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 700 }); await expect(page.getByRole('button', { name: 'Select table', exact: true })).toBeVisible(); await expect(page.locator('.sidebar')).toBeHidden();
});

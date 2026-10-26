/*
Purpose: Verify multi-table navigation, safe staged edits and responsive SQLite editor rendering.
*/
import { test, expect, type Locator } from '@playwright/test';
import { EditorFixture } from './EditorFixture';
let fixture: EditorFixture;
test.beforeEach(async ({ page }) => { fixture = new EditorFixture(); await fixture.open(page); });
test.afterEach(async () => { await fixture.close(); });
/** Column labels share their right end with hover tools, so pointer tests target the start of the name. */
const LABEL = { x: 12, y: 12 };
/** Reveal the header before targeting tools that collapse when the pointer leaves. */
async function revealHeaderButton(control: Locator): Promise<Locator> {
  await control.locator('xpath=ancestor::th').hover({ position: LABEL }); return control;
}
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
  await selectUsers(page); await page.getByRole('button', { name: 'Record 1', exact: true }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Add record…', exact: true }).click();
  await page.getByRole('combobox', { name: 'name Type', exact: true }).selectOption('text'); await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Carol'); await page.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(page.getByRole('grid').getByText('Carol', { exact: true })).toBeVisible();
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Carol'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
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

test('cycles each sort column and combines several columns in the order they were added', async ({ page }) => {
  await selectUsers(page); const sortName = page.getByRole('button', { name: 'Sort name', exact: true, includeHidden: true }); const names = page.locator('.data-grid tbody td[data-column="1"]');
  await expect(names).toHaveText(['Alice', 'Bob']); await expect(sortName).not.toHaveClass(/applied/);
  await (await revealHeaderButton(sortName)).click(); await expect(sortName).toHaveClass(/applied/); await expect(names).toHaveText(['Alice', 'Bob']);
  await (await revealHeaderButton(sortName)).click(); await expect(names).toHaveText(['Bob', 'Alice']); await expect(sortName).toHaveClass(/applied/);
  await (await revealHeaderButton(sortName)).click(); await expect(names).toHaveText(['Alice', 'Bob']); await expect(sortName).not.toHaveClass(/applied/);
  await (await revealHeaderButton(page.getByRole('button', { name: 'Sort score', exact: true, includeHidden: true }))).click(); await (await revealHeaderButton(sortName)).click(); await (await revealHeaderButton(sortName)).click();
  await expect(page.locator('th[data-header-column="1"] .sort-rank')).toHaveText('2'); await expect(names).toHaveText(['Bob', 'Alice']);
  await (await revealHeaderButton(sortName)).click({ button: 'right' }); const panel = page.getByRole('dialog', { name: 'Sort order', exact: true });
  await expect(panel.locator('.sort-column')).toHaveText(['score', 'name']); await expect(panel.getByLabel('Generated SQL', { exact: true })).toHaveText('ORDER BY "score" ASC, "name" DESC');
  await panel.getByRole('button', { name: 'Move name up', exact: true }).click(); await expect(panel.locator('.sort-column')).toHaveText(['name', 'score']); await expect(panel.getByLabel('Generated SQL', { exact: true })).toHaveText('ORDER BY "name" DESC, "score" ASC');
  await panel.getByRole('button', { name: 'name: Descending. Click to reverse', exact: true }).click(); await expect(names).toHaveText(['Alice', 'Bob']);
  await panel.getByRole('combobox', { name: 'Add sort column', exact: true }).selectOption('email'); await expect(panel.locator('.sort-column')).toHaveText(['name', 'score', 'email']);
  await page.screenshot({ path: 'test-results/sqlite-sort-panel.png' });
  await panel.getByRole('button', { name: 'Reset all sorting', exact: true }).click(); await expect(panel.getByText('No sorting. Records use their natural order.', { exact: true })).toBeVisible(); await expect(sortName).not.toHaveClass(/applied/);
  await page.keyboard.press('Escape'); await (await revealHeaderButton(page.getByRole('button', { name: 'Column options name', exact: true, includeHidden: true }))).click(); await expect(page.getByRole('menuitem', { name: 'Ascending', exact: true })).toBeVisible(); await expect(page.getByRole('menuitem', { name: 'Pin column', exact: true })).toBeVisible();
});

test('combines independent column filters and resets only the current column', async ({ page }) => {
  await selectUsers(page); const nameFilter = page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }); const emailFilter = page.getByRole('button', { name: 'Filter email', exact: true, includeHidden: true });
  await (await revealHeaderButton(nameFilter)).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('o'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(nameFilter).toHaveClass(/applied/);
  await (await revealHeaderButton(emailFilter)).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty'); const preview = page.getByLabel('Generated SQL', { exact: true }); await expect(preview).toContainText(' AND '); await expect(preview).toContainText('"name"'); await expect(preview).toContainText('"email"'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(0); await expect(emailFilter).toHaveClass(/applied/);
  await (await revealHeaderButton(emailFilter)).click(); await page.getByRole('button', { name: 'Reset', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(nameFilter).toHaveClass(/applied/); await expect(emailFilter).not.toHaveClass(/applied/);
});

test('assembles compact SQL from Custom condition fragments and other column filters', async ({ page }) => {
  await selectUsers(page);
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter email', exact: true, includeHidden: true }))).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty');
  const preview = page.getByLabel('Generated SQL', { exact: true });
  expect(await preview.textContent()).not.toMatch(/[\t\r\n]/);
  await expect(preview).toContainText('char(9,10');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click();
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
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click();
  await page.screenshot({ path: 'test-results/sqlite-compact-custom.png' });
});

test('keeps invalid Custom SQL input and the previously applied filter while showing the generated condition', async ({ page }) => {
  await selectUsers(page); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Bob'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); const modes = page.getByRole('combobox', { name: 'Filter type', exact: true }); expect(await modes.locator('option').last().getAttribute('value')).toBe('custom'); await modes.selectOption('custom');
  const custom = page.getByRole('textbox', { name: 'Custom SQL predicate', exact: true }); await custom.fill('"id" >='); const inputBox = await custom.boundingBox(); const previewBox = await page.getByLabel('Generated SQL', { exact: true }).boundingBox(); expect(inputBox!.y).toBeLessThan(previewBox!.y);
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.filter-error')).not.toBeEmpty(); await expect(custom).toHaveValue('"id" >='); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0);
  await custom.fill('"id" = 1 OR "name" = \'Bob\''); await expect(page.getByLabel('Generated SQL', { exact: true })).toHaveText('("id" = 1 OR "name" = \'Bob\')'); await page.screenshot({ path: 'test-results/sqlite-custom-filter.png' }); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(2); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.screenshot({ path: 'test-results/sqlite-custom-filter-applied.png' }); await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.screenshot({ path: 'test-results/sqlite-custom-filter-dark.png' });
});

test('filters exact typed values with counts and composes numeric ranges and RE2 filters', async ({ page }) => {
  await page.getByRole('button', { name: '▦ filter_values', exact: true }).click(); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter value', exact: true, includeHidden: true }))).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('values');
  await expect(page.getByRole('checkbox', { name: '0 · integer', exact: true })).toBeVisible(); await expect(page.getByRole('checkbox', { name: '0 · text', exact: true })).toBeVisible(); await expect(page.locator('.filter-value').filter({ has: page.getByRole('checkbox', { name: 'A · text', exact: true }) })).toContainText('2');
  await page.getByRole('button', { name: 'Clear', exact: true }).click(); await page.getByRole('checkbox', { name: '0 · text', exact: true }).check(); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.data-grid tbody tr')).toHaveCount(1);
  await selectUsers(page); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter score', exact: true, includeHidden: true }))).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('number'); await page.getByRole('combobox', { name: 'Number comparison', exact: true }).selectOption('between'); await page.getByRole('textbox', { name: 'Filter number', exact: true }).fill('1'); await page.getByRole('textbox', { name: 'Filter maximum', exact: true }).fill('2'); await expect(page.getByLabel('Generated SQL', { exact: true })).toContainText('BETWEEN'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('regex'); await page.getByRole('textbox', { name: 'Filter column by regular expression', exact: true }).fill('^A'); await expect(page.locator('.filter-note')).toContainText('RE2'); await expect(page.getByLabel('Generated SQL', { exact: true })).not.toContainText('REGEXP'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toHaveCount(0);
});

test('switches language directly from the checked Settings submenu', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Language', exact: true }).hover(); await expect(page.getByRole('menuitemradio', { name: 'English', exact: true })).toHaveAttribute('aria-checked', 'true'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('menuitem', { name: '语言', exact: true }).click(); await expect(page.getByRole('menuitemradio', { name: '简体中文', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.screenshot({ path: 'test-results/sqlite-language-submenu.png' });
});

test('supports modifier selections for rows and columns with distinct header menu and reorder controls', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Record 1', exact: true }).click(); await page.getByRole('button', { name: 'Record 2', exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(10);
  await page.getByRole('button', { name: 'Record 1', exact: true }).click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(5);
  await page.getByRole('button', { name: 'Select column name', exact: true }).click({ position: LABEL }); await expect(page.locator('td.selected')).toHaveCount(2); await page.getByRole('button', { name: 'Select column email', exact: true }).click({ position: LABEL, modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Select column score', exact: true }).click({ position: LABEL, modifiers: ['Shift'] }); await expect(page.locator('td.selected')).toHaveCount(4);
  await (await revealHeaderButton(page.getByRole('button', { name: 'Column options name', exact: true, includeHidden: true }))).click(); await expect(page.getByRole('menuitem', { name: 'Pin column', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Reorder column name', exact: true, includeHidden: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Select column name', exact: true }).click({ position: LABEL }); await expect(page.locator('td[data-row="1"][data-column="1"]')).toHaveClass(/selection-bottom/);
  await page.getByRole('button', { name: 'Record 1', exact: true }).click(); await expect(page.locator('td[data-row="0"][data-column="4"]')).toHaveClass(/selection-right/);
  await page.getByRole('button', { name: 'Select all loaded cells', exact: true }).click(); await expect(page.locator('td[data-row="1"][data-column="4"]')).toHaveClass(/selection-bottom/); await expect(page.locator('td[data-row="1"][data-column="4"]')).toHaveClass(/selection-right/);
});

test('does not edit a Ctrl-toggled-off cell when the selection becomes empty', async ({ page }) => {
  await selectUsers(page); const alice = page.getByRole('grid').getByText('Alice', { exact: true }); await alice.click(); await alice.click({ modifiers: ['Control'] }); await expect(page.locator('td.selected')).toHaveCount(0); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('Select a cell first');
});

test('keeps each table filter state isolated when a delayed Custom query fails after switching tables', async ({ page }) => {
  await selectUsers(page); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Bob'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('custom'); await page.getByRole('textbox', { name: 'Custom SQL predicate', exact: true }).fill('"id" >='); const release = fixture.holdNextPage('users');
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('button', { name: '▦ orders', exact: true }).click(); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible(); release();
  await expect.poll(() => page.locator('.viewport').getAttribute('aria-busy')).toBe('false');
  await page.getByRole('button', { name: '▦ users', exact: true }).click(); await expect(page.getByRole('grid').getByText('Bob', { exact: true })).toBeVisible(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '▦ orders', exact: true }).click(); await expect(page.getByRole('grid').getByText('First order', { exact: true })).toBeVisible();
});

test('drags header labels to extend column and row selections while reordering only with the separate handle', async ({ page }) => {
  await selectUsers(page); const first = await page.getByRole('button', { name: 'Select column name', exact: true }).boundingBox(); const last = await page.getByRole('button', { name: 'Select column score', exact: true }).boundingBox();
  await page.mouse.move(first!.x + LABEL.x, first!.y + LABEL.y); await page.mouse.down(); await page.mouse.move(last!.x + LABEL.x, last!.y + LABEL.y, { steps: 8 }); await page.mouse.up(); await expect(page.locator('td.selected')).toHaveCount(6);
  const row1 = await page.getByRole('button', { name: 'Record 1', exact: true }).boundingBox(); const row2 = await page.getByRole('button', { name: 'Record 2', exact: true }).boundingBox(); await page.mouse.move(row1!.x + row1!.width / 2, row1!.y + row1!.height / 2); await page.mouse.down(); await page.mouse.move(row2!.x + row2!.width / 2, row2!.y + row2!.height / 2, { steps: 4 }); await page.mouse.up(); await expect(page.locator('td.selected')).toHaveCount(10);
  await (await revealHeaderButton(page.getByRole('button', { name: 'Reorder column name', exact: true, includeHidden: true }))).dragTo(page.getByRole('button', { name: 'Select column id', exact: true }), { targetPosition: LABEL }); await expect(page.locator('.data-grid thead th').nth(1).getByRole('button', { name: 'Select column name', exact: true })).toBeVisible(); await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 700 }); await expect(page.getByRole('button', { name: 'Select table', exact: true })).toBeVisible(); await expect(page.locator('.sidebar')).toBeHidden();
});

test('keyboard navigation reaches row edges, crosses pages and keeps focus after edits', async ({ page }) => {
  await page.getByRole('button', { name: '▦ paged', exact: true }).click(); await page.locator('td[data-row="0"][data-column="0"]').click();
  await page.keyboard.press('End'); await expect(page.locator('td.selected')).toHaveCount(1); await expect(page.locator('td[data-row="0"][data-column="1"]')).toHaveClass(/selected/);
  await page.keyboard.press('Control+End'); await expect(page.locator('td[data-row="199"][data-column="1"]')).toHaveClass(/selected/);
  await page.keyboard.press('ArrowDown'); await expect(page.getByText('Rows: 201–205', { exact: true })).toBeVisible(); await expect(page.locator('td[data-row="0"][data-column="1"]')).toHaveClass(/selected/); await expect(page.locator('td[data-row="0"][data-column="1"]')).toHaveText('2010');
  await page.keyboard.press('ArrowUp'); await expect(page.getByText('Rows: 1–200', { exact: true })).toBeVisible(); await expect(page.locator('td[data-row="199"][data-column="1"]')).toHaveClass(/selected/);
  await page.keyboard.press('F2'); await page.getByRole('textbox', { name: 'amount Value', exact: true }).fill('7'); await page.keyboard.press('Enter');
  await expect(page.locator('td[data-row="199"][data-column="1"]')).toHaveText('7'); await expect(page.locator('.viewport')).toBeFocused();
  await page.keyboard.press('Shift+ArrowUp'); await expect(page.locator('td.selected')).toHaveCount(2); await expect(page.locator('.selection-status')).toContainText('Sum: 1997');
});

test('menus reflect availability and move between top-level menus from the keyboard', async ({ page }) => {
  await selectUsers(page); await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled(); await expect(page.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled(); await expect(page.getByRole('menuitem', { name: 'Discard all changes…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Find…', exact: true })).toBeFocused(); await expect(page.getByRole('menuitem', { name: 'Paste', exact: true })).toBeEnabled();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Add record…', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Data', exact: true }).first()).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape'); await expect(page.locator('.command-menu')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Data', exact: true }).first()).toBeFocused();
  await page.getByRole('grid').getByText('Alice', { exact: true }).click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Edit cell…', exact: true })).toBeFocused(); await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Delete selected records…', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '▤ user_names', exact: true }).click(); await page.getByRole('grid').getByText('Alice', { exact: true }).click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Paste', exact: true })).toBeDisabled(); await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
});

test('resizes columns in place and fits a column to its content', async ({ page }) => {
  await selectUsers(page); const heading = page.locator('th[data-header-column="2"]'); const handle = heading.locator('.column-resize'); const before = (await heading.boundingBox())!.width; const box = await handle.boundingBox();
  await page.mouse.move(box!.x + 3, box!.y + 10); await page.mouse.down(); await page.mouse.move(box!.x + 103, box!.y + 10, { steps: 5 });
  await expect.poll(async () => Math.round((await heading.boundingBox())!.width)).toBe(Math.round(before) + 100); await page.mouse.up();
  const widths = await page.locator('.data-grid thead th').evaluateAll(nodes => nodes.reduce((sum, node) => sum + (node as HTMLElement).getBoundingClientRect().width, 0));
  const grid = await page.getByRole('grid').evaluate(node => Number.parseFloat((node as HTMLElement).style.width)); expect(Math.abs(grid - widths)).toBeLessThan(1);
  await handle.dblclick(); const fitted = (await heading.boundingBox())!.width; expect(fitted).toBeGreaterThanOrEqual(120); expect(fitted).toBeLessThan(before + 100);
  await expect(page.getByRole('grid').getByText('alice@example.com', { exact: true })).toBeVisible();
});

for (const selectAll of ['corner', 'keyboard']) test(`fits every visible column after selecting all with ${selectAll}`, async ({ page }) => {
  await selectUsers(page);
  const headings = page.locator('th[data-header-column]');
  const widths = () => headings.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  const before = await widths();
  if (selectAll === 'corner') await page.getByRole('button', { name: 'Select all loaded cells', exact: true }).click();
  else { await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.keyboard.press('ControlOrMeta+a'); }
  await headings.nth(0).locator('.column-resize').dblclick();
  const after = await widths();
  for (let index = 0; index < before.length; index++) expect(after[index]).toBeLessThan(before[index]!);
  await expect(page.locator('td[aria-selected="true"]')).toHaveCount(await page.locator('td[data-row]').count());
});

test('follows the VS Code theme class until the user picks a theme and localizes parameterized status text', async ({ page }) => {
  await page.evaluate(() => document.body.classList.add('vscode-dark')); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); }); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await selectUsers(page); await page.getByRole('grid').getByText('Alice', { exact: true }).dblclick(); await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Ann'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('menuitem', { name: 'Language', exact: true }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await expect(page.getByText('待保存修改：1', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '筛选 name', exact: true })).toBeVisible(); await expect(page.getByText('记录：1–2', { exact: true })).toBeVisible();
});

test('header controls share one icon set and header text has no hover fill', async ({ page }) => {
  await selectUsers(page); const heading = page.locator('th[data-header-column="1"]');
  await heading.hover(); const controls = heading.locator('.header-icon'); await expect(controls).toHaveCount(4); await expect(heading.locator('.header-icon svg.icon')).toHaveCount(4);
  const sizes = await controls.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); const icon = node.querySelector('svg')!.getBoundingClientRect(); return `${box.width}x${box.height}:${icon.width}x${icon.height}`; }));
  expect(new Set(sizes).size).toBe(1);
  const label = page.getByRole('button', { name: 'Select column name', exact: true }); await label.hover({ position: LABEL });
  expect(await label.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.move(0, 400); await (await revealHeaderButton(page.getByRole('button', { name: 'Sort name', exact: true, includeHidden: true }))).click(); await (await revealHeaderButton(page.getByRole('button', { name: 'Filter email', exact: true, includeHidden: true }))).click(); await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort name', exact: true, includeHidden: true }).locator('svg.icon-ascending')).toHaveCount(1); await page.mouse.move(0, 400);
  await page.screenshot({ path: 'test-results/sqlite-header-light.png', clip: { x: 0, y: 0, width: 1200, height: 180 } });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await page.mouse.move(0, 400); await page.screenshot({ path: 'test-results/sqlite-header-dark.png', clip: { x: 0, y: 0, width: 1200, height: 180 } });
});

test('column moves show a dimmed source and drop side, keep icon hover, and only change display order', async ({ page }) => {
  await selectUsers(page); const sortIcon = page.getByRole('button', { name: 'Sort email', exact: true, includeHidden: true }); await (await revealHeaderButton(sortIcon)).hover();
  expect(await sortIcon.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const handle = page.getByRole('button', { name: 'Reorder column name', exact: true, includeHidden: true }); const target = page.locator('th[data-header-column="3"]');
  await revealHeaderButton(handle); const from = (await handle.boundingBox())!; const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); await page.mouse.move(to.x + to.width * 0.75, to.y + to.height / 2, { steps: 10 });
  await expect(target).toHaveClass(/drop-after/); await expect(page.locator('.data-grid th[data-header-column="1"]')).toHaveClass(/dragging/); await expect(page.locator('.column-drag-image [data-header-column], .column-drag-image [data-row]')).toHaveCount(0); await expect(page.locator('td.column-dragging')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/sqlite-column-drag.png' });
  await page.mouse.up();
  await expect(page.locator('.data-grid thead th').nth(4).getByRole('button', { name: 'Select column name', exact: true })).toBeVisible();
  await expect(page.locator('.column-drag-image, th.drop-target, .column-dragging')).toHaveCount(0); await expect(page.getByText('No unsaved changes', { exact: true })).toBeVisible();
});

test('the column menu exposes sorting, filtering and layout while active tools remain visible', async ({ page }) => {
  await selectUsers(page);
  const heading = page.locator('th[data-header-column="1"]'); const tools = heading.locator('.header-icon');
  await page.mouse.move(0, 400);
  const labelWidth = () => heading.locator('.column-label').evaluate(node => node.getBoundingClientRect().width);
  const fullLabelWidth = await labelWidth();
  const options = page.getByRole('button', { name: 'Column options name', exact: true, includeHidden: true });
  await (await revealHeaderButton(options)).click();
  for (const name of ['Ascending', 'Descending', 'Remove sorting', 'Sort order…', 'Filter…', 'Clear filter', 'Pin column', 'Hide column']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Remove sorting', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Clear filter', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Descending', exact: true }).click(); await expect(heading).toHaveAttribute('aria-sort', 'descending');
  await (await revealHeaderButton(options)).click(); await page.getByRole('menuitem', { name: 'Filter…', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter type', exact: true }).selectOption('notEmpty'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.mouse.move(0, 400);
  await expect(heading.locator('.header-icon:visible')).toHaveCount(2);
  const compactLabelWidth = await labelWidth();
  const activeWidth = await heading.locator('.column-tools').evaluate(node => node.getBoundingClientRect().width);
  expect(fullLabelWidth - compactLabelWidth).toBeCloseTo(activeWidth, 0);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
    for (const property of ['color', 'background-color']) {
      const token = property === 'color' ? '--applied-fg' : '--applied-bg';
      const colors = await heading.locator('.applied').evaluateAll((nodes, params) => nodes.map(node => ({ actual: getComputedStyle(node).getPropertyValue(params.property), expected: getComputedStyle(node).getPropertyValue(params.token).trim() })), { property, token });
      for (const color of colors) expect(color.actual).toBe(await page.evaluate(value => { const span = document.createElement('span'); span.style.color = value; document.body.append(span); const result = getComputedStyle(span).color; span.remove(); return result; }, color.expected));
    }
    await page.screenshot({ path: `test-results/sqlite-active-tools-${theme}.png`, clip: { x: 0, y: 0, width: 1200, height: 180 } });
  }
  await heading.hover(); await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  expect(await labelWidth()).toBeLessThan(compactLabelWidth);
  await page.mouse.move(0, 400); expect(await labelWidth()).toBe(compactLabelWidth);
  await heading.locator('.column-label').focus(); await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  await (await revealHeaderButton(options)).click(); await page.screenshot({ path: 'test-results/sqlite-column-menu.png' }); await page.getByRole('menuitem', { name: 'Sort order…', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Sort order', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await (await revealHeaderButton(options)).click(); await page.getByRole('menuitem', { name: 'Clear filter', exact: true }).click(); await expect(heading.locator('.column-filter-button')).not.toHaveClass(/applied/);
  await (await revealHeaderButton(options)).click(); await page.getByRole('menuitem', { name: 'Remove sorting', exact: true }).click(); await expect(heading.locator('.sort-button')).not.toHaveClass(/applied/);
  await (await revealHeaderButton(options)).click(); await page.getByRole('menuitem', { name: 'Pin column', exact: true }).click(); await expect(page.getByRole('button', { name: 'Select column name', exact: true }).locator('xpath=ancestor::th')).toHaveClass(/pinned/);
});

test('keeps all four header tools visible while any column popup is open and collapses them when closed', async ({ page }) => {
  await selectUsers(page);
  const heading = page.locator('th[data-header-column="1"]');
  const options = page.getByRole('button', { name: 'Column options name', exact: true, includeHidden: true });
  const filter = page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true });
  const sort = page.getByRole('button', { name: 'Sort name', exact: true, includeHidden: true });
  await (await revealHeaderButton(options)).click(); await page.getByRole('menuitem', { name: 'Filter…', exact: true }).hover();
  await expect(options).toBeVisible(); await expect(options).toHaveAttribute('aria-expanded', 'true');
  await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  await page.getByRole('menuitem', { name: 'Filter…', exact: true }).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Alice');
  await expect(options).toBeVisible(); await expect(options).toHaveAttribute('aria-expanded', 'true');
  await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.mouse.move(0, 400); await expect(options).toBeHidden();
  await (await revealHeaderButton(filter)).click(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).hover(); await page.getByRole('textbox', { name: 'Filter column by text', exact: true }).fill('Bob');
  await expect(filter).toBeVisible(); await expect(filter).toHaveAttribute('aria-expanded', 'true'); await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  await page.keyboard.press('Escape'); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.mouse.move(0, 400); await expect(filter).toBeHidden();
  await (await revealHeaderButton(sort)).click({ button: 'right' }); await page.getByRole('dialog', { name: 'Sort order', exact: true }).hover(); await expect(sort).toBeVisible();
  await page.getByRole('combobox', { name: 'Add sort column', exact: true }).selectOption('email');
  await expect(page.locator('th[data-header-column="2"]')).toHaveAttribute('aria-sort', 'ascending'); await expect(sort).toBeVisible(); await expect(sort).toHaveAttribute('aria-expanded', 'true');
  await expect(heading.locator('.header-icon:visible')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/sqlite-open-header-menu.png', clip: { x: 0, y: 0, width: 1200, height: 600 } });
  await page.keyboard.press('Escape'); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.mouse.move(0, 400); await expect(sort).toBeHidden();
});

test('header tools appear on hover and the toolbar tip follows the hovered control', async ({ page }) => {
  await selectUsers(page); const heading = page.locator('th[data-header-column="1"]'); const tools = heading.locator('.column-tools'); const hint = page.locator('.toolbar-hint');
  await page.mouse.move(600, 500); await expect(tools.locator('.header-icon:visible')).toHaveCount(0); await expect(hint).toHaveText('');
  await (await revealHeaderButton(page.getByRole('button', { name: 'Reorder column name', exact: true, includeHidden: true }))).hover(); await expect(tools.locator('.header-icon:visible')).toHaveCount(4);
  await expect(hint).toContainText('The column order in the database does not change');
  await (await revealHeaderButton(page.getByRole('button', { name: 'Filter name', exact: true, includeHidden: true }))).hover(); await expect(hint).toContainText('filter this column');
  await page.getByRole('grid').getByText('Alice', { exact: true }).hover(); await expect(hint).toContainText('Double-click, Enter or F2: edit');
  await page.getByRole('button', { name: 'Undo', exact: true }).hover(); await expect(hint).toContainText('undo');
  await (await revealHeaderButton(page.getByRole('button', { name: 'Sort name', exact: true, includeHidden: true }))).click(); await page.mouse.move(600, 500);
  await expect(heading).toHaveAttribute('aria-sort', 'ascending'); await expect(heading.locator('.column-name')).toHaveText('name');
  await page.screenshot({ path: 'test-results/sqlite-header-rest.png', clip: { x: 0, y: 0, width: 1200, height: 180 } });
  await (await revealHeaderButton(page.getByRole('button', { name: 'Reorder column email', exact: true, includeHidden: true }))).hover(); await page.screenshot({ path: 'test-results/sqlite-header-hover.png', clip: { x: 0, y: 0, width: 1200, height: 180 } });
});

/*
Purpose: Verify the SQL workbench, full-query data tools, foreign key navigation and visible pagination.
*/
import { test, expect, type Page } from '@playwright/test';
import { EditorFixture } from './EditorFixture';
let fixture: EditorFixture;
test.beforeEach(async ({ page }) => { fixture = new EditorFixture(); await fixture.open(page); });
test.afterEach(async () => { await fixture.close(); });
async function table(page: Page, name: string): Promise<void> { await page.locator('.table-list').getByRole('button', { name: `▦ ${name}`, exact: true }).click(); await expect(page.getByRole('grid', { name, exact: true })).toBeVisible(); }
async function menu(page: Page, name: string, item: string): Promise<void> { await page.locator('.toolbar').getByRole('button', { name, exact: true }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); }
async function sql(page: Page, text: string): Promise<void> { await page.getByRole('button', { name: 'SQL Query', exact: true }).click(); await page.locator('.cm-content').click(); await page.locator('.cm-content').press('ControlOrMeta+a'); await page.keyboard.type(text); }

test('SQL query results preserve integer precision and support history, saved queries and real CSP styles', async ({ page }) => {
  const errors: string[] = []; page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await sql(page, "SELECT 9223372036854775807 AS exact, NULL AS missing, '' AS empty; SELECT 2 AS other;");
  await page.locator('.cm-content').press('Home'); await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.locator('.query-result-table')).toContainText('9223372036854775807'); await expect(page.locator('.query-result-table')).toContainText('NULL'); await expect(page.locator('.query-result-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save query…', exact: true }).click(); await page.getByRole('textbox', { name: 'Query name' }).fill('Exact integers'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Saved queries' }).locator('option')).toHaveCount(2); await expect(page.getByRole('combobox', { name: 'Query history' }).locator('option')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/sqlite-query-light.png' });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click(); await page.screenshot({ path: 'test-results/sqlite-query-dark.png' });
  await page.setViewportSize({ width: 390, height: 700 }); await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeVisible(); await page.screenshot({ path: 'test-results/sqlite-query-narrow.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors.filter(error => /content security|refused|style-src/i.test(error))).toEqual([]);
});

test('SQL cancellation interrupts a real long-running query without losing the editor', async ({ page }) => {
  await sql(page, 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n');
  await page.getByRole('button', { name: 'Run query', exact: true }).click(); await page.getByRole('button', { name: 'Cancel query', exact: true }).click(); await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeEnabled();
  await page.locator('.cm-content').press('ControlOrMeta+a'); await page.keyboard.type('SELECT 42 AS answer'); await page.getByRole('button', { name: 'Run query', exact: true }).click(); await expect(page.locator('.query-result-table')).toContainText('42');
});

test('SQL writes require confirmation and refresh schema while retaining the query workspace', async ({ page }) => {
  await sql(page, 'CREATE TABLE added_table(id INTEGER PRIMARY KEY, title TEXT)'); await page.getByRole('checkbox', { name: 'Execute writes immediately' }).check(); await page.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Execute SQL write?' })).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.locator('.table-list')).toContainText('added_table'); await expect(page.locator('.cm-content')).toContainText('CREATE TABLE added_table'); await expect(page.locator('.query-status')).toContainText('Committed');
});

test('pagination offers visible controls, changes page size and validates jumps', async ({ page }) => {
  await table(page, 'paged'); const navigation = page.getByRole('navigation', { name: 'Pagination' }); await expect(navigation.getByText('Rows: 1–200')).toBeVisible();
  await navigation.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(navigation.getByText('Rows: 201–205')).toBeVisible(); await expect(navigation.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await navigation.getByRole('combobox', { name: 'Rows per page' }).selectOption('50'); await expect(navigation.getByText('Rows: 1–50')).toBeVisible();
  await navigation.getByRole('button', { name: 'Go to page…' }).click(); await page.getByRole('spinbutton', { name: 'Page number' }).fill('5'); await page.getByRole('button', { name: 'Go', exact: true }).click(); await expect(navigation.getByText('Rows: 201–205')).toBeVisible();
  await navigation.getByRole('button', { name: 'Go to page…' }).click(); await page.getByRole('spinbutton', { name: 'Page number' }).fill('6'); await page.getByRole('button', { name: 'Go', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('The last page is 5.'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 }); await expect(navigation.getByRole('button', { name: 'Previous page' })).toBeVisible(); await page.screenshot({ path: 'test-results/sqlite-pagination-narrow.png' });
});

test('find and replacement preview covers other pages and stages changes for Undo', async ({ page }) => {
  await table(page, 'search_pages'); await expect(page.getByRole('grid')).not.toContainText('Needle'); await menu(page, 'Edit', 'Replace…'); await page.getByRole('combobox', { name: 'Search column', exact: true }).selectOption('note'); await page.getByRole('searchbox', { name: 'Find text', exact: true }).fill('Needle'); await page.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Found'); await page.getByRole('button', { name: 'Preview replacement' }).click();
  await expect(page.locator('.search-status')).toHaveText('1 matching cell'); await page.getByRole('button', { name: 'Replace all matches' }).click(); await expect(page.locator('.search-status')).toContainText('Replaced 1 cells'); await page.getByRole('button', { name: 'Close search', exact: true }).click(); await page.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(page.getByRole('grid')).toContainText('Found'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('grid')).toContainText('Needle');
});

test('CSV import maps types and stages records rather than committing immediately', async ({ page }) => {
  await table(page, 'users'); await menu(page, 'File', 'Import CSV…'); const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Caroline'); await page.getByRole('combobox', { name: 'id Type', exact: true }).selectOption('integer'); await page.getByRole('combobox', { name: 'score Type', exact: true }).selectOption('real');
  await page.getByRole('button', { name: 'Stage import', exact: true }).click(); await expect(page.getByRole('grid')).toContainText('Caroline'); await expect(page.getByRole('grid')).toContainText('9007199254740993'); await expect(page.getByRole('grid')).toContainText('9.25'); await expect(page.locator('.pending-status')).toContainText('Unsaved changes: 1'); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('grid')).not.toContainText('Caroline');
});

test('fill down and duplicate retain staged editing semantics', async ({ page }) => {
  await table(page, 'users'); await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await page.getByRole('grid').getByText('Bob', { exact: true }).click({ modifiers: ['Shift'] }); await menu(page, 'Edit', 'Fill down'); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(2); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('grid')).toContainText('Bob');
  await page.getByRole('grid').getByText('Alice', { exact: true }).click(); await menu(page, 'Data', 'Duplicate selected records…'); await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(2); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.getByRole('grid').getByText('Alice', { exact: true })).toHaveCount(1);
});

test('foreign key navigation follows parent affinity and collation and returns to the original table', async ({ page }) => {
  await table(page, 'parent_number'); await page.getByRole('grid').getByText('Other parent', { exact: true }).dblclick(); await page.getByRole('textbox', { name: 'name Value' }).fill('Pending parent'); await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(page.locator('.pending-status')).toContainText('Unsaved changes: 1');
  await table(page, 'related'); await page.locator('td[data-row="0"][data-column="1"]').click(); await menu(page, 'Data', 'Open related record…'); await expect(page.getByRole('grid', { name: 'parent_number' })).toContainText('Number parent'); await page.getByRole('button', { name: 'Back', exact: true }).click(); await expect(page.getByRole('grid', { name: 'related' })).toBeVisible();
  await page.getByRole('grid').getByText('ABC', { exact: true }).click(); await menu(page, 'Data', 'Open related record…'); await expect(page.getByRole('grid', { name: 'parent_case' })).toContainText('Case parent');
});

test('composite foreign keys resolve implicit parent keys with pending parent edits', async ({ page }) => {
  await table(page, 'composite_parent'); await page.getByRole('grid').getByText('Original label', { exact: true }).dblclick(); await page.getByRole('textbox', { name: 'label Value' }).fill('Pending label'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.pending-status')).toContainText('Unsaved changes: 1'); await table(page, 'composite_child'); await page.getByRole('grid').getByText('7', { exact: true }).click(); await menu(page, 'Data', 'Open related record…'); await expect(page.getByRole('grid', { name: 'composite_parent' })).toContainText('key');
});

test('schema forms create tables with confirmation and maintenance reports integrity', async ({ page }) => {
  await menu(page, 'Data', 'Create table…'); const dialog = page.getByRole('dialog'); await page.getByRole('textbox', { name: 'Name', exact: true }).fill('from_form'); await page.getByRole('checkbox', { name: 'Apply immediately. This change cannot be undone here.' }).check(); await dialog.getByRole('button', { name: 'Apply structure change' }).click(); await expect(page.locator('.table-list')).toContainText('from_form');
  await menu(page, 'Data', 'Database maintenance…'); await page.getByRole('button', { name: 'Run integrity and foreign key checks' }).click(); await expect(page.locator('.maintenance-report')).toContainText('ok'); await expect(page.locator('.maintenance-report')).toContainText('Foreign key violations: 0');
});

test('record forms preserve JSON integer tokens and flush valid input when saving', async ({ page }) => {
  await table(page, 'json_values'); await page.locator('td[data-row="0"][data-column="1"]').click(); await menu(page, 'Edit', 'Edit record…'); await page.getByRole('button', { name: 'Format JSON' }).click(); const input = page.getByRole('textbox', { name: 'data Value', exact: true }); await expect(input).toHaveValue(/9223372036854775807/); await expect(input).toHaveValue(/\n/); await input.press('ControlOrMeta+s'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.pending-status')).toHaveText('No unsaved changes'); await expect(page.getByRole('grid')).toContainText('9223372036854775807');
  await page.locator('td[data-row="0"][data-column="0"]').click(); await menu(page, 'Edit', 'Edit record…'); await page.getByRole('textbox', { name: 'id Value', exact: true }).fill('not-integer'); await page.getByRole('textbox', { name: 'id Value', exact: true }).press('ControlOrMeta+s'); await expect(page.getByRole('dialog')).toContainText('Integer values must be whole numbers.'); await expect(page.getByRole('dialog')).toBeVisible();
});

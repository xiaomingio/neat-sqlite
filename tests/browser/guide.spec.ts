/*
Purpose: Verify tour navigation, visible anchors, and preservation of staged edits and SQL drafts.
*/
import { test, expect, type Page } from '@playwright/test';
import { EditorFixture } from './EditorFixture';
let fixture: EditorFixture;
test.beforeEach(async ({ page }) => { fixture = new EditorFixture(); await fixture.open(page); });
test.afterEach(async () => { await fixture.close(); });

async function visiblePanel(page: Page): Promise<void> {
  const panel = await page.locator('.guide-panel').boundingBox();
  const spotlight = await page.locator('.guide-spotlight').boundingBox();
  expect(panel).toBeTruthy(); expect(spotlight).toBeTruthy();
  const viewport = page.viewportSize()!;
  expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height);
  expect(spotlight!.width).toBeGreaterThan(0); expect(spotlight!.height).toBeGreaterThan(0);
  expect(panel!.x >= spotlight!.x + spotlight!.width || panel!.x + panel!.width <= spotlight!.x || panel!.y >= spotlight!.y + spotlight!.height || panel!.y + panel!.height <= spotlight!.y).toBe(true);
}

for (const width of [1200, 390]) {
  test(`tour points to real controls and restores SQL drafts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.getByRole('button', { name: 'SQL Query', exact: true }).click();
    const draft = 'SELECT 42 AS preserved_draft;';
    await page.locator('.cm-content').click(); await page.locator('.cm-content').press('ControlOrMeta+a'); await page.keyboard.type(draft);
    await expect(page.locator('.cm-content')).toHaveText(draft);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const guide = page.getByRole('dialog', { name: 'Choose a table', exact: true });
    await expect(guide).toBeVisible(); await visiblePanel(page);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(guide).toBeVisible();
    for (let step = 1; step <= 10; step++) {
      await expect(page.locator('.guide-progress')).toHaveText(`${step} / 10`);
      await visiblePanel(page);
      if (step === 4 || step === 6 || step === 7) await expect(page.locator('.command-menu')).toBeVisible();
      if (step === 8) await expect(page.locator('.structure-table')).toBeVisible();
      if (step === 9) await expect(page.locator('.cm-content')).toHaveText(draft);
      if ([3, 4, 9].includes(step)) await page.screenshot({ path: `test-results/guide-${width}-${step}.png` });
      await page.getByRole('button', { name: step === 10 ? 'Done' : 'Next', exact: true }).click();
    }
    await expect(page.locator('.quick-guide')).toHaveCount(0);
    await expect(page.locator('.command-menu')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toHaveText(draft);
    await expect(page.locator('.sidebar')).toBeVisible({ visible: width > 650 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('Skip and Escape preserve staged edits, selection, and the collapsed table list', async ({ page }) => {
  await page.locator('.table-list').getByRole('button', { name: '▦ users', exact: true }).click();
  await page.locator('tbody tr').first().locator('td').nth(1).dblclick();
  await page.getByRole('textbox', { name: 'name Value', exact: true }).fill('Preserved edit');
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.pending-status')).toContainText('1');
  await page.getByRole('button', { name: 'Hide table list', exact: true }).click();
  for (const exit of ['skip', 'escape']) {
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (exit === 'skip') {
      await page.getByRole('button', { name: 'Skip', exact: true }).click();
      const reminder = page.getByRole('dialog', { name: 'Quick guide', exact: true });
      await expect(reminder).toContainText('? button at the top right');
      await reminder.getByRole('button', { name: 'Got it', exact: true }).click();
    }
    else await page.keyboard.press('Escape');
    await expect(page.locator('.quick-guide')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('td.selected')).toContainText('Preserved edit');
    await expect(page.locator('.pending-status')).toContainText('1');
  }
});

test('Chinese dark tour keeps its controls and targets visible in a narrow editor', async ({ page }) => {
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Language', exact: true }).hover();
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole('button', { name: '帮助', exact: true }).click();
  for (let step = 1; step <= 10; step++) {
    await visiblePanel(page);
    if ([1, 4, 9].includes(step)) await page.screenshot({ path: `test-results/guide-chinese-dark-${step}.png` });
    await page.getByRole('button', { name: step === 10 ? '完成' : '下一步', exact: true }).click();
  }
  await expect(page.locator('.quick-guide')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '帮助', exact: true })).toBeVisible();
});

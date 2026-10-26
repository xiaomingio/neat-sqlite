/*
Purpose: Render every assets/icon*.svg to a 256 px PNG with headless Chromium. Only icon.png ships in the VSIX.
*/
import { chromium } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';

const assets = new URL('../assets/', import.meta.url);
const sources = (await readdir(assets)).filter(name => /^icon.*\.svg$/.test(name));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  for (const name of sources) {
    const svg = await readFile(new URL(name, assets), 'utf8');
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`);
    await page.screenshot({ path: new URL(name.replace(/\.svg$/, '.png'), assets).pathname, omitBackground: true });
  }
} finally { await browser.close(); }

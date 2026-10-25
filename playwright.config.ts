/*
Purpose: Run SQLite webview integration checks in Chromium Headless Shell only.
*/
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/browser', timeout: 30000, fullyParallel: false, workers: 1, use: { headless: true, viewport: { width: 1200, height: 800 } } });

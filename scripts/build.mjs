/*
Purpose: Build the VS Code host and browser resources while retaining the native SQLite dependency.
*/
import { build } from 'esbuild';
import { rm, mkdir, copyFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode', 'sqlite3'], outfile: 'dist/extension.js' }),
  build({ entryPoints: ['src/webview/grid.ts'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/grid.js' }),
  copyFile('src/webview/style.css', 'dist/style.css'),
]);

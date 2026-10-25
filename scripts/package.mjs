/*
Purpose: Package a platform-specific VSIX containing the installed native SQLite binary.
*/
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const targets = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'win32-x64': 'win32-x64', 'win32-arm64': 'win32-arm64' };
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('Packaging is unsupported on this platform.');
await mkdir('release', { recursive: true });
const result = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', '--target', target, '--allow-missing-repository', '--no-rewrite-relative-links', '--out', 'release/'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

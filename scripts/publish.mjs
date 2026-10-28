/*
Purpose: Publish the complete six-platform VSIX set using an environment-only Marketplace credential.
*/
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

assert(process.env.VSCE_PAT, 'VSCE_PAT must be supplied through the environment');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = process.argv[2] ?? 'release';
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const files = await readdir(directory);
const packages = targets.map((target) => {
  const name = `neat-sqlite-${target}-${version}.vsix`;
  assert(files.includes(name), `Missing package: ${name}`);
  return join(directory, name);
});
const result = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'publish', '--packagePath', ...packages, '--skip-duplicate'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

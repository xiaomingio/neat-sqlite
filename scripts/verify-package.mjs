/*
Purpose: Verify a VSIX target, native binary architecture, and its packaged SQLite runtime.
*/
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const [packagePath, target = `${process.platform}-${process.arch}`] = process.argv.slice(2);
assert(packagePath, 'Usage: node scripts/verify-package.mjs <vsix> [target]');
assert.equal(`${process.platform}-${process.arch}`, target, 'Runner must match the package target');
const directory = await mkdtemp(join(tmpdir(), 'neat-sqlite-vsix-'));
try {
  const zip = await new Promise((ok, fail) => yauzl.open(packagePath, { lazyEntries: true }, (error, file) => error ? fail(error) : ok(file)));
  const names = [];
  await new Promise((ok, fail) => {
    zip.on('error', fail).on('end', ok).on('entry', async (entry) => {
      try {
        names.push(entry.fileName);
        assert(!/(^|\/)(\.env[^/]*|\.github|AGENTS\.md)(\/|$)/.test(entry.fileName), 'Private/config files must not be packaged');
        if (!entry.fileName.endsWith('/')) {
          const destination = resolve(directory, entry.fileName);
          assert(destination.startsWith(directory + sep), 'Unsafe ZIP path');
          const { mkdir } = await import('node:fs/promises');
          await mkdir(dirname(destination), { recursive: true });
          const stream = await new Promise((done, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : done(value)));
          await pipeline(stream, createWriteStream(destination));
        }
        zip.readEntry();
      } catch (error) { zip.close(); fail(error); }
    });
    zip.readEntry();
  });
  const manifest = await readFile(join(directory, 'extension.vsixmanifest'), 'utf8');
  assert(manifest.includes(`TargetPlatform="${target}"`), 'VSIX target mismatch');
  const natives = names.filter((name) => name.endsWith('.node'));
  assert.deepEqual(natives, ['extension/node_modules/sqlite3/build/Release/node_sqlite3.node']);
  const binary = await readFile(join(directory, natives[0]));
  let architecture;
  if (process.platform === 'linux') {
    assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
    architecture = { 62: 'x64', 183: 'arm64' }[binary.readUInt16LE(18)];
  } else if (process.platform === 'darwin') {
    assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
    architecture = { 0x01000007: 'x64', 0x0100000c: 'arm64' }[binary.readUInt32LE(4)];
  } else {
    assert.equal(binary.subarray(0, 2).toString(), 'MZ');
    architecture = { 0x8664: 'x64', 0xaa64: 'arm64' }[binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4)];
  }
  assert.equal(architecture, process.arch, 'Native binary architecture mismatch');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(process.argv[1]);
    const sqlite3 = require('sqlite3');
    const database = await new Promise((ok, fail) => { const db = new sqlite3.Database(':memory:', (error) => error ? fail(error) : ok(db)); });
    try {
      await new Promise((ok, fail) => database.exec("CREATE TABLE smoke (value TEXT); BEGIN; INSERT INTO smoke VALUES ('packed runtime'); COMMIT;", (error) => error ? fail(error) : ok()));
      const row = await new Promise((ok, fail) => database.get('SELECT value, sqlite_version() AS version FROM smoke', (error, value) => error ? fail(error) : ok(value)));
      assert.equal(row.value, 'packed runtime');
      console.log('Packaged SQLite ' + row.version);
    } finally { await new Promise((ok, fail) => database.close((error) => error ? fail(error) : ok())); }
  `, join(directory, 'extension/package.json')], { stdio: 'inherit' });
  assert.equal(result.status, 0, 'Packaged SQLite runtime must execute SQL');
  console.log(`Verified ${target}: ${names.length} files`);
} finally { await rm(directory, { recursive: true, force: true }); }

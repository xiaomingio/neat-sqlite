/*
Purpose: Prevent CSV exports from overwriting database files through paths, symlinks, or hard links.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, link, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseDestination } from '../src/DatabaseDestination';
test('export destinations protect database and journal aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neat-destination-'));
  try {
    const source = join(directory, 'source.db'); await writeFile(source, 'database');
    await assert.rejects(DatabaseDestination.validate(source, source), /outside/);
    await assert.rejects(DatabaseDestination.validate(source, `${source}-wal`), /outside/);
    const alias = join(directory, 'alias.db'); await symlink(source, alias);
    await assert.rejects(DatabaseDestination.validate(source, alias), /outside/);
    const hard = join(directory, 'hard.csv'); await link(source, hard);
    await assert.rejects(DatabaseDestination.validate(source, hard), /refers/);
    const aliases = join(directory, 'aliases'); await mkdir(aliases);
    const parentAlias = join(aliases, 'parent'); await symlink(directory, parentAlias);
    await assert.rejects(DatabaseDestination.validate(source, join(parentAlias, 'source.db-wal')), /outside/);
    await DatabaseDestination.validate(source, join(directory, 'export.csv'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/*
Purpose: Exercise native-document save, recovery, and request serialization against real database files.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sqlite3 from 'sqlite3';
import type * as vscode from 'vscode';
import { SqliteDocument } from '../src/SqliteDocument';
import { SqliteDatabase } from '../src/SqliteDatabase';

const uri = (path: string) => ({ scheme: 'file', fsPath: path } as vscode.Uri);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neat-sqlite-document-'));
  const path = join(directory, 'source.db');
  const db = new sqlite3.Database(path);
  await new Promise<void>((resolve, reject) => db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1,'original')", error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  return { directory, path, document: await SqliteDocument.open(uri(path)) };
}
const query = { table: 'records', offset: 0, limit: 200 };

test('native save flushes active input before committing and advances history baseline', async () => {
  const { directory, path, document } = await fixture();
  try {
    const row = (await document.run(() => document.database.page(query))).rows[0];
    document.flushInput = async () => { await document.run(() => document.database.edit([{ kind: 'update', table: 'records', key: row.key, column: 'value', value: { type: 'text', value: 'flushed' } }])); };
    await document.save();
    assert.equal(document.epoch, 1);
    const reader = await SqliteDatabase.open(path);
    try { assert.equal((await reader.page(query)).rows[0].values[1].value, 'flushed'); }
    finally { await reader.close(); }
    assert.equal(document.database.status().pending, 0);
  } finally { document.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid active input aborts native save without touching disk', async () => {
  const { directory, path, document } = await fixture();
  try {
    document.flushInput = async () => { throw new Error('Invalid integer'); };
    await assert.rejects(document.save(), /Invalid integer/);
    assert.equal(document.epoch, 0);
    const reader = await SqliteDatabase.open(path);
    try { assert.equal((await reader.page(query)).rows[0].values[1].value, 'original'); }
    finally { await reader.close(); }
  } finally { document.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('save as commits only the copy and recovery backup restores pending edits', async () => {
  const { directory, path, document } = await fixture();
  let restored: SqliteDocument | undefined;
  try {
    const row = (await document.run(() => document.database.page(query))).rows[0];
    await document.run(() => document.database.edit([{ kind: 'update', table: 'records', key: row.key, column: 'value', value: { type: 'text', value: 'pending' } }]));
    const destination = join(directory, 'copy.db');
    await document.saveAs(uri(destination));
    const copy = await SqliteDatabase.open(destination);
    try { assert.equal((await copy.page(query)).rows[0].values[1].value, 'pending'); } finally { await copy.close(); }
    const original = await SqliteDatabase.open(path);
    try { assert.equal((await original.page(query)).rows[0].values[1].value, 'original'); } finally { await original.close(); }
    const backup = await document.backup(uri(join(directory, 'recovery', 'pending.json')));
    assert.ok(await readFile(backup.id, 'utf8'));
    restored = await SqliteDocument.open(uri(path), backup.id);
    assert.equal(restored.database.status().pending, 1);
    assert.equal((await restored.database.page(query)).rows[0].values[1].value, 'pending');
    await backup.delete();
  } finally { restored?.dispose(); document.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('failed queued operations do not block later requests and requests remain ordered', async () => {
  const { directory, document } = await fixture();
  try {
    const order: string[] = [];
    const first = document.run(async () => { order.push('first'); throw new Error('expected'); });
    const second = document.run(async () => { order.push('second'); return document.database.page(query); });
    await assert.rejects(first, /expected/);
    assert.equal((await second).rows.length, 1);
    assert.deepEqual(order, ['first', 'second']);
  } finally { document.dispose(); await rm(directory, { recursive: true, force: true }); }
});


test('failed save as removes its incomplete copy and preserves source edits', async () => {
  const { directory, document } = await fixture();
  try {
    await document.run(() => document.database.edit([{ kind: 'insert', table: 'records', values: { id: { type: 'integer', value: '1' }, value: { type: 'text', value: 'duplicate' } } }]));
    const target = join(directory, 'failed.db');
    await assert.rejects(document.saveAs(uri(target)), /UNIQUE/);
    await assert.rejects(access(target), { code: 'ENOENT' });
    assert.equal(document.database.status().pending, 1);
  } finally { document.dispose(); await rm(directory, { recursive: true, force: true }); }
});

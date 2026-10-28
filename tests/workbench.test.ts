/*
Purpose: Verify SQL precision/read-only boundaries, atomic writes, mapped CSV imports and whole-query replace against real files.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sqlite3 from 'sqlite3';
import { SqliteDatabase } from '../src/SqliteDatabase';
import { CsvImport } from '../src/CsvImport';
import { searchSnippet } from '../src/SearchSnippet';
import { RE2JS } from 're2js';
import { RegexReplacement } from '../src/RegexReplacement';
import { SqlQuery } from '../src/SqlQuery';
import type { CsvMapping, Query } from '../src/protocol';
const query: Query = { table: 'items', offset: 0, limit: 200 };
async function fixture(run: (engine: SqliteDatabase) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-workbench-')); const path = join(directory, 'test.sqlite');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => { const connection = new sqlite3.Database(path, error => error ? reject(error) : resolve(connection)); });
  await new Promise<void>((resolve, reject) => db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, n INTEGER DEFAULT 42, ref INTEGER REFERENCES items(id)); INSERT INTO items VALUES(1,'Alice',9223372036854775807,NULL),(2,'alice',-9223372036854775808,NULL);", error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  const engine = await SqliteDatabase.open(path);
  try { await run(engine); } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
}

test('custom SELECT, CTE and duplicate aliases retain ordinal values, empty columns and 64-bit integers', async () => {
  await fixture(async engine => {
    const result = await engine.sqlQuery("WITH x AS (SELECT n FROM items ORDER BY id) SELECT n AS duplicate, n+0 AS duplicate, NULL AS missing, '' AS empty, x'00ff' AS binary FROM x", 1);
    assert.deepEqual(result.columns, ['duplicate', 'duplicate:1', 'missing', 'empty', 'binary']);
    assert.deepEqual(result.rows[0], [{ type: 'integer', value: '9223372036854775807' }, { type: 'integer', value: '9223372036854775807' }, { type: 'null', value: '' }, { type: 'text', value: '' }, { type: 'blob', value: '00FF' }]);
    assert.equal(result.truncated, true);
    assert.deepEqual((await engine.sqlQuery('SELECT id,name FROM items WHERE 0')).columns, ['id', 'name']);
    assert.equal((await engine.sqlQuery('SELECT n FROM items WHERE id=2')).rows[0]?.[0]?.value, '-9223372036854775808');
    assert.match(SqlQuery.csv(result), /9223372036854775807/);
    await engine.sqlQuery('SELECT random() AS token'); const exported = engine.sqlExport('SELECT random() AS token');
    assert.equal(exported, engine.sqlExport('SELECT random() AS token'));
    assert.throws(() => engine.sqlExport('SELECT 2'), /Run the current SQL/);
  });
});

test('query connection rejects write statements, stacked statements and survives cancellation', async () => {
  await fixture(async engine => {
    for (const sql of ['DELETE FROM items', 'PRAGMA query_only=OFF', 'SELECT 1; DELETE FROM items', 'WITH x AS (SELECT 1) DELETE FROM items']) await assert.rejects(engine.sqlQuery(sql));
    assert.equal(await engine.count(query), 2);
    assert.equal((await engine.sqlQuery("SELECT 'a;b' AS value; -- trailing comment")).rows[0]?.[0]?.value, 'a;b');
    const running = engine.sqlQuery('WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x');
    setTimeout(() => engine.sqlCancel(), 30);
    await assert.rejects(running, /cancelled/i);
    assert.equal((await engine.sqlQuery('SELECT 1')).rows[0]?.[0]?.value, '1');
  });
});

test('explicit SQL writes are transactional, enforce foreign keys and block unresolved staged edits', async () => {
  await fixture(async engine => {
    await assert.rejects(engine.sqlWrite("INSERT INTO items VALUES(3,'bad',1,999)"), /FOREIGN KEY/);
    assert.equal(await engine.count(query), 2);
    assert.equal(await engine.sqlWrite("INSERT INTO items(name) VALUES ('three'),('four') RETURNING id"), 2);
    await assert.rejects(engine.sqlWrite("INSERT INTO items(id,name) VALUES (10,'good'),(1,'duplicate')"), /UNIQUE/);
    assert.equal(await engine.count(query), 4);
    await assert.rejects(engine.sqlWrite("INSERT OR ROLLBACK INTO items(id,name) VALUES(11,'good'),(1,'duplicate')"), /UNIQUE/);
    assert.equal(await engine.count(query), 4);
    await assert.rejects(engine.sqlWrite('CREATE VIEW broken AS SELECT * FROM does_not_exist'));
    assert.equal((await engine.sqlQuery("SELECT count(*) FROM sqlite_schema WHERE name='broken'")).rows[0]?.[0]?.value, '0');
    await engine.sqlWrite('CREATE TABLE extra(id INTEGER PRIMARY KEY)');
    await engine.sqlWrite('ALTER TABLE extra ADD COLUMN label TEXT');
    await engine.sqlWrite('ALTER TABLE extra RENAME COLUMN label TO name');
    await engine.sqlWrite('CREATE INDEX extra_name ON extra(name)');
    await engine.sqlWrite('CREATE VIEW names AS SELECT name FROM extra');
    assert.ok((await engine.metadata()).some(table => table.name === 'names'));
    await engine.sqlWrite('DROP VIEW names'); await engine.sqlWrite('DROP INDEX extra_name');
    await engine.edit([{ kind: 'insert', table: 'items', values: { name: { type: 'text', value: 'pending' } } }]);
    await assert.rejects(engine.sqlWrite('UPDATE items SET name=\'changed\''), /pending/);
    await assert.rejects(engine.sqlWrite('PRAGMA foreign_keys=OFF'));
  });
});

test('CSV parser handles BOM, quoted multiline records, NULL tokens, exact integers and omitted defaults', async () => {
  await fixture(async engine => {
    const csv = '\ufeffname,n,ref\r\n"line\nwith ""quotes""",9223372036854775806,\\N\r\nUnicode 中文,,\\N\r\n';
    const imported = new CsvImport(csv); assert.equal(imported.preview().total, 2); assert.match(imported.preview().rows[0]![0]!, /\n/);
    const mapping: CsvMapping[] = [{ source: 0, column: 'name', type: 'text', empty: 'text' }, { source: 1, column: 'n', type: 'integer', empty: 'default' }, { source: 2, column: 'ref', type: 'integer', empty: 'null' }];
    assert.equal(await engine.csvImport('items', csv, mapping, '\\N'), 2);
    assert.equal((await engine.sqlQuery('SELECT count(*) FROM items')).rows[0]?.[0]?.value, '2');
    assert.equal((await engine.page(query)).rows.length, 4);
    await engine.undo(); assert.equal((await engine.page(query)).rows.length, 2); await engine.redo();
    await engine.save();
    const result = await engine.sqlQuery('SELECT n,ref FROM items ORDER BY id DESC LIMIT 2');
    assert.equal(result.rows[0]?.[0]?.value, '42'); assert.equal(result.rows[1]?.[0]?.value, '9223372036854775806'); assert.equal(result.rows[1]?.[1]?.type, 'null');
  });
});

test('CSV import failure leaves the entire pending edit session unchanged', async () => {
  await fixture(async engine => {
    await engine.edit([{ kind: 'insert', table: 'items', values: { name: { type: 'text', value: 'retained' } } }]);
    const before = engine.recovery(); const status = engine.status();
    await assert.rejects(engine.csvImport('items', 'name,n\ngood,3\nbad,not-a-number', [{ source: 0, column: 'name', type: 'text', empty: 'text' }, { source: 1, column: 'n', type: 'integer', empty: 'null' }]));
    assert.equal(engine.recovery(), before); assert.deepEqual(engine.status(), status);
    assert.throws(() => new CsvImport('name,n\n"unterminated,3'));
    assert.equal(new CsvImport('n\n9223372036854775808').values([{ source: 0, column: 'n', type: 'auto', empty: 'text' }])[0]?.n?.type, 'text');
  });
});

test('Find searches all scalar cells across pages and ignores the visible filtered page', async () => {
  await fixture(async engine => {
    await engine.sqlWrite("INSERT INTO items(name) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<205) SELECT 'needle_'||i FROM n");
    await engine.page({ ...query, filters: [{ column: 'name', mode: 'text', text: 'Alice' }] });
    const found = await engine.search({ table: 'items', scope: { type: 'table' }, search: 'needle_', matchCase: true }, 'find');
    assert.equal(found.count, 205); assert.equal(found.changes, 0); assert.equal(engine.status().pending, 0);
    const last = found.samples.at(-1)!; const located = await engine.searchLocate(found.token, last.key, last.column, 50);
    assert.equal(located.query.offset, 200); assert.equal(located.row, 6); assert.equal(located.page.rows[located.row]?.values[1]?.value, 'needle_205'); assert.equal(located.query.filters, undefined);
    assert.equal((await engine.search({ table: 'items', scope: { type: 'table' }, search: '9223372036854775807', matchCase: true }, 'find')).samples[0]?.before, '9223372036854775807');
  });
});

test('Selection searches exact sparse cells and Replace stages one atomic undo operation', async () => {
  await fixture(async engine => {
    await engine.sqlWrite("CREATE TABLE notes(id INTEGER PRIMARY KEY,a TEXT,b TEXT,c TEXT GENERATED ALWAYS AS (a||'!'))");
    await engine.sqlWrite("INSERT INTO notes(a,b) VALUES ('needle','needle'),('needle','needle'),('needle','needle')");
    const page = await engine.page({ table: 'notes', offset: 0, limit: 200 });
    const scope = { type: 'selection' as const, snapshot: page.snapshot!, cells: [{ key: page.rows[0]!.key, column: 'a' }, { key: page.rows[1]!.key, column: 'b' }, { key: page.rows[1]!.key, column: 'b' }] };
    const request = { table: 'notes', scope, search: 'needle', replacement: '$&new', matchCase: true };
    const found = await engine.search(request, 'find'); assert.equal(found.count, 2); assert.equal(found.changes, 0); assert.equal(engine.status().pending, 0);
    const preview = await engine.search(request, 'replacePreview'); assert.equal(preview.count, 2);
    const applied = await engine.search({ ...request, preview: preview.token }, 'replaceApply'); assert.equal(applied.changes, 2); assert.equal(applied.count, 2);
    const result = await engine.page({ table: 'notes', offset: 0, limit: 200 });
    assert.equal(result.rows[0]?.values[1]?.value, '$&new'); assert.equal(result.rows[0]?.values[2]?.value, 'needle'); assert.equal(result.rows[1]?.values[1]?.value, 'needle'); assert.equal(result.rows[1]?.values[2]?.value, '$&new'); assert.equal(result.rows[2]?.values[1]?.value, 'needle');
    await engine.undo(); assert.equal(engine.status().pending, 0); await engine.redo(); assert.equal(engine.status().pending, 2); await engine.save();
  });
});

test('Find supports generated values and filtered view selections without mistaking view ordinal identities', async () => {
  await fixture(async engine => {
    await engine.sqlWrite("CREATE TABLE notes(id INTEGER PRIMARY KEY,a TEXT,c TEXT GENERATED ALWAYS AS (a||'!'))");
    await engine.sqlWrite("INSERT INTO notes VALUES(1,'first'),(2,'needle'),(3,'needle')");
    await engine.sqlWrite('CREATE VIEW named AS SELECT id,a,c FROM notes');
    const scope = { type: 'table' as const };
    assert.equal((await engine.search({ table: 'notes', scope, search: 'needle!', matchCase: true }, 'find')).count, 2);
    const filtered = { table: 'named', offset: 0, limit: 200, sort: [{ column: 'id', direction: 'DESC' as const }], filters: [{ column: 'id', mode: 'number' as const, operator: 'gt' as const, value: '1' }] };
    const page = await engine.page(filtered); const selection = { type: 'selection' as const, snapshot: page.snapshot!, cells: [{ key: page.rows[0]!.key, column: 'a' }] };
    const found = await engine.search({ table: 'named', scope: selection, search: 'needle', matchCase: true }, 'find'); assert.equal(found.count, 1);
    const hit = found.samples[0]!; const located = await engine.searchLocate(found.token, hit.key, hit.column, 50); assert.equal(located.page.rows[located.row]?.values[0]?.value, '3'); assert.deepEqual(located.query.filters, filtered.filters);
    await assert.rejects(engine.search({ table: 'named', scope, search: 'needle', replacement: 'changed', matchCase: true }, 'replacePreview'), /read-only/);
    await assert.rejects(engine.search({ table: 'notes', scope, column: 'c', search: 'needle', replacement: 'changed', matchCase: true }, 'replacePreview'), /generated/i);
    assert.equal(engine.status().pending, 0);
  });
});

test('Replace requires an unchanged preview and never dirties no-op replacements', async () => {
  await fixture(async engine => {
    const request = { table: 'items', scope: { type: 'table' as const }, search: 'alice', replacement: 'Bob', matchCase: false };
    await assert.rejects(engine.search(request, 'replaceApply'), /Preview/);
    const preview = await engine.search(request, 'replacePreview');
    await engine.sqlWrite("INSERT INTO items(name) VALUES ('ALICE')");
    await assert.rejects(engine.search({ ...request, preview: preview.token }, 'replaceApply'), /changed/); assert.equal(engine.status().pending, 0);
    const latest = await engine.search(request, 'replacePreview'); const applied = await engine.search({ ...request, preview: latest.token }, 'replaceApply'); assert.equal(applied.changes, 3); await engine.undo();
    const noop = { ...request, search: 'Alice', replacement: 'Alice', matchCase: true }; const noChange = await engine.search(noop, 'replacePreview');
    const status = engine.status(); assert.equal((await engine.search({ ...noop, preview: noChange.token }, 'replaceApply')).changes, 0); assert.deepEqual(engine.status(), status);
    const literal = await engine.search({ ...request, search: '.', replacement: 'x' }, 'replacePreview'); assert.equal(literal.count, 0);
  });
});

test('expired, invalid and changed selections fail instead of broadening their scope or mislocating results', async () => {
  await fixture(async engine => {
    const page = await engine.page(query); const request = { table: 'items', scope: { type: 'selection' as const, snapshot: page.snapshot!, cells: [{ key: page.rows[0]!.key, column: 'name' }] }, search: 'Alice', matchCase: true };
    await assert.rejects(engine.search({ ...request, scope: { ...request.scope, snapshot: 'unknown' } }, 'find'), /expired/);
    await assert.rejects(engine.search({ ...request, scope: { ...request.scope, cells: [{ key: 'unknown', column: 'name' }] } }, 'find'), /unavailable/);
    const found = await engine.search(request, 'find');
    await engine.sqlWrite("UPDATE items SET name='external change' WHERE id=1");
    await assert.rejects(engine.search(request, 'find'), /changed/);
    await assert.rejects(engine.searchLocate(found.token, found.samples[0]!.key, 'name', 200), /changed/);
    const fresh = await engine.search({ table: 'items', scope: { type: 'table' }, search: 'external change', matchCase: true }, 'find');
    await engine.sqlWrite('ALTER TABLE items RENAME COLUMN name TO renamed');
    await assert.rejects(engine.searchLocate(fresh.token, fresh.samples[0]!.key, 'name', 200), /structure changed/);
  });
});

test('maintenance reports real integrity and resets obsolete redo after VACUUM', async () => {
  await fixture(async engine => {
    const filtered: Query = { ...query, filters: [{ column: 'id', mode: 'number', operator: 'eq', value: '2' }] }; assert.equal(await engine.count(filtered), 1);
    const report = await engine.maintenance('check'); assert.deepEqual(report.integrity, ['ok']); assert.equal(report.foreignKeys.length, 0); assert.ok(report.bytes > 0);
    await engine.edit([{ kind: 'insert', table: 'items', values: { name: { type: 'text', value: 'undo-before-vacuum' } } }]);
    await engine.undo(); assert.equal(engine.status().canRedo, true);
    await engine.maintenance('vacuum'); assert.equal(engine.status().canRedo, false); await engine.redo(); assert.equal(engine.status().pending, 0);
  });
});

test('foreign key navigation uses parent affinity/collation and overlays pending parent edits', async () => {
  await fixture(async engine => {
    await engine.sqlWrite('CREATE TABLE parent(a INTEGER,b TEXT COLLATE NOCASE,note TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID');
    await engine.sqlWrite("INSERT INTO parent VALUES(1,'key','original')");
    await engine.sqlWrite('CREATE TABLE child(id INTEGER PRIMARY KEY,a TEXT,b TEXT,FOREIGN KEY(a,b) REFERENCES parent(a,b))');
    await engine.sqlWrite("INSERT INTO child VALUES(1,'1','KEY')");
    const child = (await engine.page({ table: 'child', offset: 0, limit: 200 })).rows[0]!;
    const parent = (await engine.page({ table: 'parent', offset: 0, limit: 200 })).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'parent', key: parent.key, column: 'note', value: { type: 'text', value: 'pending parent edit' } }]);
    const related = await engine.foreignRecord('child', child.key, 0);
    assert.equal(related.table, 'parent');
    const found = await engine.page({ table: related.table, offset: 0, limit: 200, filters: related.filters });
    assert.equal(found.rows.length, 1); assert.equal(found.rows[0]?.values[2]?.value, 'pending parent edit');
    assert.deepEqual(related.filters, [{ column: 'a', mode: 'values', values: [{ type: 'integer', value: '1' }] }, { column: 'b', mode: 'values', values: [{ type: 'text', value: 'key' }] }]);
    await engine.edit([{ kind: 'update', table: 'parent', key: parent.key, column: 'a', value: { type: 'integer', value: '2' } }]);
    const moved = await engine.foreignRecord('child', child.key, 0); assert.equal((await engine.page({ table: moved.table, offset: 0, limit: 200, filters: moved.filters })).rows[0]?.values[0]?.value, '2');
    await engine.edit([{ kind: 'update', table: 'child', key: child.key, column: 'a', value: { type: 'text', value: '2' } }]);
    await assert.rejects(engine.foreignRecord('child', child.key, 0), /No committed related record/);
  });
});

test('RE2 Find/Replace supports captures, case folding, raw newlines and zero-length progress', async () => {
  await fixture(async engine => {
    await engine.sqlWrite("UPDATE items SET name=CASE id WHEN 1 THEN 'Hello World' ELSE 'line'||char(10)||'two' END");
    const request = { table: 'items', scope: { type: 'table' as const }, column: 'name', search: '(hello) (world)', replacement: '$2, $1 | $& | $$', matchCase: false, regex: true };
    const preview = await engine.search(request, 'replacePreview'); assert.equal(preview.count, 1); assert.equal(preview.samples[0]?.after, 'World, Hello | Hello World | $');
    await engine.search({ ...request, preview: preview.token }, 'replaceApply'); await engine.undo();
    assert.equal((await engine.search({ ...request, search: '^line\\ntwo$', replacement: undefined }, 'find')).count, 1);
    const zero = { ...request, search: '^|$', replacement: 'x', matchCase: true }; const ends = await engine.search(zero, 'replacePreview'); assert.equal(ends.count, 2); assert.equal(ends.samples[0]?.after, 'xHello Worldx');
    await engine.search({ ...zero, preview: ends.token }, 'replaceApply'); await engine.undo();
    const literal = await engine.search({ ...request, search: 'Hello', replacement: '$1 $& $$', regex: false }, 'replacePreview'); assert.equal(literal.samples[0]?.after, '$1 $& $$ World');
  });
});

test('invalid or unsupported regex and expansion overflow fail atomically without changing previews or edits', async () => {
  await fixture(async engine => {
    const request = { table: 'items', scope: { type: 'table' as const }, column: 'name', search: '(Alice)', replacement: '$1!', matchCase: true, regex: true };
    const preview = await engine.search(request, 'replacePreview'); const before = engine.recovery();
    for (const search of ['[', '(?=Alice)', '(Alice)\\1']) await assert.rejects(engine.search({ ...request, search }, 'replacePreview'));
    assert.equal(engine.recovery(), before); assert.equal(engine.status().pending, 0);
    await engine.search({ ...request, preview: preview.token }, 'replaceApply'); await engine.undo();
    await engine.sqlWrite("UPDATE items SET name=replace(hex(zeroblob(150)),'0','a') WHERE id=1");
    await assert.rejects(engine.search({ ...request, search: 'a', replacement: 'b'.repeat(65536) }, 'replacePreview'), /8 MiB/); assert.equal(engine.status().pending, 0);
    const changedFlag = await engine.search({ ...request, search: 'a', replacement: 'b', regex: false }, 'replacePreview');
    await assert.rejects(engine.search({ ...request, search: 'a', replacement: 'b', preview: changedFlag.token }, 'replaceApply'), /changed/);
  });
});

test('native ALTER DROP COLUMN preserves remaining data and rejects dependent indexes and primary keys atomically', async () => {
  await fixture(async engine => {
    await engine.sqlWrite('CREATE TABLE structure_demo(id INTEGER PRIMARY KEY,a TEXT,b INTEGER,note TEXT)');
    await engine.sqlWrite("INSERT INTO structure_demo VALUES(7,'retained',42,'indexed')");
    await engine.sqlWrite('CREATE INDEX structure_note ON structure_demo(note)');
    await engine.sqlWrite('ALTER TABLE structure_demo DROP COLUMN b');
    const result = await engine.sqlQuery('SELECT * FROM structure_demo'); assert.deepEqual(result.columns, ['id', 'a', 'note']); assert.deepEqual(result.rows[0]?.map(value => value.value), ['7', 'retained', 'indexed']);
    const schema = (await engine.metadata()).find(table => table.name === 'structure_demo')!;
    await assert.rejects(engine.sqlWrite('ALTER TABLE structure_demo DROP COLUMN note'), /index|column/i);
    await assert.rejects(engine.sqlWrite('ALTER TABLE structure_demo DROP COLUMN id'), /PRIMARY KEY/i);
    assert.deepEqual((await engine.metadata()).find(table => table.name === 'structure_demo'), schema);
    assert.deepEqual((await engine.sqlQuery('SELECT * FROM structure_demo')).rows, result.rows);
  });
});


test('shared browser-safe replacement expansion agrees with RE2 substitutions and preflights amplification', () => {
  for (const expression of ['(a)(b)?', '(?P<name>a)(b)?']) {
    const pattern = RE2JS.compile(expression); const input = '😀 a ab';
    for (const template of ['$2/$1/$&/$$', '$10|$01|$00', "$`|$'|$<name>|$<missing>"]) {
      const matcher = pattern.matcher(input); assert.equal(matcher.find(), true); const from = matcher.start(); const to = matcher.end();
      const expanded = RegexReplacement.expand(matcher, input, template, 1024);
      const native = pattern.matcher(input).replaceFirst(template); assert.equal(expanded, native.slice(from, native.length - (input.length - to)));
      assert.equal(RegexReplacement.measure(matcher, input, template, 1024), Buffer.byteLength(expanded));
    }
  }
  const input = 'x'.repeat(1000) + 'a'; const matcher = RE2JS.compile('a').matcher(input); matcher.find();
  assert.throws(() => RegexReplacement.expand(matcher, input, '$`'.repeat(1000), 2000), /size limit/);
});

test('search previews keep a late first match visible and report its highlight range', () => {
  const text = `${'x'.repeat(5000)}Needle tail`; const snippet = searchSnippet(text, text.replace('Needle', 'Pin'), 5000, 5006);
  assert.equal(snippet.before.slice(...snippet.match!), 'Needle'); assert.ok(snippet.before.startsWith('…')); assert.ok(snippet.before.length <= 4096); assert.ok(snippet.after.includes('Pin tail'));
  const short = searchSnippet('a Needle', 'a Needle', 2, 8); assert.deepEqual(short, { before: 'a Needle', after: 'a Needle', match: [2, 8] });
});

test('Replace one stages a single previewed cell and rejects stale previews or changed records', async () => {
  await fixture(async engine => {
    const request = { table: 'items', scope: { type: 'table' as const }, search: 'lice', replacement: 'X', matchCase: true };
    const preview = await engine.search(request, 'replacePreview'); const [first, second] = preview.samples; assert.equal(preview.count, 2);
    assert.equal((await engine.replaceOne({ ...request, preview: preview.token, target: { key: first!.key, column: 'name' } })).changes, 1); assert.equal(engine.status().pending, 1);
    const rows = (await engine.page({ table: 'items', offset: 0, limit: 10 })).rows; assert.equal(rows[0]!.values[1]!.value, 'AX'); assert.equal(rows[1]!.values[1]!.value, 'alice');
    await assert.rejects(engine.replaceOne({ ...request, preview: preview.token, target: { key: first!.key, column: 'name' } }), /changed/);
    await assert.rejects(engine.replaceOne({ ...request, replacement: 'Y', preview: preview.token, target: { key: second!.key, column: 'name' } }), /Preview/);
    await engine.save(); const fresh = await engine.search(request, 'replacePreview'); assert.equal(fresh.count, 1);
    await engine.sqlWrite("UPDATE items SET name = 'alice!' WHERE id = 2"); await assert.rejects(engine.replaceOne({ ...request, preview: fresh.token, target: { key: fresh.samples[0]!.key, column: 'name' } }), /changed/); assert.equal(engine.status().pending, 0);
  });
});

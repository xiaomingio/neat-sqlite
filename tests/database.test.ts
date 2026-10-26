/*
Purpose: Verify real SQLite edits, constraints, concurrency, recovery and backup boundaries.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sqlite3 from 'sqlite3';
import { SqliteDatabase } from '../src/SqliteDatabase';
import { compileFilters, compactSqlExpression } from '../src/ColumnFilter';
import type { ColumnFilter, Query, Value } from '../src/protocol';
const text = (value: string): Value => ({ type: 'text', value });
const integer = (value: string): Value => ({ type: 'integer', value });
const query = (table = 'items'): Query => ({ table, offset: 0, limit: 200 });
async function fixture(sql: string, run: (engine: SqliteDatabase, external: sqlite3.Database, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'neat-sqlite-'));
  const external = await new Promise<sqlite3.Database>((done, fail) => { const db = new sqlite3.Database(join(directory, 'sample.db'), error => error ? fail(error) : done(db)); });
  let engine: SqliteDatabase | undefined;
  try {
    await execute(external, sql);
    engine = await SqliteDatabase.open(join(directory, 'sample.db'));
    await run(engine, external, directory);
  } finally {
    if (engine) await engine.close();
    await new Promise<void>((done, fail) => external.close(error => error ? fail(error) : done()));
    await rm(directory, { recursive: true, force: true });
  }
}
const execute = (db: sqlite3.Database, sql: string): Promise<void> => new Promise((done, fail) => db.exec(sql, error => error ? fail(error) : done()));

test('Custom fragments compact formatting while preserving literals and AND grouping', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, category TEXT); INSERT INTO items VALUES(1,'two  spaces','yes'),(2,'single','yes'),(3,'two  spaces','no');", async engine => {
    const filters: ColumnFilter[] = [
      { column: 'name', mode: 'custom', sql: "  name  = 'two  spaces'\n OR\t id = 2  " },
      { column: 'category', mode: 'custom', sql: "category = 'yes'" }
    ];
    const compiled = compileFilters(filters, ['id', 'name', 'category']);
    assert.equal(compiled.preview, "(name = 'two  spaces' OR id = 2) AND (category = 'yes')");
    assert.deepEqual((await engine.page({ ...query(), filters })).rows.map(row => row.values[0]!.value), ['1', '2']);
    const quoted = "  \"a  \nb\"  =  'line\n  it''s here'  AND `two  names` = [two  names]  ";
    assert.equal(compactSqlExpression(quoted), "\"a  \nb\" = 'line\n  it''s here' AND `two  names` = [two  names]");
  });
});

test('whitespace filters and SQL previews avoid hidden formatting without changing values', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,char(9,10,160)),(2,''),(3,'line'||char(10)||'  end');", async (engine, external) => {
    for (const filter of [{ column: 'name', mode: 'empty' }, { column: 'name', mode: 'text', text: 'line\n  end' }] satisfies ColumnFilter[]) {
      const compiled = compileFilters([filter], ['id', 'name']);
      assert.doesNotMatch(compiled.preview, /[\t\r\n]/);
      const previewRows = await new Promise<{ id: number }[]>((done, fail) => external.all(`SELECT id FROM items WHERE ${compiled.preview} ORDER BY id`, (error, rows: { id: number }[]) => error ? fail(error) : done(rows)));
      assert.deepEqual((await engine.page({ ...query(), filters: [filter] })).rows.map(row => row.values[0]!.value), previewRows.map(row => String(row.id)));
      assert.deepEqual(previewRows.map(row => row.id), filter.mode === 'empty' ? [1, 2] : [3]);
    }
  });
});

test('typed values retain 64-bit integers, NULL, empty strings and blobs', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, txt TEXT, n INTEGER, nullable TEXT, binary BLOB); INSERT INTO items VALUES(9223372036854775807,'',9223372036854775806,NULL,x'00ff');", async engine => {
    const row = (await engine.page(query())).rows[0]!;
    assert.deepEqual(row.values, [integer('9223372036854775807'), text(''), integer('9223372036854775806'), { type: 'null', value: '' }, { type: 'blob', value: '00FF' }]);
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'n', value: integer('-9223372036854775808') }]);
    await engine.save();
    assert.deepEqual((await engine.page(query())).rows[0]!.values[2], integer('-9223372036854775808'));
  });
});

test('staged changes participate in SQL filters, sorting, undo and redo', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1,'alpha'),(2,'beta');", async engine => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('zeta') }]);
    const filtered = await engine.page({ ...query(), filters: [{ column: 'name', mode: 'text', text: 'zet' }] });
    assert.equal(filtered.rows[0]!.values[1]!.value, 'zeta');
    await engine.undo(); assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'alpha');
    await engine.redo(); assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'zeta');
    await engine.edit([{ kind: 'insert', table: 'items', values: { name: text('aardvark') } }]);
    assert.equal((await engine.page({ ...query(), sort: [{ column: 'name', direction: 'ASC' }] })).rows[0]!.values[1]!.value, 'aardvark');
    await engine.save(); assert.equal(engine.status().pending, 0);
    assert.equal((await engine.page(query())).rows.length, 3);
  });
});

test('constraint failures roll back the whole transaction and retain pending edits', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL); INSERT INTO items VALUES(1,'alpha'),(2,'beta');", async (engine, external) => {
    const rows = (await engine.page(query())).rows;
    await engine.edit([{ kind: 'update', table: 'items', key: rows[0]!.key, column: 'name', value: text('gamma') }, { kind: 'update', table: 'items', key: rows[1]!.key, column: 'name', value: text('gamma') }]);
    await assert.rejects(engine.save(), /UNIQUE/);
    assert.equal(engine.status().pending, 2);
    await engine.discard();
    assert.deepEqual((await engine.page(query())).rows.map(row => row.values[1]!.value), ['alpha', 'beta']);
    await execute(external, "INSERT INTO items VALUES(3,'delta')");
  });
});

test('external edits conflict even after pending changes are recovered', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES(1,'alpha');", async (engine, external) => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('local') }]);
    const recovery = engine.recovery(); await engine.discard(); await engine.restore(recovery);
    await execute(external, "UPDATE items SET name='external' WHERE id=1");
    await assert.rejects(engine.save(), /another program/);
    assert.equal(engine.status().pending, 1);
    await engine.discard(); assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'external');
  });
});

test('compound keys, quoted names, defaults, generated values and views behave safely', async () => {
  await fixture(`CREATE TABLE "odd""table"(a TEXT,b TEXT,value TEXT DEFAULT 'fresh',generated TEXT GENERATED ALWAYS AS (a||b) STORED,PRIMARY KEY(a,b)) WITHOUT ROWID;
    INSERT INTO "odd""table"(a,b) VALUES('one','two'); CREATE VIEW summary AS SELECT a FROM "odd""table";`, async engine => {
    const name = 'odd"table';
    const tables = await engine.metadata(); assert.equal(tables.find(table => table.name === 'summary')!.editable, false);
    const row = (await engine.page(query(name))).rows[0]!;
    await assert.rejects(engine.edit([{ kind: 'update', table: name, key: row.key, column: 'generated', value: text('bad') }]), /Generated/);
    await engine.edit([{ kind: 'update', table: name, key: row.key, column: 'a', value: text('three') }, { kind: 'insert', table: name, values: { a: text('new'), b: text('record') } }]);
    await engine.save();
    const saved = (await engine.page(query(name))).rows;
    assert.equal(saved.find(item => item.values[0]!.value === 'three')!.values[3]!.value, 'threetwo');
    assert.equal(saved.find(item => item.values[0]!.value === 'new')!.values[2]!.value, 'fresh');
  });
});

test('foreign key violations and schema changes block saves', async () => {
  await fixture('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE items(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO items VALUES(1,1);', async (engine, external) => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'parent', value: integer('2') }]);
    await assert.rejects(engine.save(), /FOREIGN KEY/);
    await engine.discard();
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'parent', value: { type: 'null', value: '' } }]);
    await execute(external, 'ALTER TABLE items ADD COLUMN extra TEXT');
    await assert.rejects(engine.save(), /structure/);
  });
});

test('WAL backups include committed log contents and exclude staged changes', async () => {
  await fixture("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'committed');", async (engine, external, directory) => {
    await execute(external, "INSERT INTO items VALUES(2,'from-wal')");
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('pending') }]);
    const backupPath = join(directory, 'backup.db'); await engine.backup(backupPath);
    const backup = await SqliteDatabase.open(backupPath);
    try { assert.deepEqual((await backup.page(query())).rows.map(item => item.values[1]!.value), ['committed', 'from-wal']); }
    finally { await backup.close(); }
    await assert.rejects(engine.backup(backupPath), /EEXIST/);
  });
});

test('batch failures are atomic and CSV export safely quotes line breaks', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'first');", async engine => {
    const row = (await engine.page(query())).rows[0]!;
    await assert.rejects(engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('changed') }, { kind: 'update', table: 'items', key: row.key, column: 'id', value: integer('9223372036854775808') }]), /64-bit/);
    assert.equal(engine.status().pending, 0);
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('a,"b"\nc') }]);
    assert.equal(await engine.exportCsv(query()), 'id,name\r\n1,"a,""b""\nc"\r\n');
  });
});

test('rowid alias shadowing uses an accessible identity or becomes read-only', async () => {
  await fixture('CREATE TABLE items(rowid TEXT,_rowid_ TEXT,oid TEXT,value TEXT); INSERT INTO items VALUES(\'x\',\'y\',\'z\',\'data\');', async engine => {
    assert.equal((await engine.metadata())[0]!.editable, false);
    assert.equal((await engine.page(query())).rows[0]!.values[3]!.value, 'data');
  });
});

test('changes made after a page was displayed cannot be overwritten by a new edit', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'first');", async (engine, external) => {
    const row = (await engine.page(query())).rows[0]!;
    await execute(external, "UPDATE items SET name='external'");
    await assert.rejects(engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('local') }]), /after it was displayed/);
    assert.equal(engine.status().pending, 0);
  });
});

test('schema conflicts remain blocked on repeated save attempts', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'first');", async (engine, external) => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('local') }]);
    await execute(external, 'CREATE INDEX name_index ON items(name)');
    await assert.rejects(engine.save(), /structure/);
    await assert.rejects(engine.save(), /structure/);
    assert.equal(engine.status().pending, 1);
  });
});

test('virtual table shadow storage stays hidden and views have distinct display row keys', async () => {
  await fixture("CREATE VIRTUAL TABLE docs USING fts5(content); INSERT INTO docs VALUES('hello'),('world'); CREATE VIEW entries AS SELECT content FROM docs;", async engine => {
    const tables = await engine.metadata();
    assert.deepEqual(tables.map(table => table.name), ['docs', 'entries']);
    assert.equal(tables[0]!.editable, false);
    const page = await engine.page(query('entries'));
    assert.notEqual(page.rows[0]!.key, page.rows[1]!.key);
  });
});

test('prototype-like identifiers remain ordinary database column names', async () => {
  await fixture('CREATE TABLE "__proto__"(id INTEGER PRIMARY KEY,"__proto__" TEXT,"constructor" TEXT); INSERT INTO "__proto__" VALUES(1,\'a\',\'b\');', async engine => {
    const row = (await engine.page(query('__proto__'))).rows[0]!;
    await engine.edit([{ kind: 'update', table: '__proto__', key: row.key, column: '__proto__', value: text('changed') }, { kind: 'update', table: '__proto__', key: row.key, column: 'constructor', value: text('other') }]);
    assert.deepEqual((await engine.page(query('__proto__'))).rows[0]!.values.map(value => value.value), ['1', 'changed', 'other']);
    await engine.save();
    assert.deepEqual((await engine.page(query('__proto__'))).rows[0]!.values.map(value => value.value), ['1', 'changed', 'other']);
  });
});

test('save-as recovery applies edits only to the consistent database copy', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'first');", async (engine, external, directory) => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('copy') }]);
    const path = join(directory, 'copy.db'); await engine.backup(path);
    const copy = await SqliteDatabase.open(path);
    try { await copy.restore(engine.recovery()); await copy.save(); assert.equal((await copy.page(query())).rows[0]!.values[1]!.value, 'copy'); }
    finally { await copy.close(); }
    await engine.discard(); assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'first');
    assert.equal(engine.status().pending, 0);
  });
});

test('real values retain significant digits when staged rows are projected', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,n REAL,name TEXT); INSERT INTO items VALUES(1,1.0000000000000002,'first');", async engine => {
    const row = (await engine.page(query())).rows[0]!;
    assert.equal(Number(row.values[1]!.value), 1.0000000000000002);
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('changed') }]);
    assert.equal(Number((await engine.page(query())).rows[0]!.values[1]!.value), 1.0000000000000002);
    await engine.save();
    assert.equal(Number((await engine.page(query())).rows[0]!.values[1]!.value), 1.0000000000000002);
  });
});

test('a trigger changing another pending record rolls back the save', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'first'),(2,'second'); CREATE TRIGGER side_effect AFTER UPDATE ON items WHEN NEW.id=1 BEGIN UPDATE items SET name='trigger' WHERE id=2; END;", async engine => {
    const rows = (await engine.page(query())).rows;
    await engine.edit(rows.map((row, index) => ({ kind: 'update', table: 'items', key: row.key, column: 'name', value: text(`local${index}`) })));
    await assert.rejects(engine.save(), /trigger/);
    await engine.discard();
    assert.deepEqual((await engine.page(query())).rows.map(row => row.values[1]!.value), ['first', 'second']);
  });
});

test('SQLite sidecar files cannot be used as backup destinations', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY);", async (engine, external, directory) => {
    await assert.rejects(engine.backup(join(directory, 'sample.db-wal')), /different file/);
    await assert.rejects(engine.backup(join(directory, 'sample.db-shm')), /different file/);
    await assert.rejects(engine.backup(join(directory, 'sample.db-journal')), /different file/);
  });
});

test('binary compound primary keys locate records without text conversion loss', async () => {
  await fixture("CREATE TABLE items(id BLOB PRIMARY KEY,name TEXT) WITHOUT ROWID; INSERT INTO items VALUES(x'00ff80','first');", async engine => {
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'name', value: text('changed') }]);
    assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'changed');
    await engine.save();
    assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'changed');
  });
});

test('default browsing preserves numeric primary-key order across staged pages', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'a'),(2,'b'),(10,'c'),(100,'d');", async engine => {
    const rows = (await engine.page(query())).rows;
    assert.deepEqual(rows.map(row => row.values[0]!.value), ['1', '2', '10', '100']);
    await engine.edit([{ kind: 'update', table: 'items', key: rows[1]!.key, column: 'name', value: text('changed') }]);
    assert.deepEqual((await engine.page(query())).rows.map(row => row.values[0]!.value), ['1', '2', '10', '100']);
  });
});

test('real input accepts decimal notation and rejects values SQLite would truncate', async () => {
  await fixture('CREATE TABLE items(id INTEGER PRIMARY KEY,n REAL); INSERT INTO items VALUES(1,0);', async engine => {
    const row = (await engine.page(query())).rows[0]!;
    for (const value of ['0x10', '0b1', '0o7', '1e', '1e+', '1.2tail', 'Infinity', 'NaN', '']) {
      await assert.rejects(engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'n', value: { type: 'real', value } }]), /finite number/);
      assert.equal(engine.status().pending, 0);
    }
    for (const value of ['.5', '1.', '-1e-3', '+2.5E+3', ' -0.125 ']) {
      await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'n', value: { type: 'real', value } }]);
      await engine.save();
      const saved = (await engine.page(query())).rows[0]!;
      assert.equal(Number(saved.values[1]!.value), Number(value));
    }
  });
});

test('table declarations containing SQL keywords in defaults retain real row identities', async () => {
  await fixture("CREATE TABLE items(name TEXT DEFAULT 'WITHOUT ROWID',value TEXT); INSERT INTO items(value) VALUES('first');", async engine => {
    const table = (await engine.metadata())[0]!;
    assert.equal(table.editable, true);
    const row = (await engine.page(query())).rows[0]!;
    await engine.edit([{ kind: 'update', table: 'items', key: row.key, column: 'value', value: text('changed') }]);
    await engine.save();
    assert.equal((await engine.page(query())).rows[0]!.values[1]!.value, 'changed');
  });
});

test('column filters AND together over staged values and clear independently', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,n INTEGER); INSERT INTO items VALUES(1,'alpha',10),(2,'beta',20),(3,'alpha',30);", async engine => {
    const row = (await engine.page(query())).rows[1]!;
    await engine.edit([{kind:'update',table:'items',key:row.key,column:'name',value:text('alpha')}]);
    const filters = [{column:'name',mode:'text' as const,text:'ALP'},{column:'n',mode:'number' as const,operator:'between' as const,value:'15',max:'25'}];
    assert.deepEqual((await engine.page({...query(),filters})).rows.map(row=>row.values[0]!.value),['2']);
    assert.equal((await engine.page({...query(),filters:filters.slice(0,1)})).rows.length,3);
    assert.equal((await engine.page({...query(),filters:[]})).rows.length,3);
  });
});

test('numeric filters preserve bigint comparisons and exclude numeric-looking text', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,n); INSERT INTO items VALUES(1,9223372036854775807),(2,9223372036854775806),(3,'9223372036854775807'),(4,'abc'),(5,0);", async engine => {
    const exact=await engine.page({...query(),filters:[{column:'n',mode:'number',operator:'eq',value:'9223372036854775807'}]});
    assert.deepEqual(exact.rows.map(row=>row.values[0]!.value),['1']);
    const zero=await engine.page({...query(),filters:[{column:'n',mode:'number',operator:'eq',value:'0'}]});
    assert.deepEqual(zero.rows.map(row=>row.values[0]!.value),['5']);
    await assert.rejects(engine.page({...query(),filters:[{column:'n',mode:'number',operator:'gt',value:'0x10'}]}),/decimal/);
  });
});

test('empty filters distinguish null and whitespace from zero and binary values', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,value); INSERT INTO items VALUES(1,NULL),(2,''),(3,char(9)||char(10)||char(160)||char(12288)),(4,0),(5,x''),(6,'text');", async engine => {
    assert.deepEqual((await engine.page({...query(),filters:[{column:'value',mode:'empty'}]})).rows.map(row=>row.values[0]!.value),['1','2','3']);
    assert.deepEqual((await engine.page({...query(),filters:[{column:'value',mode:'notEmpty'}]})).rows.map(row=>row.values[0]!.value),['4','5','6']);
  });
});

test('typed distinct values scan unloaded rows and include pending inserts and changes', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,value); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600) INSERT INTO items SELECT x,'shared' FROM n; INSERT INTO items VALUES(601,NULL),(602,''),(603,1),(604,1.0),(605,x'00ff');", async engine => {
    const row=(await engine.page(query())).rows[0]!;
    await engine.edit([{kind:'update',table:'items',key:row.key,column:'value',value:text('changed')},{kind:'insert',table:'items',values:{value:text('inserted')}}]);
    const distinct=await engine.distinct('items','value');
    assert.equal(distinct.find(item=>item.value.type==='text'&&item.value.value==='shared')!.count,599);
    for(const type of ['null','integer','real','blob']) assert.ok(distinct.some(item=>item.value.type===type));
    assert.ok(distinct.some(item=>item.value.value==='inserted'));
    assert.equal((await engine.page({...query(),filters:[{column:'value',mode:'values',values:[integer('1')]}]})).rows.length,1);
    assert.equal((await engine.page({...query(),filters:[{column:'value',mode:'values',values:[{type:'null',value:''},text('')]}]})).rows.length,2);
    assert.equal((await engine.page({...query(),filters:[{column:'value',mode:'values',values:[{type:'blob',value:'00FF'}]}]})).rows.length,1);
  });
});

test('distinct enumeration rejects overflow instead of returning an incomplete list', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO items SELECT x,'v'||x FROM n;", async engine => {
    await assert.rejects(engine.distinct('items','value'),/more than 1,000/);
  });
});

test('custom SQL uses real hostile column names, pending values and read-only expression scope', async () => {
  await fixture('CREATE TABLE items("__key" TEXT,"v0" TEXT,"quote\"\"column" INTEGER); INSERT INTO items VALUES(\'a\',\'b\',1);', async engine => {
    const row=(await engine.page(query())).rows[0]!;
    await engine.edit([{kind:'update',table:'items',key:row.key,column:'__key',value:text('changed')}]);
    const filters=[{column:'__key',mode:'custom' as const,sql:'"__key" = \'changed\' AND "v0" = \'b\' AND "quote""column" = 1'}];
    assert.equal((await engine.page({...query(),filters})).rows.length,1);
    assert.equal((await engine.page({...query(),filters:[{column:'v0',mode:'custom',sql:'items."v0" = \'b\''}]})).rows.length,1);
    for(const sql of ['1); DELETE FROM items; --','EXISTS(SELECT 1 FROM sqlite_schema)','load_extension(\'x\')','"load_extension"(\'x\')','1 OR','(1','1 -- comment']) {
      await assert.rejects(engine.page({...query(),filters:[{column:'v0',mode:'custom',sql}]}));
    }
    await engine.save(); assert.equal((await engine.page(query())).rows[0]!.values[0]!.value,'changed');
  });
});

test('backend regular expressions match unloaded candidate rows before pagination', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600) INSERT INTO items SELECT x,CASE WHEN x%100=0 THEN 'match-'||x ELSE 'other' END FROM n;", async engine => {
    const filters=[{column:'name',mode:'regex' as const,text:'^match-\\d+$'}];
    const first=await engine.page({...query(),limit:2,filters});
    assert.deepEqual(first.rows.map(row=>row.values[0]!.value),['100','200']); assert.equal(first.hasMore,true);
    const later=await engine.page({...query(),offset:4,limit:2,filters});
    assert.deepEqual(later.rows.map(row=>row.values[0]!.value),['500','600']); assert.equal(later.hasMore,false);
    await assert.rejects(engine.page({...query(),filters:[{column:'name',mode:'regex',text:'(?=x)'}]}));
    assert.equal((await engine.page(query())).rows.length,200);
  });
});

test('regex candidate overflow rejects the entire result and leaves the connection usable', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001) INSERT INTO items SELECT x,'x' FROM n;", async engine => {
    await assert.rejects(engine.page({...query(),filters:[{column:'name',mode:'regex',text:'x'}]}),/100,000 candidate/);
    assert.equal((await engine.page(query())).rows.length,200);
    const narrowed=await engine.page({...query(),filters:[{column:'name',mode:'regex',text:'x'},{column:'id',mode:'number',operator:'lte',value:'10'}]});
    assert.equal(narrowed.rows.length,10);
  });
});

test('regex CSV export scans matches once and preserves full filtered scope', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600) INSERT INTO items SELECT x,'match-'||x FROM n;", async engine => {
    const csv=await engine.exportCsv({...query(),offset:400,limit:2,filters:[{column:'name',mode:'regex',text:'^match-'}]});
    assert.equal(csv.split('\r\n').length,602);
    assert.ok(csv.includes('600,match-600\r\n'));
  });
});

test('custom expression timeout restores writable connection state', {timeout:15000}, async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO items SELECT x,'name' FROM n;", async engine => {
    await assert.rejects(engine.page({...query(),filters:[{column:'name',mode:'custom',sql:'length(hex(randomblob(65536)))=0'}]}),/interrupt|five seconds/i);
    const row=(await engine.page(query())).rows[0]!;
    await engine.edit([{kind:'update',table:'items',key:row.key,column:'name',value:text('saved after timeout')}]);
    await engine.save();
    assert.equal((await engine.page(query())).rows[0]!.values[1]!.value,'saved after timeout');
  });
});

test('value filters and distinct enumeration retain exact text despite column collation', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT COLLATE NOCASE); INSERT INTO items VALUES(1,'Alpha'),(2,'alpha'),(3,' Alpha ');", async engine => {
    assert.equal((await engine.distinct('items','name')).length,3);
    assert.deepEqual((await engine.page({...query(),filters:[{column:'name',mode:'values',values:[text('Alpha')]}]})).rows.map(row=>row.values[0]!.value),['1']);
  });
});

test('custom SQL rejects implicit table reads through SQLite IN shorthand', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE secret(value TEXT); INSERT INTO items VALUES(1,'name'); INSERT INTO secret VALUES('name');", async engine => {
    await assert.rejects(engine.page({...query(),filters:[{column:'name',mode:'custom',sql:'name IN secret'}]}),/Other tables/);
    assert.equal((await engine.page({...query(),filters:[{column:'name',mode:'custom',sql:"name IN ('name','other')"}]})).rows.length,1);
  });
});

test('equal sort values retain natural numeric identity order in both directions', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO items VALUES(1,'same'),(2,'same'),(10,'same');", async engine => {
    for(const direction of ['ASC','DESC'] as const) {
      assert.deepEqual((await engine.page({...query(),sort:[{column:'name',direction}]})).rows.map(row=>row.values[0]!.value),['1','2','10']);
    }
    const row=(await engine.page(query())).rows[1]!;
    await engine.edit([{kind:'update',table:'items',key:row.key,column:'name',value:text('other')}]);
    assert.deepEqual((await engine.page({...query(),sort:[{column:'id',direction:'ASC'}]})).rows.map(row=>row.values[0]!.value),['1','2','10']);
  });
});

test('multiple sort keys apply in order and reject duplicate or excessive keys', async () => {
  await fixture("CREATE TABLE items(id INTEGER PRIMARY KEY, team TEXT, score INTEGER); INSERT INTO items VALUES(1,'b',2),(2,'a',1),(3,'b',5),(4,'a',3),(5,'b',5);", async engine => {
    const ids = async (sort: { column: string; direction: 'ASC' | 'DESC' }[]) => (await engine.page({ ...query(), sort })).rows.map(row => row.values[0]!.value);
    assert.deepEqual(await ids([{ column: 'team', direction: 'ASC' }, { column: 'score', direction: 'DESC' }]), ['4', '2', '3', '5', '1']);
    assert.deepEqual(await ids([{ column: 'score', direction: 'DESC' }, { column: 'team', direction: 'ASC' }]), ['3', '5', '4', '1', '2']);
    await assert.rejects(ids([{ column: 'team', direction: 'ASC' }, { column: 'team', direction: 'DESC' }]), /only once/);
    await assert.rejects(ids(Array.from({ length: 17 }, () => ({ column: 'team', direction: 'ASC' as const }))), /at most 16/);
  });
});

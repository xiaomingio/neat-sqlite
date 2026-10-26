/*
Purpose: Browse SQLite files and stage lossless edits for conflict-checked atomic saves.
*/
import sqlite3 from 'sqlite3';
import { SqlQuery, singleStatement } from './SqlQuery';
import { CellSearch, type SearchMatch } from './CellSearch';
import { CsvImport } from './CsvImport';
import { RE2JS } from 're2js';
import { compileFilters } from './ColumnFilter';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Column, Edit, Page, Query, Row, Status, Table, Value, DistinctValue, SqlResult, CsvMapping, DatabaseReport, RelatedRecord, SearchRequest, SearchResult, SearchHit, SearchLocation } from './protocol';

type RecordData = Record<string, unknown>;
type BackupHandle = { step(pages: number, callback: (error: Error | null) => void): void; finish(callback: (error: Error | null) => void): void };
type BackupDatabase = sqlite3.Database & { backup(path: string, callback: (error: Error | null) => void): BackupHandle };
type Pending = { schema: string; table: string; key: string; original?: Value[]; values: Record<string, Value>; deleted: boolean };
type TableInfo = { table: Table; identity: string[]; schema: string };
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const nullValue = (): Value => ({ type: 'null', value: '' });
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SORT_KEYS = 16;

export class SqliteDatabase {
  private tables = new Map<string, TableInfo>();
  private pending: Pending[] = [];
  private history: Pending[][] = [];
  private future: Pending[][] = [];
  private readonly historySizes = new WeakMap<Pending[], number>();
  private readOnly = false;
  private activeQuery?: SqlQuery;
  private readonly searches = new CellSearch('snapshot', true);
  private lastSqlResult?: { sql: string; limit: number; result: SqlResult };
  private observed = new Map<string, Value[]>();
  private observedBytes = 0;
  private constructor(private readonly db: sqlite3.Database, private readonly path: string) {}

  static async open(path: string): Promise<SqliteDatabase> {
    const file = await stat(path);
    if (!file.isFile()) throw new Error('Choose a local SQLite database file.');
    let readOnly = false;
    const connect = (mode: number): Promise<sqlite3.Database> => new Promise((done, fail) => {
      const db = new sqlite3.Database(path, mode, error => {
        if (error) { db.close(() => fail(error)); } else done(db);
      });
    });
    let db: sqlite3.Database;
    try { db = await connect(sqlite3.OPEN_READWRITE); }
    catch { db = await connect(sqlite3.OPEN_READONLY); readOnly = true; }
    const instance = new SqliteDatabase(db, path);
    instance.readOnly = readOnly;
    try {
      db.configure('busyTimeout', 1500);
      await instance.run('PRAGMA foreign_keys = ON');
      await instance.run('PRAGMA trusted_schema = OFF');
      await instance.loadMetadata();
      return instance;
    } catch (error) { await instance.close(); throw error; }
  }

  private all(sql: string, params: unknown[] = []): Promise<RecordData[]> {
    return new Promise((done, fail) => {
      const records: RecordData[] = []; let bytes = 0; let failure: Error | undefined;
      this.db.each(sql, params, (error: Error | null, record: RecordData) => {
        if (failure) return;
        if (error) { failure = error; return; }
        bytes += Buffer.byteLength(JSON.stringify(record));
        if (bytes > MAX_BYTES) { failure = new Error('The result exceeds 8 MiB. Reduce the page size or apply a filter.'); this.db.interrupt(); return; }
        records.push(record);
      }, (error: Error | null) => error || failure ? fail(failure ?? error) : done(records));
    });
  }

  private run(sql: string, params: unknown[] = []): Promise<number> {
    return new Promise((done, fail) => this.db.run(sql, params, function (error) { if (error) fail(error); else done(this.changes); }));
  }

  private async loadMetadata(): Promise<void> {
    const schemaVersion = (await this.all('PRAGMA schema_version'))[0]?.schema_version;
    const descriptions = new Map((await this.all("SELECT name,type,wr FROM pragma_table_list WHERE schema='main'")).map(row => [String(row.name), row]));
    const shadows = new Set([...descriptions].filter(([, row]) => row.type === 'shadow').map(([name]) => name));
    const objects = (await this.all("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY type, name COLLATE NOCASE")).filter(object => !shadows.has(String(object.name)));
    const tables = new Map<string, TableInfo>();
    for (const object of objects) {
      const name = String(object.name);
      const fields = await this.all('SELECT * FROM pragma_table_xinfo(?)', [name]);
      const columns: Column[] = fields.filter(field => Number(field.hidden) !== 1).map(field => ({ name: String(field.name), type: String(field.type), notNull: Boolean(field.notnull), defaultValue: field.dflt_value === null ? null : String(field.dflt_value), pk: Number(field.pk), generated: Number(field.hidden) > 1 }));
      const sql = String(object.sql ?? '');
      const withoutRowid = Boolean(descriptions.get(name)?.wr);
      const rowid = ['rowid', '_rowid_', 'oid'].find(candidate => !columns.some(column => column.name.toLowerCase() === candidate));
      const pk = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      const identity = withoutRowid ? pk : rowid ? [rowid] : [];
      const keys = object.type === 'view' ? [] : identity;
      const editable = !this.readOnly && object.type === 'table' && descriptions.get(name)?.type !== 'virtual' && keys.length > 0;
      const indexes = await this.all('SELECT * FROM pragma_index_list(?)', [name]);
      const foreignKeys = await this.all('SELECT * FROM pragma_foreign_key_list(?)', [name]);
      const table: Table = { name, kind: object.type === 'view' ? 'view' : 'table', sql, editable, columns, indexes, foreignKeys };
      if (!editable) table.reason = this.readOnly ? 'Database is read-only.' : object.type === 'view' ? 'Views are read-only.' : 'This table has no supported writable row identity.';
      tables.set(name, { table, identity: keys, schema: JSON.stringify({ schemaVersion, sql, fields, indexes, foreignKeys }) });
    }
    this.tables = tables;
  }

  async metadata(): Promise<Table[]> { return [...this.tables.values()].map(info => structuredClone(info.table)); }

  private info(name: string): TableInfo {
    if (typeof name !== 'string' || !this.tables.has(name)) throw new Error('The selected table no longer exists. Refresh the database.');
    return this.tables.get(name)!;
  }

  private keyExpression(info: TableInfo): string {
    return info.identity.length ? `json_array(${info.identity.flatMap(name => [`typeof(${quote(name)})`, `CASE WHEN typeof(${quote(name)})='blob' THEN hex(${quote(name)}) WHEN typeof(${quote(name)})='real' THEN printf('%!.17g',${quote(name)}) ELSE CAST(${quote(name)} AS TEXT) END`]).join(',')})` : "''";
  }

  private identityWhere(info: TableInfo, key: string, aliases = false): { sql: string; params: unknown[] } {
    const values = JSON.parse(key) as unknown[];
    if (!Array.isArray(values) || values.length !== info.identity.length * 2) throw new Error('Invalid record identity.');
    const params: unknown[] = [];
    const sql = info.identity.map((name, index) => {
      const type = values[index * 2]; const value = values[index * 2 + 1];
      const column = quote(aliases ? `__o${index}` : name);
      if (typeof type !== 'string' || !['null', 'integer', 'real', 'text', 'blob'].includes(type) || (value !== null && typeof value !== 'string')) throw new Error('Invalid record identity.');
      params.push(type);
      let expression: string;
      if (type === 'blob') {
        if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{2})*$/.test(value)) throw new Error('Invalid binary record identity.');
        params.push(Buffer.from(value, 'hex')); expression = '?';
      } else expression = this.valueSql({ type: type as Value['type'], value: value === null ? '' : value }, params);
      return `(typeof(${column}) = ? AND ${column} IS ${expression})`;
    }).join(' AND ');
    return { sql, params };
  }

  private valueSql(value: Value, params: unknown[]): string {
    this.validateValue(value);
    if (value.type === 'null') return 'NULL';
    params.push(value.value);
    return value.type === 'integer' ? 'CAST(? AS INTEGER)' : value.type === 'real' ? 'CAST(? AS REAL)' : '?';
  }

  private validateValue(value: Value): void {
    if (!value || !['null', 'text', 'integer', 'real'].includes(value.type) || typeof value.value !== 'string') throw new Error('Use text, integer, real, or NULL values. BLOB editing is unavailable.');
    if (Buffer.byteLength(value.value) > MAX_BYTES) throw new Error('A value exceeds the 8 MiB editing limit.');
    if (value.type === 'integer' && (!/^[+-]?\d+$/.test(value.value) || BigInt(value.value) < -(1n << 63n) || BigInt(value.value) >= 1n << 63n)) throw new Error('Enter a signed 64-bit integer.');
    if (value.type === 'real' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value.trim()) || !Number.isFinite(Number(value.value)))) throw new Error('Enter a finite number.');
  }

  private source(info: TableInfo, includePending: boolean): { sql: string; params: unknown[] } {
    const columns = info.table.columns;
    const changes = includePending ? this.pending.filter(item => item.table === info.table.name) : [];
    const params: unknown[] = [];
    const excludes = changes.filter(item => item.original).map(item => item.key);
    const key = this.keyExpression(info);
    const orderColumns = info.identity.map((name, index) => `${quote(name)} AS ${quote(`__o${index}`)}`);
    let sql = `SELECT ${key} AS __key, ${orderColumns.length ? `${orderColumns.join(',')}, ` : ''}${columns.map((column, index) => `${quote(column.name)} AS ${quote(`v${index}`)}`).join(',')} FROM ${quote(info.table.name)}`;
    if (excludes.length) { sql += ` WHERE ${key} NOT IN (${excludes.map(() => '?').join(',')})`; params.push(...excludes); }
    const stagedRows: string[] = [];
    for (const change of changes.filter(item => !item.deleted)) {
      params.push(change.key);
      const originalKeys = change.original ? JSON.parse(change.key) as string[] : [];
      const ordering = info.identity.map((name, index) => {
        if (Object.hasOwn(change.values, name)) return this.valueSql(change.values[name]!, params);
        if (change.original) {
          if (originalKeys[index * 2] === 'blob') { params.push(Buffer.from(originalKeys[index * 2 + 1]!, 'hex')); return '?'; }
          return this.valueSql({ type: originalKeys[index * 2] as Value['type'], value: originalKeys[index * 2 + 1] ?? '' }, params);
        }
        return 'NULL';
      });
      const expressions = columns.map((column, index) => {
        const value = Object.hasOwn(change.values, column.name) ? change.values[column.name] : change.original?.[index];
        if (value?.type === 'blob') { params.push(Buffer.from(value.value, 'hex')); return '?'; }
        if (value) return this.valueSql(value, params);
        return column.defaultValue === null ? 'NULL' : `(${column.defaultValue})`;
      });
      stagedRows.push(`(?,${ordering.length ? `${ordering.join(',')},` : ''}${expressions.join(',')})`);
    }
    if (stagedRows.length) sql += ` UNION ALL SELECT * FROM (VALUES ${stagedRows.join(',')})`;
    if (params.length > 30000) throw new Error('Pending edits exceed the query parameter budget. Save a smaller batch.');
    return { sql, params };
  }

  private projection(info: TableInfo): string {
    return info.table.columns.map((_, index) => {
      const name = quote(`v${index}`);
      return `typeof(${name}) AS ${quote(`t${index}`)}, length(CAST(${name} AS BLOB)) AS ${quote(`b${index}`)}, CASE WHEN length(CAST(${name} AS BLOB)) > ${MAX_BYTES / 2} THEN NULL WHEN typeof(${name})='blob' THEN hex(${name}) WHEN typeof(${name})='real' THEN printf('%!.17g',${name}) ELSE CAST(${name} AS TEXT) END AS ${quote(`s${index}`)}`;
    }).join(',');
  }

  /** Index pending changes for one table so per-row decoding stays O(1). */
  private pendingIndex(table: string): Map<string, Pending> {
    return new Map(this.pending.filter(item => item.table === table).map(item => [item.key, item]));
  }

  private decode(info: TableInfo, record: RecordData, index = 0, pending = this.pendingIndex(info.table.name)): Row {
    const key = info.identity.length ? String(record.__key) : `view:${index}`;
    const change = pending.get(key);
    if (info.table.columns.some((_, index) => Number(record[`b${index}`]) > MAX_BYTES / 2)) throw new Error('A cell exceeds the 4 MiB browsing limit. Use a dedicated SQLite tool for this value.');
    const values: Value[] = info.table.columns.map((_, column) => ({ type: String(record[`t${column}`]) as Value['type'], value: record[`s${column}`] === null ? '' : String(record[`s${column}`]) }));
    return { key, values, modified: Boolean(change), inserted: Boolean(change && !change.original), deleted: false };
  }

  private queryParts(query: Query, info: TableInfo): { where: string; order: string; params: unknown[]; regex: {column:string;text:string}[] } {
    const columns = info.table.columns;
    const columnRef = (name: string): string => {
      const index = columns.findIndex(column => column.name === name);
      if (index < 0) throw new Error('Choose a valid column.');
      return quote(`v${index}`);
    };
    const compiled = compileFilters(query.filters, columns.map(column => column.name), info.table.name, columns.map((_, index) => quote(`v${index}`)));
    const where = compiled.sql === '1' ? '' : ` WHERE ${compiled.sql}`;
    const params = compiled.params;
    // Sort keys apply in the order the user added them; the row identity breaks remaining ties.
    const sorts = query.sort ?? [];
    if (!Array.isArray(sorts) || sorts.length > MAX_SORT_KEYS) throw new Error('Sort by at most 16 columns.');
    const seen = new Set<string>();
    const keys = sorts.map(sort => {
      if (!sort || typeof sort.column !== 'string' || !['ASC', 'DESC'].includes(sort.direction)) throw new Error('Choose a valid sort direction.');
      if (seen.has(sort.column)) throw new Error('Each column can appear only once in the sort order.');
      seen.add(sort.column); return `${columnRef(sort.column)} ${sort.direction}`;
    });
    const ties = info.identity.map((_, index) => quote(`__o${index}`));
    const terms = [...keys, ...ties];
    const order = terms.length ? ` ORDER BY ${terms.join(', ')}` : '';
    return { where, order, params, regex: compiled.regex };
  }

  private async readQuery<T>(operation: () => Promise<T>, queryOnly = false): Promise<T> {
    const previous = queryOnly ? Number((await this.all('PRAGMA query_only'))[0]?.query_only) : 0;
    if (queryOnly && !previous) await this.run('PRAGMA query_only = ON');
    const deadline = setTimeout(() => this.db.interrupt(), 5000);
    try { return await operation(); }
    finally { clearTimeout(deadline); if (queryOnly && !previous) await this.run('PRAGMA query_only = OFF'); }
  }

  private regexMatcher(filters: {column:string;text:string}[], info: TableInfo): (record: RecordData) => boolean {
    const patterns = filters.map(filter => ({ index: info.table.columns.findIndex(column => column.name === filter.column), pattern: RE2JS.compile(filter.text) }));
    return record => patterns.map(({index, pattern}) => {
      const value = record[`s${index}`];
      if (Number(record[`b${index}`]) > 65536) throw new Error('Regular expressions support values of at most 65,536 bytes. Add another filter or use Text.');
      return { pattern, value: value === null ? '' : String(value) };
    }).every(({pattern, value}) => pattern.test(value));
  }

  private scan(sql: string, params: unknown[], visit: (record: RecordData) => void): Promise<void> {
    const deadline = Date.now() + 5000;
    return new Promise((done, fail) => {
      let failure: Error | undefined;
      this.db.each(sql, params, (error: Error | null, record: RecordData) => {
        if (failure) return;
        try { if (error) throw error; if (Date.now() > deadline) throw new Error('The query exceeded five seconds. Narrow the filters.'); visit(record); }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); this.db.interrupt(); }
      }, (error: Error | null) => error || failure ? fail(failure ?? error) : done());
    });
  }

  private async regexPage(sql: string, params: unknown[], filters: {column:string;text:string}[], info: TableInfo, query: Query): Promise<RecordData[]> {
    const matches: RecordData[] = []; const test = this.regexMatcher(filters, info);
    let count = 0; let bytes = 0; let matching = 0;
    await this.scan(`${sql} LIMIT 100001`, params, record => {
      count++; bytes += Buffer.byteLength(JSON.stringify(record));
      if (count > 100000 || bytes > 16 * 1024 * 1024) throw new Error('Regular expression scan exceeds 100,000 candidate rows or 16 MiB. Add another column filter to narrow the scan.');
      if (test(record)) { if (matching >= query.offset && matches.length <= query.limit) matches.push(record); matching++; }
    });
    return matches;
  }

  async distinct(table: string, column: string): Promise<DistinctValue[]> {
    const info = this.info(table); const index = info.table.columns.findIndex(item => item.name === column);
    if (index < 0) throw new Error('Choose a valid column.');
    const source = this.source(info, true); const reference = quote(`v${index}`);
    const single: TableInfo = { ...info, identity: [], table: { ...info.table, columns: [info.table.columns[index]!] } };
    const records = await this.readQuery(() => this.all(`WITH data AS (${source.sql}), grouped AS (SELECT ${reference} AS v0, count(*) AS __count FROM data GROUP BY typeof(${reference}), ${reference} COLLATE BINARY LIMIT 1001) SELECT __count, ${this.projection(single)} FROM grouped`, source.params));
    if (records.length > 1000) throw new Error('This column has more than 1,000 distinct values. Use Text, Number, or Custom SQL instead.');
    return records.map(record => {
      if (Number(record.b0) > 65536) throw new Error('A distinct value exceeds 65,536 bytes. Use another filter mode.');
      const count = Number(record.__count);
      if (!Number.isSafeInteger(count)) throw new Error('A distinct value count exceeds the supported range.');
      return { value: this.decode(single, record, 0, new Map()).values[0]!, count };
    });
  }

  async page(query: Query): Promise<Page> {
    if (!query || !Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) throw new Error('Pages support between 1 and 500 records.');
    const info = this.info(query.table);
    const source = this.source(info, true); const parts = this.queryParts(query, info);
    const sql = `WITH data AS (${source.sql}) SELECT __key, ${this.projection(info)} FROM data${parts.where}${parts.order}`;
    const records = await this.readQuery(async () => {
      if (parts.regex.length) return this.regexPage(sql, [...source.params, ...parts.params], parts.regex, info, query);
      return this.all(`${sql} LIMIT ? OFFSET ?`, [...source.params, ...parts.params, query.limit + 1, query.offset]);
    }, Boolean(query.filters?.some(filter => filter.mode === 'custom')));
    if (Buffer.byteLength(JSON.stringify(records)) > MAX_BYTES) throw new Error('This page exceeds 8 MiB. Reduce the page size or export the data with another tool.');
    const pending = this.pendingIndex(info.table.name);
    const rows = records.slice(0, query.limit).map((record, index) => this.decode(info, record, query.offset + index, pending));
    if (info.table.editable) for (const row of rows.filter(row => !row.modified)) {
      const id = JSON.stringify([query.table, row.key]);
      const previous = this.observed.get(id);
      if (previous) this.observedBytes -= Buffer.byteLength(JSON.stringify(previous));
      this.observed.delete(id); this.observed.set(id, row.values);
      this.observedBytes += Buffer.byteLength(JSON.stringify(row.values));
      while (this.observed.size > 2000 || this.observedBytes > MAX_BYTES) {
        const oldest = this.observed.keys().next().value!;
        this.observedBytes -= Buffer.byteLength(JSON.stringify(this.observed.get(oldest)));
        this.observed.delete(oldest);
      }
    }
    const page = { rows, hasMore: records.length > query.limit, offset: query.offset };
    this.searches.rememberPage(query, page, info.schema); return page;
  }

  private async original(info: TableInfo, key: string): Promise<Value[]> {
    const source = this.source(info, false);
    const identity = this.identityWhere(info, key, true);
    const records = await this.all(`WITH data AS (${source.sql}) SELECT __key, ${this.projection(info)} FROM data WHERE ${identity.sql}`, identity.params);
    if (records.length !== 1) throw new Error('The record changed or was removed. Refresh before editing.');
    return this.decode(info, records[0]!, 0, new Map()).values;
  }

  async edit(edits: Edit[]): Promise<void> {
    if (!Array.isArray(edits) || !edits.length || edits.length > 10000) throw new Error('Edit between 1 and 10,000 cells at a time.');
    const before = structuredClone(this.pending);
    // Key pending records once so large batches avoid a linear search per edited cell.
    const recordId = (table: string, key: string): string => JSON.stringify([table, key]);
    const staged = new Map(this.pending.map(item => [recordId(item.table, item.key), item]));
    const remove = (change: Pending): void => { this.pending = this.pending.filter(item => item !== change); staged.delete(recordId(change.table, change.key)); };
    try {
      for (const edit of edits) {
        const info = this.info(edit.table);
        if (!info.table.editable) throw new Error(info.table.reason ?? 'This table is read-only.');
        if (!['insert', 'update', 'delete'].includes(edit.kind)) throw new Error('Unsupported edit.');
        if (edit.kind === 'insert') {
          if (!edit.values || typeof edit.values !== 'object' || Array.isArray(edit.values)) throw new Error('Enter record values.');
          for (const [name, value] of Object.entries(edit.values)) { this.writableColumn(info, name); this.validateValue(value); }
          this.pending.push({ schema: info.schema, table: edit.table, key: `new:${randomUUID()}`, values: structuredClone(edit.values), deleted: false });
        } else {
          if (typeof edit.key !== 'string') throw new Error('Choose a valid record.');
          let change = staged.get(recordId(edit.table, edit.key));
          if (!change) {
            const observed = this.observed.get(recordId(edit.table, edit.key));
            if (!observed) throw new Error('Reload this page before editing the record.');
            if (!same(observed, await this.original(info, edit.key))) throw new Error('This record changed after it was displayed. Refresh before editing.');
            change = { schema: info.schema, table: edit.table, key: edit.key, original: structuredClone(observed), values: {}, deleted: false }; this.pending.push(change); staged.set(recordId(edit.table, edit.key), change);
          }
          if (edit.kind === 'delete') {
            if (change.original) change.deleted = true;
            else remove(change);
          } else {
            this.writableColumn(info, edit.column); this.validateValue(edit.value);
            if (change.deleted) throw new Error('Undo the record deletion before editing it.');
            const index = info.table.columns.findIndex(column => column.name === edit.column);
            if (change.original?.[index]?.type === 'blob') throw new Error('BLOB values are read-only.');
            if (same(edit.value, change.original?.[index])) delete change.values[edit.column];
            else change.values = { ...change.values, [edit.column]: structuredClone(edit.value) };
            if (change.original && !Object.keys(change.values).length) remove(change);
          }
        }
      }
      if (this.pending.length > 10000 || Buffer.byteLength(JSON.stringify(this.pending)) > MAX_BYTES) throw new Error('Pending edits exceed 10,000 records or 8 MiB. Save a smaller batch.');
      this.historySizes.delete(this.pending); this.history.push(before); this.future = []; this.trimHistory();
    } catch (error) { this.pending = before; throw error; }
  }

  private writableColumn(info: TableInfo, name: string): void {
    const column = info.table.columns.find(item => item.name === name);
    if (!column || column.generated) throw new Error('Choose an editable column. Generated columns are read-only.');
  }

  /** History states are replaced, never mutated, so their serialized size is measured once. */
  private stateBytes(state: Pending[]): number {
    let bytes = this.historySizes.get(state);
    if (bytes === undefined) { bytes = Buffer.byteLength(JSON.stringify(state)); this.historySizes.set(state, bytes); }
    return bytes;
  }

  private trimHistory(): void {
    let bytes = this.history.reduce((total, state) => total + this.stateBytes(state), 0);
    while (this.history.length > 1 && (this.history.length > 100 || bytes > 32 * 1024 * 1024)) bytes -= this.stateBytes(this.history.shift()!);
  }

  async undo(): Promise<void> { const state = this.history.pop(); if (state) { this.future.push(this.pending); this.pending = state; } }
  async redo(): Promise<void> { const state = this.future.pop(); if (state) { this.history.push(this.pending); this.pending = state; } }
  async discard(): Promise<void> { this.pending = []; this.history = []; this.future = []; }
  status(): Status { return { pending: this.pending.reduce((count, item) => count + (item.deleted || !item.original ? 1 : Object.keys(item.values).length), 0), tables: [...new Set(this.pending.map(item => item.table))], canUndo: this.history.length > 0, canRedo: this.future.length > 0, readOnly: this.readOnly }; }

  async save(): Promise<void> {
    if (!this.pending.length) return;
        await this.run('BEGIN IMMEDIATE');
    try {
      await this.loadMetadata();
      for (const change of this.pending) {
        const info = this.info(change.table);
        if (change.schema !== info.schema) throw new Error(`The structure of ${change.table} changed. Discard edits and refresh.`);
        if (change.original && !same(await this.original(info, change.key), change.original)) throw new Error(`A record in ${change.table} was changed by another program. Discard edits and refresh.`);
      }
      for (const change of this.pending) {
        const info = this.info(change.table); const params: unknown[] = [];
        if (change.original && !same(await this.original(info, change.key), change.original)) throw new Error('A database trigger changed another pending record. No edits were saved.');
        if (change.deleted) {
          const identity = this.identityWhere(info, change.key);
          const count = await this.run(`DELETE FROM ${quote(change.table)} WHERE ${identity.sql}`, identity.params);
          if (count !== 1) throw new Error('A record could not be deleted. No edits were saved.');
        } else {
          const fields = Object.keys(change.values);
          const expressions = fields.map(name => this.valueSql(change.values[name]!, params));
          if (!change.original) {
            await this.run(fields.length ? `INSERT INTO ${quote(change.table)} (${fields.map(quote).join(',')}) VALUES (${expressions.join(',')})` : `INSERT INTO ${quote(change.table)} DEFAULT VALUES`, params);
          } else {
            const identity = this.identityWhere(info, change.key); params.push(...identity.params);
            const count = await this.run(`UPDATE ${quote(change.table)} SET ${fields.map((name, index) => `${quote(name)}=${expressions[index]}`).join(',')} WHERE ${identity.sql}`, params);
            if (count !== 1) throw new Error('A record could not be updated. No edits were saved.');
          }
        }
      }
      await this.run('COMMIT');
    } catch (error) { await this.run('ROLLBACK'); throw error; }
    await this.discard(); this.observed.clear(); this.observedBytes = 0;
  }

  async refresh(): Promise<void> {
    if (this.pending.length) throw new Error('Save or discard pending edits before refreshing.');
    await this.loadMetadata(); this.observed.clear(); this.observedBytes = 0;
  }

  async sqlQuery(sql: string, limit?: number): Promise<SqlResult> {
    if (this.activeQuery) throw new Error('A SQL query is already running.');
    const query = new SqlQuery(); this.activeQuery = query;
    try { const result = await query.execute(this.path, sql, limit); this.lastSqlResult = { sql, limit: limit ?? 1000, result: structuredClone(result) }; return result; }
    finally { this.activeQuery = undefined; }
  }
  sqlExport(sql: string, limit = 1000): string {
    const cached = this.lastSqlResult;
    if (!cached || cached.sql !== sql || cached.limit !== limit) throw new Error('Run the current SQL and result limit before exporting.');
    return SqlQuery.csv(cached.result);
  }
  sqlCancel(): void { this.activeQuery?.cancel(); }

  /** Explicit writes commit independently; pending editor edits must be resolved first. */
  async sqlWrite(input: string): Promise<number> {
    if (this.readOnly) throw new Error('Database is read-only.');
    if (this.pending.length) throw new Error('Save or discard pending edits before executing SQL writes.');
    const { sql, words } = singleStatement(input);
    const first = words[0]; const second = words[1] === 'UNIQUE' ? words[2] : words[1];
    if (!['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(first!) && !(first === 'CREATE' && ['TABLE', 'VIEW', 'INDEX'].includes(second!)) && !(first === 'ALTER' && second === 'TABLE') && !(first === 'DROP' && ['VIEW', 'INDEX'].includes(second!))) throw new Error('Execute one INSERT, UPDATE, DELETE, REPLACE, CREATE TABLE/VIEW/INDEX, ALTER TABLE, or DROP VIEW/INDEX statement.');
    await this.run('PRAGMA foreign_keys = ON');
    await this.run('BEGIN IMMEDIATE');
    let changes = 0; const beforeTables = this.tables;
    const deadline = setTimeout(() => this.db.interrupt(), 5000);
    try {
      await this.run(sql);
      // sqlite3.run reports stale this.changes for RETURNING; a new statement observes the finalized write.
      if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(first!)) changes = Number((await this.all('SELECT changes() AS count'))[0]?.count);
      await this.loadMetadata();
      await this.run('COMMIT');
    } catch (error) { await this.run('ROLLBACK').catch(() => undefined); this.tables = beforeTables; throw error; }
    finally { clearTimeout(deadline); }
    await this.discard(); await this.refresh(); return changes;
  }

  async csvImport(table: string, text: string, mapping: CsvMapping[], nullToken?: string): Promise<number> {
    const info = this.info(table);
    if (!info.table.editable) throw new Error(info.table.reason ?? 'This table is read-only.');
    const values = new CsvImport(text).values(mapping, nullToken);
    for (const record of values) for (const [name, value] of Object.entries(record)) { this.writableColumn(info, name); this.validateValue(value); }
    if (values.length) await this.edit(values.map(record => ({ kind: 'insert', table, values: record })));
    return values.length;
  }

  async count(query: Query): Promise<number> {
    const info = this.info(query.table); const source = this.source(info, true); const parts = this.queryParts(query, info);
    if (!parts.regex.length) return this.readQuery(async () => Number((await this.all(`WITH data AS (${source.sql}) SELECT count(*) AS count FROM data${parts.where}`, [...source.params, ...parts.params]))[0]?.count), true);
    let count = 0; let scanned = 0; let bytes = 0; const test = this.regexMatcher(parts.regex, info);
    await this.readQuery(() => this.scan(`WITH data AS (${source.sql}) SELECT __key, ${this.projection(info)} FROM data${parts.where} LIMIT 100001`, [...source.params, ...parts.params], record => {
      bytes += Buffer.byteLength(JSON.stringify(record)); scanned++;
      if (scanned > 100000 || bytes > 16 * 1024 * 1024) throw new Error('Regular expression count exceeds the scan budget. Apply another filter.');
      if (test(record)) count++;
    }), true);
    return count;
  }

  async search(request: SearchRequest, mode: 'find' | 'replacePreview' | 'replaceApply'): Promise<SearchResult> {
    const info = this.info(request.table); const replacing = mode !== 'find';
    await this.assertSearchSchema(info);
    if (!['find', 'replacePreview', 'replaceApply'].includes(mode)) throw new Error('Choose a search operation.');
    if (replacing && !info.table.editable) throw new Error(info.table.reason ?? 'This table is read-only.');
    if (request.column !== undefined && !info.table.columns.some(column => column.name === request.column)) throw new Error('Choose a valid column.');
    if (replacing && request.column !== undefined) this.writableColumn(info, request.column);
    if (replacing && typeof request.replacement !== 'string') throw new Error('Enter replacement text.');
    const matcher = new CellSearch(request.search, request.matchCase, replacing ? request.replacement : undefined, request.regex ?? false);
    let query: Query = { table: request.table, offset: 0, limit: 200 };
    let selected: Map<string, Set<string>> | undefined; let selectedRows: Row[] | undefined;
    if (request.scope?.type === 'selection') {
      const scope = request.scope;
      if (!Array.isArray(scope.cells) || !scope.cells.length || scope.cells.length > 10000) throw new Error('Select between 1 and 10,000 cells.');
      const snapshot = this.searches.page(scope.snapshot);
      if (snapshot.schema !== info.schema) throw new Error('The database structure changed. Refresh and run the search again.');
      if (snapshot.query.table !== request.table) throw new Error('Select cells from the current table.');
      selected = new Map(); const rows = new Map(snapshot.rows.map(row => [row.key, row]));
      for (const cell of scope.cells) {
        if (!cell || !rows.has(cell.key) || !info.table.columns.some(column => column.name === cell.column)) throw new Error('The selected cells are unavailable. Reload the page and select them again.');
        const columns = selected.get(cell.key) ?? new Set<string>(); columns.add(cell.column); selected.set(cell.key, columns);
      }
      const current = await this.page(snapshot.query);
      if (!same(current.rows, snapshot.rows)) throw new Error('The selected page changed. Reload it and select the cells again.');
      query = snapshot.query; selectedRows = snapshot.rows;
    } else if (request.scope?.type !== 'table') throw new Error('Choose Table or Selection as the search scope.');
    const source = this.source(info, true); const pending = this.pendingIndex(info.table.name);
    const edits: Edit[] = []; const originals = new Map<string, Value[]>(); const samples: SearchHit[] = []; const matches: SearchMatch[] = [];
    let count = 0; let scanned = 0; let bytes = 0; let sampleBytes = 0;
    const fingerprint = createHash('sha256'); const deadline = Date.now() + 5000;
    const visit = (row: Row, offset: number): void => {
      let cost: number | undefined; let rowFingerprint: string | undefined;
      for (const [index, column] of info.table.columns.entries()) {
        if (Date.now() > deadline) throw new Error('Search exceeded five seconds. Search a smaller selection.');
        if (request.column !== undefined && request.column !== column.name || selected && !selected.get(row.key)?.has(column.name)) continue;
        const value = row.values[index]!;
        if (replacing && (column.generated || value.type !== 'text')) continue;
        const matched = matcher.match(value); if (!matched) continue; count++;
        rowFingerprint ??= createHash('sha256').update(JSON.stringify([row.key, row.values])).digest('hex');
        fingerprint.update(JSON.stringify([rowFingerprint, column.name, matched.after]));
        cost ??= Buffer.byteLength(JSON.stringify(row));
        if (samples.length < 1000 && sampleBytes + cost < 4 * 1024 * 1024) { sampleBytes += cost; matches.push({ row, column: column.name, offset }); samples.push({ key: row.key, column: column.name, before: matched.before.slice(0, 4096), after: matched.after.slice(0, 4096), type: value.type, offset }); }
        if (!replacing || matched.after === matched.before) continue;
        if (edits.length >= 10000) throw new Error('Replace at most 10,000 cells at a time. Narrow the selection or choose one column.');
        edits.push({ kind: 'update', table: request.table, key: row.key, column: column.name, value: { type: 'text', value: matched.after } });
        if (!pending.has(row.key)) originals.set(JSON.stringify([request.table, row.key]), row.values);
      }
    };
    if (selectedRows) selectedRows.forEach((row, index) => visit(row, query.offset + index));
    else await this.readQuery(() => this.scan(`WITH data AS (${source.sql}) SELECT __key, ${this.projection(info)} FROM data${this.queryParts(query, info).order} LIMIT 100001`, source.params, record => {
      scanned++; bytes += Buffer.byteLength(JSON.stringify(record));
      if (scanned > 100000 || bytes > 16 * 1024 * 1024) throw new Error('Search exceeds 100,000 scanned records or 16 MiB. Search a selection instead.');
      visit(this.decode(info, record, scanned - 1, pending), scanned - 1);
    }), true);
    const digest = fingerprint.digest('hex');
    const signature = JSON.stringify({ schema: info.schema, table: request.table, scope: request.scope, column: request.column, search: request.search, replacement: request.replacement, matchCase: request.matchCase, regex: request.regex ?? false, replacing });
    if (mode === 'replaceApply') this.searches.validatePreview(request.preview, digest, signature);
    if (mode === 'replaceApply' && edits.length) {
      const observed = this.observed; const observedBytes = this.observedBytes; this.observed = new Map([...observed, ...originals]);
      try { await this.edit(edits); } finally { this.observed = observed; this.observedBytes = observedBytes; }
    }
    return this.searches.rememberResults(query, matches, count, mode === 'replaceApply' ? edits.length : 0, samples, digest, signature, info.schema);
  }

  private async assertSearchSchema(info: TableInfo): Promise<void> {
    const current = Number((await this.all('PRAGMA schema_version'))[0]?.schema_version);
    if (current !== JSON.parse(info.schema).schemaVersion) throw new Error('The database structure changed. Refresh and run the search again.');
  }

  async searchLocate(token: string, key: string, column: string, limit: number): Promise<SearchLocation> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Pages support between 1 and 500 records.');
    const { query, match, schema } = this.searches.result(token, key, column);
    const info = this.info(query.table); await this.assertSearchSchema(info);
    if (info.schema !== schema || !info.table.columns.some(field => field.name === column)) throw new Error('The database structure changed. Refresh and run the search again.');
    const target = { ...query, limit, offset: Math.floor(match.offset / limit) * limit };
    const page = await this.page(target); const row = match.offset - target.offset; const current = page.rows[row];
    if (!current || current.key !== match.row.key || !same(current.values, match.row.values)) throw new Error('This search result changed. Run the search again before navigating.');
    return { query: target, page, row, column };
  }

  /** Resolve relationships against SQLite's parent-column affinity and collation, then show its staged overlay. */
  async foreignRecord(table: string, key: string, foreignKey: number): Promise<RelatedRecord> {
    if (typeof key !== 'string' || !Number.isSafeInteger(foreignKey)) throw new Error('Choose a valid foreign key relationship.');
    const child = this.info(table);
    type ForeignKey = { id: number; seq: number; table: string; from: string; to: string | null };
    const fields = (child.table.foreignKeys as ForeignKey[]).filter(field => field.id === foreignKey).sort((a, b) => a.seq - b.seq);
    if (!fields.length) throw new Error('This foreign key relationship is unavailable.');
    const parent = this.info(fields[0]!.table); const primary = parent.table.columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk);
    return this.readQuery(async () => {
      const source = this.source(child, true);
      const childRecords = await this.all(`WITH data AS (${source.sql}) SELECT __key, ${this.projection(child)} FROM data WHERE __key = ?`, [...source.params, key]);
      if (childRecords.length !== 1) throw new Error('The selected record is unavailable. Reload the table.');
      const row = this.decode(child, childRecords[0]!); const params: unknown[] = [];
      const names: string[] = [];
      const conditions = fields.map(field => {
        const value = row.values[child.table.columns.findIndex(column => column.name === field.from)];
        const name = field.to ?? primary[field.seq]?.name;
        if (!name) throw new Error('The referenced key is unavailable.');
        if (!value || value.type === 'null') throw new Error('A NULL foreign key has no related record.');
        names.push(name);
        let expression: string;
        if (value.type === 'blob') { params.push(Buffer.from(value.value, 'hex')); expression = '?'; }
        else expression = this.valueSql(value, params);
        return `${quote(name)} = ${expression}`;
      });
      // The physical parent column stays on the left: SQLite applies its declared affinity and collation.
      const matches = await this.all(`SELECT ${this.keyExpression(parent)} AS __key FROM ${quote(parent.table.name)} WHERE ${conditions.join(' AND ')} LIMIT 2`, params);
      if (matches.length !== 1) throw new Error('No committed related record was found. Save changes to the referenced table and try again.');
      const parentSource = this.source(parent, true);
      const records = await this.all(`WITH data AS (${parentSource.sql}) SELECT __key, ${this.projection(parent)} FROM data WHERE __key = ?`, [...parentSource.params, matches[0]!.__key]);
      if (records.length !== 1) throw new Error('The related record is pending deletion. Undo the deletion or save your changes.');
      const current = this.decode(parent, records[0]!);
      return { table: parent.table.name, filters: names.map(name => ({ column: name, mode: 'values' as const, values: [current.values[parent.table.columns.findIndex(column => column.name === name)]!] })) };
    }, true);
  }

  async maintenance(operation: 'check' | 'vacuum'): Promise<DatabaseReport> {
    if (!['check', 'vacuum'].includes(operation)) throw new Error('Choose a database maintenance operation.');
    if (operation === 'vacuum') {
      if (this.readOnly) throw new Error('Database is read-only.');
      if (this.pending.length) throw new Error('Save or discard pending edits before vacuuming.');
      await this.readQuery(() => this.run('VACUUM'));
      await this.discard(); await this.refresh();
    }
    return this.readQuery(async () => {
      const integrity = (await this.all('PRAGMA integrity_check')).map(row => String(Object.values(row)[0]));
      const foreignKeys = await this.all('SELECT \"table\", CAST(rowid AS TEXT) AS rowid, parent, fkid FROM pragma_foreign_key_check');
      const pageCount = Number((await this.all('PRAGMA page_count'))[0]?.page_count);
      const pageSize = Number((await this.all('PRAGMA page_size'))[0]?.page_size);
      const freePages = Number((await this.all('PRAGMA freelist_count'))[0]?.freelist_count);
      return { integrity, foreignKeys, pageCount, pageSize, freePages, bytes: pageCount * pageSize };
    }, true);
  }

  async exportCsv(query: Query): Promise<string> {
    const info = this.info(query.table); const source = this.source(info, true); const parts = this.queryParts(query, info);
    const escape = (value: string): string => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const lines = [info.table.columns.map(column => escape(column.name)).join(',')];
    let bytes = Buffer.byteLength(lines[0]!); let candidates = 0; let candidateBytes = 0; let matching = 0;
    const test = this.regexMatcher(parts.regex, info); const pending = this.pendingIndex(info.table.name);
    await this.readQuery(() => this.scan(`WITH data AS (${source.sql}) SELECT __key, ${this.projection(info)} FROM data${parts.where}${parts.order} LIMIT 100001`, [...source.params, ...parts.params], record => {
      candidates++;
      if (parts.regex.length) {
        candidateBytes += Buffer.byteLength(JSON.stringify(record));
        if (candidates > 100000 || candidateBytes > 16 * 1024 * 1024) throw new Error('Regular expression scan exceeds 100,000 candidate rows or 16 MiB. Add another column filter to narrow the scan.');
        if (!test(record)) return;
      }
      matching++;
      const row = this.decode(info, record, matching - 1, pending);
      const line = row.values.map(value => escape(value.type === 'null' ? '' : value.type === 'blob' ? `X'${value.value}'` : value.value)).join(',');
      bytes += Buffer.byteLength(line) + 2;
      if (bytes > MAX_BYTES || matching > 100000) throw new Error('CSV export exceeds 100,000 records or 8 MiB. Apply a filter and export again.');
      lines.push(line);
    }), Boolean(query.filters?.some(filter => filter.mode === 'custom')));
    return `${lines.join('\r\n')}\r\n`;
  }

  async backup(path: string): Promise<void> {
    const source = await realpath(this.path);
    const target = join(await realpath(dirname(resolve(path))), basename(path));
    if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(target)) throw new Error('Choose a different file for the database backup.');
    const destination = await open(path, 'wx');
    await destination.close();
    try {
      await new Promise<void>((done, fail) => {
        const backup = (this.db as BackupDatabase).backup(path, error => {
          if (error) { backup.finish(() => fail(error)); return; }
          backup.step(-1, stepError => backup.finish(finishError => stepError || finishError ? fail(stepError ?? finishError) : done()));
        });
      });
    } catch (error) { await unlink(path).catch(() => undefined); throw error; }
  }

  recovery(): string { return JSON.stringify({ version: 1, path: this.path, schemas: [...this.tables].map(([name, info]) => [name, info.schema]), pending: this.pending }); }

  async restore(serialized: string): Promise<void> {
    if (Buffer.byteLength(serialized) > MAX_BYTES * 2) throw new Error('Recovery data exceeds the supported size.');
    const data = JSON.parse(serialized) as { version: number; path: string; schemas: [string, string][]; pending: Pending[] };
    if (data.version !== 1 || !Array.isArray(data.pending) || data.pending.length > 10000) throw new Error('The recovery data does not belong to this database.');
    for (const change of data.pending) {
      const info = this.info(change.table);
      if (change.schema !== info.schema || !info.table.editable || typeof change.key !== 'string' || typeof change.deleted !== 'boolean') throw new Error('The database structure changed. Recovery cannot be applied safely.');
      if (change.original && (!Array.isArray(change.original) || change.original.length !== info.table.columns.length)) throw new Error('Invalid recovery record.');
      for (const [name, value] of Object.entries(change.values)) { this.writableColumn(info, name); this.validateValue(value); }
    }
    this.pending = structuredClone(data.pending); this.history = []; this.future = [];
  }

  async close(): Promise<void> { await new Promise<void>((done, fail) => this.db.close(error => error ? fail(error) : done())); }
}

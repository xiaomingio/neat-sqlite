/*
Purpose: Execute bounded, lossless SQL reads on an isolated read-only connection and validate single statements.
*/
import sqlite3 from 'sqlite3';
import type { SqlResult, Value } from './protocol';

/** SQLite quoting rules, including comment and string boundaries, determine statement boundaries. */
export function singleStatement(input: string): { sql: string; words: string[] } {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 1024 * 1024) throw new Error('Enter SQL of at most 1 MiB.');
  let sql = ''; let ended = false; let index = 0; const words: string[] = [];
  while (index < input.length) {
    const char = input[index]!; const next = input[index + 1];
    if (/\s/.test(char)) { sql += char; index++; continue; }
    if (char === '-' && next === '-') { const end = input.indexOf('\n', index + 2); index = end < 0 ? input.length : end; sql += ' '; continue; }
    if (char === '/' && next === '*') { const end = input.indexOf('*/', index + 2); if (end < 0) throw new Error('Close the SQL comment.'); index = end + 2; sql += ' '; continue; }
    if (char === ';') { ended = true; index++; continue; }
    if (ended) throw new Error('Run one SQL statement at a time.');
    if (['\'', '"', '`', '['].includes(char)) {
      const close = char === '[' ? ']' : char; let value = char; let closed = false; index++;
      while (index < input.length) { const current = input[index++]!; value += current; if (current === close) { if (char !== '[' && input[index] === close) { value += input[index++]; } else { closed = true; break; } } }
      if (!closed) throw new Error('Close the quoted SQL value or identifier.'); sql += value; continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(input.slice(index));
    if (word) { words.push(word[0].toUpperCase()); sql += word[0]; index += word[0].length; } else { sql += char; index++; }
  }
  if (!sql.trim()) throw new Error('Enter a SQL statement.');
  return { sql: sql.trim(), words };
}
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export class SqlQuery {
  private connection?: sqlite3.Database;
  private cancelled = false;
  cancel(): void { this.cancelled = true; this.connection?.interrupt(); }
  async execute(path: string, input: string, limit = 1000): Promise<SqlResult> {
    const { sql, words } = singleStatement(input);
    if (!['SELECT', 'WITH', 'VALUES'].includes(words[0]!)) throw new Error('Use SELECT, WITH, or VALUES in the query editor. Use Execute write for changes.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Choose a result limit between 1 and 10,000 rows.');
    const started = Date.now();
    const db = await new Promise<sqlite3.Database>((resolve, reject) => { const connection = new sqlite3.Database(path, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection)); });
    this.connection = db;
    const run = (statement: string): Promise<void> => new Promise((resolve, reject) => db.run(statement, error => error ? reject(error) : resolve()));
    const all = <T>(statement: string): Promise<T[]> => new Promise((resolve, reject) => db.all(statement, (error, rows: T[]) => error ? reject(error) : resolve(rows)));
    const timer = setTimeout(() => db.interrupt(), 5000);
    try {
      if (this.cancelled) throw new Error('Query cancelled.');
      db.configure('busyTimeout', 1500); db.configure('limit', sqlite3.LIMIT_LENGTH, 8 * 1024 * 1024);
      await run('PRAGMA trusted_schema = OFF');
      // SQLite parses the query as a view body, preventing writes and exposing every result column even for zero rows.
      await run(`CREATE TEMP VIEW __neat_query AS ${sql}`);
      const fields = await all<{ name: string }>('PRAGMA temp.table_info(__neat_query)');
      if (!fields.length || fields.length > 1000) throw new Error('Queries support between 1 and 1,000 result columns.');
      await run('PRAGMA query_only = ON');
      const projection = fields.map(({ name }, index) => `typeof(${quote(name)}) AS t${index}, CASE WHEN typeof(${quote(name)})='blob' THEN hex(${quote(name)}) WHEN typeof(${quote(name)})='real' THEN printf('%!.17g',${quote(name)}) ELSE CAST(${quote(name)} AS TEXT) END AS v${index}`).join(',');
      const rows: Value[][] = []; let bytes = 0; let failure: Error | undefined;
      await new Promise<void>((resolve, reject) => db.each(`WITH __neat_result AS MATERIALIZED (SELECT * FROM __neat_query LIMIT ${limit + 1}) SELECT ${projection} FROM __neat_result`, (error: Error | null, record: Record<string, string | null>) => {
        if (failure) return;
        if (error) { failure = error; return; }
        const row = fields.map((_, index) => ({ type: record[`t${index}`] as Value['type'], value: record[`v${index}`] ?? '' }));
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > 8 * 1024 * 1024) { failure = new Error('Query results exceed 8 MiB. Reduce the result limit or select fewer columns.'); db.interrupt(); return; }
        rows.push(row);
      }, (error: Error | null) => error || failure ? reject(failure ?? error) : resolve()));
      return { columns: fields.map(field => field.name), rows: rows.slice(0, limit), elapsedMs: Date.now() - started, truncated: rows.length > limit };
    } catch (error) {
      if (this.cancelled) throw new Error('Query cancelled.');
      if (Date.now() - started >= 4900) throw new Error('Query exceeded the 5 second limit. Narrow the query and try again.');
      throw error;
    } finally { clearTimeout(timer); this.connection = undefined; await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
  }
  static csv(result: SqlResult): string {
    const escape = (value: string): string => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    return [result.columns.map(escape).join(','), ...result.rows.map(row => row.map(value => escape(value.type === 'null' ? '' : value.type === 'blob' ? `X'${value.value}'` : value.value)).join(','))].join('\r\n') + '\r\n';
  }
}

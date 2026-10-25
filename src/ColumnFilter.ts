/*
Purpose: Compile column filter builders and safe SQL previews from one shared contract.
*/
import type { ColumnFilter, Value } from './protocol';
export type CompiledFilters = { sql: string; params: unknown[]; preview: string; regex: { column: string; text: string }[] };
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const literal = (value: string): string => {
  const parts = value.split(/([\u0000-\u001f\u007f]+)/).filter(Boolean).map(part => /^[\u0000-\u001f\u007f]/.test(part)
    ? `char(${Array.from(part, char => char.codePointAt(0)).join(',')})`
    : `'${part.replaceAll("'", "''")}'`);
  return parts.length > 1 ? `(${parts.join('||')})` : parts[0] ?? "''";
};
const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const whitespaceSql = `char(${Array.from(whitespace, char => char.codePointAt(0)).join(',')})`;

export function compactSqlExpression(sql: string): string {
  let result = ''; let space = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (/[ \t\r\n\f\v]/.test(char)) { space = true; continue; }
    if (space && result) result += ' ';
    space = false; result += char;
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const end = char === '[' ? ']' : char;
      while (++index < sql.length) {
        result += sql[index];
        if (sql[index] === end) {
          if (end !== ']' && sql[index + 1] === end) { result += sql[++index]; continue; }
          break;
        }
      }
    }
  }
  return result;
}

export function validateCustomExpression(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 4096) throw new Error('Enter a WHERE expression of at most 4,096 characters.');
  let depth = 0;
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const end = char === '[' ? ']' : char; let token = ''; let closed = false; index++;
      while (index < sql.length) {
        if (sql[index] === end) {
          if (end !== ']' && sql[index + 1] === end) { token += end; index += 2; continue; }
          index++; closed = true; break;
        }
        token += sql[index++];
      }
      if (!closed) throw new Error('Close every SQL quote.');
      if (char !== "'" && /^\s*\(/.test(sql.slice(index)) && /^(load_extension|readfile|writefile|eval|fts3_tokenizer)$/i.test(token)) throw new Error('This SQL function is unavailable in filters.');
      continue;
    }
    if (char === ';' || char === '?' || char === ':' || char === '@' || char === '$' || sql.slice(index, index + 2) === '--' || sql.slice(index, index + 2) === '/*') throw new Error('Use one WHERE expression without statements, comments, or parameters.');
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) throw new Error('Balance the SQL parentheses.');
    if (/[A-Za-z_]/.test(char)) {
      const token = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(index))![0]; index += token.length;
      if (/^in$/i.test(token) && !/^\s*\(/.test(sql.slice(index))) throw new Error('Use IN with a parenthesized value list. Other tables are unavailable in filters.');
      if (/^(select|with|insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension|readfile|writefile|eval|fts3_tokenizer)$/i.test(token)) throw new Error('Use a WHERE expression over the current table. SQL statements and external access are unavailable.');
      continue;
    }
    index++;
  }
  if (depth) throw new Error('Balance the SQL parentheses.');
}

export function compileFilters(filters: ColumnFilter[] | undefined, columns: string[], table?: string, references?: string[]): CompiledFilters {
  if (filters !== undefined && (!Array.isArray(filters) || filters.length > 100)) throw new Error('Use at most 100 column filters.');
  if (JSON.stringify(filters ?? []).length > 1024 * 1024) throw new Error('Column filters exceed the 1 MiB limit.');
  const params: unknown[] = []; const clauses: string[] = []; const previews: string[] = []; const regex: CompiledFilters['regex'] = [];
  const seen = new Set<string>();
  const add = (sql: string, preview: string): void => { clauses.push(`(${sql})`); previews.push(`(${preview})`); };
  const typed = (value: Value): { sql: string; preview: string } => {
    if (!value || typeof value.value !== 'string' || !['null', 'integer', 'real', 'text', 'blob'].includes(value.type)) throw new Error('Choose valid typed values.');
    if (value.type === 'null') return { sql: 'NULL', preview: 'NULL' };
    if (value.type === 'blob') {
      if (!/^(?:[a-fA-F0-9]{2})*$/.test(value.value)) throw new Error('Invalid binary filter value.');
      // Hex text avoids Node Buffer in the browser-shared compiler.
      params.push(value.value.toUpperCase()); return { sql: '?', preview: literal(value.value.toUpperCase()) };
    }
    if (value.type === 'integer' && (!/^[+-]?\d+$/.test(value.value) || BigInt(value.value) < -(1n << 63n) || BigInt(value.value) >= 1n << 63n)) throw new Error('Enter a signed 64-bit integer.');
    if (value.type === 'real' && (!decimal.test(value.value.trim()) || !Number.isFinite(Number(value.value)))) throw new Error('Enter a finite decimal number.');
    params.push(value.value);
    const cast = value.type === 'integer' ? 'INTEGER' : value.type === 'real' ? 'REAL' : undefined;
    return { sql: cast ? `CAST(? AS ${cast})` : '?', preview: cast ? `CAST(${literal(value.value)} AS ${cast})` : literal(value.value) };
  };
  const number = (value: string): { sql: string; preview: string } => {
    if (typeof value !== 'string' || !decimal.test(value.trim()) || !Number.isFinite(Number(value))) throw new Error('Enter a finite decimal number.');
    const normalized = value.trim();
    const integer = /^[+-]?\d+$/.test(normalized) && BigInt(normalized) >= -(1n << 63n) && BigInt(normalized) < 1n << 63n;
    return typed({ type: integer ? 'integer' : 'real', value: normalized });
  };
  for (const filter of filters ?? []) {
    if (!filter || typeof filter.column !== 'string') throw new Error('Choose a valid filter column.');
    const index = columns.indexOf(filter.column);
    if (index < 0 || seen.has(filter.column)) throw new Error('Choose one filter per valid column.');
    seen.add(filter.column);
    const column = references?.[index] ?? quoteIdentifier(filter.column); const display = quoteIdentifier(filter.column);
    switch (filter.mode) {
      case 'text': {
        if (typeof filter.text !== 'string' || filter.text.length > 65536) throw new Error('Text filters support at most 65,536 characters.');
        params.push(filter.text); add(`instr(lower(CAST(${column} AS TEXT)), lower(?)) > 0`, `instr(lower(CAST(${display} AS TEXT)), lower(${literal(filter.text)})) > 0`); break;
      }
      case 'regex':
        if (typeof filter.text !== 'string' || filter.text.length > 1024) throw new Error('Regular expressions support at most 1,024 characters.');
        regex.push({ column: filter.column, text: filter.text }); break;
      case 'empty': case 'notEmpty': {
        const empty = `${column} IS NULL OR (typeof(${column})='text' AND trim(${column},${whitespaceSql})='')`;
        const preview = `${display} IS NULL OR (typeof(${display})='text' AND trim(${display},${whitespaceSql})='')`;
        add(filter.mode === 'empty' ? empty : `NOT (${empty})`, filter.mode === 'empty' ? preview : `NOT (${preview})`); break;
      }
      case 'values': {
        if (!Array.isArray(filter.values) || filter.values.length > 1000) throw new Error('Choose at most 1,000 distinct values.');
        const terms: string[] = []; const shown: string[] = [];
        for (const value of filter.values) {
          const term = typed(value); const left = value.type === 'blob' ? `hex(${column})` : column; const shownLeft = value.type === 'blob' ? `hex(${display})` : display;
          terms.push(`(typeof(${column})=${literal(value.type)} AND ${left} COLLATE BINARY IS ${term.sql})`); shown.push(`(typeof(${display})=${literal(value.type)} AND ${shownLeft} COLLATE BINARY IS ${term.preview})`);
        }
        add(terms.join(' OR ') || '0', shown.join(' OR ') || '0'); break;
      }
      case 'number': {
        const operators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
        const lower = number(filter.value); let condition: string; let shown: string;
        if (filter.operator === 'between') {
          const upper = number(filter.max ?? ''); condition = `${column} BETWEEN ${lower.sql} AND ${upper.sql}`; shown = `${display} BETWEEN ${lower.preview} AND ${upper.preview}`;
        } else {
          const operator = Object.hasOwn(operators, filter.operator) ? operators[filter.operator] : undefined; if (!operator) throw new Error('Choose a numeric comparison.');
          condition = `${column} ${operator} ${lower.sql}`; shown = `${display} ${operator} ${lower.preview}`;
        }
        add(`typeof(${column}) IN ('integer','real') AND ${condition}`, `typeof(${display}) IN ('integer','real') AND ${shown}`); break;
      }
      case 'custom': {
        validateCustomExpression(filter.sql);
        const condition = compactSqlExpression(filter.sql);
        const projection = columns.map((name, position) => `${references?.[position] ?? quoteIdentifier(name)} AS ${quoteIdentifier(name)}`).join(',');
        const execution = references ? `EXISTS (SELECT 1 FROM (SELECT ${projection}) AS ${quoteIdentifier(table ?? 'current_table')} WHERE (${condition}))` : condition;
        add(execution, condition); break;
      }
      default: throw new Error('Choose a valid filter mode.');
    }
  }
  const note = regex.length ? ' /* Regular expressions are evaluated by RE2 after SQLite filtering. */' : '';
  return { sql: clauses.join(' AND ') || '1', params, preview: (previews.join(' AND ') || '1') + note, regex };
}

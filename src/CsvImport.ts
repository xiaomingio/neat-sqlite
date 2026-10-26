/*
Purpose: Parse standard CSV with explicit field mapping, storage types, NULL markers and omitted defaults.
*/
import { parse } from 'csv-parse/sync';
import type { CsvMapping, CsvPreview, Value } from './protocol';
export class CsvImport {
  readonly headers: string[];
  readonly rows: string[][];
  constructor(text: string) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Import CSV files of at most 8 MiB.');
    let count = 0;
    const records = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 8 * 1024 * 1024, on_record: (record: string[]) => {
      if (++count > 10001) throw new Error('Import at most 10,000 records at a time.');
      if (record.length > 1000) throw new Error('Import at most 1,000 CSV columns.');
      return record;
    } }) as string[][];
    if (!records.length || !records[0]!.length) throw new Error('CSV needs a header row.');
    this.headers = records.shift()!; this.rows = records;
    if (this.rows.length > 10000) throw new Error('Import at most 10,000 records at a time.');
  }
  preview(): CsvPreview { return { headers: this.headers, rows: this.rows.slice(0, 20), total: this.rows.length }; }
  values(mapping: CsvMapping[], nullToken?: string): Record<string, Value>[] {
    if (!Array.isArray(mapping) || !mapping.length) throw new Error('Map at least one CSV column.');
    const used = new Set<string>();
    for (const entry of mapping) {
      if (!Number.isInteger(entry.source) || entry.source < 0 || entry.source >= this.headers.length || typeof entry.column !== 'string' || used.has(entry.column) || !['auto', 'text', 'integer', 'real'].includes(entry.type) || !['text', 'null', 'default'].includes(entry.empty)) throw new Error('Choose valid, unique destination columns and CSV types.');
      used.add(entry.column);
    }
    return this.rows.map(row => {
      const values: Record<string, Value> = Object.create(null);
      for (const entry of mapping) {
        const value = row[entry.source]!;
        if (value === '' && entry.empty === 'default') continue;
        if (value === '' && entry.empty === 'text' && value !== nullToken) { values[entry.column] = { type: 'text', value: '' }; continue; }
        if (nullToken !== undefined && value === nullToken || value === '' && entry.empty === 'null') { values[entry.column] = { type: 'null', value: '' }; continue; }
        let type: Value['type'] = entry.type === 'auto' ? 'text' : entry.type;
        if (entry.type === 'auto') {
          if (/^[+-]?\d+$/.test(value)) { if (BigInt(value) >= -(1n << 63n) && BigInt(value) < 1n << 63n) type = 'integer'; }
          else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) type = 'real';
        }
        values[entry.column] = { type, value };
      }
      return values;
    });
  }
}

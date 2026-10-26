/*
Purpose: Match scalar cells literally or with RE2 and retain bounded server-owned page and search snapshots for exact navigation.
*/
import { RegexReplacement } from './RegexReplacement';
import { RE2JS } from 're2js';
import { randomUUID } from 'node:crypto';
import type { Page, Query, Row, SearchHit, SearchResult, Value } from './protocol';
type PageSnapshot = { query: Query; rows: Row[]; bytes: number; schema: string };
export type SearchMatch = { row: Row; column: string; offset: number };
type SearchSnapshot = { query: Query; matches: SearchMatch[]; bytes: number; fingerprint: string; signature: string; schema: string };
const MAX_CACHE = 16 * 1024 * 1024;
export class CellSearch {
  private readonly pages = new Map<string, PageSnapshot>();
  private readonly results = new Map<string, SearchSnapshot>();
  private readonly pattern: RE2JS;
  private readonly deadline = Date.now() + 5000;
  constructor(search: string, matchCase: boolean, readonly replacement?: string, readonly regex = false) {
    if (typeof search !== 'string' || !search.length || search.length > 65536 || typeof matchCase !== 'boolean' || typeof regex !== 'boolean' || replacement !== undefined && (typeof replacement !== 'string' || replacement.length > 65536)) throw new Error('Enter search and replacement text of at most 65,536 characters.');
    if (regex && search.length > 4096) throw new Error('Regular expressions support patterns of at most 4,096 characters.');
    this.pattern = RE2JS.compile(regex ? search : RE2JS.quote(search), matchCase ? 0 : RE2JS.CASE_INSENSITIVE);
  }
  match(value: Value): { before: string; after: string } | undefined {
    if (!['text', 'integer', 'real'].includes(value.type)) return;
    if (this.regex && Buffer.byteLength(value.value) > 65536) throw new Error('Regular expressions support values of at most 65,536 bytes. Choose another column or selection.');
    const matcher = this.pattern.matcher(value.value);
    if (!matcher.find()) return;
    if (this.replacement === undefined) return { before: value.value, after: value.value };
    let bytes = Buffer.byteLength(value.value);
    do {
      if (Date.now() > this.deadline) throw new Error('Search exceeded five seconds. Search a smaller selection.');
      bytes += (this.regex ? RegexReplacement.measure(matcher, value.value, this.replacement, 8 * 1024 * 1024) : Buffer.byteLength(this.replacement)) - Buffer.byteLength(matcher.group() ?? '');
      if (bytes > 8 * 1024 * 1024) throw new Error('A replaced value exceeds 8 MiB. Narrow the replacement.');
    } while (matcher.find());
    const after = matcher.replaceAll(this.regex ? this.replacement : RE2JS.quoteReplacement(this.replacement));
    return { before: value.value, after };
  }
  rememberPage(query: Query, page: Page, schema: string): void {
    const token = randomUUID(); page.snapshot = token;
    const rows = structuredClone(page.rows); this.pages.set(token, { query: structuredClone(query), rows, bytes: Buffer.byteLength(JSON.stringify(rows)), schema });
    this.trim(this.pages, 8);
  }
  page(token: string): PageSnapshot {
    const snapshot = this.pages.get(token);
    if (!snapshot) throw new Error('The selected page has expired. Reload it and select the cells again.');
    return snapshot;
  }
  rememberResults(query: Query, matches: SearchMatch[], count: number, changes: number, samples: SearchHit[], fingerprint: string, signature: string, schema: string): SearchResult {
    const token = randomUUID(); const bytes = Buffer.byteLength(JSON.stringify(matches));
    this.results.set(token, { query: structuredClone(query), matches: structuredClone(matches), bytes, fingerprint, signature, schema }); this.trim(this.results, 4);
    return { token, count, changes, samples, truncated: count > samples.length };
  }
  validatePreview(token: string | undefined, fingerprint: string, signature: string): void {
    const preview = token ? this.results.get(token) : undefined;
    if (!preview || preview.signature !== signature || preview.fingerprint !== fingerprint) throw new Error('The replacement or matching cells changed. Preview it again before applying.');
  }
  result(token: string, key: string, column: string): { query: Query; match: SearchMatch; schema: string } {
    const snapshot = this.results.get(token); const match = snapshot?.matches.find(match => match.row.key === key && match.column === column);
    if (!snapshot || !match) throw new Error('These search results have expired. Run the search again.');
    return { query: snapshot.query, match, schema: snapshot.schema };
  }
  private trim<T extends { bytes: number }>(cache: Map<string, T>, limit: number): void {
    let bytes = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (cache.size > 1 && (cache.size > limit || bytes > MAX_CACHE)) { const key = cache.keys().next().value!; bytes -= cache.get(key)!.bytes; cache.delete(key); }
  }
}

/*
Purpose: Search and replace SQL editor text with captured ranges, bounded matching and native editor undo.
*/
import { SearchCursor } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { EditorSelection } from '@codemirror/state';
import { RE2JS } from 're2js';
import { RegexReplacement } from '../RegexReplacement';
import type { SearchHit, SearchResult } from '../protocol';
export type SqlSearchOptions = { scope: 'table' | 'selection'; search: string; replacement?: string; matchCase: boolean; regex: boolean };
type Match = { from: number; to: number; insert: string; hit: SearchHit };
export class SqlTextSearch {
  private selection: EditorSelection;
  private selectionDoc: string;
  private readonly scrollTop: number;
  private cached?: { token: string; doc: string; signature: string; matches: Match[] };
  private sequence = 0;
  constructor(private readonly view: EditorView) { this.selection = view.state.selection; this.selectionDoc = view.state.doc.toString(); this.scrollTop = view.scrollDOM.scrollTop; }
  get selectionSize(): number { return this.selection.ranges.reduce((count, range) => count + range.to - range.from, 0); }
  async search(options: SqlSearchOptions): Promise<SearchResult> {
    const state = this.view.state; const source = state.doc.toString(); const bytes = (text: string) => new TextEncoder().encode(text).byteLength; if (bytes(source) > 1024 * 1024) throw new Error('SQL text search supports at most 1 MiB.'); if (options.search.length > (options.regex ? 4096 : 65536) || (options.replacement?.length ?? 0) > 65536) throw new Error('Search or replacement text exceeds the size limit.'); if (!options.search) throw new Error('Enter search text.'); if (options.scope === 'selection' && source !== this.selectionDoc) throw new Error('The SQL selection changed. Reopen Find to capture it again.');
    const ranges = options.scope === 'selection' ? this.selection.ranges.filter(range => !range.empty).map(range => ({ from: range.from, to: range.to })) : [{ from: 0, to: source.length }]; if (!ranges.length) throw new Error('Select SQL text or choose Whole query.');
    const matches: Match[] = []; const started = Date.now(); let outputBytes = bytes(source);
    const add = (from: number, to: number, insert: string) => { if (matches.length >= 10000 || Date.now() - started > 5000) throw new Error('SQL text search exceeds 10,000 matches or 5 seconds. Narrow the selection.'); const before = source.slice(from, to); outputBytes += bytes(insert) - bytes(before); if (outputBytes > 1024 * 1024) throw new Error('The replaced SQL text exceeds 1 MiB. Narrow the replacement.'); matches.push({ from, to, insert, hit: { key: `${from}:${to}`, column: 'SQL text', before: before.slice(0, 4096), after: insert.slice(0, 4096), type: 'text', offset: state.doc.lineAt(from).number - 1 } }); };
    const pattern = options.regex ? RE2JS.compile(options.search, options.matchCase ? 0 : RE2JS.CASE_INSENSITIVE) : undefined;
    for (const range of ranges) {
      if (pattern) { const text = source.slice(range.from, range.to); const matcher = pattern.matcher(text); while (matcher.find()) { const from = matcher.start(); const to = matcher.end(); const insert = options.replacement === undefined ? matcher.group() ?? '' : RegexReplacement.expand(matcher, text, options.replacement, Math.max(0, 1024 * 1024 - outputBytes + bytes(matcher.group() ?? ''))); add(range.from + from, range.from + to, insert); } }
      else { const cursor = new SearchCursor(state.doc, options.search, range.from, range.to, options.matchCase ? undefined : text => text.toLocaleLowerCase()); while (!cursor.next().done) add(cursor.value.from, cursor.value.to, options.replacement ?? source.slice(cursor.value.from, cursor.value.to)); }
    }
    const token = `sql-text:${++this.sequence}`; this.cached = { token, doc: source, signature: JSON.stringify(options), matches }; return { count: matches.length, changes: matches.filter(match => source.slice(match.from, match.to) !== match.insert).length, samples: matches.slice(0, 1000).map(match => match.hit), token, truncated: matches.length > 1000 };
  }
  async apply(options: SqlSearchOptions, token: string): Promise<number> {
    const cache = this.cached; if (!cache || cache.token !== token || cache.doc !== this.view.state.doc.toString() || cache.signature !== JSON.stringify(options)) throw new Error('The SQL text or search changed. Preview the replacement again.');
    const changes = cache.matches.filter(match => cache.doc.slice(match.from, match.to) !== match.insert).map(match => ({ from: match.from, to: match.to, insert: match.insert })); const size = cache.doc.length + changes.reduce((size, change) => size + change.insert.length - (change.to - change.from), 0); if (size > 1024 * 1024) throw new Error('The replaced SQL text exceeds 1 MiB. Narrow the replacement.');
    if (changes.length) { const transaction = this.view.state.update({ changes, userEvent: 'input.replace.all' }); this.selection = this.selection.map(transaction.changes); this.view.dispatch(transaction); this.selectionDoc = this.view.state.doc.toString(); } this.cached = undefined; return changes.length;
  }
  async locate(token: string, hit: SearchHit): Promise<void> { const cache = this.cached; if (!cache || cache.token !== token || cache.doc !== this.view.state.doc.toString()) throw new Error('The SQL text changed. Search again.'); const match = cache.matches.find(match => match.hit.key === hit.key); if (!match) throw new Error('The search result is unavailable. Search again.'); this.view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true }); }
  async restore(): Promise<void> { if (this.view.state.doc.toString() !== this.selectionDoc) throw new Error('The SQL text changed. Reopen Find to capture the selection again.'); this.view.dispatch({ selection: this.selection, scrollIntoView: false }); this.view.scrollDOM.scrollTop = this.scrollTop; }
}

/*
Purpose: Build bounded result previews that keep the first match visible and report its highlight range.
*/
import type { SearchHit } from './protocol';
const CONTEXT = 32;
const LIMIT = 4096;
/** `start`/`end` locate the first match in `before`; `after` shares the unchanged prefix, so both use the same window. */
export function searchSnippet(before: string, after: string, start: number, end: number): Pick<SearchHit, 'before' | 'after' | 'match'> {
  const from = start > CONTEXT ? start - CONTEXT : 0; const lead = from ? '…' : '';
  const clip = (text: string) => lead + text.slice(from, from + LIMIT - lead.length);
  const clipped = clip(before); const offset = lead.length - from;
  return { before: clipped, after: clip(after), match: [Math.min(start + offset, clipped.length), Math.min(end + offset, clipped.length)] };
}

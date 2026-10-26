/*
Purpose: Bound and expand JavaScript-style RE2 capture substitutions consistently in host and browser searches.
*/
import type { Matcher } from 're2js';
const encoder = new TextEncoder();
export class RegexReplacement {
  static measure(matcher: Matcher, input: string, replacement: string, maxBytes: number): number {
    let bytes = 0;
    for (const part of this.parts(matcher, input, replacement)) { bytes += encoder.encode(part).byteLength; if (bytes > maxBytes) throw new Error('The replacement exceeds the output size limit. Narrow the replacement.'); }
    return bytes;
  }
  static expand(matcher: Matcher, input: string, replacement: string, maxBytes: number): string {
    const parts: string[] = []; let bytes = 0;
    for (const part of this.parts(matcher, input, replacement)) { bytes += encoder.encode(part).byteLength; if (bytes > maxBytes) throw new Error('The replacement exceeds the output size limit. Narrow the replacement.'); parts.push(part); }
    return parts.join('');
  }
  private static *parts(matcher: Matcher, input: string, replacement: string): Generator<string> {
    let offset = 0;
    for (const token of replacement.matchAll(/\$(\$|&|`|'|<[^>]*>|\d{1,2})/g)) {
      yield replacement.slice(offset, token.index); offset = token.index! + token[0].length;
      const code = token[1]!; let value = token[0];
      if (code === '$') value = '$';
      else if (code === '&') value = matcher.group() ?? '';
      else if (code === '`') value = input.slice(0, matcher.start());
      else if (code === "'") value = input.slice(matcher.end());
      else if (code.startsWith('<')) { const groups = matcher.pattern().namedGroups(); if (Object.keys(groups).length) value = Object.hasOwn(groups, code.slice(1, -1)) ? matcher.group(code.slice(1, -1)) ?? '' : ''; }
      else { const group = Number(code); const first = Number(code[0]); if (group >= 1 && group <= matcher.groupCount()) value = matcher.group(group) ?? ''; else if (code.length === 2 && first >= 1 && first <= matcher.groupCount()) value = (matcher.group(first) ?? '') + code[1]; }
      yield value;
    }
    yield replacement.slice(offset);
  }
}

/*
Purpose: Mark line breaks in compact cell previews while keeping stored and edited values unchanged.
*/
export function singleLineText(value: string): string { return value.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ↵ '); }
/** Generated markers stay out of the DOM text, so copying text retains the original line breaks. */
export function renderCellText(target: HTMLElement, value: string): void {
  target.replaceChildren(); let offset = 0;
  for (const match of value.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) { target.append(document.createTextNode(value.slice(offset, match.index))); const marker = document.createElement('span'); marker.className = 'line-break'; marker.textContent = match[0]; target.append(marker); offset = match.index + match[0].length; }
  target.append(document.createTextNode(value.slice(offset)));
}

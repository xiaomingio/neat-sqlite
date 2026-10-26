/*
Purpose: Provide one consistent stroke icon set for toolbar, header, and panel buttons.
*/
const paths = {
  undo: 'M9 5 4 10l5 5 M4 10h9a6 6 0 0 1 6 6v2',
  redo: 'm15 5 5 5-5 5 M20 10h-9a6 6 0 0 0-6 6v2',
  sun: 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01',
  filter: 'M4 5h16l-6 7v6l-4 2v-8L4 5Z',
  move: 'M7 5h3 M14 5h3 M7 12h3 M14 12h3 M7 19h3 M14 19h3',
  sort: 'M8 5v14m-4-4 4 4 4-4 M16 19V5m-4 4 4-4 4 4',
  ascending: 'M12 19V5m-5 5 5-5 5 5',
  descending: 'M12 5v14m-5-5 5 5 5-5',
  chevronDown: 'm6 9 6 6 6-6',
  more: 'M12 3h.01 M12 12h.01 M12 21h.01',
  chevronUp: 'm6 15 6-6 6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
} as const;
export type IconName = keyof typeof paths;

/** Replace a button's content with a decorative SVG; the button keeps its own accessible name. */
export function setIcon(target: HTMLElement, name: IconName): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon', `icon-${name}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path);
  if (name === 'more') { path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-width', '4.5'); }
  target.replaceChildren(svg);
}

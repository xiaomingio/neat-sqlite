/*
Purpose: Walk through real editor controls with a positioned spotlight and restore the editor on exit.
*/
import { button, element } from './Dialog';
import type { Locale } from './Locale';

export type GuideStep = {
  title: string;
  text: string;
  target: () => HTMLElement;
  enter?: () => void;
  leave?: () => void;
};

export class QuickGuide {
  private readonly dialog = element('dialog', 'quick-guide');
  private readonly spotlight = element('div', 'guide-spotlight');
  private readonly panel = element('section', 'guide-panel');
  private readonly heading = element('h2');
  private readonly body = element('p', 'guide-body');
  private readonly progress = element('span', 'guide-progress');
  private readonly back: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private index = -1;
  private frame?: number;
  private skipped = false;
  private returnFocus?: HTMLElement;
  private readonly scrollers: { node: HTMLElement; left: number; top: number }[];

  constructor(root: HTMLElement, private readonly locale: Locale, private readonly steps: GuideStep[], private readonly restore: () => void) {
    this.scrollers = [...root.querySelectorAll<HTMLElement>('.toolbar, .viewport, .table-list, .cm-scroller')].map(node => ({ node, left: node.scrollLeft, top: node.scrollTop }));
    this.heading.id = 'quick-guide-title'; this.body.id = 'quick-guide-description';
    this.dialog.setAttribute('aria-labelledby', this.heading.id); this.dialog.setAttribute('aria-describedby', this.body.id);
    this.spotlight.setAttribute('aria-hidden', 'true'); this.progress.setAttribute('aria-live', 'polite');
    this.back = button(locale.t('Back'), () => this.go(this.index - 1));
    this.next = button('', () => { if (this.index === steps.length - 1) this.dialog.close(); else this.go(this.index + 1); }, 'primary');
    const footer = element('footer'); footer.append(this.progress, button(locale.t('Skip'), () => { this.skipped = true; this.dialog.close(); }), this.back, this.next);
    const arrow = element('span', 'guide-arrow'); arrow.setAttribute('aria-hidden', 'true');
    this.panel.append(this.heading, this.body, footer, arrow); this.dialog.append(this.spotlight, this.panel); root.append(this.dialog);
    this.dialog.addEventListener('pointerdown', event => { event.stopPropagation(); if (!this.panel.contains(event.target as Node)) event.preventDefault(); });
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.steps[this.index]?.leave?.(); this.restore();
      for (const { node, left, top } of this.scrollers) { node.scrollLeft = left; node.scrollTop = top; }
      this.dialog.remove(); if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
      if (this.skipped) this.showReminder(root);
    });
  }

  get open(): boolean { return this.dialog.open; }

  private showReminder(root: HTMLElement): void {
    const reminder = element('dialog', 'editor-dialog guide-reminder');
    const title = element('h2', '', this.locale.t('Quick guide')); title.id = 'guide-reminder-title';
    const message = element('p', '', this.locale.t('Reopen this guide anytime with the ? button at the top right.')); message.id = 'guide-reminder-description';
    reminder.setAttribute('aria-labelledby', title.id); reminder.setAttribute('aria-describedby', message.id);
    const footer = element('footer'); footer.append(button(this.locale.t('Got it'), () => reminder.close(), 'primary'));
    reminder.append(title, message, footer); root.append(reminder);
    reminder.addEventListener('keydown', event => event.stopPropagation());
    reminder.addEventListener('close', () => { reminder.remove(); if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true }); });
    reminder.showModal();
  }

  show(): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.dialog.showModal(); this.go(0);
    const follow = () => { if (!this.open) return; this.position(); this.frame = requestAnimationFrame(follow); };
    this.frame = requestAnimationFrame(follow);
  }

  private go(index: number): void {
    this.steps[this.index]?.leave?.(); this.index = index;
    const step = this.steps[index]!; step.enter?.();
    this.heading.textContent = this.locale.t(step.title); this.body.textContent = this.locale.t(step.text);
    this.progress.textContent = `${index + 1} / ${this.steps.length}`;
    this.back.disabled = index === 0; this.next.textContent = this.locale.t(index === this.steps.length - 1 ? 'Done' : 'Next');
    step.target().scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    this.position(); this.next.focus({ preventScroll: true });
  }

  private position(): void {
    const rect = this.steps[this.index]!.target().getBoundingClientRect();
    const width = innerWidth, height = innerHeight, margin = 10, gap = 16;
    const target = { left: Math.max(0, rect.left - 4), right: Math.min(width, rect.right + 4), top: Math.max(0, rect.top - 4), bottom: Math.min(height, rect.bottom + 4) };
    Object.assign(this.spotlight.style, { left: `${target.left}px`, top: `${target.top}px`, width: `${Math.max(0, target.right - target.left)}px`, height: `${Math.max(0, target.bottom - target.top)}px` });
    const panel = this.panel.getBoundingClientRect(), x = (target.left + target.right) / 2, y = (target.top + target.bottom) / 2;
    const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
    let side: string, left: number, top: number;
    if (height - target.bottom >= panel.height + gap + margin) {
      side = 'bottom'; left = clamp(x - panel.width / 2, width - panel.width); top = target.bottom + gap;
    } else if (target.top >= panel.height + gap + margin) {
      side = 'top'; left = clamp(x - panel.width / 2, width - panel.width); top = target.top - gap - panel.height;
    } else if (width - target.right >= panel.width + gap + margin) {
      side = 'right'; left = target.right + gap; top = clamp(y - panel.height / 2, height - panel.height);
    } else {
      side = 'left'; left = clamp(target.left - gap - panel.width, width - panel.width); top = clamp(y - panel.height / 2, height - panel.height);
    }
    this.panel.style.left = `${left}px`; this.panel.style.top = `${top}px`; this.panel.dataset.side = side;
    this.panel.style.setProperty('--guide-arrow-x', `${Math.max(18, Math.min(panel.width - 18, x - left))}px`);
    this.panel.style.setProperty('--guide-arrow-y', `${Math.max(18, Math.min(panel.height - 18, y - top))}px`);
  }
}

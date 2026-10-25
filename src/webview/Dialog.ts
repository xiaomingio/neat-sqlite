/*
Purpose: Render keyboard-accessible editor dialogs with inline validation and cancellation.
*/
import type { Locale } from './Locale';
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
export function button(label: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', className, label); node.type = 'button'; node.onclick = action; return node;
}
export class Dialog {
  onClose?: () => void;
  private readonly root = element('dialog', 'editor-dialog');
  readonly body = element('div', 'dialog-body');
  private readonly error = element('p', 'dialog-error');
  private readonly footer = element('footer');
  constructor(title: string, private readonly locale: Locale) {
    const heading = element('h2', '', title); heading.id = 'dialog-title';
    this.root.setAttribute('aria-labelledby', heading.id); this.error.setAttribute('role', 'alert');
    this.root.append(heading, this.body, this.error, this.footer);
    this.root.addEventListener('close', () => { this.onClose?.(); this.root.remove(); });
  }
  showError(message: string): void { this.error.textContent = message; }
  close(): void { this.root.close(); }
  show(confirmLabel: string, submit: () => Promise<void> | void): void {
    const cancel = button(this.locale.t('Cancel'), () => this.root.close());
    const confirm = button(confirmLabel, () => {
      confirm.disabled = true; this.error.textContent = '';
      Promise.resolve().then(submit).then(() => this.root.close(), error => {
        this.error.textContent = error instanceof Error ? error.message : String(error); confirm.disabled = false;
      });
    }, 'primary');
    this.footer.append(cancel, confirm); document.body.append(this.root); this.root.showModal();
    this.root.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); confirm.click(); } });
    requestAnimationFrame(() => (this.body.querySelector('input, textarea, select, button') as HTMLElement | null)?.focus());
  }
}

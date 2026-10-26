/*
Purpose: Show the operation hint of the control under the pointer or with keyboard focus in the toolbar.
*/
export class Tooltips {
  private hovered?: HTMLElement;
  private focused?: HTMLElement;

  /** `translate` resolves English hint keys in the current interface language. */
  constructor(private readonly hint: HTMLElement, private readonly translate: (text: string, params?: Record<string, string>) => string) {
    hint.setAttribute('aria-live', 'off');
    document.addEventListener('pointerover', event => { if (event.pointerType === 'touch') return; this.hovered = this.control(event.target); this.show(); });
    document.addEventListener('pointerout', event => { this.hovered = this.control(event.relatedTarget); this.show(); });
    document.addEventListener('focusin', event => { this.focused = this.control(event.target); this.show(); });
    document.addEventListener('focusout', event => { this.focused = this.control(event.relatedTarget); this.show(); });
    window.addEventListener('blur', () => { this.hovered = undefined; this.show(); });
  }

  /** Re-render after a language change or after the hovered control was replaced. */
  refresh(): void { this.show(); }

  private control(node: EventTarget | null): HTMLElement | undefined {
    return (node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null) ?? undefined;
  }

  private show(): void {
    // Pointer hover wins over keyboard focus, matching what the user is looking at.
    const target = [this.hovered, this.focused].find(node => node?.isConnected && node.dataset.tooltip);
    const text = target?.dataset.tooltip;
    this.hint.textContent = text ? this.translate('Tips: {text}', { text: this.translate(text) }) : '';
  }
}

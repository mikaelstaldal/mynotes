// Keep arrow navigation within the displayed list; nested controls retain their
// native keys. Links and buttons keep native Tab and Enter activation.
export function listKeyboard(e: KeyboardEvent, selector: string): void {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.matches(selector)) return;
  const container = e.currentTarget as HTMLElement;
  const items = Array.from(container.querySelectorAll<HTMLElement>(selector));
  const index = items.indexOf(target);
  if (index < 0) return;
  e.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

export function editingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  );
}

import { editingTarget } from './keyboard.js';

/** Activate the same visible, enabled buttons used by pointer users. */
export function handleActionShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || event.isComposing
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (!['n', 'e', 'd'].includes(key) || editingTarget(event.target)) return;
  if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], '
    + '.emoji-picker-overlay, .icon-picker-overlay, .link-picker-overlay')) return;
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`button[data-shortcut="${key}"]`))
    .find(button => !button.disabled && button.getClientRects().length > 0);
  if (!button) return;
  event.preventDefault();
  button.click();
}

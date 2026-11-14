import { useEffect, useRef } from 'preact/hooks';

/** Focus the first available action once, without changing native tab order. */
export function useDialogFocus(selector = 'button') {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])
      .find(button => !button.disabled && button.getClientRects().length > 0)?.focus();
  }, []);
  return ref;
}

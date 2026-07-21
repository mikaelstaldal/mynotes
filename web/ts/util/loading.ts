import { useState, useEffect, useRef } from 'preact/hooks';

// Delay before a "Loading…" indicator is allowed to appear. Loads that finish
// faster than this never show the indicator, so the UI doesn't flicker on quick
// (typically local) fetches. Single source of truth for every loading indicator
// in the web UI — change it here to adjust them all.
export const LOADING_INDICATOR_DELAY_MS = 400;

// Delayed mirror of a `loading` boolean: stays false until `loading` has been
// continuously true for LOADING_INDICATOR_DELAY_MS, then tracks it. Gate the
// *visible* indicator on the returned value while keeping the real `loading`
// flag for logic that must react immediately (disabling buttons, empty-state
// checks, load-more gating).
export function useSlowLoading(loading: boolean): boolean {
  const [slow, setSlow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setSlow(false);
      return;
    }
    // Loading just started: arm the reveal timer (unless one is already armed).
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setSlow(true);
      }, LOADING_INDICATOR_DELAY_MS);
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [loading]);

  return slow;
}

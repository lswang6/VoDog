import {useEffect, useRef} from 'react';

export const VISIBLE_REFRESH_MS = 5000;

/** Refresh mounted data while the page is foregrounded, plus immediately after focus/visibility recovery. */
export function useVisibleRefresh(
  load: () => void | Promise<void>,
  intervalMs = VISIBLE_REFRESH_MS,
  immediate = true,
): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      if (immediate) void latest.current();
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = (immediate: boolean) => {
      stop();
      if (document.visibilityState !== 'visible') return;
      if (immediate) void latest.current();
      timer = setInterval(() => void latest.current(), intervalMs);
    };
    const visibility = () => start(document.visibilityState === 'visible');
    const focus = () => start(true);
    start(immediate);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
    };
  }, [intervalMs, immediate]);
}

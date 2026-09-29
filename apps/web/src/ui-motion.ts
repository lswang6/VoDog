import {useEffect} from 'react';

/** Web currently follows the OS theme. Snap palette changes without animating every control. */
export function useUiMotionSafety() {
  useEffect(() => {
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    let frame = 0;
    let suppression: HTMLStyleElement | null = null;
    const restore = () => { suppression?.remove(); suppression = null; };
    const snap = () => {
      cancelAnimationFrame(frame);
      restore();
      suppression = document.createElement('style');
      suppression.textContent = '*,*::before,*::after{transition:none !important}';
      document.head.append(suppression);
      void document.documentElement.offsetHeight;
      frame = requestAnimationFrame(restore);
    };
    theme.addEventListener('change', snap);
    return () => { theme.removeEventListener('change', snap); cancelAnimationFrame(frame); restore(); };
  }, []);
}

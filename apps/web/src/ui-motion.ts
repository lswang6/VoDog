import {useEffect} from 'react';

let frame = 0;
let suppression: HTMLStyleElement | null = null;
const restore = () => { suppression?.remove(); suppression = null; };

/** Snap a palette change (system theme or the 外观 setting) without animating every control. */
export function snapThemeChange() {
  cancelAnimationFrame(frame);
  restore();
  suppression = document.createElement('style');
  suppression.textContent = '*,*::before,*::after{transition:none !important}';
  document.head.append(suppression);
  void document.documentElement.offsetHeight;
  frame = requestAnimationFrame(restore);
}

/** Follows the OS theme while the 外观 setting is 跟随系统; manual changes call snapThemeChange directly. */
export function useUiMotionSafety() {
  useEffect(() => {
    const theme = window.matchMedia('(prefers-color-scheme: dark)');
    theme.addEventListener('change', snapThemeChange);
    return () => { theme.removeEventListener('change', snapThemeChange); cancelAnimationFrame(frame); restore(); };
  }, []);
}

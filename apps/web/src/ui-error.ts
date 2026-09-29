import {useEffect} from 'react';
import {diag} from './diag.ts';

/** S69 ui.error_shown 的统一出口：错误文案出现或变化时记一次；空值不记，去重与取消过滤在 diag.uiError。 */
export function useReportedError(screen: string, site: string, message: string | null | undefined | false, code?: string): void {
  useEffect(() => {if (message) diag.uiError(screen, site, message, code);}, [screen, site, message, code]);
}

/** How long a confirmation stays on screen before it clears itself. */
export const CONFIRMATION_VISIBLE_MS = 5000;

/**
 * Show a confirmation and clear it after {@link CONFIRMATION_VISIBLE_MS} unless something else replaced it.
 * Errors are set directly and stay until the next action.
 */
export function flashConfirmation(set: (update: (current: string) => string) => void, text: string, ms = CONFIRMATION_VISIBLE_MS): void {
  set(() => text);
  setTimeout(() => set(current => current === text ? '' : current), ms);
}

import {useCallback, useId, useSyncExternalStore} from 'react';
import {browserSessionGeneration} from './session-boundary';
type Draft = {number: string; body: string};
type Drafts = Record<string, Draft>;
const empty: Drafts = {};
const stores = new Map<string, Drafts>();
const listeners = new Set<() => void>();
let generation = browserSessionGeneration();
/** Memory only: preserve dismissal/tab navigation without writing message text to browser storage. */
export function useSmsDrafts(account?: string) {
  const transient = useId();
  const currentGeneration = browserSessionGeneration();
  if (generation !== currentGeneration) {stores.clear();generation = currentGeneration;}
  const scope = JSON.stringify([currentGeneration, account || transient]);
  const subscribe = useCallback((listener: () => void) => {listeners.add(listener);return () => {listeners.delete(listener);};}, []);
  const snapshot = useCallback(() => stores.get(scope) || empty, [scope]);
  const drafts = useSyncExternalStore(subscribe, snapshot, () => empty);
  const update = useCallback((change: (old: Drafts) => Drafts) => {
    if (currentGeneration !== browserSessionGeneration()) return;
    stores.set(scope, change(stores.get(scope) || empty));
    for (const listener of listeners) listener();
  }, [scope, currentGeneration]);
  return [drafts, update] as const;
}

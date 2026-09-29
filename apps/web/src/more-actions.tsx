import React, {useEffect, useRef, type ReactNode} from 'react';

/** Native disclosure keeps secondary actions keyboard reachable without custom menu semantics. */
export function MoreActions({children, label = '更多操作'}: {children: ReactNode; label?: string}) {
  const details = useRef<HTMLDetailsElement>(null);
  function close() {
    if (!details.current?.open) return;
    details.current.open = false;
    details.current.querySelector('summary')?.focus();
  }
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const outside = (event: PointerEvent) => {
      if (event.target && details.current && !details.current.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details className="more-actions" ref={details} onToggle={() => {
    const element = details.current;
    if (element && !element.open && element.contains(document.activeElement)) element.querySelector('summary')?.focus();
  }} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  }}>
    <summary aria-label={label}><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>更多</summary>
    <div className="more-actions-content">{children}</div>
  </details>;
}

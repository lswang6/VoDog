import {useEffect, useRef} from 'react';
import type {ApiRequest} from './contacts';
import {useVisibleRefresh} from './visible-refresh';

/** Keep independently opened report media tied to the server call, even when its list row is off-page. */
export function CallDetailGuard({callId, request, onMissing}: {
  callId: string;
  request: ApiRequest;
  onMissing: (message: string) => void;
}) {
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  useVisibleRefresh(async () => {
    const captured = ++sequence.current;
    try {
      await request(`/calls/${encodeURIComponent(callId)}`);
    } catch (caught) {
      if (captured !== sequence.current) return;
      if (Number((caught as {status?: unknown})?.status) === 404) {
        onMissing('此通话已在其他设备删除，详情已关闭。');
      }
    }
  });
  return null;
}

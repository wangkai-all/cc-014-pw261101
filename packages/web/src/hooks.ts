import { useSyncExternalStore } from 'react';
import { tracker } from './tracker';
import type { ConsentState, DebugEntry } from '@pointwise/sdk';

/** 同意状态（localStorage 持久化，刷新页面后保持） */
export function useConsent(): ConsentState {
  return useSyncExternalStore(
    (onChange) =>
      tracker.onDebug((entry) => {
        if (entry.kind === 'consent' || entry.kind === 'queue_cleared') onChange();
      }),
    () => tracker.getConsent(),
  );
}

/** SDK 调试事件流（过滤、入队、投递、ACK、重试、死信……） */
export function useDebugLog(): DebugEntry[] {
  return useSyncExternalStore(
    (onChange) => tracker.onDebug(() => onChange()),
    () => tracker.getDebugLog(),
  );
}

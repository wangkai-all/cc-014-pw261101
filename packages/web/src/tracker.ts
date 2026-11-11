import { createTracker, PointwiseTracker } from '@pointwise/sdk';

/**
 * 页面级单例。endpoint 走 Vite 代理到本地 Express。
 * 同一实例被商品页与调试台共享，调试台订阅它的 debug 事件流。
 */
export const tracker: PointwiseTracker = createTracker({
  endpoint: '/api/events/batch',
  batchSize: 10,
  flushIntervalMs: 4000,
  maxAttempts: 5,
  requestTimeoutMs: 5000,
  pii: {
    phone: 'mask',
    email: 'mask',
    freetext: 'mask',
  },
});

// 便于在浏览器控制台手动操作
declare global {
  interface Window {
    pointwise?: PointwiseTracker;
  }
}
window.pointwise = tracker;

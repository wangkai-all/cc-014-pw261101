export { PointwiseTracker, createTracker, type TrackInput } from './tracker.js';
export type {
  PointwiseConfig,
  ConsentState,
  DeliveryStatus,
  DebugEntry,
  DebugKind,
  QueuedEvent,
  DeadletterEntry,
} from './types.js';
export { defaultTransport, type Transport, type BatchResponse, type ItemAck } from './transport.js';
// 重新导出规则类型，方便嵌入方配置
export {
  EVENT_REGISTRY,
  DEFAULT_PII_POLICY,
  type PiiPolicy,
  type PiiAction,
  type EventType,
} from '@pointwise/shared';

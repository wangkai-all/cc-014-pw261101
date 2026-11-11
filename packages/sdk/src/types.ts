import type { FilterTrace, PiiPolicy } from '@pointwise/shared';

export type ConsentState = 'granted' | 'denied' | 'unknown';

export type DeliveryStatus =
  | 'queued' // 已过滤、暂存 IndexedDB
  | 'sending' // 正在投递
  | 'accepted' // 服务端落库
  | 'duplicate' // 服务端幂等去重（重试未产生重复记录）
  | 'rejected' // 服务端校验不合法，进入死信
  | 'retry_wait' // 投递失败，等待重试
  | 'deadletter'; // 超过重试次数或被服务端拒绝

export interface PointwiseConfig {
  /** 接收端批次接口地址 */
  endpoint: string;
  /** 每批最大条数 */
  batchSize?: number;
  /** 定时刷发间隔 */
  flushIntervalMs?: number;
  /** 单条最大重试次数，超过进入死信 */
  maxAttempts?: number;
  /** 请求超时（超时按未知结果处理，靠 event_id 幂等重试） */
  requestTimeoutMs?: number;
  /** PII 处理策略：drop 删除 / mask 脱敏 */
  pii?: Partial<PiiPolicy>;
  /** 调试环形缓冲容量 */
  debugBufferSize?: number;
}

export interface QueuedEvent {
  event_id: string;
  /** 仅保存过滤后的 payload —— IndexedDB 从不存原始值 */
  payload: Record<string, unknown>;
  trace: FilterTrace[];
  attempts: number;
  enqueued_ts: number;
  last_attempt_ts: number;
}

export interface DeadletterEntry {
  event_id: string;
  payload: Record<string, unknown>;
  trace: FilterTrace[];
  attempts: number;
  deadletter_ts: number;
  reason: string;
  server_errors?: unknown;
}

export type DebugKind =
  | 'consent'
  | 'ignored_no_consent'
  | 'filtered'
  | 'enqueue'
  | 'dispatch'
  | 'ack'
  | 'retry'
  | 'deadletter'
  | 'offline_hold'
  | 'queue_cleared'
  | 'debug_raw_send';

export interface DebugEntry {
  debug_id: string;
  ts: number;
  kind: DebugKind;
  event_id?: string;
  event_type?: string;
  event_version?: number;
  /** 字段处理原因；trace 不含任何字段原值 */
  trace?: FilterTrace[];
  /** 过滤后的 payload（可安全展示） */
  payload?: Record<string, unknown>;
  status?: DeliveryStatus;
  attempts?: number;
  detail?: string;
}

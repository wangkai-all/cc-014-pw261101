import {
  DEFAULT_PII_POLICY,
  filterEvent,
  type FilterTrace,
  type PiiPolicy,
} from '@pointwise/shared';
import { EventStore } from './store.js';
import { defaultTransport, type BatchResponse, type ItemAck, type Transport } from './transport.js';
import type {
  ConsentState,
  DebugEntry,
  DebugKind,
  DeadletterEntry,
  DeliveryStatus,
  PointwiseConfig,
  QueuedEvent,
} from './types.js';

const CONSENT_KEY = 'pointwise.consent';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface TrackInput {
  event_type: string;
  properties: Record<string, unknown>;
}

export class PointwiseTracker {
  private config: Required<Omit<PointwiseConfig, 'pii'>> & { pii: PiiPolicy };
  private store = new EventStore();
  private transport: Transport;
  private consent: ConsentState = 'unknown';
  private sessionId: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private debugBuffer: DebugEntry[] = [];
  private listeners = new Set<(entry: DebugEntry) => void>();
  private onlineHandler = () => {
    if (this.consent === 'granted') void this.flush();
  };

  constructor(config: PointwiseConfig, transport?: Transport) {
    this.config = {
      batchSize: config.batchSize ?? 20,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      maxAttempts: config.maxAttempts ?? 5,
      requestTimeoutMs: config.requestTimeoutMs ?? 6000,
      debugBufferSize: config.debugBufferSize ?? 200,
      endpoint: config.endpoint,
      pii: { ...DEFAULT_PII_POLICY, ...(config.pii ?? {}) },
    };
    this.transport = transport ?? defaultTransport;
    this.sessionId = uuid();
    this.consent = this.readConsent();

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
    }
    if (this.consent === 'granted') this.startTimer();
  }

  // ---------- 同意状态 ----------

  getConsent(): ConsentState {
    return this.consent;
  }

  /** 运行时切换 PII 策略，只影响切换之后新产生的事件 */
  setPiiPolicy(policy: Partial<PiiPolicy>): void {
    this.config.pii = { ...this.config.pii, ...policy };
    this.emit({ kind: 'consent', detail: `PII 策略已更新：${JSON.stringify(this.config.pii)}（仅影响新事件）` });
  }

  getPiiPolicy(): PiiPolicy {
    return { ...this.config.pii };
  }

  /** 同意采集：仅对之后的操作生效，同意前不缓存、不补发 */
  grantConsent(): void {
    this.consent = 'granted';
    this.writeConsent('granted');
    this.startTimer();
    this.emit({ kind: 'consent', detail: 'granted：开始记录（同意前事件不补发）' });
  }

  /**
   * 撤回同意：
   *  - 停止产生新事件（track 直接忽略）
   *  - 停止定时重试
   *  - 清空待发队列与死信（过滤后的暂存数据一并删除）
   */
  withdrawConsent(): void {
    this.consent = 'denied';
    this.writeConsent('denied');
    this.stopTimer();
    void this.store.clearQueue();
    void this.store.clearDead();
    this.emit({ kind: 'consent', detail: 'withdrawn：停止采集与重试' });
    this.emit({ kind: 'queue_cleared', detail: '撤回同意，待发队列与死信已清空' });
  }

  private readConsent(): ConsentState {
    try {
      const v = localStorage.getItem(CONSENT_KEY);
      return v === 'granted' || v === 'denied' ? v : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private writeConsent(state: 'granted' | 'denied'): void {
    try {
      localStorage.setItem(CONSENT_KEY, state);
    } catch {
      /* 隐私模式等场景下忽略持久化失败 */
    }
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
  }

  private stopTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ---------- 调试事件 ----------

  onDebug(listener: (entry: DebugEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDebugLog(): DebugEntry[] {
    return [...this.debugBuffer];
  }

  private emit(partial: Omit<DebugEntry, 'debug_id' | 'ts'>): void {
    const entry: DebugEntry = { debug_id: uuid(), ts: Date.now(), ...partial };
    this.debugBuffer.push(entry);
    const cap = this.config.debugBufferSize;
    if (this.debugBuffer.length > cap) this.debugBuffer.splice(0, this.debugBuffer.length - cap);
    this.listeners.forEach((fn) => {
      try {
        fn(entry);
      } catch {
        /* 监听方异常不影响 SDK */
      }
    });
  }

  // ---------- 事件采集 ----------

  async track(input: TrackInput): Promise<void> {
    // 未同意/已撤回：直接忽略，不缓存、不补发
    if (this.consent !== 'granted') {
      this.emit({
        kind: 'ignored_no_consent',
        event_type: input.event_type,
        detail: `consent=${this.consent}，事件被丢弃且不缓存`,
      });
      return;
    }

    const eventId = uuid();
    // 关键顺序：先过滤，之后任何持久化/网络/日志只能接触过滤结果
    const result = filterEvent(
      {
        event_id: eventId,
        event_type: input.event_type,
        event_version: 0, // filterEvent 会按注册表回填真实版本
        session_id: this.sessionId,
        client_ts: Date.now(),
        properties: input.properties ?? {},
      },
      this.config.pii,
    );

    if (!result || !result.payload.event_type) {
      this.emit({
        kind: 'filtered',
        event_id: eventId,
        event_type: input.event_type,
        trace: result?.trace,
        detail: '事件类型未注册，整条放弃',
      });
      return;
    }

    const { payload, trace } = result;
    const queued: QueuedEvent = {
      event_id: eventId,
      payload,
      trace,
      attempts: 0,
      enqueued_ts: Date.now(),
      last_attempt_ts: 0,
    };
    await this.store.putQueued(queued);

    this.emit({
      kind: 'filtered',
      event_id: eventId,
      event_type: payload.event_type as string,
      event_version: payload.event_version as number,
      trace,
      payload,
      detail: '字段过滤完成（原值不进队列/网络/日志）',
    });
    this.emit({
      kind: 'enqueue',
      event_id: eventId,
      event_type: payload.event_type as string,
      status: 'queued',
      payload,
      detail: '已暂存 IndexedDB，等待批量投递',
    });

    void this.flush();
  }

  // ---------- 投递 ----------

  isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  async getQueueSize(): Promise<number> {
    return this.store.queueSize();
  }

  async getQueue(): Promise<QueuedEvent[]> {
    return this.store.allQueued();
  }

  async getDeadletters(): Promise<DeadletterEntry[]> {
    return this.store.allDead();
  }

  async flush(): Promise<void> {
    if (this.consent !== 'granted') return;
    if (this.flushing) return;

    if (!this.isOnline()) {
      this.emit({ kind: 'offline_hold', status: 'queued', detail: '当前断网，事件留在 IndexedDB 等待恢复' });
      return;
    }

    this.flushing = true;
    try {
      const all = await this.store.allQueued();
      if (all.length === 0) return;

      const batch = all.slice(0, this.config.batchSize);
      const ids = batch.map((e) => e.event_id);
      const now = Date.now();
      const updated = batch.map((e) => ({ ...e, attempts: e.attempts + 1, last_attempt_ts: now }));
      await Promise.all(updated.map((e) => this.store.putQueued(e)));

      this.emit({
        kind: 'dispatch',
        detail: `投递批次 ${batch.length} 条，event_id 保持不变`,
        status: 'sending',
        payload: { events: updated.map((e) => e.payload) },
      });

      const resp: BatchResponse = await this.transport.sendBatch(
        this.config.endpoint,
        updated.map((e) => e.payload),
        this.config.requestTimeoutMs,
      );

      await this.handleResponse(batch, updated, resp);
    } finally {
      this.flushing = false;
    }
  }

  private async handleResponse(
    original: QueuedEvent[],
    updated: QueuedEvent[],
    resp: BatchResponse,
  ): Promise<void> {
    // 网络错误/超时：结果未知，带原 event_id 重试，绝不本地去重
    if (resp.networkError) {
      for (const evt of updated) {
        if (evt.attempts >= this.config.maxAttempts) {
          await this.moveToDeadletter(evt, `max_attempts:${resp.networkError}`);
          continue;
        }
        this.emit({
          kind: 'retry',
          event_id: evt.event_id,
          event_type: evt.payload.event_type as string,
          status: 'retry_wait',
          attempts: evt.attempts,
          detail:
            resp.networkError === 'timeout'
              ? '请求超时（服务端可能已收到），沿用原 event_id 重试，由服务端幂等去重'
              : `网络错误 ${resp.networkError}，等待重试`,
        });
      }
      return;
    }

    if (!resp.body || !Array.isArray(resp.body.results)) {
      // 服务端返回了无法解析的响应，同样按未知结果重试
      for (const evt of updated) {
        if (evt.attempts >= this.config.maxAttempts) {
          await this.moveToDeadletter(evt, `max_attempts:http_${resp.httpStatus}`);
        } else {
          this.emit({
            kind: 'retry',
            event_id: evt.event_id,
            status: 'retry_wait',
            attempts: evt.attempts,
            detail: `服务端响应异常 HTTP ${resp.httpStatus}，沿用原 event_id 重试`,
          });
        }
      }
      return;
    }

    const byId = new Map(updated.map((e) => [e.event_id, e]));
    const removable: string[] = [];

    for (const ack of resp.body.results) {
      const evt = byId.get(ack.event_id);
      if (!evt) continue;

      if (ack.status === 'accepted' || ack.status === 'duplicate') {
        // accepted=首次落库；duplicate=重试命中幂等，都代表服务端已有这条，移出队列
        removable.push(ack.event_id);
        this.emit({
          kind: 'ack',
          event_id: ack.event_id,
          event_type: evt.payload.event_type as string,
          status: ack.status satisfies DeliveryStatus,
          attempts: evt.attempts,
          payload: evt.payload,
          trace: evt.trace,
          detail:
            ack.status === 'duplicate'
              ? '服务端按 event_id 幂等去重，未重复落库'
              : '服务端校验通过并落库',
        });
      } else {
        // 服务端逐条校验拒绝：合法事件不受影响，本条进死信不再重试
        await this.moveToDeadletter(evt, 'server_rejected', ack.errors);
        removable.push(ack.event_id);
        this.emit({
          kind: 'deadletter',
          event_id: ack.event_id,
          event_type: evt.payload.event_type as string,
          status: 'rejected',
          attempts: evt.attempts,
          detail: `服务端校验不合法：${summarizeErrors(ack.errors)}`,
        });
      }
    }

    if (removable.length > 0) await this.store.deleteQueued(removable);
    void original;
  }

  private async moveToDeadletter(evt: QueuedEvent, reason: string, serverErrors?: unknown): Promise<void> {
    const entry: DeadletterEntry = {
      event_id: evt.event_id,
      payload: evt.payload,
      trace: evt.trace,
      attempts: evt.attempts,
      deadletter_ts: Date.now(),
      reason,
      server_errors: serverErrors,
    };
    await this.store.putDead(entry);
    await this.store.deleteQueued([evt.event_id]);
    this.emit({
      kind: 'deadletter',
      event_id: evt.event_id,
      event_type: evt.payload.event_type as string,
      status: 'deadletter',
      attempts: evt.attempts,
      detail: `进入死信：${reason}`,
    });
  }

  /**
   * 调试台专用：绕过过滤直接发送原始批次，用于验证服务端兜底校验。
   * 正常 track() 流程不会调用它；调用方（调试台）负责在界面上明确标注。
   */
  async sendRawBatch(events: Record<string, unknown>[]): Promise<BatchResponse> {
    this.emit({
      kind: 'debug_raw_send',
      detail: `调试台直发 ${events.length} 条未经客户端过滤的事件（仅用于验证服务端校验）`,
      payload: { events },
    });
    return this.transport.sendBatch(this.config.endpoint, events, this.config.requestTimeoutMs);
  }

  destroy(): void {
    this.stopTimer();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
    this.listeners.clear();
  }
}

function summarizeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return 'unknown';
  return errors
    .map((e) => {
      const err = e as { path?: string; reason?: string };
      return `${err.path ?? '?'}:${err.reason ?? '?'}`;
    })
    .join(', ');
}

export function createTracker(config: PointwiseConfig, transport?: Transport): PointwiseTracker {
  return new PointwiseTracker(config, transport);
}

export type { FilterTrace };

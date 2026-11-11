import { useCallback, useEffect, useMemo, useState } from 'react';
import { tracker } from '../tracker';
import { useConsent, useDebugLog } from '../hooks';
import type { DebugEntry, PiiPolicy } from '@pointwise/sdk';

interface ServerEvent extends Record<string, unknown> {
  event_id: string;
  event_type: string;
  event_version: number;
  received_ts: number;
  properties: Record<string, unknown>;
}

interface RejectedRow {
  rejection_id: string;
  event_id: string | null;
  received_ts: number;
  reasons: Array<{ path: string; reason: string }>;
}

interface Stats {
  byType: Array<{ event_type: string; count: number }>;
  total_events: number;
  distinct_ids: number;
  total_rejected: number;
}

function uid(): string {
  return crypto.randomUUID();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');
}

const KIND_BADGE: Record<DebugEntry['kind'], string> = {
  consent: 'badge-consent',
  ignored_no_consent: 'badge-ignored',
  filtered: 'badge-filtered',
  enqueue: 'badge-queue',
  dispatch: 'badge-dispatch',
  ack: 'badge-ack',
  retry: 'badge-retry',
  deadletter: 'badge-dead',
  offline_hold: 'badge-offline',
  queue_cleared: 'badge-consent',
  debug_raw_send: 'badge-raw',
};

const KIND_LABEL: Record<DebugEntry['kind'], string> = {
  consent: '同意状态',
  ignored_no_consent: '未授权丢弃',
  filtered: '字段过滤',
  enqueue: '入队',
  dispatch: '批次投递',
  ack: '服务端确认',
  retry: '等待重试',
  deadletter: '死信',
  offline_hold: '断网滞留',
  queue_cleared: '队列清空',
  debug_raw_send: '调试直发',
};

export function DebugConsole() {
  const consent = useConsent();
  const log = useDebugLog();
  const [offline, setOffline] = useState(false);
  const [queueSize, setQueueSize] = useState(0);
  const [deadCount, setDeadCount] = useState(0);
  const [serverEvents, setServerEvents] = useState<ServerEvent[]>([]);
  const [rejected, setRejected] = useState<RejectedRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [rawResult, setRawResult] = useState<string>('');
  const [policy, setPolicy] = useState<PiiPolicy>({ phone: 'mask', email: 'mask', freetext: 'mask' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [q, d, evts, rej, st] = await Promise.all([
      tracker.getQueueSize(),
      tracker.getDeadletters(),
      fetch('/api/events?limit=50').then((r) => r.json()) as Promise<{ events: ServerEvent[] }>,
      fetch('/api/rejected').then((r) => r.json()) as Promise<{ rejected: RejectedRow[] }>,
      fetch('/api/stats').then((r) => r.json()) as Promise<Stats>,
    ]);
    setQueueSize(q);
    setDeadCount(d.length);
    setServerEvents(evts.events);
    setRejected(rej.rejected);
    setStats(st);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  // 调试台本地断网开关：拦截 fetch，模拟浏览器离线
  useEffect(() => {
    if (!offline) return;
    const original = window.fetch;
    window.fetch = () => Promise.reject(new DOMException('simulated offline', 'AbortError'));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    return () => {
      window.fetch = original;
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    };
  }, [offline]);

  // 注意：PII 策略切换只影响新产生的事件
  function applyPolicy(next: PiiPolicy) {
    setPolicy(next);
    tracker.setPiiPolicy(next);
  }

  async function flushNow() {
    await tracker.flush();
    setTimeout(refresh, 300);
  }

  /** 构造一条能通过客户端过滤的合法事件（对照用） */
  function buildValidEvent() {
    return {
      event_id: uid(),
      event_type: 'click',
      event_version: 1,
      session_id: 'debug-console-session',
      client_ts: Date.now(),
      properties: {
        element_id: 'debug-valid-btn',
        element_text: '调试台合法事件',
        position: { x: 10, y: 20 },
      },
    };
  }

  /** 构造不合法事件：未知字段 + 类型错误 + PII 泄漏（服务端必须拒绝且不落库原值） */
  function buildInvalidEvent() {
    return {
      event_id: uid(),
      event_type: 'subscribe',
      event_version: 1,
      session_id: 'debug-console-session',
      client_ts: Date.now(),
      properties: {
        channel: 'sms',
        phone: '13800138000', // 未脱敏 PII，服务端应判 pii_leak
        email: 'leak@example.com',
        unknown_field: 'not-allowed', // 白名单外
        message: 12345, // 类型错误（应为 string）
      },
      unexpected_envelope: 'x',
    };
  }

  async function sendMixedBatch() {
    const resp = await tracker.sendRawBatch([buildInvalidEvent(), buildValidEvent()]);
    setRawResult(JSON.stringify(resp, null, 2));
    setTimeout(refresh, 300);
  }

  async function sendDupes() {
    // 同一 event_id 连发两次：即使都到达服务端，也只能落库一条
    const evt = buildValidEvent();
    const r1 = await tracker.sendRawBatch([evt]);
    const r2 = await tracker.sendRawBatch([evt]);
    setRawResult(`第一次: ${JSON.stringify(r1.body?.results)}\n第二次（同 event_id）: ${JSON.stringify(r2.body?.results)}`);
    setTimeout(refresh, 300);
  }

  const timeline = useMemo(() => [...log].reverse(), [log]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="debug-console">
      <section className="panel">
        <h2>调试控制</h2>
        <div className="controls">
          <div className="control-group">
            <span className="control-label">同意状态</span>
            {consent === 'granted' ? (
              <button className="btn danger" onClick={() => tracker.withdrawConsent()}>
                撤回同意（停止采集/重试并清空队列）
              </button>
            ) : (
              <button className="btn primary" onClick={() => tracker.grantConsent()}>
                同意采集
              </button>
            )}
          </div>

          <div className="control-group">
            <span className="control-label">网络</span>
            <button className={offline ? 'btn danger' : 'btn'} onClick={() => setOffline((v) => !v)}>
              {offline ? '当前：断网（点击恢复）' : '当前：联网（点击模拟断网）'}
            </button>
            <button className="btn" onClick={flushNow} disabled={consent !== 'granted'}>
              立即刷发
            </button>
          </div>

          <div className="control-group">
            <span className="control-label">服务端校验测试（绕过客户端过滤直发）</span>
            <button className="btn warn" onClick={sendMixedBatch} disabled={offline}>
              发送混合批次（1 条非法 + 1 条合法）
            </button>
            <button className="btn warn" onClick={sendDupes} disabled={offline}>
              发送重复 event_id（幂等测试）
            </button>
          </div>

          <div className="control-group">
            <span className="control-label">PII 策略（只影响新事件）</span>
            {(['phone', 'email', 'freetext'] as const).map((kind) => (
              <label key={kind} className="policy-label">
                {kind === 'phone' ? '手机号' : kind === 'email' ? '邮箱' : '自由文本'}
                <select
                  value={policy[kind]}
                  onChange={(e) => applyPolicy({ ...policy, [kind]: e.target.value as 'mask' | 'drop' })}
                >
                  <option value="mask">脱敏 mask</option>
                  <option value="drop">删除 drop</option>
                </select>
              </label>
            ))}
          </div>
        </div>
        {rawResult && <pre className="raw-result">{rawResult}</pre>}
      </section>

      <section className="panel stat-cards">
        <div className="stat-card">
          <span className="stat-num">{queueSize}</span>
          <span className="stat-label">IndexedDB 待发队列</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{deadCount}</span>
          <span className="stat-label">浏览器死信</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{stats?.total_events ?? '-'}</span>
          <span className="stat-label">服务端落库事件</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{stats?.distinct_ids ?? '-'}</span>
          <span className="stat-label">服务端去重 ID 数</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{stats?.total_rejected ?? '-'}</span>
          <span className="stat-label">服务端拒绝条数</span>
        </div>
      </section>

      <div className="two-col debug-grid">
        <section className="panel">
          <h2>
            事件时间线（{timeline.length}）
            <span className="muted small"> 规则版本 / 字段处理原因 / 投递状态</span>
          </h2>
          <div className="timeline">
            {timeline.length === 0 && <p className="muted">暂无事件，去商品页操作试试</p>}
            {timeline.map((entry) => (
              <div key={entry.debug_id} className="timeline-item" onClick={() => toggle(entry.debug_id)}>
                <div className="timeline-head">
                  <span className={`badge ${KIND_BADGE[entry.kind]}`}>{KIND_LABEL[entry.kind]}</span>
                  <span className="timeline-time">{fmtTime(entry.ts)}</span>
                  {entry.event_type && (
                    <span className="event-type">
                      {entry.event_type}
                      {entry.event_version ? ` v${entry.event_version}` : ''}
                    </span>
                  )}
                  {entry.status && <span className={`status status-${entry.status}`}>{entry.status}</span>}
                  {typeof entry.attempts === 'number' && <span className="attempts">第 {entry.attempts} 次</span>}
                </div>
                {entry.detail && <div className="timeline-detail">{entry.detail}</div>}
                {entry.event_id && <div className="event-id">event_id: {entry.event_id}</div>}
                {expanded.has(entry.debug_id) && (
                  <div className="timeline-expanded" onClick={(e) => e.stopPropagation()}>
                    {entry.trace && entry.trace.length > 0 && (
                      <>
                        <h4>字段处理原因（不含原值）</h4>
                        <table className="trace-table">
                          <thead>
                            <tr>
                              <th>字段路径</th>
                              <th>动作</th>
                              <th>原因</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.trace.map((t, i) => (
                              <tr key={i}>
                                <td className="mono">{t.path}</td>
                                <td>
                                  <span className={`action action-${t.action}`}>{t.action}</span>
                                  {t.pii && <span className="pii-tag">{t.pii}</span>}
                                </td>
                                <td className="mono small">{t.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                    {entry.payload && (
                      <>
                        <h4>过滤后 payload（唯一会进入网络请求/本地队列的内容）</h4>
                        <pre className="payload-view">{JSON.stringify(entry.payload, null, 2)}</pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>服务端数据（SQLite 实际落库）</h2>
          <h3>按类型统计</h3>
          <table className="server-table">
            <tbody>
              {(stats?.byType ?? []).map((row) => (
                <tr key={row.event_type}>
                  <td className="mono">{row.event_type}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>最近落库事件</h3>
          <div className="server-list">
            {serverEvents.map((evt) => (
              <div key={evt.event_id} className="server-row">
                <div>
                  <span className="event-type">{evt.event_type} v{evt.event_version}</span>
                  <span className="timeline-time">{fmtTime(evt.received_ts)}</span>
                </div>
                <pre className="payload-view small">{JSON.stringify(evt.properties, null, 2)}</pre>
              </div>
            ))}
            {serverEvents.length === 0 && <p className="muted">暂无落库事件</p>}
          </div>

          <h3>服务端拒绝记录（仅存路径与原因，不存原值）</h3>
          <div className="server-list">
            {rejected.map((row) => (
              <div key={row.rejection_id} className="server-row rejected-row">
                <span className="timeline-time">{fmtTime(row.received_ts)}</span>
                <ul className="error-list">
                  {row.reasons.map((r, i) => (
                    <li key={i} className="mono small">
                      {r.path} → {r.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {rejected.length === 0 && <p className="muted">暂无拒绝记录</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

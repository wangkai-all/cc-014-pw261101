import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

// 必须在 import app 之前指定数据目录（ESM import 会先于语句执行，故放独立模块顶层）
const dataDir = mkdtempSync(join(tmpdir(), 'pointwise-test-'));
process.env.POINTWISE_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { app } = await import('../packages/server/src/index.js');
const { getDb } = await import('../packages/server/src/db.js');

const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api`;

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    event_type: 'click',
    event_version: 1,
    session_id: 'sess-test',
    client_ts: Date.now(),
    properties: {
      element_id: 'btn-1',
      element_text: '普通按钮',
      position: { x: 1, y: 2 },
    },
    ...overrides,
  };
}

function invalidEvent(): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    event_type: 'subscribe',
    event_version: 1,
    session_id: 'sess-test',
    client_ts: Date.now(),
    properties: {
      channel: 'sms',
      phone: '13800138000', // 未脱敏 PII
      unknown_field: 'x', // 白名单外
    },
  };
}

before(() => {
  getDb().exec('DELETE FROM events; DELETE FROM rejected_events;');
});

after(() => server.close());

describe('批量接口逐条校验', () => {
  test('混合批次：非法条拒绝并记录原因，合法条正常落库', async () => {
    const good = validEvent();
    const bad = invalidEvent();
    const res = await fetch(`${base}/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [bad, good] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      accepted: number;
      duplicate: number;
      rejected: number;
      results: Array<{ event_id: string; status: string; errors?: unknown[] }>;
    };
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 1);
    const badAck = body.results.find((r) => r.event_id === bad.event_id)!;
    assert.equal(badAck.status, 'rejected');
    assert.ok(Array.isArray(badAck.errors) && badAck.errors!.length > 0);
    const goodAck = body.results.find((r) => r.event_id === good.event_id)!;
    assert.equal(goodAck.status, 'accepted');

    // 拒绝原因中不得包含原始 PII 值
    assert.ok(!JSON.stringify(body).includes('13800138000'));

    const stored = (await (await fetch(`${base}/events?limit=50`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(stored.events.some((e) => e.event_id === good.event_id));
    assert.ok(!stored.events.some((e) => e.event_id === bad.event_id));

    const rej = (await (await fetch(`${base}/rejected`)).json()) as {
      rejected: Array<{ reasons: unknown[] }>;
    };
    assert.ok(rej.rejected.length >= 1);
    assert.ok(!JSON.stringify(rej).includes('13800138000'));
  });

  test('同一 event_id 重发（模拟超时重试）返回 duplicate，只落库一条', async () => {
    const evt = validEvent();
    const first = await fetch(`${base}/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [evt] }),
    });
    const firstBody = (await first.json()) as { results: Array<{ status: string }> };
    assert.equal(firstBody.results[0].status, 'accepted');

    // 浏览器超时后带原 event_id 重试
    const second = await fetch(`${base}/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [evt] }),
    });
    const secondBody = (await second.json()) as { results: Array<{ status: string }> };
    assert.equal(secondBody.results[0].status, 'duplicate');

    const db = getDb();
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE event_id = ?')
      .get(evt.event_id as string) as { c: number };
    assert.equal(count.c, 1);
  });

  test('整批非法请求返回 400', async () => {
    const notArray = await fetch(`${base}/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: { nope: true } }),
    });
    assert.equal(notArray.status, 400);

    const empty = await fetch(`${base}/events/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(empty.status, 400);
  });

  test('统计接口：落库数与去重 ID 数一致', async () => {
    const stats = (await (await fetch(`${base}/stats`)).json()) as {
      total_events: number;
      distinct_ids: number;
      total_rejected: number;
      byType: Array<{ event_type: string; count: number }>;
    };
    assert.equal(stats.total_events, stats.distinct_ids);
    assert.ok(stats.total_rejected >= 1);
    assert.ok(stats.byType.some((r) => r.event_type === 'click'));
  });
});

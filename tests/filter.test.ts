import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEvent,
  DEFAULT_PII_POLICY,
  validateEvent,
  type PiiPolicy,
} from '@pointwise/shared';

const baseEnvelope = {
  event_id: 'evt-1',
  session_id: 'sess-1',
  client_ts: 1700000000000,
};

function rawSubscribe(overrides: Record<string, unknown> = {}) {
  return {
    ...baseEnvelope,
    event_type: 'subscribe',
    event_version: 1,
    properties: {
      channel: 'sms',
      phone: '13800138000',
      email: 'zhangsan@example.com',
      message: '请加我微信 13912345678 或发邮件 a.b@test.cn',
      injected_field: 'not-allowed',
      ...overrides,
    },
    rogue_envelope: 'x',
  };
}

describe('PII 脱敏', () => {
  test('手机号/邮箱整体脱敏，自由文本内嵌 PII 被替换', () => {
    const result = filterEvent(rawSubscribe(), DEFAULT_PII_POLICY);
    assert.ok(result);
    const props = result.payload.properties as Record<string, unknown>;
    assert.equal(props.phone, '138****8000');
    assert.equal(props.email, 'z***@example.com');
    assert.equal(
      props.message,
      '请加我微信 139****5678 或发邮件 a***@test.cn',
    );
  });

  test('drop 策略下字段直接删除，原值不进入 payload', () => {
    const policy: PiiPolicy = { phone: 'drop', email: 'drop', freetext: 'drop' };
    const result = filterEvent(rawSubscribe(), policy);
    assert.ok(result);
    const props = result.payload.properties as Record<string, unknown>;
    assert.equal('phone' in props, false);
    assert.equal('email' in props, false);
    assert.equal('message' in props, false);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('13800138000'));
    assert.ok(!serialized.includes('zhangsan@example.com'));
    assert.ok(!serialized.includes('13912345678'));
    assert.ok(!serialized.includes('a.b@test.cn'));
  });

  test('自由文本不含 PII 时原样保留', () => {
    const result = filterEvent(
      rawSubscribe({ message: '普通留言，没有联系方式' }),
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    assert.equal((result.payload.properties as Record<string, unknown>).message, '普通留言，没有联系方式');
  });
});

describe('字段白名单与逐层处理', () => {
  test('顶层与嵌套白名单外字段被删除并记录原因', () => {
    const result = filterEvent(
      {
        ...baseEnvelope,
        event_type: 'add_to_cart',
        event_version: 1,
        properties: {
          product_id: 'SKU-1',
          product_name: '键盘',
          price: 359,
          quantity: 1,
          top_rogue: 'drop',
          meta: {
            source: 'list',
            campaign: 'c1',
            extra: { note: '加急 13800138000', inner_rogue: 'drop' },
            meta_rogue: 'drop',
          },
        },
      },
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    const props = result.payload.properties as Record<string, unknown>;
    assert.equal('top_rogue' in props, false);
    const meta = props.meta as Record<string, unknown>;
    assert.equal('meta_rogue' in meta, false);
    const extra = meta.extra as Record<string, unknown>;
    assert.equal('inner_rogue' in extra, false);
    assert.equal(extra.note, '加急 138****8000');

    const paths = result.trace.map((t) => t.path);
    assert.ok(paths.includes('properties.top_rogue'));
    assert.ok(paths.includes('properties.meta.meta_rogue'));
    assert.ok(paths.includes('properties.meta.extra.inner_rogue'));
    assert.ok(result.trace.some((t) => t.reason === 'not_in_whitelist'));
    assert.ok(result.trace.some((t) => t.reason === 'pii_masked' && t.pii === 'freetext'));
  });

  test('类型不符字段被删除', () => {
    const result = filterEvent(
      {
        ...baseEnvelope,
        event_type: 'add_to_cart',
        event_version: 1,
        properties: { product_id: 12345, price: 'abc', quantity: 2 },
      },
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    const props = result.payload.properties as Record<string, unknown>;
    assert.equal('product_id' in props, false);
    assert.equal('price' in props, false);
    assert.equal(props.quantity, 2);
    assert.ok(result.trace.some((t) => t.reason === 'type_mismatch'));
  });

  test('数组逐元素处理，非法元素被删除', () => {
    const result = filterEvent(
      {
        ...baseEnvelope,
        event_type: 'search',
        event_version: 1,
        properties: {
          keyword: '机械键盘',
          result_count: 3,
          filters: { category: '外设', tags: ['红轴', 123, '三模'] },
        },
      },
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    const filters = (result.payload.properties as Record<string, unknown>).filters as Record<string, unknown>;
    assert.deepEqual(filters.tags, ['红轴', '三模']);
  });

  test('嵌套对象被清空后整体移除', () => {
    const result = filterEvent(
      {
        ...baseEnvelope,
        event_type: 'click',
        event_version: 1,
        properties: {
          element_id: 'btn',
          position: { x: 'bad-type', y: 'also-bad', rogue: 1 },
        },
      },
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    const props = result.payload.properties as Record<string, unknown>;
    assert.equal('position' in props, false);
  });

  test('信封未知字段被删除，事件版本按注册表回填', () => {
    const result = filterEvent(rawSubscribe(), DEFAULT_PII_POLICY);
    assert.ok(result);
    assert.equal('rogue_envelope' in result.payload, false);
    assert.equal(result.payload.event_version, 1);
  });

  test('未注册事件类型不产生可投递 payload', () => {
    const result = filterEvent(
      { ...baseEnvelope, event_type: 'not_a_real_event', event_version: 9, properties: { a: 1 } },
      DEFAULT_PII_POLICY,
    );
    assert.ok(result);
    assert.equal(result.payload.event_type, undefined);
  });
});

describe('安全红线：原值不泄漏', () => {
  test('任何处理结果（payload + trace）序列化后都找不到被 drop 的原值', () => {
    const policy: PiiPolicy = { phone: 'drop', email: 'mask', freetext: 'drop' };
    const result = filterEvent(rawSubscribe(), policy);
    assert.ok(result);
    const blob = JSON.stringify(result);
    // trace 只允许出现路径/原因，禁止出现原值
    assert.ok(!blob.includes('13800138000')); // phone 被 drop
    assert.ok(!blob.includes('13912345678')); // freetext 整条被 drop
    assert.ok(!blob.includes('not-allowed')); // 白名单外字段的值
    // 信封未知字段：不得出现在 payload 中（trace 路径里出现字段名是允许的，值才是敏感数据）
    assert.ok(!JSON.stringify(result.payload).includes('rogue_envelope'));
    // email 是 mask 而非 drop，原值不应出现，脱敏值应出现
    assert.ok(!blob.includes('zhangsan@example.com'));
    assert.ok(blob.includes('z***@example.com'));
  });
});

describe('服务端严格校验', () => {
  test('客户端正常过滤后的事件可通过服务端校验', () => {
    const filtered = filterEvent(rawSubscribe(), DEFAULT_PII_POLICY)!;
    const check = validateEvent(filtered.payload);
    assert.equal(check.valid, true, JSON.stringify(check.errors));
  });

  test('未脱敏 PII 直送服务端被 pii_leak 拒绝，且错误不含原值', () => {
    const check = validateEvent(rawSubscribe());
    assert.equal(check.valid, false);
    const reasons = check.errors.map((e) => e.reason);
    assert.ok(reasons.includes('pii_leak'));
    assert.ok(reasons.includes('not_in_whitelist'));
    const serialized = JSON.stringify(check);
    assert.ok(!serialized.includes('13800138000'));
    assert.ok(!serialized.includes('zhangsan@example.com'));
  });

  test('缺字段、版本不符、未知事件类型分别报错', () => {
    assert.equal(validateEvent({ event_type: 'click' }).valid, false);
    const versionBad = validateEvent({
      ...baseEnvelope,
      event_type: 'click',
      event_version: 99,
      properties: {},
    });
    assert.ok(versionBad.errors.some((e) => e.reason === 'version_mismatch'));
    const unknownType = validateEvent({
      ...baseEnvelope,
      event_type: 'nope',
      event_version: 1,
      properties: {},
    });
    assert.ok(unknownType.errors.some((e) => e.reason === 'unknown_event_type'));
  });
});

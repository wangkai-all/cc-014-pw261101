/**
 * 事件注册表：每类事件的版本号与字段白名单。
 * SDK 与服务端共用这一份定义，保证两端规则一致。
 *
 * FieldRule.pii 含义：
 *  - "phone"    手机号字段，按 config.pii.phone 处理
 *  - "email"    邮箱字段，按 config.pii.email 处理
 *  - "freetext" 表单自由文本，按 config.pii.freetext 处理；
 *               脱敏模式下还会扫描文本内嵌的手机号/邮箱
 */

export type PiiKind = 'phone' | 'email' | 'freetext';
export type PiiAction = 'drop' | 'mask';
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldRule {
  type: FieldType;
  /** 声明为 PII 后按 TrackerConfig.pii 中的策略处理 */
  pii?: PiiKind;
  /** type=object 时的嵌套白名单，逐层递归处理 */
  properties?: Record<string, FieldRule>;
  /** type=array 时的元素规则，数组逐元素处理 */
  items?: FieldRule;
}

export interface EventVersionDef {
  version: number;
  properties: Record<string, FieldRule>;
}

export type EventType =
  | 'page_view'
  | 'click'
  | 'search'
  | 'add_to_cart'
  | 'subscribe';

export const ENVELOPE_FIELDS = [
  'event_id',
  'event_type',
  'event_version',
  'session_id',
  'client_ts',
  'properties',
] as const;

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

const rule = (r: FieldRule): FieldRule => r;
const str = (pii?: PiiKind): FieldRule => ({ type: 'string', ...(pii ? { pii } : {}) });

export const EVENT_REGISTRY: Record<EventType, EventVersionDef> = {
  page_view: {
    version: 1,
    properties: {
      path: str(),
      referrer: str(),
      title: str(),
    },
  },
  click: {
    version: 1,
    properties: {
      element_id: str(),
      element_text: str('freetext'),
      position: rule({
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
      }),
    },
  },
  search: {
    version: 1,
    properties: {
      keyword: str('freetext'),
      result_count: { type: 'number' },
      filters: rule({
        type: 'object',
        properties: {
          category: str(),
          max_price: { type: 'number' },
          tags: rule({ type: 'array', items: str() }),
        },
      }),
    },
  },
  add_to_cart: {
    version: 1,
    properties: {
      product_id: str(),
      product_name: str(),
      price: { type: 'number' },
      quantity: { type: 'number' },
      meta: rule({
        type: 'object',
        properties: {
          source: str(),
          campaign: str(),
          extra: rule({
            type: 'object',
            properties: {
              note: str('freetext'),
            },
          }),
        },
      }),
    },
  },
  subscribe: {
    version: 1,
    properties: {
      channel: str(),
      phone: str('phone'),
      email: str('email'),
      message: str('freetext'),
    },
  },
};

export function getEventDef(type: string): EventVersionDef | undefined {
  return (EVENT_REGISTRY as Record<string, EventVersionDef>)[type];
}

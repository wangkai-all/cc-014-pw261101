import {
  ENVELOPE_FIELDS,
  getEventDef,
  type EventType,
  type FieldRule,
  type FieldType,
  type PiiAction,
  type PiiKind,
} from './schema.js';
import { freetextHasPii, maskValue } from './pii.js';

/**
 * 浏览器端过滤引擎。
 * 安全红线：
 *  - 被 drop 的字段原值不会出现在返回的 payload、trace（调试原因）或任何返回结构中；
 *  - trace 只记录路径 + 动作 + 原因，从不携带字段原值；
 *  - 白名单之外的字段一律删除，嵌套对象逐层递归处理。
 */

export type FilterReason =
  | 'not_in_whitelist' // 不在字段白名单
  | 'type_mismatch' // 类型与声明不符
  | 'pii_dropped' // PII 策略：删除
  | 'pii_masked' // PII 策略：脱敏
  | 'array_item_dropped' // 数组元素被删除
  | 'empty_object_removed'; // 嵌套对象被清空后移除

export interface FilterTrace {
  path: string;
  action: 'dropped' | 'masked' | 'kept';
  reason: FilterReason;
  pii?: PiiKind;
  /** 规则版本，便于调试台展示 */
  event_version?: number;
}

export interface PiiPolicy {
  phone: PiiAction;
  email: PiiAction;
  freetext: PiiAction;
}

export const DEFAULT_PII_POLICY: PiiPolicy = {
  phone: 'mask',
  email: 'mask',
  freetext: 'mask',
};

export interface FilterResult {
  /** 已过滤、可安全进入队列/网络请求的事件 */
  payload: Record<string, unknown>;
  /** 字段处理原因（不含任何原值） */
  trace: FilterTrace[];
}

const JSON_TYPE: Record<FieldType, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

function joinPath(base: string, key: string | number): string {
  return base === '' ? String(key) : `${base}.${key}`;
}

/**
 * 按白名单递归过滤一个对象。
 * @returns 过滤后的对象；若整个对象无合法字段则返回 null（由上层移除）
 */
function filterObject(
  input: Record<string, unknown>,
  rules: Record<string, FieldRule>,
  policy: PiiPolicy,
  basePath: string,
  trace: FilterTrace[],
  eventVersion: number,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(input)) {
    const path = joinPath(basePath, key);
    const ruleDef = rules[key];

    // 1. 白名单之外：直接删除，原值不进入任何输出
    if (!ruleDef) {
      trace.push({ path, action: 'dropped', reason: 'not_in_whitelist', event_version: eventVersion });
      continue;
    }

    // 2. 类型不符：删除
    if (!JSON_TYPE[ruleDef.type](rawValue)) {
      trace.push({ path, action: 'dropped', reason: 'type_mismatch', event_version: eventVersion });
      continue;
    }

    // 3. PII 字段处理
    if (ruleDef.pii && typeof rawValue === 'string') {
      const action = policy[ruleDef.pii];
      const hasPii =
        ruleDef.pii === 'freetext'
          ? freetextHasPii(rawValue)
          : true; // phone/email 字段本身即视为 PII，无论内容是否匹配

      if (!hasPii) {
        // 自由文本中没有 PII，原样保留
        out[key] = rawValue;
        continue;
      }

      if (action === 'drop') {
        // 原值在此处被丢弃，之后任何环节都拿不到它
        trace.push({
          path,
          action: 'dropped',
          reason: 'pii_dropped',
          pii: ruleDef.pii,
          event_version: eventVersion,
        });
        continue;
      }

      const masked = maskValue(rawValue, ruleDef.pii);
      out[key] = masked;
      trace.push({
        path,
        action: 'masked',
        reason: 'pii_masked',
        pii: ruleDef.pii,
        event_version: eventVersion,
      });
      continue;
    }

    // 4. 嵌套对象：逐层递归
    if (ruleDef.type === 'object' && ruleDef.properties) {
      const child = filterObject(
        rawValue as Record<string, unknown>,
        ruleDef.properties,
        policy,
        path,
        trace,
        eventVersion,
      );
      if (child === null || Object.keys(child).length === 0) {
        trace.push({ path, action: 'dropped', reason: 'empty_object_removed', event_version: eventVersion });
        continue;
      }
      out[key] = child;
      continue;
    }

    // 5. 数组：逐元素处理
    if (ruleDef.type === 'array' && ruleDef.items) {
      const kept: unknown[] = [];
      (rawValue as unknown[]).forEach((item, idx) => {
        const itemPath = joinPath(path, idx);
        const processed = filterValue(item, ruleDef.items!, policy, itemPath, trace, eventVersion);
        if (processed === DROP) {
          trace.push({
            path: itemPath,
            action: 'dropped',
            reason: 'array_item_dropped',
            event_version: eventVersion,
          });
        } else {
          kept.push(processed);
        }
      });
      out[key] = kept;
      continue;
    }

    // 6. 普通合法字段
    out[key] = rawValue;
  }

  return Object.keys(out).length === 0 ? null : out;
}

const DROP = Symbol('drop');

function filterValue(
  value: unknown,
  ruleDef: FieldRule,
  policy: PiiPolicy,
  path: string,
  trace: FilterTrace[],
  eventVersion: number,
): unknown {
  if (!JSON_TYPE[ruleDef.type](value)) {
    trace.push({ path, action: 'dropped', reason: 'type_mismatch', event_version: eventVersion });
    return DROP;
  }

  if (ruleDef.pii && typeof value === 'string') {
    const action = policy[ruleDef.pii];
    const hasPii = ruleDef.pii === 'freetext' ? freetextHasPii(value) : true;
    if (!hasPii) return value;
    if (action === 'drop') {
      trace.push({ path, action: 'dropped', reason: 'pii_dropped', pii: ruleDef.pii, event_version: eventVersion });
      return DROP;
    }
    trace.push({ path, action: 'masked', reason: 'pii_masked', pii: ruleDef.pii, event_version: eventVersion });
    return maskValue(value, ruleDef.pii);
  }

  if (ruleDef.type === 'object' && ruleDef.properties) {
    return filterObject(value as Record<string, unknown>, ruleDef.properties, policy, path, trace, eventVersion) ?? DROP;
  }

  if (ruleDef.type === 'array' && ruleDef.items) {
    const kept: unknown[] = [];
    (value as unknown[]).forEach((item, idx) => {
      const processed = filterValue(item, ruleDef.items!, policy, joinPath(path, idx), trace, eventVersion);
      if (processed === DROP) {
        trace.push({
          path: joinPath(path, idx),
          action: 'dropped',
          reason: 'array_item_dropped',
          event_version: eventVersion,
        });
      } else {
        kept.push(processed);
      }
    });
    return kept;
  }

  return value;
}

/** 信封（envelope）字段白名单校验：未知信封字段同样删除 */
function filterEnvelope(input: Record<string, unknown>, trace: FilterTrace[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = new Set<string>(ENVELOPE_FIELDS);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) {
      trace.push({ path: joinPath('$', key), action: 'dropped', reason: 'not_in_whitelist' });
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface EnvelopeInput {
  event_id: string;
  event_type: string;
  event_version: number;
  session_id: string;
  client_ts: number;
  properties: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * 过滤一整条事件。
 * 若事件类型未注册或 properties 全部不合法，返回 null（调用方应放弃该事件并记录原因）。
 */
export function filterEvent(raw: EnvelopeInput, policy: PiiPolicy = DEFAULT_PII_POLICY): FilterResult | null {
  const trace: FilterTrace[] = [];
  const def = getEventDef(raw.event_type);
  if (!def) {
    trace.push({ path: '$.event_type', action: 'dropped', reason: 'not_in_whitelist' });
    return { payload: {}, trace };
  }

  const envelope = filterEnvelope(raw, trace);
  const filteredProps = filterObject(
    (raw.properties ?? {}) as Record<string, unknown>,
    def.properties,
    policy,
    'properties',
    trace,
    def.version,
  );

  const payload = {
    ...envelope,
    event_type: raw.event_type as EventType,
    event_version: def.version,
    properties: filteredProps ?? {},
  };

  return { payload, trace };
}

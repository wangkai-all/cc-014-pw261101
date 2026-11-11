import { getEventDef, type FieldRule, type FieldType } from './schema.js';
import { containsAnyPii, containsEmail, containsPhone } from './pii.js';
import { DEFAULT_PII_POLICY, type PiiPolicy } from './filter.js';

/**
 * 服务端严格校验。
 * 与浏览器端过滤共用同一份 EVENT_REGISTRY，但策略不同：
 *  - 浏览器端：静默删除/脱敏，尽量保留事件；
 *  - 服务端：任何未知字段、类型错误、未处理的 PII 都判定该条不合法，
 *    批次内其余合法事件照常落库（逐条结果）。
 * 错误信息只含字段路径与原因，绝不回显原值。
 */

export interface ValidationError {
  path: string;
  reason:
    | 'missing_field'
    | 'not_in_whitelist'
    | 'type_mismatch'
    | 'unknown_event_type'
    | 'version_mismatch'
    | 'pii_leak';
}

export interface EventValidationResult {
  event_id: string | null;
  valid: boolean;
  errors: ValidationError[];
}

export const MAX_BATCH_SIZE = 100;

const TYPE_CHECK: Record<FieldType, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

function join(base: string, key: string | number): string {
  return base === '' ? String(key) : `${base}.${key}`;
}

function piiEscaped(value: string, kind: NonNullable<FieldRule['pii']>, policy: PiiPolicy): boolean {
  // 脱敏后的数据不应再命中原始 PII 模式；命中说明客户端没按规则处理
  if (kind === 'phone') return !containsPhone(value);
  if (kind === 'email') return !containsEmail(value);
  if (policy.freetext === 'drop') return true; // drop 策略下该字段理应已被删除，走到这里即异常
  return !containsAnyPii(value);
}

function validateValue(
  value: unknown,
  ruleDef: FieldRule,
  path: string,
  errors: ValidationError[],
  policy: PiiPolicy,
): void {
  if (!TYPE_CHECK[ruleDef.type](value)) {
    errors.push({ path, reason: 'type_mismatch' });
    return;
  }

  if (ruleDef.pii && typeof value === 'string') {
    if (!piiEscaped(value, ruleDef.pii, policy)) {
      errors.push({ path, reason: 'pii_leak' });
    }
  }

  if (ruleDef.type === 'object' && ruleDef.properties) {
    validateProperties(value as Record<string, unknown>, ruleDef.properties, path, errors, policy);
  }

  if (ruleDef.type === 'array' && ruleDef.items) {
    (value as unknown[]).forEach((item, idx) => {
      validateValue(item, ruleDef.items!, join(path, idx), errors, policy);
    });
  }
}

function validateProperties(
  props: Record<string, unknown>,
  rules: Record<string, FieldRule>,
  basePath: string,
  errors: ValidationError[],
  policy: PiiPolicy,
): void {
  for (const [key, value] of Object.entries(props)) {
    const path = join(basePath, key);
    const ruleDef = rules[key];
    if (!ruleDef) {
      errors.push({ path, reason: 'not_in_whitelist' });
      continue;
    }
    validateValue(value, ruleDef, path, errors, policy);
  }
}

export function validateEvent(input: unknown, policy: PiiPolicy = DEFAULT_PII_POLICY): EventValidationResult {
  const errors: ValidationError[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { event_id: null, valid: false, errors: [{ path: '$', reason: 'type_mismatch' }] };
  }
  const evt = input as Record<string, unknown>;
  const eventId = typeof evt.event_id === 'string' ? evt.event_id : null;

  const required: Array<[string, (v: unknown) => boolean]> = [
    ['event_id', (v) => typeof v === 'string' && v.length > 0],
    ['event_type', (v) => typeof v === 'string'],
    ['event_version', (v) => typeof v === 'number' && Number.isInteger(v)],
    ['session_id', (v) => typeof v === 'string' && v.length > 0],
    ['client_ts', (v) => typeof v === 'number' && Number.isFinite(v)],
    ['properties', (v) => typeof v === 'object' && v !== null && !Array.isArray(v)],
  ];
  for (const [field, check] of required) {
    if (evt[field] === undefined) errors.push({ path: join('$', field), reason: 'missing_field' });
    else if (!check(evt[field])) errors.push({ path: join('$', field), reason: 'type_mismatch' });
  }

  // 信封未知字段
  const envelopeAllowed = new Set([
    'event_id',
    'event_type',
    'event_version',
    'session_id',
    'client_ts',
    'properties',
  ]);
  for (const key of Object.keys(evt)) {
    if (!envelopeAllowed.has(key)) {
      errors.push({ path: join('$', key), reason: 'not_in_whitelist' });
    }
  }

  if (typeof evt.event_type === 'string') {
    const def = getEventDef(evt.event_type);
    if (!def) {
      errors.push({ path: '$.event_type', reason: 'unknown_event_type' });
    } else {
      if (evt.event_version !== def.version) {
        errors.push({ path: '$.event_version', reason: 'version_mismatch' });
      }
      if (typeof evt.properties === 'object' && evt.properties !== null) {
        validateProperties(
          evt.properties as Record<string, unknown>,
          def.properties,
          'properties',
          errors,
          policy,
        );
      }
    }
  }

  return { event_id: eventId, valid: errors.length === 0, errors };
}

export interface BatchCheck {
  valid: boolean;
  reason?: 'not_array' | 'batch_too_large' | 'empty';
  results?: EventValidationResult[];
}

export function validateBatch(batch: unknown, policy: PiiPolicy = DEFAULT_PII_POLICY): BatchCheck {
  if (!Array.isArray(batch)) return { valid: false, reason: 'not_array' };
  if (batch.length === 0) return { valid: false, reason: 'empty' };
  if (batch.length > MAX_BATCH_SIZE) return { valid: false, reason: 'batch_too_large' };
  return { valid: true, results: batch.map((item) => validateEvent(item, policy)) };
}

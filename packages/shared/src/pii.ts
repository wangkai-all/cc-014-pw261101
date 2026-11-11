import type { PiiKind } from './schema.js';

/**
 * PII 识别与脱敏。
 * 注意：本模块只输出「是否命中」和「脱敏后的值」，
 * 原始值不允许进入调试日志 / 队列 / 网络请求（由 filter.ts 保证）。
 */

// 中国大陆手机号：1 开头、第二位 3-9，共 11 位；用边界避免把长数字的一部分误判
export const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

// 邮箱
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export type PiiMatchKind = Exclude<PiiKind, 'freetext'> | 'phone' | 'email';

export function containsPhone(value: string): boolean {
  PHONE_RE.lastIndex = 0;
  return PHONE_RE.test(value);
}

export function containsEmail(value: string): boolean {
  EMAIL_RE.lastIndex = 0;
  return EMAIL_RE.test(value);
}

/** 字符串内嵌的任意 PII（用于自由文本脱敏扫描） */
export function containsAnyPii(value: string): boolean {
  return containsPhone(value) || containsEmail(value);
}

function maskPhoneString(value: string): string {
  return value.replace(PHONE_RE, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
}

function maskEmailString(value: string): string {
  return value.replace(EMAIL_RE, (m) => {
    const [local, domain] = m.split('@');
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
  });
}

/** 对单个手机号/邮箱字段整体脱敏 */
export function maskValue(value: string, kind: PiiKind): string {
  if (kind === 'phone') return maskPhoneString(value);
  if (kind === 'email') return maskEmailString(value);
  // freetext：扫描并替换文本内嵌的手机号与邮箱，保留其余文本
  return maskEmailString(maskPhoneString(value));
}

/** 自由文本是否包含 PII（决定是否需要脱敏/删除的前置判断） */
export function freetextHasPii(value: string): boolean {
  return containsAnyPii(value);
}

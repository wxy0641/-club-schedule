// 输入规范化与有界校验。只做纯函数，不触碰数据库。
import { AppError } from './http.mjs';

export const USERNAME_MIN_CHARS = 3;
export const USERNAME_MAX_CHARS = 32;
export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 256;
export const FULL_NAME_MAX_CHARS = 50;
export const NICKNAME_MAX_CHARS = 50;
export const SPACE_NAME_MAX_CHARS = 50;
export const COURSE_NAME_MAX_CHARS = 100;
export const MAX_ENTRIES = 12;

export function canonicalUsername(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_username', 400);
  const canonical = raw.trim().toLowerCase();
  if (canonical.length < USERNAME_MIN_CHARS || canonical.length > USERNAME_MAX_CHARS) {
    throw new AppError('invalid_username', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(canonical)) throw new AppError('invalid_username', 400);
  return canonical;
}

export function validatePassword(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_password', 400);
  if ([...raw].length < PASSWORD_MIN_CHARS) throw new AppError('invalid_password', 400);
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) throw new AppError('invalid_password', 400);
  return raw;
}

const controlChars = /[\u0000-\u001f\u007f]/;

// 昵称只用于本人展示，可重复、可留空；不是登录标识，也不作为空间内姓名。
export function validateNickname(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new AppError('invalid_input', 400);
  const value = raw.trim();
  if (!value) return null;
  if ([...value].length > NICKNAME_MAX_CHARS || controlChars.test(value)) {
    throw new AppError('invalid_input', 400);
  }
  return value;
}

export function validateFullName(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_input', 400);
  const value = raw.trim();
  if (!value || [...value].length > FULL_NAME_MAX_CHARS || controlChars.test(value)) {
    throw new AppError('invalid_input', 400);
  }
  return value;
}

export function validateSpaceName(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_input', 400);
  const value = raw.trim();
  if (!value || [...value].length > SPACE_NAME_MAX_CHARS || controlChars.test(value)) {
    throw new AppError('invalid_input', 400);
  }
  return value;
}

export function validateMode(raw) {
  if (raw !== 'presence' && raw !== 'courses') throw new AppError('invalid_input', 400);
  return raw;
}

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function validateVersion(raw) {
  if (!Number.isSafeInteger(raw) || raw < 0) throw new AppError('invalid_input', 400);
  return raw;
}

// 整表提交：entries 覆盖该成员在该空间的全部格子；空白格用 hasClass=false 表示。
export function validateEntries(raw, mode) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENTRIES) {
    throw new AppError('invalid_input', 400);
  }
  const seen = new Set();
  const normalized = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('invalid_input', 400);
    const day = item.day;
    const period = item.period;
    if (!Number.isSafeInteger(day) || day < 1 || day > 7) throw new AppError('invalid_input', 400);
    if (!Number.isSafeInteger(period) || period < 1 || period > MAX_ENTRIES) throw new AppError('invalid_input', 400);
    const slot = `${day}:${period}`;
    if (seen.has(slot)) throw new AppError('invalid_input', 400);
    seen.add(slot);
    if (typeof item.hasClass !== 'boolean') throw new AppError('invalid_input', 400);

    let courseName = item.courseName ?? null;
    if (courseName !== null && typeof courseName !== 'string') throw new AppError('invalid_input', 400);
    if (typeof courseName === 'string') {
      courseName = courseName.trim();
      if (controlChars.test(courseName)) throw new AppError('invalid_input', 400);
      if (courseName.length > COURSE_NAME_MAX_CHARS) throw new AppError('invalid_input', 400);
      if (!courseName) courseName = null;
    }
    if (!item.hasClass && courseName !== null) throw new AppError('invalid_input', 400);
    if (mode === 'presence' && courseName !== null) throw new AppError('invalid_input', 400);

    normalized.push({ day, period, hasClass: item.hasClass, courseName });
  }
  return normalized;
}

// S2a 周课表：存储层仍兼容 every / odd / even，用于读取旧数据与原投影；
// 新写入统一归一到空间负责人配置的单一周次规则，成员端不再逐格选择。
import { AppError } from './http.mjs';
import { COURSE_NAME_MAX_CHARS } from './validate.mjs';
import { sha256Hex } from './sessions.mjs';
import { UNIFORM_WEEK_RULES } from './config.mjs';

export const WEEK_RULES = ['every', 'odd', 'even'];
export const SCHEDULE_BODY_LIMIT_BYTES = 64 * 1024;
export const SCHEDULE_DOCUMENT_COLUMNS = [
  'id', 'space_id', 'member_id', 'revision', 'draft_entries', 'published_entries',
  'published_version', 'draft_updated_at', 'published_at', 'updated_at',
  'last_request_id', 'last_request_op', 'last_request_digest',
].join(',');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const RULE_ORDER = { every: 0, odd: 1, even: 2 };
const controlChars = /[\u0000-\u001f\u007f]/;

export function validateRequestId(raw) {
  if (typeof raw !== 'string' || !REQUEST_ID_PATTERN.test(raw)) {
    throw new AppError('invalid_request_id', 400);
  }
  return raw;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.day - b.day)
    || (a.period - b.period)
    || (RULE_ORDER[a.weekRule] - RULE_ORDER[b.weekRule]));
}

// 整表校验：entries 为空表示“全周无课”；空白格不单独落库。
// 周次由空间统一规则决定：缺省 weekRule 按该规则归一化，其他规则一律拒绝。
export function validateWeekEntries(raw, config) {
  if (!Array.isArray(raw)) throw new AppError('invalid_input', 400);
  if (!UNIFORM_WEEK_RULES.includes(config.weekRule)) {
    throw new AppError('space_week_rule_unresolved', 409);
  }
  const periodIndexes = new Set(config.periods.map((period) => period.index));
  const maxEntries = 7 * config.periods.length;
  if (raw.length > maxEntries) throw new AppError('invalid_input', 400);

  const slots = new Set();
  const normalized = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError('invalid_input', 400);
    }
    const { day, period } = item;
    const weekRule = item.weekRule === undefined ? config.weekRule : item.weekRule;
    if (!Number.isSafeInteger(day) || day < 1 || day > 7) {
      throw new AppError('invalid_input', 400);
    }
    if (!Number.isSafeInteger(period) || !periodIndexes.has(period)) {
      throw new AppError('invalid_period', 400);
    }
    if (!WEEK_RULES.includes(weekRule)) {
      throw new AppError('invalid_week_rule', 400);
    }
    if (weekRule !== config.weekRule) {
      throw new AppError('week_rule_mismatch', 400);
    }

    const slot = `${day}:${period}`;
    if (slots.has(slot)) throw new AppError('duplicate_cell', 400);
    slots.add(slot);

    const entry = { day, period, weekRule };
    if (config.mode === 'courses') {
      if (typeof item.courseName !== 'string') throw new AppError('invalid_course_name', 400);
      const courseName = item.courseName.trim();
      if (!courseName || [...courseName].length > COURSE_NAME_MAX_CHARS || controlChars.test(courseName)) {
        throw new AppError('invalid_course_name', 400);
      }
      entry.courseName = courseName;
    } else if (item.courseName !== undefined && item.courseName !== null) {
      if (typeof item.courseName !== 'string' || item.courseName.trim() !== '') {
        throw new AppError('invalid_course_name', 400);
      }
    }
    normalized.push(entry);
  }
  return sortEntries(normalized);
}

export function scheduleRequestDigest(operation, baseRevision, entries, collectionJoin = false) {
  const payload = { operation, baseRevision, entries };
  if (collectionJoin) payload.collectionJoin = true;
  return sha256Hex(JSON.stringify(payload));
}

export function scheduleDocumentView(row) {
  if (!row) {
    return {
      revision: 0,
      draftEntries: null,
      publishedEntries: null,
      publishedVersion: 0,
      draftUpdatedAt: null,
      publishedAt: null,
      updatedAt: null,
      exists: false,
      submitted: false,
    };
  }
  const publishedVersion = Number.isSafeInteger(row.published_version) ? row.published_version : 0;
  return {
    revision: Number.isSafeInteger(row.revision) ? row.revision : 0,
    draftEntries: Array.isArray(row.draft_entries) ? row.draft_entries : null,
    publishedEntries: Array.isArray(row.published_entries) ? row.published_entries : null,
    publishedVersion,
    draftUpdatedAt: row.draft_updated_at ?? null,
    publishedAt: row.published_at ?? null,
    updatedAt: row.updated_at ?? null,
    exists: true,
    submitted: publishedVersion > 0,
  };
}

export function isPublishedDocument(row) {
  return Number.isSafeInteger(row?.published_version) && row.published_version > 0;
}

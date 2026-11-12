// 空间创建配置的校验与 S2 读契约。节次上限是可调整的工程默认值，不是产品规则。
import { AppError } from './http.mjs';
import { validateFullName, validateMode, validateSpaceName } from './validate.mjs';

export const CONFIG_VERSION = 1;
export const PERIODS_MIN = 1;
export const PERIODS_MAX = 20;
export const VISIBILITIES = ['stats', 'masked_list'];
export const UNIFORM_WEEK_RULES = ['every', 'odd', 'even'];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateUniformWeekRule(raw) {
  if (!UNIFORM_WEEK_RULES.includes(raw)) throw new AppError('invalid_input', 400);
  return raw;
}

export function validateVisibility(raw) {
  if (!VISIBILITIES.includes(raw)) throw new AppError('invalid_input', 400);
  return raw;
}

export function validatePeriods(raw) {
  if (!Array.isArray(raw) || raw.length < PERIODS_MIN || raw.length > PERIODS_MAX) {
    throw new AppError('invalid_input', 400);
  }
  const periods = [];
  let previousEnd = null;
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('invalid_input', 400);
    if (item.index !== index + 1) throw new AppError('invalid_input', 400);
    if (typeof item.start !== 'string' || !TIME_PATTERN.test(item.start)) throw new AppError('invalid_input', 400);
    if (typeof item.end !== 'string' || !TIME_PATTERN.test(item.end)) throw new AppError('invalid_input', 400);
    if (item.start >= item.end) throw new AppError('invalid_input', 400);
    if (previousEnd !== null && item.start < previousEnd) throw new AppError('invalid_input', 400);
    previousEnd = item.end;
    periods.push({ index: index + 1, start: item.start, end: item.end });
  }
  return periods;
}

export function validateSpaceConfig(body) {
  const name = validateSpaceName(body?.name);
  const ownerName = validateFullName(body?.ownerName);
  const mode = validateMode(body?.mode);
  // 新空间必须明确选择统一周次规则；旧的 oddEvenEnabled=false 仍按“每周”兼容，
  // 但 true 不再被静默解释成单周或双周。
  let weekRule;
  if (body?.weekRule !== undefined) weekRule = validateUniformWeekRule(body.weekRule);
  else if (body?.oddEvenEnabled === false) weekRule = 'every';
  else throw new AppError('invalid_input', 400);
  const visibility = validateVisibility(body?.visibility);
  const periods = validatePeriods(body?.periods);
  return {
    name,
    ownerName,
    mode,
    config: {
      version: CONFIG_VERSION,
      mode,
      weekRule,
      oddEvenEnabled: weekRule !== 'every',
      periods,
      visibility,
    },
  };
}

// 旧空间没有 config；读取方应把 null 视为“未通过 S1 创建流程配置”，而不是猜测默认节次。
// 旧配置没有 weekRule：这里保持 null，由路由层结合既有课表数据推断；
// 不能把 oddEvenEnabled=true 直接映射成单周或双周。
export function publicConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== CONFIG_VERSION) return null;
  if (raw.mode !== 'presence' && raw.mode !== 'courses') return null;
  if (typeof raw.oddEvenEnabled !== 'boolean') return null;
  const weekRule = UNIFORM_WEEK_RULES.includes(raw.weekRule) ? raw.weekRule : null;
  if (!VISIBILITIES.includes(raw.visibility)) return null;
  if (!Array.isArray(raw.periods) || raw.periods.length < PERIODS_MIN || raw.periods.length > PERIODS_MAX) return null;
  const periods = [];
  for (let index = 0; index < raw.periods.length; index += 1) {
    const item = raw.periods[index];
    if (!item || typeof item !== 'object') return null;
    if (item.index !== index + 1) return null;
    if (typeof item.start !== 'string' || !TIME_PATTERN.test(item.start)) return null;
    if (typeof item.end !== 'string' || !TIME_PATTERN.test(item.end)) return null;
    if (item.start >= item.end) return null;
    if (index > 0 && item.start < periods[index - 1].end) return null;
    periods.push({ index: item.index, start: item.start, end: item.end });
  }
  return {
    version: raw.version,
    mode: raw.mode,
    weekRule,
    oddEvenEnabled: weekRule ? weekRule !== 'every' : raw.oddEvenEnabled,
    periods,
    visibility: raw.visibility,
  };
}

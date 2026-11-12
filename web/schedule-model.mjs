// S2a 周课表前端模型：与浏览器、界面无关的纯函数，供页面和本地测试共用。
export const WEEK_RULES = ['every', 'odd', 'even'];
export const RULE_LABELS = { every: '每周', odd: '单周', even: '双周' };
export const DAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const COURSE_NAME_MAX_CHARS = 100;

const RULE_ORDER = { every: 0, odd: 1, even: 2 };
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function scheduleKey(day, period) {
  return `${day}:${period}`;
}

export function emptyCell(day, period) {
  return { day, period, every: null, odd: null, even: null };
}

export function cloneRuleValue(value) {
  return value?.hasClass
    ? { hasClass: true, courseName: value.courseName ?? null }
    : null;
}

export function cloneCell(cell) {
  return {
    day: cell.day,
    period: cell.period,
    every: cloneRuleValue(cell.every),
    odd: cloneRuleValue(cell.odd),
    even: cloneRuleValue(cell.even),
  };
}

export function cloneCellInto(cell, day, period) {
  return { ...cloneCell(cell), day, period };
}

function cleanValue(value, mode) {
  if (!value?.hasClass) return null;
  return {
    hasClass: true,
    courseName: mode === 'courses' ? String(value.courseName ?? '').trim() : null,
  };
}

export function entriesToSlots(entries, mode) {
  const slots = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !WEEK_RULES.includes(entry.weekRule)) continue;
    const key = scheduleKey(entry.day, entry.period);
    const cell = slots.get(key) ?? emptyCell(entry.day, entry.period);
    cell[entry.weekRule] = {
      hasClass: true,
      courseName: mode === 'courses' ? String(entry.courseName ?? '') : null,
    };
    slots.set(key, cell);
  }
  return slots;
}

export function normalizeCell(cell, mode) {
  const normalized = emptyCell(cell.day, cell.period);
  for (const rule of WEEK_RULES) {
    normalized[rule] = cleanValue(cell[rule], mode);
  }
  return normalized;
}

export function slotsToEntries(slots, mode) {
  const entries = [];
  for (const slot of slots.values()) {
    const cell = normalizeCell(slot, mode);
    for (const rule of WEEK_RULES) {
      if (!cell[rule]) continue;
      const entry = { day: cell.day, period: cell.period, weekRule: rule };
      if (mode === 'courses') entry.courseName = cell[rule].courseName;
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => (a.day - b.day)
    || (a.period - b.period)
    || (RULE_ORDER[a.weekRule] - RULE_ORDER[b.weekRule]));
}

export function canonicalEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && WEEK_RULES.includes(entry.weekRule))
    .map((entry) => {
      const item = { day: entry.day, period: entry.period, weekRule: entry.weekRule };
      if (typeof entry.courseName === 'string') item.courseName = entry.courseName;
      return item;
    })
    .sort((a, b) => (a.day - b.day)
      || (a.period - b.period)
      || (RULE_ORDER[a.weekRule] - RULE_ORDER[b.weekRule]));
}

export function entriesEqual(left, right) {
  return JSON.stringify(canonicalEntries(left)) === JSON.stringify(canonicalEntries(right));
}

export function cellHasContent(cell) {
  return Boolean(cell?.every?.hasClass || cell?.odd?.hasClass || cell?.even?.hasClass);
}

export function countClassSlots(slots) {
  let count = 0;
  for (const cell of slots.values()) {
    if (cellHasContent(cell)) count += 1;
  }
  return count;
}

export function ruleMode(cell) {
  return cell?.odd?.hasClass || cell?.even?.hasClass ? 'split' : 'every';
}

export function describeRuleValue(value, mode) {
  if (!value?.hasClass) return '无课';
  return mode === 'courses' ? `有课 · ${value.courseName}` : '有课';
}

export function validateCell(cell, mode) {
  const every = Boolean(cell?.every?.hasClass);
  const odd = Boolean(cell?.odd?.hasClass);
  const even = Boolean(cell?.even?.hasClass);
  if (every && (odd || even)) {
    return { ok: false, code: 'week_rule_conflict', message: '“每周”不能与单周或双周同时存在。' };
  }
  if (mode !== 'courses') return { ok: true };
  for (const rule of WEEK_RULES) {
    if (!cell?.[rule]?.hasClass) continue;
    const name = String(cell[rule].courseName ?? '').trim();
    if (!name) {
      return { ok: false, code: 'invalid_course_name', message: `${RULE_LABELS[rule]}课程名不能为空。` };
    }
    if ([...name].length > COURSE_NAME_MAX_CHARS) {
      return { ok: false, code: 'invalid_course_name', message: `${RULE_LABELS[rule]}课程名超过 ${COURSE_NAME_MAX_CHARS} 个字符。` };
    }
    if (CONTROL_CHARS.test(name)) {
      return { ok: false, code: 'invalid_course_name', message: `${RULE_LABELS[rule]}课程名包含不可见控制字符。` };
    }
  }
  return { ok: true };
}

function sameRuleValue(left, right) {
  return (left?.courseName ?? '') === (right?.courseName ?? '');
}

// 切换规则前先算出受影响内容；调用方在用户确认后才调用 applyRuleSwitch。
export function planRuleSwitch(cell, target) {
  const every = cloneRuleValue(cell.every);
  const odd = cloneRuleValue(cell.odd);
  const even = cloneRuleValue(cell.even);
  if (target === 'split') {
    if (every) return { kind: 'expand', value: every };
    return { kind: 'switch' };
  }
  if (target === 'every') {
    if (!odd && !even) return { kind: 'switch' };
    if (odd && even) {
      if (sameRuleValue(odd, even)) {
        return { kind: 'merge', source: 'both', value: cloneRuleValue(odd) };
      }
      return { kind: 'choose', odd, even };
    }
    return { kind: 'merge', source: odd ? 'odd' : 'even', value: cloneRuleValue(odd ?? even) };
  }
  throw new Error('invalid_rule_target');
}

// choice 只在 plan.kind === 'choose' 时使用；未选择时保持空单元格，绝不默认覆盖。
export function applyRuleSwitch(cell, target, plan, choice) {
  const result = emptyCell(cell.day, cell.period);
  if (target === 'split') {
    if (plan.kind === 'expand') {
      result.odd = cloneRuleValue(plan.value);
      result.even = cloneRuleValue(plan.value);
    }
    return result;
  }
  let value = null;
  if (plan.kind === 'merge') value = plan.value;
  if (plan.kind === 'choose') {
    if (choice === 'odd') value = plan.odd;
    else if (choice === 'even') value = plan.even;
  }
  if (value) result.every = cloneRuleValue(value);
  return result;
}

export function previousCell(slots, day, period) {
  if (period <= 1) return null;
  const previous = slots.get(scheduleKey(day, period - 1));
  if (!previous || !cellHasContent(previous)) return null;
  return { period: period - 1, cell: cloneCell(previous) };
}

export function daySlideDuration(distance, reducedMotion = false) {
  if (reducedMotion) return 0;
  const days = Math.max(1, Math.min(6, Math.abs(Number(distance) || 1)));
  return Math.min(650, 220 + (days - 1) * 90);
}

export function swipeTargetDay(day, deltaX, threshold = 48) {
  if (Math.abs(deltaX) < threshold) return day;
  const target = day + (deltaX < 0 ? 1 : -1);
  return Math.max(1, Math.min(7, target));
}

export const SWIPE_DISTANCE_RATIO = 0.18;
export const SWIPE_VELOCITY = 0.35;

// 吸附目标由可见位移决定，快甩至少跨一天；只允许落在实际拖过的页附近。
export function swipeDestination(day, deltaX, width, velocity = 0) {
  const viewport = Math.max(1, Number(width) || 1);
  const moved = Math.abs(Number(deltaX) || 0) / viewport;
  const speed = Number(velocity) || 0;
  const flick = Math.abs(speed) >= SWIPE_VELOCITY
    && Math.sign(speed) === Math.sign(Number(deltaX) || 0);
  if (moved < SWIPE_DISTANCE_RATIO && !flick) return day;
  const direction = deltaX < 0 ? 1 : -1;
  const steps = Math.max(1, Math.round(moved));
  return Math.max(1, Math.min(7, day + direction * steps));
}

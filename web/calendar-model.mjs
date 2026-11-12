// 月历页面使用的纯日期与展示模型。日期只按日历日计算，不使用毫秒差或 ISO 周号；
// “今天”由空间时区推导，页面切换月份不会改写周课表规则。
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const PERSONAL_LABELS = { none: '不声明', busy: '忙', available: '有空' };

export const STATUS_LABELS = {
  class_occupied: '有课',
  busy: '忙碌',
  available: '有空',
  no_class: '没课',
  conflict: '冲突待确认',
  unknown: '未提交',
  term_out: '学期外',
};

export const LEGEND = [
  { kind: 'class', label: '有课' },
  { kind: 'busy', label: '个人忙' },
  { kind: 'available', label: '个人有空' },
  { kind: 'cancel', label: '已停课' },
  { kind: 'conflict', label: '冲突' },
  { kind: 'none', label: '没课' },
  { kind: 'unknown', label: '未提交' },
  { kind: 'term', label: '学期外' },
];

export function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

export function civilFromDays(serial) {
  const z = serial + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460)
    + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function isValidDate(raw) {
  if (typeof raw !== 'string') return false;
  const matched = DATE_PATTERN.exec(raw);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1900 || year > 2200) return false;
  const back = civilFromDays(daysFromCivil(year, month, day));
  return back.year === year && back.month === month && back.day === day;
}

export function dateSerial(raw) {
  if (!isValidDate(raw)) return null;
  return daysFromCivil(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)), Number(raw.slice(8, 10)));
}

export function weekdayMon1(date) {
  const serial = dateSerial(date);
  if (serial === null) return null;
  return ((serial + 3) % 7 + 7) % 7 + 1;
}

export function addDays(date, amount) {
  const serial = dateSerial(date);
  if (serial === null || !Number.isSafeInteger(amount)) return null;
  const civil = civilFromDays(serial + amount);
  return `${civil.year}-${pad2(civil.month)}-${pad2(civil.day)}`;
}

export function mondayOf(date) {
  const weekday = weekdayMon1(date);
  return weekday === null ? null : addDays(date, 1 - weekday);
}

export function teachingWeekNumber(teaching, date) {
  const anchor = dateSerial(teaching?.firstWeekMonday);
  const target = dateSerial(date);
  if (anchor === null || target === null || target < anchor) return null;
  return Math.floor((target - anchor) / 7) + 1;
}

export function daysInMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)
    - daysFromCivil(year, month, 1);
}

export function validMonth(raw) {
  if (typeof raw !== 'string') return null;
  const matched = MONTH_PATTERN.exec(raw);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null;
  return `${year}-${pad2(month)}`;
}

export function shiftMonth(month, delta) {
  const normalized = validMonth(month);
  if (!normalized || !Number.isSafeInteger(delta)) return null;
  let year = Number(normalized.slice(0, 4));
  let index = Number(normalized.slice(5, 7)) - 1 + delta;
  year += Math.floor(index / 12);
  index = ((index % 12) + 12) % 12;
  return `${year}-${pad2(index + 1)}`;
}

export function monthLabel(month) {
  const normalized = validMonth(month);
  if (!normalized) return '';
  return `${normalized.slice(0, 4)} 年 ${Number(normalized.slice(5, 7))} 月`;
}

// 返回按周一开头排布的周数组；月外补位为 null，不把补位日期计入当月。
export function monthGrid(month) {
  const normalized = validMonth(month);
  if (!normalized) return [];
  const year = Number(normalized.slice(0, 4));
  const index = Number(normalized.slice(5, 7));
  const firstWeekday = weekdayMon1(`${normalized}-01`) - 1;
  const total = daysInMonth(year, index);
  const cells = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(`${normalized}-${pad2(day)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let index2 = 0; index2 < cells.length; index2 += 7) {
    weeks.push(cells.slice(index2, index2 + 7));
  }
  return weeks;
}

// 固定六行：4/5/6 行月份切换时表格高度与行位置不跳动，空白格不承载数据。
export function monthWeeks(month) {
  const weeks = monthGrid(month);
  while (weeks.length < 6) weeks.push(Array(7).fill(null));
  return weeks;
}

export function todayInZone(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const value = (type) => parts.find((part) => part.type === type)?.value;
    const today = `${value('year')}-${value('month')}-${value('day')}`;
    return isValidDate(today) ? today : null;
  } catch {
    return null;
  }
}

export function teachingWeekCount(anchor, termEnd) {
  const start = dateSerial(anchor);
  const end = dateSerial(termEnd);
  if (start === null || end === null || end < start) return null;
  return Math.floor((end - start) / 7) + 1;
}

const TIMEZONES = new Set([
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei',
  'Asia/Singapore', 'Asia/Tokyo', 'UTC',
]);

export function isSupportedTimezone(value) {
  return TIMEZONES.has(value);
}

const TIMEZONE_NAMES = new Map([
  ['Asia/Shanghai', '北京时间'],
  ['Asia/Hong_Kong', '香港时间'],
  ['Asia/Macau', '澳门时间'],
  ['Asia/Taipei', '台北时间'],
  ['Asia/Singapore', '新加坡时间'],
  ['Asia/Tokyo', '日本时间'],
  ['UTC', '协调世界时'],
]);

// 偏移按给定日期实时计算；夏令时地区不会套用固定偏移。名称缺失时回退 IANA 标识。
export function timezoneLabel(value, when = new Date()) {
  if (!value) return '';
  const date = when instanceof Date && !Number.isNaN(when.getTime())
    ? when
    : new Date(when);
  const at = Number.isNaN(date.getTime()) ? new Date() : date;
  let offset = '';
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: value, timeZoneName: 'longOffset',
    }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? '';
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (match) {
      const hours = Number(match[2] ?? 0);
      const minutes = Number(match[3] ?? 0);
      offset = hours === 0 && minutes === 0
        ? 'UTC+0'
        : `UTC${match[1]}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
    }
  } catch {
    offset = '';
  }
  const friendly = TIMEZONE_NAMES.get(value) ?? value;
  return offset ? `${friendly}（${offset}）` : friendly;
}

export function timezoneOptions() {
  return [
    { value: '', label: '请选择时区' },
    { value: 'Asia/Shanghai', label: `${timezoneLabel('Asia/Shanghai')}，中国大陆常用` },
    { value: 'Asia/Hong_Kong', label: timezoneLabel('Asia/Hong_Kong') },
    { value: 'Asia/Macau', label: timezoneLabel('Asia/Macau') },
    { value: 'Asia/Taipei', label: timezoneLabel('Asia/Taipei') },
    { value: 'Asia/Singapore', label: timezoneLabel('Asia/Singapore') },
    { value: 'Asia/Tokyo', label: timezoneLabel('Asia/Tokyo') },
    { value: 'UTC', label: timezoneLabel('UTC') },
  ];
}

// 教学设置必须由用户显式选择时区，不从浏览器日期或系统时区猜测；
// 锚点必须是周一，学期开始须落在锚点所在教学周内，结束不早于开始。
export function validateTeachingInput(raw) {
  const timezone = typeof raw?.timezone === 'string' ? raw.timezone : '';
  const firstWeekMonday = typeof raw?.firstWeekMonday === 'string' ? raw.firstWeekMonday : '';
  const termStart = typeof raw?.termStart === 'string' ? raw.termStart : '';
  const termEnd = typeof raw?.termEnd === 'string' ? raw.termEnd : '';
  if (!isSupportedTimezone(timezone)) return { ok: false, message: '请显式选择教学周所用时区。' };
  if (!isValidDate(firstWeekMonday)) return { ok: false, message: '请选择第一教学周的周一（真实日期）。' };
  if (!isValidDate(termStart) || !isValidDate(termEnd)) return { ok: false, message: '请选择真实的学期开始与结束日期。' };
  if (weekdayMon1(firstWeekMonday) !== 1) return { ok: false, message: '第一教学周的起点必须是周一。' };
  const anchor = dateSerial(firstWeekMonday);
  const start = dateSerial(termStart);
  const end = dateSerial(termEnd);
  if (start < anchor || start >= anchor + 7) return { ok: false, message: '学期开始须在第一教学周（周一至周日）内。' };
  if (end < start) return { ok: false, message: '学期结束不能早于学期开始。' };
  if (end - start > 366) return { ok: false, message: '学期范围过长，当前上限为 366 天。' };
  return {
    ok: true,
    teaching: { timezone, firstWeekMonday, termStart, termEnd },
    weekCount: teachingWeekCount(firstWeekMonday, termEnd),
  };
}

export function conflictLabel(type) {
  if (type === 'course_changed') return '课程已更换，旧停课未生效';
  if (type === 'class_added') return '周课表新增了本节课，个人声明未生效';
  if (type === 'stale_cancel') return '当前已无课，旧停课记录待处理';
  return '存在待确认冲突';
}

export function storedCancel(item) {
  return item?.cancelled === true
    || item?.conflict?.type === 'course_changed'
    || item?.conflict?.type === 'stale_cancel';
}

export function statusKind(item) {
  if (!item) return 'none';
  if (item.status === 'term_out') return 'term';
  if (item.status === 'unknown') return 'unknown';
  if (item.status === 'conflict') return 'conflict';
  if (item.status === 'class_occupied') return 'class';
  if (item.status === 'busy') return 'busy';
  if (item.status === 'available') return 'available';
  return 'none';
}

export function statusText(item) {
  if (!item) return '未知';
  const base = STATUS_LABELS[item.status] ?? '未知';
  if (item.cancelled && (item.status === 'busy' || item.status === 'available')) {
    return `已停课 · ${base}`;
  }
  if (item.cancelled && item.status === 'no_class') return '已停课';
  return base;
}

export function daySummary(day) {
  if (!day) return [];
  if (!day.inTerm) return [{ kind: 'term', label: '学期外' }];
  const counts = day.counts ?? {};
  if ((counts.unknown ?? 0) > 0 && (counts.unknown ?? 0) === day.periods.length) {
    return [{ kind: 'unknown', label: '未提交' }];
  }
  const result = [];
  for (const [key, kind, label] of [
    ['classOccupied', 'class', '课'],
    ['busy', 'busy', '忙'],
    ['available', 'available', '空'],
    ['cancelled', 'cancel', '停'],
    ['conflict', 'conflict', '冲突'],
    ['unknown', 'unknown', '未知'],
  ]) {
    if ((counts[key] ?? 0) > 0) result.push({ kind, label: `${label} ${counts[key]}` });
  }
  if (result.length === 0 && (counts.noClass ?? 0) > 0) {
    result.push({ kind: 'none', label: '没课' });
  }
  return result;
}

export function dayStateAria(day) {
  if (!day) return '日期';
  const label = daySummary(day).map((item) => item.label).join('，') || '无记录';
  const week = day.weekNumber ? `第 ${day.weekNumber} 教学周` : (day.inTerm ? '教学周外' : '学期外');
  return `${day.date} ${week}，${label}。查看当天节次。`;
}

export function monthTermSummary(days) {
  const inTerm = (days ?? []).filter((day) => day.inTerm && day.weekNumber !== null);
  if (inTerm.length === 0) return '';
  const first = Math.min(...inTerm.map((day) => day.weekNumber));
  const last = Math.max(...inTerm.map((day) => day.weekNumber));
  return first === last ? `第 ${first} 教学周` : `第 ${first}–${last} 教学周`;
}

export function countClasses(days) {
  let total = 0;
  for (const day of days ?? []) total += day.counts?.classOccupied ?? 0;
  return total;
}

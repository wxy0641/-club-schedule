// S2b 教学周与本人月历投影：纯日期算法 + 无落库的按月投影。
// 周课表仍是唯一重复来源；月历不生成未来课程副本，也不使用 ISO 周号或毫秒时差。
import { AppError } from './http.mjs';
import { sha256Hex } from './sessions.mjs';
import { WEEK_RULES } from './week-schedule.mjs';

export const PERSONAL_STATES = ['none', 'busy', 'available'];
export const TERM_MAX_DAYS = 366;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

// Howard Hinnant civil-from-days 算法：以 1970-01-01 为 0 的日历日序号，不受 DST 影响。
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

function dateParts(raw) {
  if (typeof raw !== 'string') return null;
  const matched = DATE_PATTERN.exec(raw);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1900 || year > 2200) return null;
  const serial = daysFromCivil(year, month, day);
  const back = civilFromDays(serial);
  if (back.year !== year || back.month !== month || back.day !== day) return null;
  return { year, month, day, serial };
}

export function isValidDate(raw) {
  return dateParts(raw) !== null;
}

export function dateSerial(raw) {
  return dateParts(raw)?.serial ?? null;
}

export function addDays(date, amount) {
  const serial = dateSerial(date);
  if (serial === null || !Number.isSafeInteger(amount)) throw new AppError('invalid_date', 400);
  const civil = civilFromDays(serial + amount);
  return `${civil.year}-${pad2(civil.month)}-${pad2(civil.day)}`;
}

export function daysBetween(later, earlier) {
  const left = dateSerial(later);
  const right = dateSerial(earlier);
  if (left === null || right === null) throw new AppError('invalid_date', 400);
  return left - right;
}

// 周一为 1，周日为 7；不依赖运行环境 locale。
export function weekdayMon1(date) {
  const serial = dateSerial(date);
  if (serial === null) throw new AppError('invalid_date', 400);
  return ((serial + 3) % 7 + 7) % 7 + 1;
}

export function daysInMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)
    - daysFromCivil(year, month, 1);
}

export function validateMonth(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_month', 400);
  const matched = MONTH_PATTERN.exec(raw);
  if (!matched) throw new AppError('invalid_month', 400);
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) throw new AppError('invalid_month', 400);
  return `${year}-${pad2(month)}`;
}

export function monthDates(month) {
  const normalized = validateMonth(month);
  const year = Number(normalized.slice(0, 4));
  const monthIndex = Number(normalized.slice(5, 7));
  return Array.from({ length: daysInMonth(year, monthIndex) }, (_, index) => `${normalized}-${pad2(index + 1)}`);
}

export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !TIMEZONE_PATTERN.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// “今天”必须由空间时区决定；页面跨过当地午夜后旧页面会被服务端拒绝。
export function localToday(timezone, now = new Date()) {
  if (!isValidTimezone(timezone)) throw new AppError('invalid_teaching_timezone', 400);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// 空间当地分钟数用于“今天已结束的节次只读”；显式 hourCycle=h23 避免部分环境给出 24:xx。
export function localMinuteOfDay(timezone, now = new Date()) {
  if (!isValidTimezone(timezone)) throw new AppError('invalid_teaching_timezone', 400);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute)) {
    throw new AppError('invalid_teaching_timezone', 400);
  }
  return hour * 60 + minute;
}

export function timeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return matched ? Number(matched[1]) * 60 + Number(matched[2]) : null;
}

// 节次结束是唯一可编辑边界：今天尚未结束的节次可改，结束时刻之后不可改；
// 配置校验已保证 start < end，不支持跨午夜猜测。
export function periodEditable({ date, today, nowMinutes, periodMeta, submitted, inTerm }) {
  if (!submitted || !inTerm) return false;
  if (date > today) return true;
  if (date < today) return false;
  const end = timeToMinutes(periodMeta?.end);
  return end !== null && nowMinutes < end;
}

export function validateTeaching(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('invalid_teaching', 400);
  const { timezone, firstWeekMonday, termStart, termEnd } = raw;
  if (!isValidTimezone(timezone)) throw new AppError('invalid_teaching_timezone', 400);
  if (!isValidDate(firstWeekMonday)) throw new AppError('invalid_teaching_anchor', 400);
  if (!isValidDate(termStart) || !isValidDate(termEnd)) throw new AppError('invalid_teaching_range', 400);
  if (weekdayMon1(firstWeekMonday) !== 1) throw new AppError('teaching_anchor_not_monday', 400);

  const anchor = dateSerial(firstWeekMonday);
  const start = dateSerial(termStart);
  const end = dateSerial(termEnd);
  if (start < anchor) throw new AppError('teaching_start_before_anchor', 400);
  if (start >= anchor + 7) throw new AppError('teaching_start_outside_first_week', 400);
  if (end < start) throw new AppError('teaching_end_before_start', 400);
  if (end - start > TERM_MAX_DAYS) throw new AppError('teaching_term_too_long', 400);
  return { timezone, firstWeekMonday, termStart, termEnd };
}

export function teachingWeekCount(teaching) {
  const anchor = dateSerial(teaching.firstWeekMonday);
  const end = dateSerial(teaching.termEnd);
  if (anchor === null || end === null || end < anchor) return null;
  return Math.floor((end - anchor) / 7) + 1;
}

export function publicTeaching(raw) {
  try {
    const teaching = validateTeaching(raw);
    const weekCount = teachingWeekCount(teaching);
    return weekCount === null ? null : { ...teaching, weekCount };
  } catch {
    return null;
  }
}

// 教学周号只由“教学周周一”与目标日期的日历日差推导，不在跨年或换月时重置。
export function teachingWeekNumber(teaching, date) {
  const week = dateSerial(teaching.firstWeekMonday);
  const target = dateSerial(date);
  if (week === null || target === null || target < week) return null;
  return Math.floor((target - week) / 7) + 1;
}

export function validatePersonalState(raw) {
  if (!PERSONAL_STATES.includes(raw)) throw new AppError('invalid_personal_state', 400);
  return raw;
}

export function buildWeeklyMap(entries, config) {
  const cells = new Map();
  const periods = new Set(config.periods.map((period) => period.index));
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !WEEK_RULES.includes(entry.weekRule)) continue;
    if (!Number.isSafeInteger(entry.day) || entry.day < 1 || entry.day > 7) continue;
    if (!periods.has(entry.period)) continue;
    const key = `${entry.day}:${entry.period}`;
    const cell = cells.get(key) ?? {};
    cell[entry.weekRule] = config.mode === 'courses'
      ? { rule: entry.weekRule, courseName: String(entry.courseName ?? '') }
      : { rule: entry.weekRule, courseName: null };
    cells.set(key, cell);
  }
  return { cells, periods, oddEvenEnabled: config.oddEvenEnabled };
}

export function weeklyValueFromMap(built, date, period, weekNumber) {
  const weekday = weekdayMon1(date);
  const cell = built.cells.get(`${weekday}:${period}`);
  if (!cell) return null;
  if (cell.every) return cell.every;
  if (!built.oddEvenEnabled || !Number.isSafeInteger(weekNumber)) return null;
  const parity = weekNumber % 2 === 1 ? 'odd' : 'even';
  return cell[parity] ?? null;
}

export function weeklyValueFor(entries, config, date, period, weekNumber) {
  return weeklyValueFromMap(buildWeeklyMap(entries, config), date, period, weekNumber);
}

export async function courseSignature(value, config) {
  if (!value) return null;
  return sha256Hex(JSON.stringify({
    mode: config.mode,
    rule: value.rule,
    courseName: config.mode === 'courses' ? (value.courseName ?? '') : null,
  }));
}

async function signatureFor(value, config, cache) {
  const key = `${value.rule}:${value.courseName ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  const signature = await courseSignature(value, config);
  cache.set(key, signature);
  return signature;
}

export function exceptionView(row, date, period) {
  return {
    date: row?.local_date ?? date,
    period: row?.period ?? period,
    cancelClass: row?.cancel_class === true,
    personalState: PERSONAL_STATES.includes(row?.personal_state) ? row.personal_state : 'none',
    version: Number.isSafeInteger(row?.version) ? row.version : 0,
    updatedAt: row?.updated_at ?? null,
    cleared: row?.cancel_class !== true
      && (!row?.personal_state || row.personal_state === 'none'),
  };
}

function emptyCounts() {
  return {
    classOccupied: 0, busy: 0, available: 0, noClass: 0,
    conflict: 0, cancelled: 0, unknown: 0, termOut: 0,
  };
}

function countStatus(counts, status) {
  if (status === 'class_occupied') counts.classOccupied += 1;
  else if (status === 'busy') counts.busy += 1;
  else if (status === 'available') counts.available += 1;
  else if (status === 'no_class') counts.noClass += 1;
  else if (status === 'conflict') counts.conflict += 1;
  else if (status === 'unknown') counts.unknown += 1;
  else if (status === 'term_out') counts.termOut += 1;
}

// 已接受的负责人安排/事件占用：课程与冲突优先，其余“无课/声明”会被忙碌占用覆盖；
// 事件占用只作为独立来源叠加，不写入日期例外，也不改动周课表。
function applyExternalOccupancy(item, entry) {
  if (!entry) return;
  const busy = Array.isArray(entry.busy) ? entry.busy : [];
  const available = Array.isArray(entry.available) ? entry.available : [];
  if (busy.length > 0) {
    item.busySources = busy;
    item.eventBusy = busy.some((source) => source.type === 'event');
    item.requestBusy = busy.some((source) => source.type === 'request');
    if (item.status === 'class_occupied' || item.status === 'conflict') return;
    item.status = 'busy';
    return;
  }
  if (available.length > 0) {
    item.availableSources = available;
    item.requestAvailable = true;
    if (item.status === 'no_class' || item.status === 'available') {
      item.status = 'available';
    }
  }
}

// 投影优先级：未设置教学周 > 学期外 > 未提交未知 > 周课表占用 > 例外。
// 课程占用优先于个人声明，除非该次停课签名与当前已发布课程一致。
export async function projectMonth({
  teaching, config, document, exceptions, month, today, now, externalOccupancy = null,
}) {
  const normalized = validateMonth(month);
  const dates = monthDates(normalized);
  const publicTerm = publicTeaching(teaching);
  const externalCells = externalOccupancy instanceof Map ? externalOccupancy : new Map();
  if (!publicTerm) {
    return { state: 'unconfigured', month: normalized, today: null, days: [] };
  }
  const submitted = document !== null
    && Number.isSafeInteger(document?.published_version)
    && document.published_version > 0;
  const publishedEntries = submitted && Array.isArray(document?.published_entries)
    ? document.published_entries
    : [];
  const weekly = buildWeeklyMap(publishedEntries, config);
  const overlays = new Map();
  for (const row of Array.isArray(exceptions) ? exceptions : []) {
    if (!isValidDate(row?.local_date) || !Number.isSafeInteger(row?.period)) continue;
    overlays.set(`${row.local_date}:${row.period}`, row);
  }
  const todayText = today ?? localToday(publicTerm.timezone, now);
  const nowMinutes = localMinuteOfDay(publicTerm.timezone, now);
  const signatureCache = new Map();
  const days = [];

  for (const date of dates) {
    const weekday = weekdayMon1(date);
    const inTerm = date >= publicTerm.termStart && date <= publicTerm.termEnd;
    const weekNumber = teachingWeekNumber(publicTerm, date);
    const counts = emptyCounts();
    const periods = [];
    let dayEditable = false;

    for (const periodMeta of config.periods) {
      const period = periodMeta.index;
      const periodIsEditable = periodEditable({
        date, today: todayText, nowMinutes, periodMeta, submitted, inTerm,
      });
      if (periodIsEditable) dayEditable = true;
      const row = overlays.get(`${date}:${period}`);
      const overlayActive = Boolean(row) && (row.cancel_class === true
        || PERSONAL_STATES.includes(row.personal_state) && row.personal_state !== 'none');
      const personalState = overlayActive && PERSONAL_STATES.includes(row.personal_state)
        ? row.personal_state
        : 'none';
      const exceptionVersion = Number.isSafeInteger(row?.version) ? row.version : 0;
      const item = {
        period,
        status: 'term_out',
        cancelled: false,
        personalState,
        courseName: null,
        rule: null,
        conflict: null,
        exceptionVersion,
        updatedAt: row?.updated_at ?? null,
        hasException: overlayActive,
        editable: periodIsEditable,
        time: { start: periodMeta.start, end: periodMeta.end },
      };

      if (!inTerm) {
        countStatus(counts, 'term_out');
      } else if (!submitted) {
        item.status = 'unknown';
        countStatus(counts, 'unknown');
      } else {
        const value = weekNumber === null ? null : weeklyValueFromMap(
          weekly, date, period, weekNumber,
        );
        item.rule = value?.rule ?? null;
        if (config.mode === 'courses' && value) item.courseName = value.courseName || null;
        const signature = value ? await signatureFor(value, config, signatureCache) : null;

        if (value && overlayActive && row.cancel_class === true) {
          if (row.course_signature === signature) {
            item.cancelled = true;
            counts.cancelled += 1;
            if (personalState === 'busy') item.status = 'busy';
            else if (personalState === 'available') item.status = 'available';
            else item.status = 'no_class';
          } else {
            item.status = 'conflict';
            item.conflict = { type: 'course_changed' };
          }
        } else if (value && overlayActive && row.cancel_class !== true) {
          item.status = 'conflict';
          item.conflict = { type: 'class_added' };
        } else if (!value && overlayActive && row.cancel_class === true) {
          item.status = 'conflict';
          item.conflict = { type: 'stale_cancel' };
        } else if (value) {
          item.status = 'class_occupied';
        } else if (personalState === 'busy') {
          item.status = 'busy';
        } else if (personalState === 'available') {
          item.status = 'available';
        } else {
          item.status = 'no_class';
        }
        applyExternalOccupancy(item, externalCells.get(`${date}:${period}`));
        countStatus(counts, item.status);
      }

      periods.push(item);
    }

    days.push({
      date,
      weekday,
      weekNumber,
      inTerm,
      isToday: date === todayText,
      editable: dayEditable,
      counts,
      periods,
    });
  }

  return {
    state: submitted ? 'ready' : 'unknown',
    month: normalized,
    today: todayText,
    days,
  };
}

// 负责人按周导出“课程状态”快照：只输出周一至周日 7 张工作表。
// 课程状态只由已发布周课表、教学周和与该次课程一致的有效停课推导；
// 个人忙/空声明与已接受事件不会改变“有课/没课”，未确认、冲突与学期外不伪装成没课。
import { AppError, rows } from './http.mjs';
import { buildXlsx, headerRow, numberCell, textCell } from './xlsx.mjs';
import { shareAccepted } from './collection.mjs';
import {
  addDays, buildWeeklyMap, courseSignature, isValidDate, publicTeaching,
  teachingWeekNumber, weekdayMon1, weeklyValueFromMap,
} from './calendar.mjs';
import { sha256Hex } from './sessions.mjs';

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const EXCEPTION_COLUMNS = [
  'space_id', 'member_id', 'local_date', 'period', 'cancel_class', 'personal_state',
  'course_signature', 'version', 'updated_at',
].join(',');
const EXPORT_ROW_LIMIT = 20000;

export function weekdayLabel(date) {
  return WEEKDAY_LABELS[weekdayMon1(date) - 1];
}

export function normalizeExportWeek(raw) {
  if (!isValidDate(raw)) throw new AppError('invalid_export_date', 400);
  const weekStart = addDays(raw, 1 - weekdayMon1(raw));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

export function weekDates(weekStart) {
  if (!isValidDate(weekStart) || weekdayMon1(weekStart) !== 1) {
    throw new AppError('invalid_export_week', 400);
  }
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function filenamePart(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return text || '空间';
}

export function exportFilename(spaceName, weekStart, weekEnd) {
  const prefix = [...filenamePart(spaceName)].slice(0, 80).join('');
  const base = `${prefix}_课程表_${weekStart}至${weekEnd}`;
  return `${[...base].slice(0, 160).join('')}.xlsx`;
}

function weekMeta(publicTerm, date) {
  const inTerm = Boolean(publicTerm) && date >= publicTerm.termStart && date <= publicTerm.termEnd;
  if (!inTerm) return { inTerm: false, label: '学期外' };
  const weekNumber = teachingWeekNumber(publicTerm, date);
  if (!Number.isSafeInteger(weekNumber) || weekNumber < 1) {
    return { inTerm: true, label: '教学周待确认' };
  }
  const parity = weekNumber % 2 === 1 ? '单周' : '双周';
  return { inTerm: true, label: `第 ${weekNumber} 教学周 · ${parity}` };
}

const COURSE_STATES = {
  class: { text: '有课', style: 'class' },
  no_class: { text: '没课', style: 'noClass' },
  unknown: { text: '未确认', style: 'unknown' },
  term_out: { text: '学期外', style: 'note' },
};

function personLabel(subject) {
  return String(subject.inSpaceName ?? '').trim() || '成员';
}

async function buildMemberLabels(space, subjects) {
  const counts = new Map();
  for (const subject of subjects) {
    const name = personLabel(subject);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map();
  const usedCodes = new Set();
  for (const subject of subjects) {
    const name = personLabel(subject);
    if ((counts.get(name) ?? 0) <= 1) {
      labels.set(subject.userId, name);
      continue;
    }
    const digest = await sha256Hex(`${space.id ?? ''}:${subject.userId}`);
    let length = 4;
    let code = digest.slice(0, length).toUpperCase();
    while (usedCodes.has(code) && length < digest.length) {
      length += 2;
      code = digest.slice(0, length).toUpperCase();
    }
    usedCodes.add(code);
    labels.set(subject.userId, `${name}（${code}）`);
  }
  return labels;
}

function prepareSubjects(collection, shareConsents, viewerId, config, exceptions) {
  const byMember = new Map();
  for (const row of Array.isArray(exceptions) ? exceptions : []) {
    if (typeof row.member_id !== 'string' || !Number.isSafeInteger(row.period)) continue;
    if (typeof row.local_date !== 'string') continue;
    const key = `${row.member_id}:${row.local_date}:${row.period}`;
    byMember.set(key, row);
  }
  return collection.subjects.map((subject) => {
    const share = shareConsents.get(subject.userId) ?? null;
    const overlays = new Map();
    for (const [key, row] of byMember) {
      if (!key.startsWith(`${subject.userId}:`)) continue;
      overlays.set(`${row.local_date}:${row.period}`, row);
    }
    return {
      ...subject,
      shared: subject.userId === viewerId || shareAccepted(share),
      weekly: subject.submitted ? buildWeeklyMap(subject.document.published_entries, config) : null,
      overlays,
      signatures: new Map(),
    };
  });
}

async function valueSignature(subject, value, config) {
  if (!value) return null;
  const key = `${value.rule}:${value.courseName ?? ''}`;
  if (subject.signatures.has(key)) return subject.signatures.get(key);
  const signature = await courseSignature(value, config);
  subject.signatures.set(key, signature);
  return signature;
}

async function courseState({ subject, date, period, weekNumber, inTerm, config }) {
  if (!inTerm) return 'term_out';
  if (!subject.submitted) return 'unknown';
  const value = weekNumber === null ? null : weeklyValueFromMap(
    subject.weekly, date, period, weekNumber,
  );
  // 未共享日期例外时仍按已发布周课表判断有课/没课，只是不读取停课与个人声明。
  if (!subject.shared) return value ? 'class' : 'no_class';

  const row = subject.overlays.get(`${date}:${period}`) ?? null;
  const cancelled = row?.cancel_class === true;
  if (!value) return cancelled ? 'unknown' : 'no_class';
  if (!cancelled) return 'class';
  const signature = await valueSignature(subject, value, config);
  return row.course_signature === signature ? 'no_class' : 'unknown';
}

async function dailySheet({
  date, subjects, labels, config, publicTerm,
}) {
  const periods = [...config.periods].sort((left, right) => left.index - right.index);
  const meta = weekMeta(publicTerm, date);
  const weekNumber = teachingWeekNumber(publicTerm, date);
  const statusGrid = [];
  const memberRows = [];

  for (const subject of subjects) {
    const label = labels.get(subject.userId) ?? personLabel(subject);
    const statuses = [];
    for (const periodMeta of periods) {
      const state = await courseState({
        subject, date, period: periodMeta.index,
        weekNumber,
        inTerm: meta.inTerm,
        config,
      });
      statuses.push(state);
    }
    statusGrid.push(statuses);
    memberRows.push([
      textCell(label, 'wrap'),
      ...statuses.map((state) => {
        const display = COURSE_STATES[state] ?? COURSE_STATES.unknown;
        return textCell(display.text, display.style);
      }),
    ]);
  }

  const title = `${weekdayLabel(date)} ${date} · ${meta.label} · ${subjects.length} 人 · 课程状态`;
  const header = headerRow([
    '成员',
    ...periods.map((period) => `第${period.index}节\n${period.start}–${period.end}`),
  ]);
  const rowsOut = [
    [{ v: title, kind: 'text', style: 'title' }],
    [{
      v: '口径：已发布周课表 + 教学周 + 有效停课；个人忙碌、已接受事件与安排不改变“有课/没课”。',
      kind: 'text', style: 'note',
    }],
    header,
    ...memberRows,
    [],
  ];
  const rowHeights = [28, 32, 34, ...memberRows.map(() => 24), 8];

  const totals = periods.map(() => ({ class: 0, noClass: 0, undetermined: 0 }));
  for (const statuses of statusGrid) {
    statuses.forEach((state, index) => {
      if (state === 'class') totals[index].class += 1;
      else if (state === 'no_class') totals[index].noClass += 1;
      else totals[index].undetermined += 1;
    });
  }
  for (const [label, key] of [
    ['有课', 'class'],
    ['没课', 'noClass'],
    ['未确定', 'undetermined'],
  ]) {
    rowsOut.push([
      textCell(label, 'footerLabel'),
      ...totals.map((total) => numberCell(total[key], 'footerCount')),
    ]);
    rowHeights.push(22);
  }

  const note = meta.inTerm
    ? '没课不代表有空参加活动；未确认与学期外不写作“没课”。'
    : '学期外：所选日期不在学期内，本日不作课程判断；没课不代表有空参加活动。';
  rowsOut.push([textCell(note, 'note')]);
  rowHeights.push(40);

  const lastColumn = columnName(periods.length);
  const noteRow = rowsOut.length;
  return {
    name: `${weekdayLabel(date)}_${date.slice(5)}`,
    widths: [20, ...periods.map(() => 13)],
    rows: rowsOut,
    rowHeights,
    merges: [`A1:${lastColumn}1`, `A2:${lastColumn}2`, `A${noteRow}:${lastColumn}${noteRow}`],
    freeze: { rows: 3, cols: 1 },
    printTitles: 3,
    orientation: 'landscape',
  };
}

export async function buildCollectionWorkbook({
  space, config, teaching, collection, shareConsents, exceptions, viewerId, weekStart,
}) {
  const { weekStart: monday } = normalizeExportWeek(weekStart);
  const dates = weekDates(monday);
  const publicTerm = publicTeaching(teaching);
  if (!publicTerm) throw new AppError('teaching_required', 409);
  const prepared = prepareSubjects(collection, shareConsents, viewerId, config, exceptions);
  const labels = await buildMemberLabels(space, prepared);
  if (dates.length * (prepared.length + 8) > EXPORT_ROW_LIMIT) {
    throw new AppError('export_too_large', 413);
  }
  const sheets = [];
  for (const date of dates) {
    sheets.push(await dailySheet({ date, subjects: prepared, labels, config, publicTerm }));
  }
  return buildXlsx(sheets);
}

export async function loadExportExceptions(db, spaceId) {
  return rows(await db.from('date_exceptions').select(EXCEPTION_COLUMNS).eq('space_id', spaceId));
}

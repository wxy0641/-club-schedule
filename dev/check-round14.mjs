// Round 14 本地契约检查：真实 router/calendar/collection/export 代码 + 内存假数据库。
// 锁定“提交即确认、空白即没课”：零条目与空节次不再逐节待确认；草稿不覆盖已发布；
// 未共享只隐藏日期例外；个人忙/已接受事件不改变课程判断；普通成员提交即计入收集。
//   node --test dev/check-round14.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createApplication } from '../functions/router.mjs';
import {
  CALENDAR_NOTICE_VERSION, NOTICE_VERSION, SHARE_NOTICE_VERSION,
} from '../functions/notices.mjs';
import { addDays, localToday, weekdayMon1 } from '../functions/calendar.mjs';
import {
  LEGEND, STATUS_LABELS, daySummary, statusText,
} from '../web/calendar-model.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://r14.test';
const PASSWORD = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const UNIQUE = {
  users: [['id'], ['username']],
  sessions: [['token_digest']],
  auth_limiter: [['key']],
  spaces: [['id']],
  memberships: [['space_id', 'user_id']],
  schedules: [['id'], ['space_id', 'member_id']],
  space_invites: [['space_id'], ['code_hash']],
  invite_slots: [['id'], ['space_id', 'generation', 'slot_no'], ['space_id', 'claimed_by']],
  schedule_documents: [['id'], ['space_id', 'member_id']],
  space_teaching: [['space_id']],
  date_exceptions: [['id'], ['space_id', 'member_id', 'local_date', 'period']],
  calendar_consents: [['space_id', 'member_id']],
  collection_participants: [['space_id', 'user_id']],
  calendar_share_consents: [['space_id', 'member_id']],
  space_events: [['id']],
  event_assignments: [['id'], ['space_id', 'request_id', 'target_user_id']],
};

function fixture() {
  const db = createFakeDb({ writes: [] }, { unique: UNIQUE });
  const handle = createApplication({ db, origin: PUBLIC_ORIGIN });
  return { db, handle };
}

function ctx(path, { method = 'GET', body, cookie, origin = PUBLIC_ORIGIN } = {}) {
  const headers = { origin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return {
    request: new Request(`https://provider.internal/functions/v1/app-d${'a'.repeat(32)}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    requestId: 'local-r14-check',
  };
}

async function call(handle, context) {
  const response = await handle(context);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text, setCookie: response.headers.get('set-cookie') };
}

async function callBytes(handle, context) {
  const response = await handle(context);
  return {
    status: response.status,
    headers: response.headers,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

const cookiePair = (result) => result.setCookie?.split(';')[0] ?? null;

async function registerOk(handle, nickname) {
  const username = `r14_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const response = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: { username, password: PASSWORD, nickname, noticeAccepted: true },
  }));
  assert.equal(response.status, 201, response.text);
  return { id: response.body.user.id, username, cookie: cookiePair(response) };
}

function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function makePeriods(count = 6) {
  return Array.from({ length: count }, (_, index) => {
    const start = 8 * 60 + index * 60;
    return { index: index + 1, start: formatTime(start), end: formatTime(start + 45) };
  });
}

const todayInSpace = () => localToday('Asia/Shanghai');
const tomorrowInSpace = () => addDays(todayInSpace(), 1);
const monthOf = (date) => date.slice(0, 7);
const makeRequestId = () => `r14_${crypto.randomUUID().replace(/-/g, '')}`;

function dynamicTeaching() {
  const today = todayInSpace();
  const monday = addDays(today, -((weekdayMon1(today) + 6) % 7));
  return {
    timezone: 'Asia/Shanghai',
    firstWeekMonday: monday,
    termStart: monday,
    termEnd: addDays(today, 180),
  };
}

async function createSpaceOk(handle, cookie, overrides = {}) {
  const response = await call(handle, ctx('/api/spaces', {
    method: 'POST',
    cookie,
    body: {
      name: 'R14 合成空间',
      ownerName: '负责人甲',
      mode: 'courses',
      weekRule: 'every',
      periods: makePeriods(6),
      visibility: 'masked_list',
      teaching: dynamicTeaching(),
      ...overrides,
    },
  }));
  assert.equal(response.status, 201, response.text);
  return response.body;
}

async function generateInvite(handle, ownerCookie, spaceId) {
  const invite = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, {
    method: 'POST', cookie: ownerCookie,
  }));
  assert.equal(invite.status, 201, invite.text);
  return invite.body;
}

async function joinWithCode(handle, memberCookie, code, name, { share = false } = {}) {
  const body = {
    code,
    inSpaceName: name,
    noticeAccepted: true,
    noticeVersion: NOTICE_VERSION,
  };
  if (share) {
    body.shareNoticeAccepted = true;
    body.shareNoticeVersion = SHARE_NOTICE_VERSION;
  }
  return call(handle, ctx('/api/join', { method: 'POST', cookie: memberCookie, body }));
}

async function joinMember(handle, invite, memberCookie, name, options = {}) {
  const joined = await joinWithCode(handle, memberCookie, invite.code, name, options);
  assert.equal(joined.status, 201, joined.text);
}

async function publishEntries(handle, cookie, spaceId, entries, baseRevision = 0) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    cookie,
    body: { requestId: makeRequestId(), baseRevision, entries },
  }));
}

async function saveDraft(handle, cookie, spaceId, entries, baseRevision = 0) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule/draft`, {
    method: 'POST',
    cookie,
    body: { requestId: makeRequestId(), baseRevision, entries },
  }));
}

const calendarConsented = new Set();

async function ensureCalendarConsent(handle, cookie, spaceId) {
  const key = `${cookie}|${spaceId}`;
  if (calendarConsented.has(key)) return;
  const consent = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: CALENDAR_NOTICE_VERSION },
  }));
  assert.equal(consent.status, 200, consent.text);
  calendarConsented.add(key);
}

async function savePersonalState(handle, cookie, spaceId, overrides) {
  await ensureCalendarConsent(handle, cookie, spaceId);
  return call(handle, ctx(`/api/spaces/${spaceId}/exceptions`, {
    method: 'POST',
    cookie,
    body: {
      requestId: makeRequestId(),
      baseVersion: 0,
      action: 'save',
      date: tomorrowInSpace(),
      period: 1,
      cancelClass: false,
      personalState: 'none',
      noticeAccepted: true,
      noticeVersion: CALENDAR_NOTICE_VERSION,
      ...overrides,
    },
  }));
}

function eventBody(overrides = {}) {
  const date = tomorrowInSpace();
  return {
    id: crypto.randomUUID(),
    title: `评审会-${crypto.randomUUID().slice(0, 6)}`,
    startDate: date,
    endDate: date,
    allDay: true,
    visibility: 'invitees',
    recipientScope: 'selected',
    recipients: [],
    ...overrides,
  };
}

const eventStampAllDay = (date) => `${date}|${date}|1||`;

async function createEvent(handle, cookie, spaceId, body) {
  return call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie, body,
  }));
}

async function getCalendar(handle, cookie, spaceId, month, preview) {
  const suffix = preview ? `&preview=${preview}` : '';
  return call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}${suffix}`, { cookie }));
}

async function getCollection(handle, cookie, spaceId, month) {
  return call(handle, ctx(`/api/spaces/${spaceId}/collection?month=${month}`, { cookie }));
}

function calendarPeriod(calendar, date, period) {
  const day = calendar.body.days.find((entry) => entry.date === date);
  return day?.periods.find((entry) => entry.period === period) ?? null;
}

function collectionPeriod(collection, date, period) {
  const day = collection.body.days.find((entry) => entry.date === date);
  return day?.periods.find((entry) => entry.period === period) ?? null;
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({ name, data, crc });
    offset = dataStart + size;
  }
  return entries;
}

function entryText(entries, name) {
  const entry = entries.find((item) => item.name === name);
  assert.ok(entry, `缺少 ${name}`);
  return entry.data.toString('utf8');
}

function workbookRows(xml) {
  return [...xml.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/g)].map((match) => match[1]);
}

function rowTexts(row) {
  return [...row.matchAll(/<t[^>]*>(.*?)<\/t>/g)].map((match) => match[1]);
}

function rowCellValues(row) {
  return [...row.matchAll(/<c[^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>([^<]*)<\/v>)<\/c>/g)]
    .map((match) => match[1] ?? match[2]);
}

async function exportDay(handle, cookie, spaceId, date) {
  const weekday = weekdayMon1(date);
  const weekStart = addDays(date, 1 - weekday);
  const response = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie },
  ));
  assert.equal(response.status, 200, response.buffer.toString('utf8'));
  const entries = zipEntries(response.buffer);
  for (const entry of entries) {
    assert.equal(crc32(entry.data), entry.crc, `${entry.name} CRC 不匹配`);
  }
  return {
    entries,
    sheetName: `${WEEKDAY_LABELS[weekday - 1]}_${date.slice(5)}`,
    daily: entryText(entries, `xl/worksheets/sheet${weekday}.xml`),
    weekStart,
  };
}

function memberRow(daily, name) {
  return workbookRows(daily).find((row) => rowTexts(row)[0] === name) ?? null;
}

function assertNoClassDay(calendar, date, periodCount = 6) {
  const day = calendar.body.days.find((entry) => entry.date === date);
  assert.ok(day, `缺少 ${date}`);
  assert.equal(day.counts.unknown, 0, '已提交的空节次不能逐节标为未确认');
  for (let period = 1; period <= periodCount; period += 1) {
    const cell = day.periods.find((entry) => entry.period === period);
    assert.equal(cell.status, 'no_class', `第 ${period} 节应为没课`);
    assert.equal(cell.cancelled, false);
  }
}

// 创建“负责人 + 成员甲”的合成空间；成员默认不确认日期共享。
async function buildSpace(handle, { share = false, name = '成员甲' } = {}) {
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, name);
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await generateInvite(handle, owner.cookie, spaceId);
  await joinMember(handle, invite, member.cookie, name, { share });
  return { owner, member, spaceId, invite };
}

test('R14-01 零条目提交即有效版本：个人日历、收集与导出均为没课，无逐节待确认', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const month = monthOf(date);

  const zero = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);
  assert.equal(zero.body.schedule.submitted, true);
  assert.equal(zero.body.schedule.publishedVersion, 1);
  assert.deepEqual(zero.body.schedule.publishedEntries, [], '空数组是有效提交，不是未提交');

  const calendar = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(calendar.status, 200, calendar.text);
  assert.equal(calendar.body.submitted, true);
  assert.equal(calendar.body.publishedVersion, 1);
  assertNoClassDay(calendar, date);
  assert.equal(daySummary(calendar.body.days.find((entry) => entry.date === date))[0].label, '没课');

  const collection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collection.status, 200, collection.text);
  assert.deepEqual(collection.body.summary, { total: 1, submitted: 1, unsubmitted: 0 });
  const cell = collectionPeriod(collection, date, 1);
  assert.equal(cell.counts.noClass, 1);
  assert.equal(cell.counts.unknown, 0);
  assert.equal(cell.groups.pending.count, 0, '零条目提交不进入待确认');
  assert.equal(cell.groups.free.members[0].userId, member.id);
  assert.equal(cell.groups.free.members[0].declared, false, '没课不等于主动有空');
  assert.equal(collection.body.members.find((row) => row.name === '成员甲').submitted, true);
  assert.equal(collection.body.roster.find((row) => row.userId === member.id).submitted, true);

  const { daily, entries, sheetName } = await exportDay(handle, owner.cookie, spaceId, date);
  assert.ok(entries.some((entry) => entry.name === 'xl/workbook.xml'));
  assert.ok(daily.includes(sheetName.replace(/_/, ' ')) || daily.includes('成员甲'));
  const row = memberRow(daily, '成员甲');
  assert.ok(row, '导出应包含零条目提交成员');
  assert.deepEqual(rowCellValues(row).slice(1), Array(6).fill('没课'));
});

test('R14-02 填写一节课其余空节次为没课；清空整表重新提交后全部没课', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);

  const first = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '数据结构' },
  ]);
  assert.equal(first.status, 201, first.text);
  assert.equal(first.body.schedule.publishedVersion, 1);

  const calendar = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(calendarPeriod(calendar, date, 1).status, 'class_occupied');
  assert.equal(calendarPeriod(calendar, date, 1).courseName, '数据结构');
  for (let period = 2; period <= 6; period += 1) {
    assert.equal(calendarPeriod(calendar, date, period).status, 'no_class',
      `未填写的第 ${period} 节应直接算没课`);
  }
  const day = calendar.body.days.find((entry) => entry.date === date);
  assert.equal(day.counts.unknown, 0);

  const partialCollection = await getCollection(handle, owner.cookie, spaceId, month);
  const partialCell = collectionPeriod(partialCollection, date, 1);
  assert.equal(partialCell.counts.classOccupied, 1);
  assert.equal(partialCell.counts.unknown, 0);
  const partialEmpty = collectionPeriod(partialCollection, date, 2);
  assert.equal(partialEmpty.counts.noClass, 1);
  assert.equal(partialEmpty.groups.pending.count, 0);

  const cleared = await publishEntries(handle, member.cookie, spaceId, [], 1);
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.body.schedule.publishedVersion, 2);
  assert.equal(cleared.body.schedule.publishedEntries.length, 0);

  const after = await getCalendar(handle, member.cookie, spaceId, month);
  assertNoClassDay(after, date);
  const afterCollection = await getCollection(handle, owner.cookie, spaceId, month);
  const afterCell = collectionPeriod(afterCollection, date, 1);
  assert.equal(afterCell.counts.noClass, 1);
  assert.equal(afterCell.counts.classOccupied, 0);
  assert.equal(afterCell.groups.pending.count, 0);

  const { daily } = await exportDay(handle, owner.cookie, spaceId, date);
  const row = memberRow(daily, '成员甲');
  assert.deepEqual(rowCellValues(row).slice(1), Array(6).fill('没课'));
});

test('R14-03 草稿隔离：清空草稿不抹已发布，草稿改动不进收集，未提交不自动发布', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const memberA = await registerOk(handle, '成员甲');
  const memberB = await registerOk(handle, '成员乙');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await generateInvite(handle, owner.cookie, spaceId);
  await joinMember(handle, invite, memberA.cookie, '成员甲');
  await joinMember(handle, invite, memberB.cookie, '成员乙');
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);

  const published = await publishEntries(handle, memberA.cookie, spaceId, [
    { day: weekday, period: 2, weekRule: 'every', courseName: '操作系统' },
  ]);
  assert.equal(published.status, 201, published.text);

  const draft = await saveDraft(handle, memberA.cookie, spaceId, [], 1);
  assert.equal(draft.status, 200, draft.text);
  assert.equal(draft.body.schedule.publishedVersion, 1);
  assert.equal(draft.body.schedule.publishedEntries.length, 1, '清空草稿不改变已发布快照');
  assert.equal(draft.body.schedule.draftEntries.length, 0);

  const own = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(own.body.draft.changed, true);
  assert.equal(own.body.preview, null);
  assert.equal(calendarPeriod(own, date, 2).status, 'class_occupied',
    '普通查看仍以已发布版本为准');
  const ownerCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(ownerCollection, date, 2).counts.classOccupied, 1,
    '草稿改动不得影响负责人收集');

  const draftOnly = await saveDraft(handle, memberB.cookie, spaceId, [
    { day: weekday, period: 3, weekRule: 'every', courseName: '编译原理' },
  ]);
  assert.equal(draftOnly.status, 201, draftOnly.text);
  assert.equal(draftOnly.body.schedule.submitted, false);
  assert.equal(draftOnly.body.schedule.publishedVersion, 0);

  const neverSubmitted = await getCalendar(handle, memberB.cookie, spaceId, month);
  assert.equal(neverSubmitted.body.submitted, false);
  for (let period = 1; period <= 6; period += 1) {
    assert.equal(calendarPeriod(neverSubmitted, date, period).status, 'unknown');
  }
  assert.equal(daySummary(neverSubmitted.body.days.find((entry) => entry.date === date))[0].label,
    '未提交', '从未提交只在页面/成员级显示未提交');

  const preview = await getCalendar(handle, memberB.cookie, spaceId, month, 'draft');
  assert.equal(preview.body.preview, 'draft');
  assert.equal(calendarPeriod(preview, date, 3).status, 'class_occupied');
  assert.equal(calendarPeriod(preview, date, 1).status, 'no_class', '草稿预览中空白也是没课');

  const afterDraft = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(afterDraft, date, 3).counts.unknown, 1,
    '仅草稿成员不得被当成已提交或自动发布');
  assert.equal(collectionPeriod(afterDraft, date, 3).counts.classOccupied, 0);
  assert.deepEqual(afterDraft.body.summary, { total: 2, submitted: 1, unsubmitted: 1 });
  assert.equal(afterDraft.body.roster.find((row) => row.userId === memberB.id).submitted, false);
});

test('R14-04 未共享日期例外：课程有课与空白没课仍可见，停课/个人忙不外泄', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);

  const published = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '计算机网络' },
  ]);
  assert.equal(published.status, 201, published.text);

  const cancelled = await savePersonalState(handle, member.cookie, spaceId, {
    period: 1, cancelClass: true,
  });
  assert.equal(cancelled.status, 201, cancelled.text);
  const busy = await savePersonalState(handle, member.cookie, spaceId, {
    period: 2, personalState: 'busy',
  });
  assert.equal(busy.status, 201, busy.text);

  const own = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(calendarPeriod(own, date, 1).status, 'no_class');
  assert.equal(calendarPeriod(own, date, 1).cancelled, true);
  assert.equal(statusText(calendarPeriod(own, date, 1)), '已停课');
  assert.equal(calendarPeriod(own, date, 2).status, 'busy');

  const collection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collection.status, 200, collection.text);
  const first = collectionPeriod(collection, date, 1);
  assert.equal(first.counts.classOccupied, 1, '未共享不隐藏已提交课程占用');
  assert.equal(first.groups.class.members[0].name, '成员甲');
  const second = collectionPeriod(collection, date, 2);
  assert.equal(second.counts.busy, 0, '未共享不得泄露个人忙碌');
  assert.equal(second.counts.noClass, 1, '空白仍按没课汇总');
  assert.ok(second.lists.noShare.includes('成员甲'));
  assert.equal(second.groups.pending.count, 0, '未共享不制造待确认');
  assert.equal(second.counts.unknown, 0);

  const { daily } = await exportDay(handle, owner.cookie, spaceId, date);
  const row = memberRow(daily, '成员甲');
  assert.deepEqual(rowCellValues(row), ['成员甲', '有课', ...Array(5).fill('没课')],
    '导出只隐藏日期例外，不把课程占用或没课降级为未确认');
});

test('R14-05 个人忙与已接受事件不变成有课、不被没课覆盖，事件确认不因提交消失', async () => {
  const { db, handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle, { share: true });
  const date = tomorrowInSpace();
  const month = monthOf(date);

  const zero = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);

  const event = eventBody({ recipients: [member.id] });
  const made = await createEvent(handle, owner.cookie, spaceId, event);
  assert.equal(made.status, 201, made.text);
  const assignmentId = db.dump('event_assignments')[0].id;

  const pendingView = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(pendingView.body.pendingCount, 1, '待确认事件仍需成员回应');
  assert.equal(calendarPeriod(pendingView, date, 1).status, 'no_class',
    '未接受事件不自动占用，也不变成有课');
  const pendingCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(pendingCollection, date, 1).counts.busy, 0);

  const accepted = await call(handle, ctx(`/api/spaces/${spaceId}/assignments/respond`, {
    method: 'POST',
    cookie: member.cookie,
    body: {
      id: assignmentId,
      requestId: crypto.randomUUID(),
      action: 'accept',
      expectedVersion: 1,
      eventStamp: eventStampAllDay(date),
    },
  }));
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.assignment.status, 'accepted');

  const afterAccept = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(afterAccept.body.pendingCount, 0);
  const busyPeriod = calendarPeriod(afterAccept, date, 1);
  assert.equal(busyPeriod.status, 'busy');
  assert.equal(busyPeriod.eventBusy, true);
  assert.notEqual(busyPeriod.status, 'class_occupied', '事件占用不是课程有课');

  const collection = await getCollection(handle, owner.cookie, spaceId, month);
  const busyCell = collectionPeriod(collection, date, 1);
  assert.equal(busyCell.counts.classOccupied, 0);
  assert.equal(busyCell.counts.busy, 1);
  assert.equal(busyCell.groups.busy.members[0].userId, member.id);
  assert.equal(busyCell.groups.busy.members[0].sources[0].type, 'event');
  assert.equal(busyCell.groups.free.members.some((row) => row.userId === member.id), false);

  const resubmitted = await publishEntries(handle, member.cookie, spaceId, [], 1);
  assert.equal(resubmitted.status, 200, resubmitted.text);
  const afterResubmit = await getCalendar(handle, member.cookie, spaceId, month);
  assert.equal(calendarPeriod(afterResubmit, date, 1).status, 'busy',
    '重新提交没课不能清掉已接受事件');
  assert.equal(calendarPeriod(afterResubmit, date, 1).eventBusy, true);
  assert.equal(afterResubmit.body.pendingCount, 0, '已接受事件不应重新变成待确认');

  const { daily } = await exportDay(handle, owner.cookie, spaceId, date);
  const row = memberRow(daily, '成员甲');
  assert.deepEqual(rowCellValues(row).slice(1), Array(6).fill('没课'),
    '导出课程判断不受个人忙或已接受事件影响');
});

test('R14-06 截图同尺寸状态：12 节全没课只汇总为“没课”，不再出现逐节待确认', () => {
  assert.equal(STATUS_LABELS.no_class, '没课');
  assert.equal(STATUS_LABELS.unknown, '未提交');
  assert.equal(LEGEND.some((item) => item.kind === 'none' && item.label === '没课'), true);
  assert.equal(LEGEND.some((item) => item.label.includes('待确认')), false);

  const day = {
    inTerm: true,
    weekNumber: 11,
    periods: Array.from({ length: 12 }, (_, index) => ({
      period: index + 1, status: 'no_class', cancelled: false,
    })),
    counts: { classOccupied: 0, busy: 0, available: 0, cancelled: 0, conflict: 0, unknown: 0, noClass: 12 },
  };
  assert.deepEqual(daySummary(day), [{ kind: 'none', label: '没课' }]);

  const unsubmitted = {
    ...day,
    periods: day.periods.map((item) => ({ ...item, status: 'unknown' })),
    counts: { ...day.counts, unknown: 12, noClass: 0 },
  };
  assert.deepEqual(daySummary(unsubmitted), [{ kind: 'unknown', label: '未提交' }]);
});

test('R14-07 普通成员提交即计入收集，无需额外开关；负责人显式退出仍生效', async () => {
  const { db, handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const month = monthOf(date);

  const zero = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);
  assert.equal(db.dump('collection_participants').length, 0,
    '普通成员提交不依赖隐藏参与开关');

  const collection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.deepEqual(collection.body.summary, { total: 1, submitted: 1, unsubmitted: 0 });
  assert.equal(collection.body.roster.some((row) => row.userId === member.id), true);
  assert.equal(collectionPeriod(collection, date, 1).counts.noClass, 1);

  const ownerJoin = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join' },
  }));
  assert.equal(ownerJoin.status, 200, ownerJoin.text);
  assert.equal(ownerJoin.body.participation.status, 'joined');

  const ownerPublish = await publishEntries(handle, owner.cookie, spaceId, []);
  assert.equal(ownerPublish.status, 201, ownerPublish.text);
  const withOwner = await getCollection(handle, owner.cookie, spaceId, month);
  assert.deepEqual(withOwner.body.summary, { total: 2, submitted: 2, unsubmitted: 0 });

  const ownerLeave = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'decline' },
  }));
  assert.equal(ownerLeave.status, 200, ownerLeave.text);
  assert.equal(ownerLeave.body.participation.status, 'declined');

  const afterLeave = await getCollection(handle, owner.cookie, spaceId, month);
  assert.deepEqual(afterLeave.body.summary, { total: 1, submitted: 1, unsubmitted: 0 },
    '负责人显式退出后不再被静默拉回收集');
  assert.equal(afterLeave.body.members.some((row) => row.role === 'owner'), false);
  assert.equal(collectionPeriod(afterLeave, date, 1).counts.noClass, 1);

  const ownerCalendar = await getCalendar(handle, owner.cookie, spaceId, month);
  assert.equal(ownerCalendar.body.submitted, true, '退出收集不删除已发布课表');
  assertNoClassDay(ownerCalendar, date);
});

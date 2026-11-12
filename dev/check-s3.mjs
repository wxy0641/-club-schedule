// S3 本地契约检查：真实 router/collection/events/export/xlsx 代码 + 内存假数据库。
// 证明角色边界、负责人参与口径、共享确认投影、收集日历、真实 xlsx 结构与事件可见性；
// 不证明真实 Provider 的事务、并发、下载缓存或 Excel/WPS 的最终渲染。
//   node --test dev/check-s3.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createApplication } from '../functions/router.mjs';
import {
  CALENDAR_NOTICE_VERSION, NOTICE_VERSION, SHARE_NOTICE_VERSION,
} from '../functions/notices.mjs';
import { addDays, localToday, weekdayMon1 } from '../functions/calendar.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s3.test';
const PASSWORD = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;

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
    requestId: 'local-s3-check',
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
  const username = `s3_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
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

function makePeriods(count = 6, stepMinutes = 60) {
  return Array.from({ length: count }, (_, index) => {
    const start = 8 * 60 + index * stepMinutes;
    return { index: index + 1, start: formatTime(start), end: formatTime(start + 45) };
  });
}

function todayInSpace() {
  return localToday('Asia/Shanghai');
}

function tomorrowInSpace() {
  return addDays(todayInSpace(), 1);
}

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

function spaceBody(overrides = {}) {
  return {
    name: 'S3 合成空间',
    ownerName: '负责人甲',
    mode: 'courses',
    weekRule: 'every',
    periods: makePeriods(6),
    visibility: 'masked_list',
    teaching: dynamicTeaching(),
    ...overrides,
  };
}

async function createSpaceOk(handle, cookie, overrides = {}) {
  const response = await call(handle, ctx('/api/spaces', {
    method: 'POST', cookie, body: spaceBody(overrides),
  }));
  assert.equal(response.status, 201, response.text);
  return response.body;
}

function makeRequestId() {
  return `s3_${crypto.randomUUID().replace(/-/g, '')}`;
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

async function generateInvite(handle, ownerCookie, spaceId) {
  const invite = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, {
    method: 'POST', cookie: ownerCookie,
  }));
  assert.equal(invite.status, 201, invite.text);
  return invite.body;
}

async function joinWithCode(handle, memberCookie, code, name, { shareConsent = false } = {}) {
  const body = {
    code,
    inSpaceName: name,
    noticeAccepted: true,
    noticeVersion: NOTICE_VERSION,
  };
  if (shareConsent) {
    body.shareNoticeAccepted = true;
    body.shareNoticeVersion = SHARE_NOTICE_VERSION;
  }
  return call(handle, ctx('/api/join', { method: 'POST', cookie: memberCookie, body }));
}

async function joinMember(handle, ownerCookie, spaceId, memberCookie, name, options) {
  const invite = await generateInvite(handle, ownerCookie, spaceId);
  const joined = await joinWithCode(handle, memberCookie, invite.code, name, options);
  assert.equal(joined.status, 201, joined.text);
  return invite;
}

function exceptionBody(overrides = {}) {
  return {
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
  };
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

async function saveException(handle, cookie, spaceId, overrides) {
  await ensureCalendarConsent(handle, cookie, spaceId);
  return call(handle, ctx(`/api/spaces/${spaceId}/exceptions`, {
    method: 'POST', cookie, body: exceptionBody(overrides),
  }));
}

async function getCollection(handle, cookie, spaceId, month) {
  return call(handle, ctx(`/api/spaces/${spaceId}/collection?month=${month}`, { cookie }));
}

function collectionPeriod(collection, date, period) {
  const day = collection.body.days.find((entry) => entry.date === date);
  return day?.periods.find((entry) => entry.period === period) ?? null;
}

function monthOf(date) {
  return date.slice(0, 7);
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(flags & 0x0008, 0, 'xlsx 不应依赖 data descriptor');
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({ name, data, method, crc });
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

function workbookSheetNames(xml) {
  return [...xml.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
}

// 创建“负责人 + 两名成员”的合成空间；成员甲可选在加入时确认日期共享。
async function buildSpace(handle, { shareConsent = false, memberName = '成员甲' } = {}) {
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, memberName);
  const other = await registerOk(handle, '成员乙');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await joinMember(handle, owner.cookie, spaceId, member.cookie, memberName, { shareConsent });
  const code = shareConsent ? null : invite.code;
  await joinWithCode(handle, other.cookie, invite.code, '成员乙');
  return { owner, member, other, spaceId, invite, code };
}

test('S3-01 收集口径：成员始终计入、负责人默认不计入、草稿不计、零条目提交有效', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const memberA = await registerOk(handle, '成员甲');
  const memberB = await registerOk(handle, '成员乙');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await generateInvite(handle, owner.cookie, spaceId);
  const joinA = await joinWithCode(handle, memberA.cookie, invite.code, '成员甲');
  assert.equal(joinA.status, 201, joinA.text);
  const joinB = await joinWithCode(handle, memberB.cookie, invite.code, '成员乙');
  assert.equal(joinB.status, 201, joinB.text);

  const zero = await publishEntries(handle, memberA.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);
  const draft = await saveDraft(handle, memberB.cookie, spaceId, [
    { day: 1, period: 1, weekRule: 'every', courseName: '仅草稿' },
  ]);
  assert.equal(draft.status, 201, draft.text);

  const members = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(members.status, 200, members.text);
  assert.deepEqual(members.body.summary, { total: 2, submitted: 1, unsubmitted: 1 });
  const ownerRow = members.body.members.find((member) => member.role === 'owner');
  assert.equal(ownerRow.countsInCollection, false);
  assert.equal(ownerRow.hasSubmission, false);
  assert.equal(members.body.ownerParticipation.status, 'unset');

  const home = await call(handle, ctx(`/api/spaces/${spaceId}/home`, { cookie: owner.cookie }));
  assert.equal(home.status, 200, home.text);
  assert.equal(home.body.participation.status, 'unset');
  assert.deepEqual(home.body.collection, { total: 2, submitted: 1, unsubmitted: 1 });

  const memberHome = await call(handle, ctx(`/api/spaces/${spaceId}/home`, { cookie: memberA.cookie }));
  assert.equal(memberHome.body.collection, undefined);
  assert.equal(memberHome.body.ownerParticipation, undefined);

  const month = monthOf(tomorrowInSpace());
  const collection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collection.status, 200, collection.text);
  assert.deepEqual(collection.body.summary, { total: 2, submitted: 1, unsubmitted: 1 });
  assert.equal(collection.body.members.length, 2, '未参与的负责人不应出现在收集名单');
  const period = collectionPeriod(collection, tomorrowInSpace(), 1);
  assert.equal(period.counts.noClass, 1);
  assert.equal(period.counts.unknown, 1);
  assert.equal(period.counts.available, 0);
  assert.ok(period.lists.noClass.includes('成员甲'));
  assert.ok(period.lists.unknown.includes('成员乙'));
  assert.equal(period.groups.pending.count, 1, '未提交成员仍进入待确认');
  assert.equal(period.groups.pending.members[0].reason, 'unsubmitted');
  assert.equal(period.groups.free.members.find((member) => member.name === '成员甲').declared, false,
    '零条目提交按没课计入，不伪装成主动有空');
  assert.equal(db.dump('collection_participants').length, 0, '默认不写负责人参与行');
});

test('S3-02 负责人参与：显式加入、零条目计入、退出保留数据、重新加入必须选择', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员甲');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  await joinMember(handle, owner.cookie, spaceId, member.cookie, '成员甲');
  const zero = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);

  const joinFirst = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join' },
  }));
  assert.equal(joinFirst.status, 200, joinFirst.text);
  assert.equal(joinFirst.body.participation.status, 'joined');
  assert.deepEqual(joinFirst.body.collection, { total: 2, submitted: 1, unsubmitted: 1 });

  const ownerPublish = await publishEntries(handle, owner.cookie, spaceId, []);
  assert.equal(ownerPublish.status, 201, ownerPublish.text);
  const joinedMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.deepEqual(joinedMembers.body.summary, { total: 2, submitted: 2, unsubmitted: 0 });
  const joinedOwnerRow = joinedMembers.body.members.find((row) => row.role === 'owner');
  assert.equal(joinedOwnerRow.countsInCollection, true);
  assert.equal(joinedOwnerRow.hasSubmission, true);

  const month = monthOf(tomorrowInSpace());
  const joinedCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(joinedCollection.body.members.length, 2);
  const ownerSubject = joinedCollection.body.members.find((row) => row.role === 'owner');
  assert.equal(ownerSubject.submitted, true);
  const ownerPeriod = collectionPeriod(joinedCollection, tomorrowInSpace(), 1);
  assert.equal(ownerPeriod.counts.noClass, 2, '零条目提交应算没课而不是未知');
  assert.equal(ownerPeriod.counts.unknown, 0);

  const leave = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'decline' },
  }));
  assert.equal(leave.status, 200, leave.text);
  assert.equal(leave.body.participation.status, 'declined');
  assert.deepEqual(leave.body.collection, { total: 1, submitted: 1, unsubmitted: 0 });
  assert.equal(db.dump('schedule_documents').filter((row) => row.member_id === owner.id).length, 1,
    '退出收集不删除已提交课表');
  assert.equal(db.dump('spaces')[0].owner_id, owner.id, '退出收集不改变负责人身份');

  const rejoinBlind = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join' },
  }));
  assert.equal(rejoinBlind.status, 409);
  assert.equal(rejoinBlind.body.error, 'rejoin_choice_required');

  const rejoinPublished = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join', source: 'published' },
  }));
  assert.equal(rejoinPublished.status, 200, rejoinPublished.text);
  assert.deepEqual(rejoinPublished.body.collection, { total: 2, submitted: 2, unsubmitted: 0 });

  const settings = await call(handle, ctx(`/api/spaces/${spaceId}/settings`, { cookie: owner.cookie }));
  assert.equal(settings.status, 200, settings.text);
  assert.equal(settings.body.space.role, 'owner');
  const denied = await call(handle, ctx(`/api/spaces/${spaceId}/settings`, { cookie: member.cookie }));
  assert.equal(denied.status, 403);
  const memberParticipation = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: member.cookie, body: { action: 'join' },
  }));
  assert.equal(memberParticipation.status, 403);
});

test('S3-03 角色边界：成员无设置与收集入口，只读配置仍包含时间与节次', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const outsider = await registerOk(handle, '旁观者');

  const config = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: member.cookie }));
  assert.equal(config.status, 200, config.text);
  assert.equal(config.body.config.periods.length, 6);
  assert.equal(config.body.teaching.firstWeekMonday, dynamicTeaching().firstWeekMonday);
  assert.equal(config.body.teachingState, 'set');
  assert.equal(config.body.configLocked, false, '尚无有效提交时不锁定');
  assert.equal(config.body.space.role, 'member');
  assert.equal(config.body.invite, undefined);
  const firstPublish = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(firstPublish.status, 201, firstPublish.text);
  const lockedConfig = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: member.cookie }));
  assert.equal(lockedConfig.body.configLocked, true);
  assert.equal(lockedConfig.body.config.periods.length, 6);

  const settings = await call(handle, ctx(`/api/spaces/${spaceId}/settings`, { cookie: member.cookie }));
  assert.equal(settings.status, 403);
  assert.equal(settings.body.error, 'forbidden');
  const settingsOwner = await call(handle, ctx(`/api/spaces/${spaceId}/settings`, { cookie: owner.cookie }));
  assert.equal(settingsOwner.status, 200);
  assert.equal(settingsOwner.body.shareNotice.version, SHARE_NOTICE_VERSION);

  for (const [name, request] of [
    ['members', { method: 'GET' }],
    ['collection', { method: 'GET' }],
    ['collection/export', { method: 'GET' }],
    ['events', { method: 'POST', body: { id: crypto.randomUUID(), title: 'x', startDate: tomorrowInSpace() } }],
    ['events/update', { method: 'POST', body: { id: crypto.randomUUID(), version: 1, title: 'x', startDate: tomorrowInSpace() } }],
    ['events/delete', { method: 'POST', body: { id: crypto.randomUUID(), version: 1 } }],
    ['participation', { method: 'POST', body: { action: 'join' } }],
    ['teaching', { method: 'POST', body: { teaching: dynamicTeaching() } }],
  ]) {
    const response = await call(handle, ctx(`/api/spaces/${spaceId}/${name}`, {
      method: request.method, cookie: member.cookie, body: request.body,
    }));
    assert.equal(response.status, 403, `${name} 应拒绝成员：${response.status} ${response.text}`);
  }

  for (const path of ['home', 'config', 'calendar?month=2026-11']) {
    const response = await call(handle, ctx(`/api/spaces/${spaceId}/${path}`, { cookie: outsider.cookie }));
    assert.equal(response.status, 403, `${path} 应拒绝非成员`);
  }
  const ownerMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(ownerMembers.status, 200);
  assert.equal(ownerMembers.body.members.some((row) => row.username || row.userId), false,
    '成员列表不返回账号标识');
});

test('S3-04 共享确认：未确认只见课程占用，无课不推断可用，撤回不删除日期例外', async () => {
  const { db, handle } = fixture();
  const { owner, member, other, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);

  const published = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '数据库系统' },
  ]);
  assert.equal(published.status, 201, published.text);
  const available = await saveException(handle, member.cookie, spaceId, {
    date, period: 2, personalState: 'available',
  });
  assert.equal(available.status, 201, available.text);

  const before = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(before.status, 200, before.text);
  const beforeClass = collectionPeriod(before, date, 1);
  const beforeFree = collectionPeriod(before, date, 2);
  assert.equal(beforeClass.counts.classOccupied, 1);
  assert.equal(beforeClass.counts.available, 0);
  assert.equal(beforeClass.lists.class[0].courseName, '数据库系统');
  assert.equal(beforeFree.counts.noClass, 1);
  assert.equal(beforeFree.counts.available, 0);
  assert.equal(beforeFree.counts.unknown, 1, '未提交成员只计未知');
  assert.ok(beforeFree.lists.noShare.includes('成员甲'));
  assert.ok(beforeFree.lists.noClass.includes('成员甲'));
  assert.ok(beforeFree.lists.unknown.includes('成员乙'));

  const badAccept = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: 'wrong-version' },
  }));
  assert.equal(badAccept.status, 403);
  assert.equal(badAccept.body.error, 'share_notice_required');

  const accept = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: SHARE_NOTICE_VERSION },
  }));
  assert.equal(accept.status, 200, accept.text);
  assert.equal(accept.body.consent.accepted, true);

  const shared = await getCollection(handle, owner.cookie, spaceId, month);
  const sharedFree = collectionPeriod(shared, date, 2);
  assert.equal(sharedFree.counts.available, 1);
  assert.equal(sharedFree.counts.noClass, 0);
  assert.equal(sharedFree.counts.unknown, 1);
  assert.ok(sharedFree.lists.available.includes('成员甲'));
  assert.equal(sharedFree.lists.noShare.includes('成员甲'), false);
  assert.ok(shared.body.members.find((row) => row.name === '成员甲').share.accepted);
  assert.equal(shared.body.members.find((row) => row.name === '成员乙').share.accepted, false);

  const memberCalendar = await call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberCalendar.status, 200);
  assert.equal(memberCalendar.body.share.consent.accepted, true);
  const ownFree = memberCalendar.body.days.find((day) => day.date === date)
    .periods.find((item) => item.period === 2);
  assert.equal(ownFree.status, 'available');

  const exceptionCount = db.dump('date_exceptions').length;
  const exceptionVersion = db.dump('date_exceptions')[0].version;
  const revoke = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie, body: { action: 'revoke' },
  }));
  assert.equal(revoke.status, 200, revoke.text);
  assert.equal(revoke.body.consent.status, 'revoked');

  const revoked = await getCollection(handle, owner.cookie, spaceId, month);
  const revokedFree = collectionPeriod(revoked, date, 2);
  assert.equal(revokedFree.counts.available, 0, '撤回后不得继续显示明确可用');
  assert.equal(revokedFree.counts.noClass, 1);
  assert.ok(revokedFree.lists.noShare.includes('成员甲'));
  assert.equal(db.dump('date_exceptions').length, exceptionCount);
  assert.equal(db.dump('date_exceptions')[0].version, exceptionVersion);

  const again = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: SHARE_NOTICE_VERSION },
  }));
  assert.equal(again.status, 200, again.text);
  const restored = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(restored, date, 2).counts.available, 1,
    '重新确认后无需重写例外即可恢复共享投影');
  assert.equal(db.dump('date_exceptions')[0].version, exceptionVersion);

  // 旧表 accepted_at 非空不代表同意：状态为 declined 时仍不得进入共享投影。
  await db.from('calendar_share_consents').update({
    status: 'declined', accepted_at: new Date().toISOString(),
  }).eq('space_id', spaceId).eq('member_id', member.id);
  const legacyDeclined = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(legacyDeclined, date, 2).counts.available, 0,
    'accepted_at 非空但 status=declined 不得视为共享');
  assert.ok(collectionPeriod(legacyDeclined, date, 2).lists.noShare.includes('成员甲'));
  const legacyConsents = await call(handle, ctx('/api/consents', { cookie: member.cookie }));
  assert.equal(legacyConsents.status, 200);
  const legacyView = legacyConsents.body.items.find((item) => item.spaceId === spaceId).share;
  assert.equal(legacyView.status, 'declined');
  assert.equal(legacyView.accepted, false);
  assert.equal(legacyView.acceptedAt, null, '拒绝状态不暴露旧 accepted_at 为确认时间');

  const crossRead = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&memberId=${owner.id}`, { cookie: member.cookie },
  ));
  assert.equal(crossRead.status, 403);
  const crossWrite = await saveException(handle, member.cookie, spaceId, {
    memberId: owner.id, date, period: 3, personalState: 'busy',
  });
  assert.equal(crossWrite.status, 403);
  const joinShare = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(joinShare.status, 200);
  assert.equal(joinShare.body.members.find((row) => row.inSpaceName === '成员乙').share.accepted, false,
    '未在加入时确认共享的成员保持未确认');
  assert.ok(other);
});

test('S3-05 收集日历：负责人专属、学期外不推断、事件分离且私有事件不泄露', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const month = monthOf(date);

  const join = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join' },
  }));
  assert.equal(join.status, 200, join.text);

  const privateTitle = `私密事件-${crypto.randomUUID().slice(0, 6)}`;
  const privateEvent = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: privateTitle, startDate: date, endDate: date },
  }));
  assert.equal(privateEvent.status, 201, privateEvent.text);
  assert.equal(privateEvent.body.event.visibility, 'private');

  const ownerView = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(ownerView.status, 200, ownerView.text);
  assert.ok(ownerView.body.events.some((event) => event.title === privateTitle),
    '负责人可在收集日历看到自己的私有事件');
  assert.equal(ownerView.body.summary.total, 3, '两名普通成员 + 参与收集的负责人');

  const memberView = await getCollection(handle, member.cookie, spaceId, month);
  assert.equal(memberView.status, 403);
  const memberEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberEvents.status, 200);
  assert.equal(memberEvents.text.includes(privateTitle), false);

  const termOut = await getCollection(handle, owner.cookie, spaceId, '2030-01');
  assert.equal(termOut.status, 200, termOut.text);
  assert.ok(termOut.body.days.every((day) => day.inTerm === false && day.periods.length === 0));
  const badMonth = await getCollection(handle, owner.cookie, spaceId, '2026-13');
  assert.equal(badMonth.status, 400);
});

test('S3-06 导出：恰好 7 张课程表、只含有课/没课/未确定、停课与个人状态/事件分离、公式与敏感内容排除、成员拒绝', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员甲');
  const other = await registerOk(handle, '成员乙');
  const outsider = await registerOk(handle, '成员丙');
  const created = await createSpaceOk(handle, owner.cookie, { mode: 'courses' });
  const spaceId = created.space.id;
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const weekStart = addDays(date, 1 - weekday);
  const weekEnd = addDays(weekStart, 6);
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const invite = await joinMember(handle, owner.cookie, spaceId, member.cookie, '=SUM(1,1)');
  await joinWithCode(handle, other.cookie, invite.code, '成员乙');
  await joinWithCode(handle, outsider.cookie, invite.code, '成员乙');

  const published = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '=HYPERLINK("http://x","y")&<测试>' },
    { day: weekday, period: 3, weekRule: 'every', courseName: '课程丙' },
    { day: weekday, period: 4, weekRule: 'every', courseName: '课程丁' },
  ]);
  assert.equal(published.status, 201, published.text);
  const shared = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: SHARE_NOTICE_VERSION },
  }));
  assert.equal(shared.status, 200, shared.text);
  const available = await saveException(handle, member.cookie, spaceId, {
    date, period: 2, personalState: 'available',
  });
  assert.equal(available.status, 201, available.text);
  const cancelValid = await saveException(handle, member.cookie, spaceId, {
    date, period: 3, cancelClass: true,
  });
  assert.equal(cancelValid.status, 201, cancelValid.text);
  const cancelStale = await saveException(handle, member.cookie, spaceId, {
    date, period: 4, cancelClass: true,
  });
  assert.equal(cancelStale.status, 201, cancelStale.text);
  const republished = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '=HYPERLINK("http://x","y")&<测试>' },
    { day: weekday, period: 3, weekRule: 'every', courseName: '课程丙' },
    { day: weekday, period: 4, weekRule: 'every', courseName: '课程丁已更换' },
  ], 1);
  assert.ok([200, 201].includes(republished.status), republished.text);

  const zero = await publishEntries(handle, outsider.cookie, spaceId, []);
  assert.equal(zero.status, 201, zero.text);
  const draft = await saveDraft(handle, other.cookie, spaceId, [
    { day: weekday, period: 3, weekRule: 'every', courseName: '草稿秘密课程' },
  ]);
  assert.equal(draft.status, 201, draft.text);

  const ownerPublish = await publishEntries(handle, owner.cookie, spaceId, []);
  assert.equal(ownerPublish.status, 201, ownerPublish.text);
  const ownerJoin = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join', source: 'published' },
  }));
  assert.equal(ownerJoin.status, 200, ownerJoin.text);

  for (const period of [1, 2]) {
    const arrangement = await call(handle, ctx(`/api/spaces/${spaceId}/arrangements`, {
      method: 'POST', cookie: owner.cookie,
      body: { id: crypto.randomUUID(), kind: 'busy', targetUserId: member.id, date, period },
    }));
    assert.equal(arrangement.status, 201, arrangement.text);
    const accepted = await call(handle, ctx(`/api/spaces/${spaceId}/assignments/respond`, {
      method: 'POST', cookie: member.cookie,
      body: {
        id: arrangement.body.assignment.id,
        requestId: crypto.randomUUID(),
        action: 'accept',
        expectedVersion: 1,
      },
    }));
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.assignment.status, 'accepted');
  }

  const privateTitle = `私密事件-${crypto.randomUUID().slice(0, 6)}`;
  const publicTitle = `公开事件-${crypto.randomUUID().slice(0, 6)}`;
  const privateEvent = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: privateTitle, startDate: date, endDate: date },
  }));
  assert.equal(privateEvent.status, 201);
  const publicEvent = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: publicTitle, startDate: date, endDate: date, visibility: 'space' },
  }));
  assert.equal(publicEvent.status, 201);

  const response = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie: owner.cookie },
  ));
  assert.equal(response.status, 200, response.buffer.toString('utf8'));
  assert.match(response.headers.get('content-type') ?? '',
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.equal(response.buffer.readUInt32LE(0), 0x04034b50, '必须是 ZIP 容器而不是改后缀的 HTML');

  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  assert.ok(encodedName, '必须提供 RFC 5987 中文文件名');
  const filename = decodeURIComponent(encodedName);
  assert.equal(filename, `S3 合成空间_课程表_${weekStart}至${weekEnd}.xlsx`);
  assert.equal(/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename), false, '文件名不能包含非法字符');
  const fallbackName = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
  assert.equal(/[^\x20-\x7e]/.test(fallbackName), false, 'ASCII 降级文件名不能包含非 ASCII 字符');

  const entries = zipEntries(response.buffer);
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    assert.equal(entry.method, 0, '当前实现使用 ZIP store');
    assert.equal(crc32(entry.data), entry.crc, `${entry.name} CRC 不匹配`);
  }
  const sheetNames = workbookSheetNames(entryText(entries, 'xl/workbook.xml'));
  assert.deepEqual(sheetNames, weekdays.map((label, index) => (
    `${label}_${addDays(weekStart, index).slice(5)}`
  )), '恰好 7 张周一至周日工作表，不包含独立说明表');
  for (const name of sheetNames) {
    assert.ok(name.length <= 31, `工作表名过长：${name}`);
    assert.equal(/[:\\/?*\[\]]/.test(name), false, `工作表名含非法字符：${name}`);
  }
  const workbookXml = entryText(entries, 'xl/workbook.xml');
  assert.equal((workbookXml.match(/_xlnm\.Print_Titles/g) ?? []).length, 7, '每张表都设置打印标题');
  for (const entry of entries.filter((item) => item.name.startsWith('xl/worksheets/'))) {
    const xml = entry.data.toString('utf8');
    assert.equal(/<f[\s>]/.test(xml), false, '不得写入公式单元格');
  }

  const daily = entryText(entries, `xl/worksheets/sheet${weekday}.xml`);
  assert.ok(daily.includes('t="inlineStr"'));
  assert.ok(daily.includes('=SUM(1,1)'), '姓名以文本写入');
  assert.ok(daily.includes('负责人甲'));
  assert.ok(daily.includes(`${weekdays[weekday - 1]} ${date}`), '标题包含具体日期');
  assert.match(daily, /第 \d+ 教学周 · [单双]周/);
  assert.ok(daily.includes('第1节'));
  assert.ok(daily.includes('08:00–08:45'), '表头包含节次时间');
  assert.ok(daily.includes('第6节'));
  assert.ok(daily.includes('没课不代表有空参加活动'));
  assert.ok(daily.includes('个人忙碌、已接受事件与安排不改变'));
  assert.match(daily, /<pane xSplit="1" ySplit="3"[^>]*state="frozen"/, '冻结姓名列与表头');
  assert.ok(daily.includes('orientation="landscape"'));
  assert.ok(daily.includes('<c r="A4" t="inlineStr" s="2">'), '姓名列自动换行');
  assert.ok(entryText(entries, 'xl/styles.xml').includes('wrapText="1"'));

  const rows = workbookRows(daily);
  const memberRow = rows.find((row) => row.includes('>=SUM(1,1)<'));
  assert.ok(memberRow, '每日表应包含成员甲（空间名以公式样文本写入）');
  assert.deepEqual(rowTexts(memberRow), [
    '=SUM(1,1)', '有课', '没课', '没课', '未确认', '没课', '没课',
  ], '有课+已接受事件仍为有课；无课+事件/声明仍为没课；有效停课为没课；课程更换后停课冲突为未确认');
  assert.equal(memberRow.includes('有课') && memberRow.includes('课程'), false,
    '课程名与课程明细不进入导出');

  const footerRows = rows.filter((row) => /<c r="A\d+"[^>]*s="7"/.test(row));
  assert.equal(footerRows.length, 3, '页脚只保留有课、没课、未确定三行');
  const footerCounts = Object.fromEntries(footerRows.map((row) => {
    const cells = rowCellValues(row);
    return [cells[0], cells.slice(1)];
  }));
  assert.deepEqual({ ...footerCounts, 有课: footerCounts['有课'][0], 没课: footerCounts['没课'][0], 未确定: footerCounts['未确定'][0] },
    { 有课: '1', 没课: '2', 未确定: '1' }, '第 1 节：成员甲有课；负责人与零条目提交成员没课；仅草稿成员未确定');
  for (const label of ['有课人数', '忙碌人数', '有空人数', '待确认人数', '未授权人数', '有空＊']) {
    assert.equal(daily.includes(label), false, `导出不得保留旧统计/状态：${label}`);
  }

  const duplicateCodes = [...daily.matchAll(/成员乙（([0-9A-F]{4,})）/g)].map((match) => match[1]);
  assert.equal(duplicateCodes.length, 2, '重名成员各占一行');
  assert.equal(new Set(duplicateCodes).size, 2, '重名成员使用不同短代码');
  assert.equal((daily.match(/负责人甲/g) ?? []).length, 1, '参与收集的负责人只出现一次');
  const duplicateRows = rows.filter((row) => row.includes('成员乙（'));
  assert.equal(duplicateRows.length, 2, '重名成员各占一行');
  const unsubmittedRow = duplicateRows.find((row) => row.includes('未确认'));
  const noClassRow = duplicateRows.find((row) => row.includes('没课'));
  assert.ok(unsubmittedRow, '只有草稿、从未提交的成员保持未确认');
  assert.ok(noClassRow, '零条目提交且未共享日期例外的成员按没课导出');
  assert.equal(unsubmittedRow.includes('没课'), false);
  assert.equal(daily.includes('草稿秘密课程'), false, '草稿不得导出');
  assert.equal(daily.includes('HYPERLINK'), false, '课程名不进入日课表单元格');
  assert.equal(daily.includes('课程丙') || daily.includes('课程丁'), false, '课程名不进入导出');

  const notes = entryText(entries, 'xl/worksheets/sheet1.xml');
  assert.equal(notes.includes('日期状态口径'), false, '不再生成独立说明内容');
  assert.ok(notes.includes('没课不代表有空参加活动'));

  const allXml = entries.map((entry) => entry.data.toString('utf8')).join('\n');
  for (const secret of [
    privateTitle, publicTitle, '草稿秘密课程', '课程丙', '课程丁已更换', invite.code,
    invite.code.replace(/-/g, ''), member.username, other.username, outsider.username, owner.username,
    PASSWORD, member.cookie.split('=')[1],
    db.dump('space_invites')[0].code_hash,
  ]) {
    assert.equal(allXml.includes(secret), false, `导出不得包含敏感内容：${secret.slice(0, 12)}…`);
  }

  const denied = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie: member.cookie },
  ));
  assert.equal(denied.status, 403);
  const badWeek = await call(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=not-a-date`, { cookie: owner.cookie },
  ));
  assert.equal(badWeek.status, 400);
  assert.equal(badWeek.body.error, 'invalid_export_date');

  const outStart = addDays('2030-01-01', 1 - weekdayMon1('2030-01-01'));
  const termOut = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${outStart}`, { cookie: owner.cookie },
  ));
  assert.equal(termOut.status, 200, termOut.buffer.toString('utf8'));
  const outEntries = zipEntries(termOut.buffer);
  const outDaily = entryText(outEntries, 'xl/worksheets/sheet1.xml');
  assert.ok(outDaily.includes('学期外'), '学期外不能伪装成没课');
  const outMemberRows = workbookRows(outDaily)
    .filter((row) => !/<c r="A\d+"[^>]*s="7"/.test(row));
  assert.equal(outMemberRows.some((row) => row.includes('>没课<')), false,
    '学期外成员单元格不得写作没课');
  assert.ok(outDaily.includes('本日不作课程判断'));
  assert.equal(workbookSheetNames(entryText(outEntries, 'xl/workbook.xml')).length, 7);

  const leave = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'decline' },
  }));
  assert.equal(leave.status, 200);
  const afterLeave = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie: owner.cookie },
  ));
  assert.equal(afterLeave.status, 200);
  const afterEntries = zipEntries(afterLeave.buffer);
  const afterDaily = entryText(afterEntries, `xl/worksheets/sheet${weekday}.xml`);
  assert.equal(afterDaily.includes('负责人甲'), false, '退出收集的负责人不出现在导出');
  assert.equal(afterDaily.includes('=SUM(1,1)'), true);
  assert.equal(workbookSheetNames(entryText(afterEntries, 'xl/workbook.xml')).length, 7);
});

test('S3-07 导出口径：仅有课模式不写课程名、未共享日期例外仍按没课、节次列自适应、跨年周仍为 7 张', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员甲');
  const created = await createSpaceOk(handle, owner.cookie, {
    mode: 'presence', periods: makePeriods(4),
  });
  const spaceId = created.space.id;
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const weekStart = addDays(date, 1 - weekday);
  await joinMember(handle, owner.cookie, spaceId, member.cookie, '成员甲');
  const published = await publishEntries(handle, owner.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', hasClass: true },
  ]);
  assert.equal(published.status, 201, published.text);
  const memberPublish = await publishEntries(handle, member.cookie, spaceId, []);
  assert.equal(memberPublish.status, 201, memberPublish.text);
  const join = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join', source: 'published' },
  }));
  assert.equal(join.status, 200, join.text);

  const response = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie: owner.cookie },
  ));
  assert.equal(response.status, 200, response.buffer.toString('utf8'));
  const entries = zipEntries(response.buffer);
  const daily = entryText(entries, `xl/worksheets/sheet${weekday}.xml`);
  assert.equal((daily.match(/第\d节/g) ?? []).length, 4, '节次列按空间配置而不是硬编码 12 节');
  assert.ok(daily.includes('没课'), '已提交但未共享日期例外时，空节次仍按没课导出');
  const rows = workbookRows(daily);
  const memberRow = rows.find((row) => row.includes('>成员甲<'));
  assert.ok(memberRow, '每日表应包含成员甲');
  assert.equal(rowTexts(memberRow).slice(1).every((text) => text === '没课'), true,
    '零条目提交的空节次为没课，不因未共享变成未授权');
  assert.match(daily, /第 \d+ 教学周 · [单双]周/);
  assert.equal(/<f[\s>]/.test(daily), false);
  assert.equal(daily.includes('仅课状态'), false);
  assert.equal(entries.some((entry) => entry.name === 'xl/worksheets/sheet8.xml'), false);

  const crossYear = '2026-12-31';
  const cross = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?date=${crossYear}`, { cookie: owner.cookie },
  ));
  assert.equal(cross.status, 200, cross.buffer.toString('utf8'));
  const crossDisposition = cross.headers.get('content-disposition') ?? '';
  const crossName = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(crossDisposition)?.[1] ?? '');
  assert.equal(crossName, 'S3 合成空间_课程表_2026-12-28至2027-01-03.xlsx',
    'date 参数按所选日期所在周生成周一至周日文件名');
  const crossEntries = zipEntries(cross.buffer);
  assert.deepEqual(workbookSheetNames(entryText(crossEntries, 'xl/workbook.xml')), [
    '周一_12-28', '周二_12-29', '周三_12-30', '周四_12-31', '周五_01-01', '周六_01-02', '周日_01-03',
  ], '跨年周仍然恰好 7 张工作日工作表');
});

test('S3-08 空间事件：默认私有、CAS 更新、私有→公开→私有、成员只读', async () => {
  const { db, handle } = fixture();
  const { owner, member, other, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const month = monthOf(date);
  const eventId = crypto.randomUUID();
  const title = `内部安排-${crypto.randomUUID().slice(0, 6)}`;

  const created = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, title, startDate: date, endDate: date },
  }));
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.event.visibility, 'private');
  assert.equal(created.body.event.version, 1);

  const replay = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, title, startDate: date, endDate: date },
  }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const reuse = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, title: `${title}-改`, startDate: date, endDate: date },
  }));
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error, 'event_reuse_conflict');

  const memberPrivate = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberPrivate.status, 200);
  assert.equal(memberPrivate.body.events.length, 0);
  assert.equal(memberPrivate.text.includes(title), false);
  const memberCalendarPrivate = await call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberCalendarPrivate.body.events.length, 0);

  const toPublic = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, version: 1, title, startDate: date, endDate: date, visibility: 'space' },
  }));
  assert.equal(toPublic.status, 200, toPublic.text);
  assert.equal(toPublic.body.event.visibility, 'space');
  assert.equal(toPublic.body.event.version, 2);

  const memberPublic = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberPublic.body.events.length, 1);
  assert.equal(memberPublic.body.events[0].title, title);
  assert.equal(memberPublic.body.events[0].editable, false);
  const memberCalendarPublic = await call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberCalendarPublic.body.events.length, 1);
  assert.equal(memberCalendarPublic.body.events[0].title, title);
  const noScheduleEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: other.cookie,
  }));
  assert.equal(noScheduleEvents.body.events.length, 1, '未提交课表的成员仍能看到公开事件');

  const stale = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, version: 1, title, startDate: date, endDate: date, visibility: 'space' },
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'event_conflict');

  const memberUpdate = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST', cookie: member.cookie,
    body: { id: eventId, version: 2, title: '成员改', startDate: date, endDate: date, visibility: 'space' },
  }));
  assert.equal(memberUpdate.status, 403);
  const memberDelete = await call(handle, ctx(`/api/spaces/${spaceId}/events/delete`, {
    method: 'POST', cookie: member.cookie, body: { id: eventId, version: 2 },
  }));
  assert.equal(memberDelete.status, 403);

  const backPrivate = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: eventId, version: 2, title, startDate: date, endDate: date, visibility: 'private' },
  }));
  assert.equal(backPrivate.status, 200, backPrivate.text);
  assert.equal(backPrivate.body.event.version, 3);
  const memberAfterPrivate = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: member.cookie,
  }));
  assert.equal(memberAfterPrivate.body.events.length, 0, '改回私有后成员立即不可见');
  const ownerStill = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: owner.cookie,
  }));
  assert.equal(ownerStill.body.events.length, 1);

  const deleteStale = await call(handle, ctx(`/api/spaces/${spaceId}/events/delete`, {
    method: 'POST', cookie: owner.cookie, body: { id: eventId, version: 1 },
  }));
  assert.equal(deleteStale.status, 409);
  const deleted = await call(handle, ctx(`/api/spaces/${spaceId}/events/delete`, {
    method: 'POST', cookie: owner.cookie, body: { id: eventId, version: 3 },
  }));
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.body.version, 4);
  const ownerAfterDelete = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: owner.cookie,
  }));
  assert.equal(ownerAfterDelete.body.events.length, 0);
  assert.equal(db.dump('space_events').filter((row) => row.deleted !== true).length, 0);
});

test('S3-09 事件校验：日期范围、时间、标题与成员写入全部拒绝', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();

  const memberCreate = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: member.cookie,
    body: { id: crypto.randomUUID(), title: '成员事件', startDate: date },
  }));
  assert.equal(memberCreate.status, 403);

  const badRange = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: '倒序', startDate: date, endDate: addDays(date, -1) },
  }));
  assert.equal(badRange.status, 400);
  assert.equal(badRange.body.error, 'event_end_before_start');

  const tooLong = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: '太长', startDate: date, endDate: addDays(date, 31) },
  }));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, 'event_range_too_long');

  const badTime = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: {
      id: crypto.randomUUID(), title: '时间', startDate: date,
      allDay: false, startTime: '10:00', endTime: '09:00',
    },
  }));
  assert.equal(badTime.status, 400);
  assert.equal(badTime.body.error, 'invalid_event_time');

  const emptyTitle = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: { id: crypto.randomUUID(), title: '   ', startDate: date },
  }));
  assert.equal(emptyTitle.status, 400);
  assert.equal(emptyTitle.body.error, 'invalid_event_title');

  const ok = await call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie: owner.cookie,
    body: {
      id: crypto.randomUUID(), title: '全天', startDate: date, endDate: addDays(date, 2),
      description: '说明',
    },
  }));
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.event.allDay, true);
});

test('S3-10 收集三主组：课程优先、取消课程不算有课、未共享只隐藏日期例外、没课与主动有空分开', async () => {
  const { handle } = fixture();
  const { owner, member, other, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);

  const memberPublish = await publishEntries(handle, member.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '第一节课' },
    { day: weekday, period: 4, weekRule: 'every', courseName: '将被取消的课' },
  ]);
  assert.equal(memberPublish.status, 201, memberPublish.text);
  const otherPublish = await publishEntries(handle, other.cookie, spaceId, []);
  assert.equal(otherPublish.status, 201, otherPublish.text);
  const ownerPublish = await publishEntries(handle, owner.cookie, spaceId, []);
  assert.equal(ownerPublish.status, 201, ownerPublish.text);
  const join = await call(handle, ctx(`/api/spaces/${spaceId}/participation`, {
    method: 'POST', cookie: owner.cookie, body: { action: 'join', source: 'published' },
  }));
  assert.equal(join.status, 200, join.text);

  const declaredFree = await saveException(handle, member.cookie, spaceId, {
    date, period: 2, personalState: 'available',
  });
  assert.equal(declaredFree.status, 201, declaredFree.text);
  const declaredBusy = await saveException(handle, member.cookie, spaceId, {
    date, period: 3, personalState: 'busy',
  });
  assert.equal(declaredBusy.status, 201, declaredBusy.text);
  const cancelCourse = await saveException(handle, member.cookie, spaceId, {
    date, period: 4, cancelClass: true, personalState: 'available',
  });
  assert.equal(cancelCourse.status, 201, cancelCourse.text);

  const before = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(before.status, 200, before.text);
  const dayBefore = before.body.days.find((day) => day.date === date);
  assert.ok(dayBefore);
  const p1 = dayBefore.periods.find((period) => period.period === 1);
  const p2 = dayBefore.periods.find((period) => period.period === 2);
  const p3 = dayBefore.periods.find((period) => period.period === 3);
  assert.deepEqual(
    [p1.groups.class.count, p1.groups.busy.count, p1.groups.free.count, p1.groups.pending.count],
    [1, 0, 2, 0],
    '未共享成员的有课仍可见，其余已提交成员的没课进入没课/有空组',
  );
  assert.deepEqual(
    [p2.groups.free.count, p2.groups.free.declaredCount, p2.groups.pending.count],
    [3, 0, 0],
    '未确认共享时只隐藏主动有空声明，没课本身仍可见',
  );
  assert.ok(p2.groups.free.members.some((item) => item.name === '成员甲' && item.declared === false));
  assert.deepEqual(
    [p3.groups.busy.count, p3.groups.free.count, p3.groups.pending.count],
    [0, 3, 0],
    '未确认共享时，忙碌声明也不外泄',
  );

  const share = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST', cookie: member.cookie,
    body: { action: 'accept', noticeAccepted: true, noticeVersion: SHARE_NOTICE_VERSION },
  }));
  assert.equal(share.status, 200, share.text);

  const after = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(after.status, 200, after.text);
  const dayAfter = after.body.days.find((day) => day.date === date);
  const pAfter = (number) => dayAfter.periods.find((period) => period.period === number);
  assert.deepEqual(
    [pAfter(1).groups.class.count, pAfter(1).groups.busy.count, pAfter(1).groups.free.count, pAfter(1).groups.pending.count],
    [1, 0, 2, 0],
    '课程优先：同一成员只进入有课组，不重复计数',
  );
  const free2 = pAfter(2).groups.free;
  assert.equal(free2.count, 3);
  assert.equal(free2.declaredCount, 1, '没课与主动有空分开计数');
  const memberFree = free2.members.find((item) => item.name === '成员甲');
  const ownerFree = free2.members.find((item) => item.name === '负责人甲');
  assert.equal(memberFree.declared, true);
  assert.equal(ownerFree.declared, false);
  const busy3 = pAfter(3).groups.busy;
  assert.equal(busy3.count, 1);
  assert.equal(busy3.members[0].name, '成员甲');
  assert.deepEqual(busy3.members[0].sources, [{ type: 'personal', label: '个人声明' }],
    '忙碌保留来源明细');
  assert.equal(pAfter(3).groups.free.count, 2);
  assert.equal(pAfter(3).groups.pending.count, 0);
  const p4 = pAfter(4);
  assert.equal(p4.groups.class.count, 0, '已取消课程不能再计入有课');
  assert.equal(p4.groups.free.count, 3);
  assert.equal(p4.groups.free.declaredCount, 1);

  for (const period of dayAfter.periods) {
    const total = ['class', 'busy', 'free', 'pending']
      .reduce((sum, key) => sum + period.groups[key].count, 0);
    assert.equal(total, before.body.summary.total, `第 ${period.period} 节分组总人数不得重复或遗漏`);
  }
});

test('S3-11 草稿预览：仅本人只读投影，不改变提交状态、收集口径或负责人视图', async () => {
  const { handle } = fixture();
  const { owner, member, spaceId } = await buildSpace(handle);
  const today = todayInSpace();
  let monday = today;
  while (weekdayMon1(monday) !== 1) monday = addDays(monday, 1);
  const month = monthOf(monday);

  const noDraft = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&preview=draft`, { cookie: member.cookie },
  ));
  assert.equal(noDraft.status, 404, '没有草稿时预览请求明确拒绝');

  const draftCourse = `草稿预览课-${crypto.randomUUID().slice(0, 6)}`;
  const saved = await saveDraft(handle, member.cookie, spaceId, [
    { day: 1, period: 1, weekRule: 'every', courseName: draftCourse },
  ]);
  assert.equal(saved.status, 201, saved.text);

  const normal = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}`, { cookie: member.cookie },
  ));
  assert.equal(normal.status, 200, normal.text);
  assert.equal(normal.body.preview, null);
  assert.equal(normal.body.submitted, false);
  assert.equal(normal.body.state, 'unknown', '未提交时普通月历仍是未知');
  assert.equal(normal.body.draft.exists, true);
  assert.equal(normal.body.draft.changed, true);
  const normalMonday = normal.body.days.find((day) => day.date === monday);
  assert.equal(normalMonday.periods.find((item) => item.period === 1).status, 'unknown');
  assert.equal(normal.text.includes(draftCourse), false, '草稿不进入普通月历响应');

  const preview = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&preview=draft`, { cookie: member.cookie },
  ));
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.body.preview, 'draft');
  assert.equal(preview.body.submitted, false);
  assert.equal(preview.body.publishedVersion, 0);
  const previewMonday = preview.body.days.find((day) => day.date === monday);
  const previewPeriod = previewMonday.periods.find((item) => item.period === 1);
  assert.equal(previewPeriod.status, 'class_occupied');
  assert.equal(previewPeriod.courseName, draftCourse);
  assert.equal(previewPeriod.editable, previewMonday.editable, '只读预览不扩大例外编辑范围');

  const stillDraft = await call(handle, ctx(`/api/spaces/${spaceId}/schedule`, { cookie: member.cookie }));
  assert.equal(stillDraft.body.schedule.publishedVersion, 0, '预览不得把草稿写成已提交');

  const ownerPreview = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&preview=draft`, { cookie: owner.cookie },
  ));
  assert.equal(ownerPreview.status, 404, '负责人没有本人草稿，不能借预览读取成员草稿');
  const ownerCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(ownerCollection.status, 200, ownerCollection.text);
  assert.equal(ownerCollection.text.includes(draftCourse), false, '草稿不得进入收集日历');
  assert.ok(ownerCollection.body.summary.unsubmitted >= 1, '草稿仍按未提交统计');

  const published = await publishEntries(handle, member.cookie, spaceId, [
    { day: 1, period: 1, weekRule: 'every', courseName: draftCourse },
  ], saved.body.schedule.revision);
  assert.ok([200, 201].includes(published.status), published.text);
  const afterPublish = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}`, { cookie: member.cookie },
  ));
  assert.equal(afterPublish.body.submitted, true);
  assert.equal(afterPublish.body.draft.changed, false, '提交后草稿与有效版本一致');
  assert.equal(afterPublish.body.days.find((day) => day.date === monday)
    .periods.find((item) => item.period === 1).status, 'class_occupied');
});

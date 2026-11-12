// Batch G 本地契约检查：真实 router/assignments/collection/export 代码 + 内存假数据库。
// 验证事件接收人快照、成员确认后投影、课程优先、改期失效、删除释放、负责人安排、
// 幂等/版本冲突、权限隔离与导出占位。不证明真实 Provider 事务或 Excel/WPS 渲染。
//   node --test dev/check-s4.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createApplication } from '../functions/router.mjs';
import {
  CALENDAR_NOTICE_VERSION, NOTICE_VERSION, SHARE_NOTICE_VERSION,
} from '../functions/notices.mjs';
import { addDays, localToday, weekdayMon1 } from '../functions/calendar.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s4.test';
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
    requestId: 'local-s4-check',
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
  const username = `s4_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
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

const todayInSpace = () => localToday('Asia/Shanghai');
const tomorrowInSpace = () => addDays(todayInSpace(), 1);
const monthOf = (date) => date.slice(0, 7);
const makeRequestId = () => `s4_${crypto.randomUUID().replace(/-/g, '')}`;

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
      name: 'S4 合成空间',
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
  return invite;
}

async function publishEntries(handle, cookie, spaceId, entries) {
  const response = await call(handle, ctx(`/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    cookie,
    body: { requestId: makeRequestId(), baseRevision: 0, entries },
  }));
  assert.equal(response.status, 201, response.text);
  return response;
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
    title: '评审会',
    startDate: date,
    endDate: date,
    allDay: true,
    visibility: 'invitees',
    recipientScope: 'selected',
    recipients: [],
    ...overrides,
  };
}

function eventStampAllDay(date) {
  return `${date}|${date}|1||`;
}

async function createEvent(handle, cookie, spaceId, body) {
  return call(handle, ctx(`/api/spaces/${spaceId}/events`, {
    method: 'POST', cookie, body,
  }));
}

async function getCalendar(handle, cookie, spaceId, month) {
  return call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}`, { cookie }));
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

async function respond(handle, cookie, spaceId, body) {
  // 安排响应按客户端 UUID 幂等；测试辅助统一生成合法 UUID。
  return call(handle, ctx(`/api/spaces/${spaceId}/assignments/respond`, {
    method: 'POST', cookie, body: { ...body, requestId: crypto.randomUUID() },
  }));
}

async function arrange(handle, cookie, spaceId, body) {
  return call(handle, ctx(`/api/spaces/${spaceId}/arrangements`, {
    method: 'POST', cookie, body,
  }));
}

async function buildSpace(handle, { shareA = true } = {}) {
  const owner = await registerOk(handle, '负责人');
  const memberA = await registerOk(handle, '成员甲');
  const memberB = await registerOk(handle, '成员乙');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await generateInvite(handle, owner.cookie, spaceId);
  await joinMember(handle, invite, memberA.cookie, '成员甲', { share: shareA });
  await joinMember(handle, invite, memberB.cookie, '成员乙');
  return { owner, memberA, memberB, spaceId, invite };
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

test('S4-01 接收人快照与可见性：仅受邀可见、重放不重复、后加入成员不自动接收', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const memberA = await registerOk(handle, '成员甲');
  const memberB = await registerOk(handle, '成员乙');
  const created = await createSpaceOk(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await generateInvite(handle, owner.cookie, spaceId);
  await joinMember(handle, invite, memberA.cookie, '成员甲', { share: true });
  await joinMember(handle, invite, memberB.cookie, '成员乙');
  const date = tomorrowInSpace();
  const month = monthOf(date);

  const body = eventBody({ title: `仅甲可见-${crypto.randomUUID().slice(0, 6)}`, recipients: [memberA.id] });
  const made = await createEvent(handle, owner.cookie, spaceId, body);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.event.recipientCount, 1);
  assert.equal(made.body.event.recipientScope, 'selected');
  assert.equal(made.body.event.assignmentSummary.pending, 1);
  const assignments = db.dump('event_assignments');
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].target_user_id, memberA.id);
  assert.equal(assignments[0].status, 'pending');
  assert.equal(assignments[0].kind, 'event');
  assert.equal(assignments[0].event_stamp, eventStampAllDay(date));

  const replay = await createEvent(handle, owner.cookie, spaceId, body);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.equal(db.dump('event_assignments').length, 1, '重放不得重复创建待办');

  const bEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: memberB.cookie,
  }));
  assert.equal(bEvents.status, 200);
  assert.equal(bEvents.body.events.length, 0, '非接收人看不到仅受邀事件');
  assert.equal(bEvents.text.includes(body.title), false);
  const bCalendar = await getCalendar(handle, memberB.cookie, spaceId, month);
  assert.equal(bCalendar.body.events.length, 0);
  assert.equal(bCalendar.body.pendingCount, 0);
  const aEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: memberA.cookie,
  }));
  assert.equal(aEvents.body.events.length, 1);
  assert.equal(aEvents.body.events[0].assignment.status, 'pending');

  const all = await createEvent(handle, owner.cookie, spaceId, eventBody({
    title: '全体通知', recipientScope: 'all', recipients: [],
  }));
  assert.equal(all.status, 201, all.text);
  const allAssignments = db.dump('event_assignments')
    .filter((row) => row.event_id === all.body.event.id);
  assert.deepEqual(allAssignments.map((row) => row.target_user_id).sort(),
    [memberA.id, memberB.id].sort());
  assert.equal(allAssignments.some((row) => row.target_user_id === owner.id), false,
    '全体快照不包含发起人本人');

  const late = await registerOk(handle, '成员丙');
  assert.equal((await joinWithCode(handle, late.cookie, invite.code, '成员丙')).status, 201);
  assert.equal(db.dump('event_assignments')
    .filter((row) => row.event_id === all.body.event.id).length, 2,
  '发送后加入的成员不自动接收');
  const lateEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: late.cookie,
  }));
  assert.equal(lateEvents.body.events.length, 0);

  const self = await createEvent(handle, owner.cookie, spaceId, eventBody({
    recipients: [owner.id],
  }));
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'event_recipient_self');
  const outsider = await createEvent(handle, owner.cookie, spaceId, eventBody({
    recipients: [crypto.randomUUID()],
  }));
  assert.equal(outsider.status, 400);
  assert.equal(outsider.body.error, 'event_recipient_not_member');
  const privateNotify = await createEvent(handle, owner.cookie, spaceId, eventBody({
    visibility: 'private', recipients: [memberA.id],
  }));
  assert.equal(privateNotify.status, 409);
  assert.equal(privateNotify.body.error, 'event_private_cannot_notify');
  const inviteesNoRecipient = await createEvent(handle, owner.cookie, spaceId, eventBody({
    recipientScope: 'none', recipients: [],
  }));
  assert.equal(inviteesNoRecipient.status, 400);
  assert.equal(inviteesNoRecipient.body.error, 'event_invitees_requires_recipients');

  const scopeChange = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      id: body.id, version: 1, title: body.title, startDate: date, endDate: date,
      recipientScope: 'all',
    },
  }));
  assert.equal(scopeChange.status, 409);
  assert.equal(scopeChange.body.error, 'event_recipients_locked');
});

test('S4-02 确认后投影：待确认不占忙、课程优先、改期旧确认失效、删除释放占用', async () => {
  const { db, handle } = fixture();
  const { owner, memberA, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const month = monthOf(date);
  await publishEntries(handle, memberA.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '数据结构' },
  ]);

  const body = eventBody({ title: `评审-${crypto.randomUUID().slice(0, 6)}`, recipients: [memberA.id] });
  const made = await createEvent(handle, owner.cookie, spaceId, body);
  assert.equal(made.status, 201, made.text);
  const assignmentId = db.dump('event_assignments')[0].id;

  const beforeCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(beforeCollection.status, 200, beforeCollection.text);
  assert.equal(collectionPeriod(beforeCollection, date, 2).counts.busy, 0,
    '待确认通知不自动占忙');
  assert.equal(collectionPeriod(beforeCollection, date, 1).counts.classOccupied, 1);

  const before = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body.pendingCount, 1);
  const pendingView = before.body.assignments.find((item) => item.id === assignmentId);
  assert.equal(pendingView.status, 'pending');
  assert.equal(pendingView.conflict.type, 'course');
  assert.equal(pendingView.conflict.items[0].period, 1);
  assert.equal(pendingView.conflict.items[0].courseName, '数据结构');
  assert.equal(calendarPeriod(before, date, 2).status, 'no_class');

  const wrongStamp = await respond(handle, memberA.cookie, spaceId, {
    id: assignmentId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
    eventStamp: `${date}|${date}|0||`,
  });
  assert.equal(wrongStamp.status, 409);
  assert.equal(wrongStamp.body.error, 'event_changed');
  assert.equal(db.dump('event_assignments')[0].status, 'pending');

  const accepted = await respond(handle, memberA.cookie, spaceId, {
    id: assignmentId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
    eventStamp: eventStampAllDay(date),
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.assignment.status, 'accepted');
  assert.equal(accepted.body.assignment.version, 2);
  const replayAccept = await respond(handle, memberA.cookie, spaceId, {
    id: assignmentId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
    eventStamp: eventStampAllDay(date),
  });
  assert.equal(replayAccept.status, 200);
  assert.equal(replayAccept.body.replayed, true);
  assert.equal(db.dump('event_assignments')[0].version, 2, '重复确认不重复写版本');

  const after = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(after.body.pendingCount, 0);
  assert.equal(calendarPeriod(after, date, 1).status, 'class_occupied', '课程优先于事件占用');
  const busyPeriod = calendarPeriod(after, date, 2);
  assert.equal(busyPeriod.status, 'busy');
  assert.equal(busyPeriod.busySources[0].type, 'event');
  assert.equal(busyPeriod.busySources[0].label, `事件：${body.title}`);
  assert.equal(busyPeriod.eventBusy, true);

  const afterCollection = await getCollection(handle, owner.cookie, spaceId, month);
  const classCell = collectionPeriod(afterCollection, date, 1);
  assert.equal(classCell.counts.classOccupied, 1, '课程与事件冲突时不重复计入忙碌');
  assert.equal(classCell.counts.busy, 0);
  assert.equal(classCell.groups.class.members[0].sources[0].type, 'event',
    '课程格里保留忙碌来源细节');
  const busyCell = collectionPeriod(afterCollection, date, 2);
  assert.equal(busyCell.counts.busy, 1);
  assert.equal(busyCell.groups.busy.members[0].userId, memberA.id);
  assert.equal(busyCell.groups.busy.members[0].sources[0].label, `事件：${body.title}`);
  const busyInFree = busyCell.groups.free.members.some((member) => member.userId === memberA.id);
  assert.equal(busyInFree, false, '同一成员不能既忙碌又出现在有空组');

  const rescheduled = await call(handle, ctx(`/api/spaces/${spaceId}/events/update`, {
    method: 'POST',
    cookie: owner.cookie,
    body: {
      id: body.id, version: 1, title: body.title, startDate: date, endDate: date,
      allDay: false, startTime: '10:00', endTime: '11:00',
    },
  }));
  assert.equal(rescheduled.status, 200, rescheduled.text);
  assert.equal(rescheduled.body.event.version, 2);

  const stale = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(stale.body.pendingCount, 1, '改期后旧确认需要重新确认');
  const staleView = stale.body.assignments.find((item) => item.id === assignmentId);
  assert.equal(staleView.requiresReconfirm, true);
  assert.equal(staleView.eventChanged, true);
  assert.equal(calendarPeriod(stale, date, 2).status, 'no_class',
    '改期后旧占用自动释放');
  const staleCollection = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(staleCollection, date, 2).counts.busy, 0);
  const ownerEvents = await call(handle, ctx(`/api/spaces/${spaceId}/events?month=${month}`, {
    cookie: owner.cookie,
  }));
  assert.equal(ownerEvents.body.events[0].assignmentSummary.requiresReconfirm, 1);

  const newStamp = `${date}|${date}|0|10:00|11:00`;
  const reconfirmed = await respond(handle, memberA.cookie, spaceId, {
    id: assignmentId, requestId: makeRequestId(), action: 'accept', expectedVersion: 2,
    eventStamp: newStamp,
  });
  assert.equal(reconfirmed.status, 200, reconfirmed.text);
  assert.equal(reconfirmed.body.assignment.status, 'accepted');
  assert.equal(reconfirmed.body.assignment.version, 3);
  const reCalendar = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(calendarPeriod(reCalendar, date, 2).status, 'no_class',
    '10:00–11:00 只覆盖第 3 节');
  assert.equal(calendarPeriod(reCalendar, date, 3).status, 'busy');

  const deleted = await call(handle, ctx(`/api/spaces/${spaceId}/events/delete`, {
    method: 'POST', cookie: owner.cookie, body: { id: body.id, version: 2 },
  }));
  assert.equal(deleted.status, 200, deleted.text);
  const afterDelete = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(afterDelete.body.assignments.length, 0);
  assert.equal(afterDelete.body.pendingCount, 0);
  assert.equal(calendarPeriod(afterDelete, date, 3).status, 'no_class',
    '删除事件立即释放占用');
  const collectionAfterDelete = await getCollection(handle, owner.cookie, spaceId, month);
  assert.equal(collectionPeriod(collectionAfterDelete, date, 3).counts.busy, 0);
  assert.equal(db.dump('event_assignments')[0].status, 'accepted',
    '释放来自投影而不是改写成员确认记录');
});

test('S4-03 负责人安排：成员确认后占忙、普通按钮不能清除、撤回只释放本人占用', async () => {
  const { db, handle } = fixture();
  const { owner, memberA, memberB, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const month = monthOf(date);
  await publishEntries(handle, memberA.cookie, spaceId, []);
  await publishEntries(handle, memberB.cookie, spaceId, []);

  const memberTry = await arrange(handle, memberA.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'busy', targetUserId: memberB.id, date, period: 2,
  });
  assert.equal(memberTry.status, 403);

  const arrangementId = crypto.randomUUID();
  const made = await arrange(handle, owner.cookie, spaceId, {
    id: arrangementId, kind: 'busy', targetUserId: memberA.id, date, period: 2,
  });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.replayed, false);
  assert.equal(made.body.conflict, null);
  const replay = await arrange(handle, owner.cookie, spaceId, {
    id: arrangementId, kind: 'busy', targetUserId: memberA.id, date, period: 2,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(db.dump('event_assignments').length, 1, '同一请求重放不重复创建');
  const reuse = await arrange(handle, owner.cookie, spaceId, {
    id: arrangementId, kind: 'available', targetUserId: memberA.id, date, period: 2,
  });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error, 'assignment_reuse_conflict');

  const selfTarget = await arrange(handle, owner.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'busy', targetUserId: owner.id, date, period: 1,
  });
  assert.equal(selfTarget.status, 400);
  assert.equal(selfTarget.body.error, 'assignment_target_self');
  const outsider = await arrange(handle, owner.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'busy', targetUserId: crypto.randomUUID(), date, period: 1,
  });
  assert.equal(outsider.status, 404);
  assert.equal(outsider.body.error, 'assignment_target_not_member');
  const past = await arrange(handle, owner.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'busy', targetUserId: memberA.id,
    date: addDays(todayInSpace(), -1), period: 1,
  });
  assert.equal(past.status, 409);
  assert.equal(past.body.error, 'assignment_date_closed');
  const badPeriod = await arrange(handle, owner.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'busy', targetUserId: memberA.id, date, period: 99,
  });
  assert.equal(badPeriod.status, 400);

  const waiting = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(waiting.body.pendingCount, 1);
  assert.equal(calendarPeriod(waiting, date, 2).status, 'no_class',
    '负责人安排未确认前不占忙');

  const accepted = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.assignment.status, 'accepted');
  assert.equal(accepted.body.assignment.kind, 'busy');

  const busy = await getCalendar(handle, memberA.cookie, spaceId, month);
  const busyCell = calendarPeriod(busy, date, 2);
  assert.equal(busyCell.status, 'busy');
  assert.equal(busyCell.requestBusy, true);
  assert.equal(busyCell.busySources[0].label, '负责人安排');

  const personal = await savePersonalState(handle, memberA.cookie, spaceId, {
    date, period: 2, cancelClass: false, personalState: 'available',
  });
  assert.equal(personal.status, 201, personal.text);
  const stillBusy = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(calendarPeriod(stillBusy, date, 2).status, 'busy',
    '普通两态按钮写入的个人声明不能清除已接受安排');
  const ownerView = await getCollection(handle, owner.cookie, spaceId, month);
  const ownerBusy = collectionPeriod(ownerView, date, 2);
  assert.equal(ownerBusy.counts.busy, 1);
  assert.equal(ownerBusy.counts.available, 0);
  assert.equal(ownerBusy.groups.busy.members[0].sources[0].type, 'request');

  const withdraw = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'withdraw', expectedVersion: 2,
  });
  assert.equal(withdraw.status, 200, withdraw.text);
  assert.equal(withdraw.body.assignment.status, 'withdrawn');
  const replayWithdraw = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'withdraw', expectedVersion: 3,
  });
  assert.equal(replayWithdraw.status, 200);
  assert.equal(replayWithdraw.body.replayed, true);
  const released = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(calendarPeriod(released, date, 2).status, 'available',
    '撤回后只释放安排占用，个人声明仍保留');

  const availableId = crypto.randomUUID();
  const request = await arrange(handle, owner.cookie, spaceId, {
    id: availableId, kind: 'available', targetUserId: memberA.id, date, period: 4,
  });
  assert.equal(request.status, 201, request.text);
  const beforeAccept = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(calendarPeriod(beforeAccept, date, 4).status, 'no_class',
    '“请求确认有空”也要本人确认');
  const acceptAvailable = await respond(handle, memberA.cookie, spaceId, {
    id: availableId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
  });
  assert.equal(acceptAvailable.status, 200, acceptAvailable.text);
  const available = await getCalendar(handle, memberA.cookie, spaceId, month);
  const availableCell = calendarPeriod(available, date, 4);
  assert.equal(availableCell.status, 'available');
  assert.equal(availableCell.requestAvailable, true);
  const ownerAvailable = collectionPeriod(
    await getCollection(handle, owner.cookie, spaceId, month), date, 4,
  );
  assert.equal(ownerAvailable.counts.available, 1);
  assert.equal(ownerAvailable.groups.free.declaredCount, 1, '主动确认有空与默认无课分开');
  await respond(handle, memberA.cookie, spaceId, {
    id: availableId, requestId: makeRequestId(), action: 'withdraw', expectedVersion: 2,
  });
  const afterAvailableWithdraw = await getCalendar(handle, memberA.cookie, spaceId, month);
  assert.equal(calendarPeriod(afterAvailableWithdraw, date, 4).status, 'no_class');
});

test('S4-04 权限与并发：非本人不能响应、版本冲突可重试、已删除事件不能确认', async () => {
  const { handle } = fixture();
  const { owner, memberA, memberB, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();

  const arrangementId = crypto.randomUUID();
  const made = await arrange(handle, owner.cookie, spaceId, {
    id: arrangementId, kind: 'busy', targetUserId: memberA.id, date, period: 5,
  });
  assert.equal(made.status, 201, made.text);

  const otherRespond = await respond(handle, memberB.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
  });
  assert.equal(otherRespond.status, 403);
  assert.equal(otherRespond.body.error, 'forbidden');

  const ownerRespond = await respond(handle, owner.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
  });
  assert.equal(ownerRespond.status, 403);

  const staleVersion = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'accept', expectedVersion: 7,
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.body.error, 'assignment_conflict');

  const rejected = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'reject', expectedVersion: 1,
  });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.body.assignment.status, 'rejected');
  const rejectAgain = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'reject', expectedVersion: 2,
  });
  assert.equal(rejectAgain.status, 200);
  assert.equal(rejectAgain.body.replayed, true);
  const withdrawPending = await respond(handle, memberA.cookie, spaceId, {
    id: arrangementId, requestId: makeRequestId(), action: 'withdraw', expectedVersion: 2,
  });
  assert.equal(withdrawPending.status, 409);
  assert.equal(withdrawPending.body.error, 'assignment_not_accepted');

  const eventBodyValue = eventBody({ recipients: [memberA.id] });
  const event = await createEvent(handle, owner.cookie, spaceId, eventBodyValue);
  assert.equal(event.status, 201, event.text);
  const evRow = (await getCalendar(handle, memberA.cookie, spaceId, monthOf(date)))
    .body.assignments.find((item) => item.eventId === eventBodyValue.id);
  assert.ok(evRow);
  const removeEvent = await call(handle, ctx(`/api/spaces/${spaceId}/events/delete`, {
    method: 'POST', cookie: owner.cookie, body: { id: eventBodyValue.id, version: 1 },
  }));
  assert.equal(removeEvent.status, 200, removeEvent.text);
  const acceptDeleted = await respond(handle, memberA.cookie, spaceId, {
    id: evRow.id, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
    eventStamp: eventStampAllDay(date),
  });
  assert.equal(acceptDeleted.status, 404);
  assert.equal(acceptDeleted.body.error, 'event_not_found');
});

test('S4-05 导出叠加：已接受事件与安排不改变课程状态，未提交保持未确认且不泄漏事件标题', async () => {
  const { handle } = fixture();
  const { owner, memberA, memberB, spaceId } = await buildSpace(handle);
  const date = tomorrowInSpace();
  const weekday = weekdayMon1(date);
  const weekStart = addDays(date, 1 - weekday);
  const month = monthOf(date);
  const title = `导出事件-${crypto.randomUUID().slice(0, 6)}`;
  await publishEntries(handle, memberA.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '数据结构' },
  ]);

  const event = eventBody({
    title, recipients: [memberA.id], allDay: false, startTime: '09:00', endTime: '10:00',
  });
  assert.equal((await createEvent(handle, owner.cookie, spaceId, event)).status, 201);
  const evRow = (await getCalendar(handle, memberA.cookie, spaceId, month))
    .body.assignments.find((item) => item.eventId === event.id);
  assert.ok(evRow);
  const accepted = await respond(handle, memberA.cookie, spaceId, {
    id: evRow.id, requestId: makeRequestId(), action: 'accept', expectedVersion: 1,
    eventStamp: `${date}|${date}|0|09:00|10:00`,
  });
  assert.equal(accepted.status, 200, accepted.text);

  const available = await arrange(handle, owner.cookie, spaceId, {
    id: crypto.randomUUID(), kind: 'available', targetUserId: memberA.id, date, period: 4,
  });
  assert.equal(available.status, 201, available.text);
  const acceptedAvailable = await respond(handle, memberA.cookie, spaceId, {
    id: available.body.assignment.id, requestId: makeRequestId(),
    action: 'accept', expectedVersion: 1,
  });
  assert.equal(acceptedAvailable.status, 200, acceptedAvailable.text);

  const response = await callBytes(handle, ctx(
    `/api/spaces/${spaceId}/collection/export?week=${weekStart}`, { cookie: owner.cookie },
  ));
  assert.equal(response.status, 200, response.buffer.toString('utf8'));
  const entries = zipEntries(response.buffer);
  for (const entry of entries) {
    assert.equal(entry.method, 0);
    assert.equal(crc32(entry.data), entry.crc, `${entry.name} CRC 不匹配`);
  }
  const sheetFiles = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
  assert.equal(sheetFiles.length, 7, '导出只有 7 张工作日表');
  const daily = entryText(entries, `xl/worksheets/sheet${weekday}.xml`);
  const dailyRows = [...daily.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/g)]
    .map((match) => match[1]);
  const rowA = dailyRows.find((row) => row.includes('>成员甲<'));
  assert.ok(rowA, '每日表应包含成员甲');
  assert.ok(rowA.includes('>有课<'), '第 1 节课程仍为有课');
  assert.ok(rowA.includes('>没课<'), '无课节次只写没课');
  assert.equal(rowA.includes('>忙碌<'), false, '已接受事件不再写入导出');
  assert.equal(rowA.includes('>有空<'), false, '个人安排不再写入导出');
  assert.equal(rowA.includes('>有空＊<'), false, '已接受“确认有空”不再写入导出');
  const rowB = dailyRows.find((row) => row.includes('>成员乙<'));
  assert.ok(rowB, '未提交成员仍占一行');
  assert.ok(rowB.includes('未确认'), '未提交不能被事件或默认无课洗成没课');
  assert.equal(rowB.includes('>忙碌<'), false);
  assert.ok(daily.includes('个人忙碌、已接受事件与安排不改变'), '表内注明事件不影响课程状态');
  const allXml = entries.map((entry) => entry.data.toString('utf8')).join('\n');
  assert.equal(allXml.includes('说明'), false, '不包含单独说明工作表');
  assert.equal(allXml.includes(title), false, '导出不得泄漏事件标题');
  assert.equal(allXml.includes(memberA.username), false);
  assert.equal(allXml.includes(PASSWORD), false);
});

// S2b 本地契约检查：真实 router/calendar 代码 + 内存假数据库。
// 证明日期算法、教学周一次性写入、按月投影、例外双维度、签名冲突、幂等与授权；
// 不证明真实 Provider 的权限、事务或并发语义。
//   node --test dev/check-s2b.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../functions/router.mjs';
import {
  CALENDAR_NOTICE_VERSION, NOTICE_VERSION,
} from '../functions/notices.mjs';
import {
  addDays, courseSignature, dateSerial, daysInMonth, localToday, monthDates, projectMonth,
  publicTeaching, teachingWeekNumber, validateTeaching, weekdayMon1,
} from '../functions/calendar.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s2b.test';
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
};

const FIXED_TEACHING = {
  timezone: 'Asia/Shanghai',
  firstWeekMonday: '2026-09-07',
  termStart: '2026-09-07',
  termEnd: '2027-01-17',
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
    requestId: 'local-s2b-check',
  };
}

async function call(handle, context) {
  const response = await handle(context);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text, setCookie: response.headers.get('set-cookie') };
}

const cookiePair = (result) => result.setCookie?.split(';')[0] ?? null;

async function registerOk(handle, nickname) {
  const username = `s2b_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
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

function makePeriods(count = 12, stepMinutes = 60) {
  return Array.from({ length: count }, (_, index) => {
    const start = 6 * 60 + index * stepMinutes;
    return { index: index + 1, start: formatTime(start), end: formatTime(start + 45) };
  });
}

function spaceBody(overrides = {}) {
  return {
    name: 'S2b 合成空间',
    ownerName: '合成负责人',
    mode: 'courses',
    weekRule: 'every',
    periods: makePeriods(12),
    visibility: 'masked_list',
    teaching: { ...FIXED_TEACHING },
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

function todayInSpace() {
  return localToday('Asia/Shanghai');
}

function mondayOfWeek(date) {
  return addDays(date, -((weekdayMon1(date) + 6) % 7));
}

function dynamicTeaching() {
  const today = todayInSpace();
  const monday = mondayOfWeek(today);
  return {
    timezone: 'Asia/Shanghai',
    firstWeekMonday: monday,
    termStart: monday,
    termEnd: addDays(today, 120),
  };
}

async function createDynamicSpace(handle, cookie, overrides = {}) {
  return createSpaceOk(handle, cookie, { teaching: dynamicTeaching(), ...overrides });
}

function makeRequestId() {
  return `s2b_${crypto.randomUUID().replace(/-/g, '')}`;
}

async function publishEntries(handle, cookie, spaceId, entries, baseRevision) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    cookie,
    body: { requestId: makeRequestId(), baseRevision, entries },
  }));
}

async function joinWithCode(handle, memberCookie, code, name) {
  const joined = await call(handle, ctx('/api/join', {
    method: 'POST',
    cookie: memberCookie,
    body: {
      code,
      inSpaceName: name,
      noticeAccepted: true,
      noticeVersion: NOTICE_VERSION,
    },
  }));
  assert.equal(joined.status, 201, joined.text);
}

async function joinMember(handle, ownerCookie, spaceId, memberCookie, name) {
  const invite = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, { method: 'POST', cookie: ownerCookie }));
  assert.equal(invite.status, 201, invite.text);
  await joinWithCode(handle, memberCookie, invite.body.code, name);
}

async function readCalendar(handle, cookie, spaceId, month) {
  return call(handle, ctx(`/api/spaces/${spaceId}/calendar?month=${month}`, { cookie }));
}

function calendarDay(calendar, date) {
  const days = calendar.body?.days ?? calendar.days;
  return days.find((day) => day.date === date);
}

function calendarPeriod(calendar, date, period) {
  return calendarDay(calendar, date)?.periods.find((item) => item.period === period);
}

function exceptionBody(overrides = {}) {
  return {
    requestId: makeRequestId(),
    baseVersion: 0,
    action: 'save',
    date: todayInSpace(),
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

test('S2B-01 日期算法：日历日差、闰年、周几与跨年周号不重置', () => {
  assert.equal(weekdayMon1('2026-09-07'), 1);
  assert.equal(weekdayMon1('2026-11-10'), 2);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(dateSerial('2026-09-07'), dateSerial('2026-09-01') + 6);
  assert.equal(teachingWeekNumber(publicTeaching(FIXED_TEACHING), '2026-09-07'), 1);
  assert.equal(teachingWeekNumber(publicTeaching(FIXED_TEACHING), '2027-01-04'), 18);
  assert.equal(monthDates('2026-09').length, 30);
  assert.equal(monthDates('2028-02').length, 29);
});

test('S2B-02 教学周校验：周一锚点、第一周内开始、结束不早于开始、时区有效', () => {
  assert.equal(publicTeaching(FIXED_TEACHING).weekCount, 19);
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, firstWeekMonday: '2026-09-08' }),
    (error) => error.code === 'teaching_anchor_not_monday');
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, termStart: '2026-09-06' }),
    (error) => error.code === 'teaching_start_before_anchor');
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, termStart: '2026-09-14' }),
    (error) => error.code === 'teaching_start_outside_first_week');
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, termEnd: '2026-09-01' }),
    (error) => error.code === 'teaching_end_before_start');
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, termStart: '2026-02-29' }),
    (error) => error.code === 'invalid_teaching_range');
  assert.throws(() => validateTeaching({ ...FIXED_TEACHING, timezone: 'Mars/Olympus' }),
    (error) => error.code === 'invalid_teaching_timezone');
  assert.equal(publicTeaching({ ...FIXED_TEACHING, termEnd: '2099-01-01' }), null);
});

test('S2B-03 新建空间必须带教学周：失败不落半成品，成功单行含版本', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const missing = await call(handle, ctx('/api/spaces', {
    method: 'POST', cookie: owner.cookie, body: spaceBody({ teaching: undefined }),
  }));
  assert.equal(missing.status, 400, missing.text);
  assert.equal(db.dump('spaces').length, 0);

  const crossed = await call(handle, ctx('/api/spaces', {
    method: 'POST',
    cookie: owner.cookie,
    body: spaceBody({ teaching: { ...FIXED_TEACHING, firstWeekMonday: '2026-09-08' } }),
  }));
  assert.equal(crossed.status, 400);
  assert.equal(db.dump('spaces').length, 0);

  const created = await createSpaceOk(handle, owner.cookie);
  assert.equal(created.teaching.firstWeekMonday, '2026-09-07');
  assert.equal(created.teaching.weekCount, 19);
  const row = db.dump('spaces')[0];
  assert.equal(row.config.teaching.termEnd, '2027-01-17');
  assert.equal(row.config.mode, 'courses');
  assert.equal(row.owner_id, owner.id);
  assert.equal(db.dump('space_teaching').length, 0, '新空间教学周随 config 单行写入');
});

test('S2B-04 旧空间一次性设置教学周：成员拒绝、并发只成一次、配置锁不变', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员');
  const spaceId = crypto.randomUUID();
  const config = {
    version: 1, mode: 'presence', oddEvenEnabled: false, visibility: 'stats',
    periods: [{ index: 1, start: '08:00', end: '08:45' }],
  };
  await db.from('spaces').insertIfAbsent({
    id: spaceId,
    owner_id: owner.id,
    name: '旧 S2a 空间',
    mode: 'presence',
    owner_name: '负责人',
    config,
    teaching: null,
    teaching_version: 0,
    created_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  await db.from('invite_slots').insertIfAbsent({
    id: crypto.randomUUID(),
    space_id: spaceId,
    generation: 1,
    slot_no: 1,
    claimed: true,
    claimed_by: member.id,
    in_space_name: '成员',
    notice_version: NOTICE_VERSION,
    notice_ack_at: new Date().toISOString(),
    claimed_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  const weekly = await call(handle, ctx(`/api/spaces/${spaceId}/schedule`, { cookie: owner.cookie }));
  assert.equal(weekly.status, 200, weekly.text);
  assert.equal(weekly.body.configLocked, false);
  const published = await publishEntries(handle, owner.cookie, spaceId, [], 0);
  assert.equal(published.status, 201, published.text);

  const memberSet = await call(handle, ctx(`/api/spaces/${spaceId}/teaching`, {
    method: 'POST', cookie: member.cookie, body: { teaching: FIXED_TEACHING },
  }));
  assert.equal(memberSet.status, 403);

  const set = await call(handle, ctx(`/api/spaces/${spaceId}/teaching`, {
    method: 'POST', cookie: owner.cookie, body: { teaching: FIXED_TEACHING },
  }));
  assert.equal(set.status, 200, set.text);
  assert.equal(set.body.teaching.weekCount, 19);

  const again = await call(handle, ctx(`/api/spaces/${spaceId}/teaching`, {
    method: 'POST', cookie: owner.cookie, body: { teaching: { ...FIXED_TEACHING, termEnd: '2027-02-01' } },
  }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'teaching_already_set');

  const space = db.dump('spaces')[0];
  assert.deepEqual(space.config, config);
  assert.equal(db.dump('space_teaching').length, 1);
  assert.equal(db.dump('space_teaching')[0].term_end, '2027-01-17');
  const document = db.dump('schedule_documents')[0];
  assert.equal(document.published_version, 1);
  const configView = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: owner.cookie }));
  assert.equal(configView.body.configLocked, true);
  assert.equal(configView.body.teaching.termStart, '2026-09-07');
  assert.equal(configView.body.teachingState, 'set');
});

test('S2B-05 旧 config=null 空间不得设置教学周', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const spaceId = crypto.randomUUID();
  await db.from('spaces').insertIfAbsent({
    id: spaceId,
    owner_id: owner.id,
    name: 'S0 旧空间',
    mode: 'presence',
    teaching: null,
    teaching_version: 0,
    created_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  const response = await call(handle, ctx(`/api/spaces/${spaceId}/teaching`, {
    method: 'POST', cookie: owner.cookie, body: { teaching: FIXED_TEACHING },
  }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'space_kind_mismatch');
});

test('S2B-06 收集进度：零条目提交计入、草稿不计入、本人提交不混入成员计数', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const memberA = await registerOk(handle, '成员甲');
  const memberB = await registerOk(handle, '成员乙');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  const invite = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(invite.status, 201, invite.text);
  await joinWithCode(handle, memberA.cookie, invite.body.code, '成员甲');
  await joinWithCode(handle, memberB.cookie, invite.body.code, '成员乙');

  const zero = await publishEntries(handle, memberA.cookie, spaceId, [], 0);
  assert.equal(zero.status, 201, zero.text);
  const draft = await call(handle, ctx(`/api/spaces/${spaceId}/schedule/draft`, {
    method: 'POST',
    cookie: memberB.cookie,
    body: {
      requestId: makeRequestId(),
      baseRevision: 0,
      entries: [{ day: 1, period: 1, weekRule: 'every', courseName: '仅草稿' }],
    },
  }));
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.body.schedule.submitted, false);

  const members = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(members.status, 200, members.text);
  assert.deepEqual(members.body.summary, { total: 2, submitted: 1, unsubmitted: 1 });
  const listed = members.body.members.filter((member) => member.role === 'member');
  assert.equal(listed.find((member) => member.inSpaceName === '成员甲').hasSubmission, true);
  assert.equal(listed.find((member) => member.inSpaceName === '成员乙').hasSubmission, false);
  const ownerRow = members.body.members.find((member) => member.role === 'owner');
  assert.equal(ownerRow.hasSubmission, false);
});

test('S2B-07 月历状态：未设置/未提交/零条目提交/学期外/仅本人', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  await joinMember(handle, owner.cookie, spaceId, member.cookie, '成员');
  const month = todayInSpace().slice(0, 7);

  const unknown = await readCalendar(handle, member.cookie, spaceId, month);
  assert.equal(unknown.status, 200, unknown.text);
  assert.equal(unknown.body.state, 'unknown');
  const unknownTermDays = unknown.body.days.filter((day) => day.inTerm);
  assert.ok(unknownTermDays.length > 0);
  assert.ok(unknownTermDays.every((day) => day.periods.every((item) => item.status === 'unknown')));

  const zero = await publishEntries(handle, member.cookie, spaceId, [], 0);
  assert.equal(zero.status, 201, zero.text);
  const ready = await readCalendar(handle, member.cookie, spaceId, month);
  assert.equal(ready.body.state, 'ready');
  assert.ok(ready.body.days.filter((day) => day.inTerm)
    .every((day) => day.periods.every((item) => item.status === 'no_class')));
  assert.ok(ready.body.days.filter((day) => day.inTerm)
    .every((day) => day.periods.every((item) => item.status !== 'available')));

  const outside = await readCalendar(handle, member.cookie, spaceId, '2025-01');
  assert.ok(outside.body.days.every((day) => !day.inTerm
    && day.periods.every((item) => item.status === 'term_out')));

  const notMember = await registerOk(handle, '旁观者');
  const denied = await readCalendar(handle, notMember.cookie, spaceId, month);
  assert.equal(denied.status, 403);

  const unconfiguredId = crypto.randomUUID();
  const config = {
    version: 1, mode: 'presence', oddEvenEnabled: false, visibility: 'stats',
    periods: [{ index: 1, start: '08:00', end: '08:45' }],
  };
  await db.from('spaces').insertIfAbsent({
    id: unconfiguredId, owner_id: owner.id, name: '未设置教学周', mode: 'presence',
    owner_name: '负责人', config, teaching: null, teaching_version: 0,
    created_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  await publishEntries(handle, owner.cookie, unconfiguredId, [], 0);
  const pending = await readCalendar(handle, owner.cookie, unconfiguredId, month);
  assert.equal(pending.body.state, 'unconfigured');
  assert.deepEqual(pending.body.days, []);
  assert.equal(pending.body.today, null);
});

test('S2B-08 投影：单双周、学期外、冲突类型与课程签名不外泄', async () => {
  const teaching = publicTeaching(FIXED_TEACHING);
  const config = {
    version: 1, mode: 'courses', oddEvenEnabled: true, visibility: 'masked_list',
    periods: makePeriods(3),
  };
  const document = {
    published_version: 1,
    published_entries: [
      { day: 1, period: 1, weekRule: 'odd', courseName: '单周课' },
      { day: 2, period: 2, weekRule: 'even', courseName: '双周课' },
    ],
  };
  const signature = await courseSignature({ rule: 'odd', courseName: '单周课' }, config);
  const base = await projectMonth({
    teaching, config, document, exceptions: [], month: '2026-09', today: '2026-09-01',
  });
  assert.equal(base.days.length, 30);
  assert.equal(calendarPeriod(base, '2026-09-07', 1).status, 'class_occupied');
  assert.equal(calendarPeriod(base, '2026-09-14', 1).status, 'no_class');
  assert.equal(calendarPeriod(base, '2026-09-21', 1).status, 'class_occupied');
  assert.equal(calendarPeriod(base, '2026-09-08', 2).status, 'no_class');
  assert.equal(calendarPeriod(base, '2026-09-15', 2).status, 'class_occupied');
  assert.equal(calendarPeriod(base, '2026-09-01', 1).status, 'term_out');
  assert.equal(calendarDay(base, '2026-09-07').weekNumber, 1);
  assert.equal(calendarDay(base, '2026-09-14').weekNumber, 2);

  const cancelled = await projectMonth({
    teaching,
    config,
    document,
    exceptions: [{
      local_date: '2026-09-07', period: 1, cancel_class: true,
      personal_state: 'available', course_signature: signature, version: 1,
    }],
    month: '2026-09',
    today: '2026-09-01',
  });
  const cancelledItem = calendarPeriod(cancelled, '2026-09-07', 1);
  assert.equal(cancelledItem.status, 'available');
  assert.equal(cancelledItem.cancelled, true);
  assert.equal(cancelledItem.course_signature, undefined);

  const stale = await projectMonth({
    teaching,
    config,
    document,
    exceptions: [{
      local_date: '2026-09-14', period: 1, cancel_class: true,
      personal_state: 'available', course_signature: signature, version: 1,
    }],
    month: '2026-09',
    today: '2026-09-01',
  });
  assert.equal(calendarPeriod(stale, '2026-09-14', 1).status, 'conflict');
  assert.equal(calendarPeriod(stale, '2026-09-14', 1).conflict.type, 'stale_cancel');

  const changedDocument = {
    published_version: 2,
    published_entries: [{ day: 1, period: 1, weekRule: 'odd', courseName: '替换课' }],
  };
  const changed = await projectMonth({
    teaching,
    config,
    document: changedDocument,
    exceptions: [{
      local_date: '2026-09-07', period: 1, cancel_class: true,
      personal_state: 'busy', course_signature: signature, version: 1,
    }],
    month: '2026-09',
    today: '2026-09-01',
  });
  const changedItem = calendarPeriod(changed, '2026-09-07', 1);
  assert.equal(changedItem.status, 'conflict');
  assert.equal(changedItem.conflict.type, 'course_changed');
  assert.equal(changedItem.cancelled, false);
  assert.equal(changedItem.status === 'available', false);

  const added = await projectMonth({
    teaching,
    config,
    document,
    exceptions: [{
      local_date: '2026-09-07', period: 1, cancel_class: false,
      personal_state: 'available', course_signature: null, version: 1,
    }],
    month: '2026-09',
    today: '2026-09-01',
  });
  assert.equal(calendarPeriod(added, '2026-09-07', 1).status, 'conflict');
  assert.equal(calendarPeriod(added, '2026-09-07', 1).conflict.type, 'class_added');
});

test('S2B-09 例外写入：通知门禁、双维度、清除语义、版本与幂等', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  const today = todayInSpace();
  const target = addDays(today, 3);
  const weekday = weekdayMon1(target);
  const month = target.slice(0, 7);
  const teaching = created.teaching;
  const published = await publishEntries(handle, owner.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '合成课程' },
  ], 0);
  assert.equal(published.status, 201, published.text);

  const noNotice = await call(handle, ctx(`/api/spaces/${spaceId}/exceptions`, {
    method: 'POST',
    cookie: owner.cookie,
    body: exceptionBody({
      date: target, period: 2, personalState: 'available', noticeAccepted: false,
    }),
  }));
  assert.equal(noNotice.status, 403);
  assert.equal(noNotice.body.error, 'calendar_notice_required');
  assert.equal(db.dump('calendar_consents').length, 0);
  assert.equal(db.dump('date_exceptions').length, 0);

  const first = exceptionBody({ date: target, period: 2, personalState: 'available' });
  const saved = await saveException(handle, owner.cookie, spaceId, first);
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.body.exception.version, 1);
  assert.equal(saved.body.exception.cancelClass, false);
  assert.equal(db.dump('calendar_consents').length, 1);

  const replayed = await saveException(handle, owner.cookie, spaceId, first);
  assert.equal(replayed.status, 200, replayed.text);
  assert.equal(replayed.body.replayed, true);
  assert.equal(replayed.body.exception.version, 1);

  const reused = await saveException(handle, owner.cookie, spaceId, { ...first, personalState: 'busy' });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, 'request_reuse_conflict');

  const staleCreate = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 2, personalState: 'busy',
  });
  assert.equal(staleCreate.status, 409);
  assert.equal(staleCreate.body.error, 'version_conflict');

  const classNoCancel = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, personalState: 'busy',
  });
  assert.equal(classNoCancel.status, 409);
  assert.equal(classNoCancel.body.error, 'cancel_required_for_statement');

  const cancelNoClass = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 2, cancelClass: true, personalState: 'none', baseVersion: 1,
  });
  assert.equal(cancelNoClass.status, 409);
  assert.equal(cancelNoClass.body.error, 'cancel_requires_class');

  const both = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'busy',
  });
  assert.equal(both.status, 201, both.text);
  const monthView = await readCalendar(handle, owner.cookie, spaceId, month);
  const busyItem = calendarPeriod(monthView, target, 1);
  assert.equal(busyItem.status, 'busy');
  assert.equal(busyItem.cancelled, true);
  assert.equal(busyItem.exceptionVersion, 1);
  assert.equal(busyItem.courseName, '合成课程');

  const clearPersonal = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'none', baseVersion: 1,
  });
  assert.equal(clearPersonal.status, 200, clearPersonal.text);
  assert.equal(clearPersonal.body.exception.version, 2);
  const cleared = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(cleared.status, 'no_class');
  assert.equal(cleared.cancelled, true);

  const silentClear = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: false, personalState: 'none', baseVersion: 2,
  });
  assert.equal(silentClear.status, 409);
  assert.equal(silentClear.body.error, 'cancel_clear_requires_reset');

  const reset = await saveException(handle, owner.cookie, spaceId, {
    action: 'reset', date: target, period: 1, baseVersion: 2,
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.body.exception.version, 3);
  const resetItem = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(resetItem.status, 'class_occupied');
  assert.equal(resetItem.cancelled, false);
  assert.equal(resetItem.exceptionVersion, 3);

  const staleAfterReset = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'available', baseVersion: 2,
  });
  assert.equal(staleAfterReset.status, 409);
  assert.equal(staleAfterReset.body.error, 'version_conflict');

  const todayWrite = await saveException(handle, owner.cookie, spaceId, {
    date: today, period: 2, personalState: 'available',
  });
  assert.equal(todayWrite.status, 409);
  assert.equal(todayWrite.body.error, 'date_not_editable');
  const pastWrite = await saveException(handle, owner.cookie, spaceId, {
    date: addDays(today, -1), period: 2, personalState: 'available',
  });
  assert.equal(pastWrite.status, 409);
  const beyondTerm = await saveException(handle, owner.cookie, spaceId, {
    date: addDays(teaching.termEnd, 1), period: 2, personalState: 'available',
  });
  assert.equal(beyondTerm.status, 409);
  assert.equal(beyondTerm.body.error, 'date_out_of_term');
  const spoof = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 2, personalState: 'available', memberId: crypto.randomUUID(),
  });
  assert.equal(spoof.status, 403);
});

test('S2B-10 周课表重交：其他格变化保留例外，同格替换冲突，不自动应用旧停课', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  const today = todayInSpace();
  const target = addDays(today, 4);
  const weekday = weekdayMon1(target);
  const month = target.slice(0, 7);
  const otherDay = weekday === 7 ? 1 : weekday + 1;

  const firstPublish = await publishEntries(handle, owner.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '课程甲' },
  ], 0);
  assert.equal(firstPublish.status, 201, firstPublish.text);
  let revision = firstPublish.body.schedule.revision;

  const save = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'busy',
  });
  assert.equal(save.status, 201, save.text);
  const baseVersion = save.body.exception.version;

  const unrelated = await publishEntries(handle, owner.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '课程甲' },
    { day: otherDay, period: 2, weekRule: 'every', courseName: '其他课程' },
  ], revision);
  assert.equal(unrelated.status, 200, unrelated.text);
  revision = unrelated.body.schedule.revision;
  assert.equal(db.dump('date_exceptions').length, 1);
  assert.equal(calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1).status, 'busy');

  const replaced = await publishEntries(handle, owner.cookie, spaceId, [
    { day: weekday, period: 1, weekRule: 'every', courseName: '课程乙' },
    { day: otherDay, period: 2, weekRule: 'every', courseName: '其他课程' },
  ], revision);
  assert.equal(replaced.status, 200, replaced.text);
  revision = replaced.body.schedule.revision;
  const conflict = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflict.type, 'course_changed');
  assert.equal(conflict.cancelled, false);

  const withoutAck = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'busy', baseVersion,
  });
  assert.equal(withoutAck.status, 409);
  assert.equal(withoutAck.body.error, 'course_change_confirmation_required');

  const withAck = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: true, personalState: 'busy',
    baseVersion, acknowledgeCourseChange: true,
  });
  assert.equal(withAck.status, 200, withAck.text);
  const reconfirmed = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(reconfirmed.status, 'busy');
  assert.equal(reconfirmed.cancelled, true);

  const emptied = await publishEntries(handle, owner.cookie, spaceId, [], revision);
  assert.equal(emptied.status, 200, emptied.text);
  revision = emptied.body.schedule.revision;
  const stale = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.conflict.type, 'stale_cancel');
  assert.equal(stale.courseName, null);
  assert.equal(stale.cancelled, false);
  assert.equal(db.dump('date_exceptions').length, 1);

  const clearStale = await saveException(handle, owner.cookie, spaceId, {
    date: target, period: 1, cancelClass: false, personalState: 'available',
    baseVersion: withAck.body.exception.version, acknowledgeCourseChange: true,
  });
  assert.equal(clearStale.status, 200, clearStale.text);
  const available = calendarPeriod(await readCalendar(handle, owner.cookie, spaceId, month), target, 1);
  assert.equal(available.status, 'available');
  assert.equal(available.cancelled, false);
  assert.equal(available.courseName, null);
});

test('S2B-11 双会话 CAS：旧基线被拒绝、旧重试不覆盖新内容、同请求重放', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  const target = addDays(todayInSpace(), 3);
  const month = target.slice(0, 7);
  const published = await publishEntries(handle, owner.cookie, spaceId, [], 0);
  assert.equal(published.status, 201, published.text);

  const requestA = exceptionBody({ date: target, period: 2, personalState: 'available' });
  const requestB = exceptionBody({ date: target, period: 2, personalState: 'busy' });
  const winner = await saveException(handle, owner.cookie, spaceId, requestA);
  assert.equal(winner.status, 201, winner.text);
  const loser = await saveException(handle, owner.cookie, spaceId, requestB);
  assert.equal(loser.status, 409);
  assert.equal(loser.body.error, 'version_conflict');

  const retry = await saveException(handle, owner.cookie, spaceId, {
    ...requestB, baseVersion: winner.body.exception.version,
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.exception.personalState, 'busy');
  assert.equal(retry.body.exception.version, 2);

  const oldRetry = await saveException(handle, owner.cookie, spaceId, requestA);
  assert.equal(oldRetry.status, 409);
  assert.equal(oldRetry.body.error, 'version_conflict');
  const row = db.dump('date_exceptions')[0];
  assert.equal(row.personal_state, 'busy');
  assert.equal(row.version, 2);

  const replay = await saveException(handle, owner.cookie, spaceId, {
    ...requestB, baseVersion: winner.body.exception.version,
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.exception.version, 2);
});

test('S2B-12 教学周读取与日历不泄露他人例外；负责人也不能按成员查询', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const member = await registerOk(handle, '成员');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  await joinMember(handle, owner.cookie, spaceId, member.cookie, '成员');
  const target = addDays(todayInSpace(), 3);
  const month = target.slice(0, 7);

  await publishEntries(handle, owner.cookie, spaceId, [], 0);
  await publishEntries(handle, member.cookie, spaceId, [], 0);
  const memberSave = await saveException(handle, member.cookie, spaceId, {
    date: target, period: 2, personalState: 'available',
  });
  assert.equal(memberSave.status, 201, memberSave.text);

  const memberView = await readCalendar(handle, member.cookie, spaceId, month);
  assert.equal(calendarPeriod(memberView, target, 2).status, 'available');
  assert.equal(JSON.stringify(memberView.body.days).includes('负责人'), false);
  const ownerView = await readCalendar(handle, owner.cookie, spaceId, month);
  assert.equal(calendarPeriod(ownerView, target, 2).status, 'no_class');
  assert.equal(calendarPeriod(ownerView, target, 2).exceptionVersion, 0);

  const ownerQuery = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&memberId=${member.id}`, { cookie: owner.cookie },
  ));
  assert.equal(ownerQuery.status, 403);
  const memberQuery = await call(handle, ctx(
    `/api/spaces/${spaceId}/calendar?month=${month}&memberId=${owner.id}`, { cookie: member.cookie },
  ));
  assert.equal(memberQuery.status, 403);
});

test('S2B-13 月历参数与首页状态：月份格式、实际日期、未设置教学周不伪造空月历', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, '负责人');
  const created = await createDynamicSpace(handle, owner.cookie);
  const spaceId = created.space.id;
  const month = todayInSpace().slice(0, 7);
  const invalid = await readCalendar(handle, owner.cookie, spaceId, '2026-13');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_month');

  const home = await call(handle, ctx(`/api/spaces/${spaceId}/home`, { cookie: owner.cookie }));
  assert.equal(home.status, 200, home.text);
  assert.equal(home.body.teaching.weekCount, created.teaching.weekCount);
  assert.equal(home.body.schedule.submitted, false);
  assert.equal(home.body.calendar.ready, false);
  assert.deepEqual(home.body.collection, { total: 0, submitted: 0, unsubmitted: 0 });

  await publishEntries(handle, owner.cookie, spaceId, [], 0);
  const after = await call(handle, ctx(`/api/spaces/${spaceId}/home`, { cookie: owner.cookie }));
  assert.equal(after.body.schedule.submitted, true);
  assert.equal(after.body.calendar.ready, true);
  assert.equal(after.body.calendar.consentAccepted, false);
  const calendar = await readCalendar(handle, owner.cookie, spaceId, month);
  const [calendarYear, calendarMonth] = month.split('-').map(Number);
  assert.equal(calendar.body.days.length, daysInMonth(calendarYear, calendarMonth));
  assert.equal(calendar.body.days[0].date, `${month}-01`);
  assert.equal(calendar.body.notice.version, CALENDAR_NOTICE_VERSION);
  assert.ok(calendar.body.notice.text.includes('仅本人可见'));

  const noNotice = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST', cookie: owner.cookie,
    body: { noticeAccepted: false, noticeVersion: CALENDAR_NOTICE_VERSION },
  }));
  assert.equal(noNotice.status, 403);
  assert.equal(noNotice.body.error, 'calendar_notice_required');
  const consent = await call(handle, ctx(`/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST', cookie: owner.cookie,
    body: { noticeAccepted: true, noticeVersion: CALENDAR_NOTICE_VERSION },
  }));
  assert.equal(consent.status, 200, consent.text);
  assert.equal(consent.body.consent.accepted, true);
  assert.equal(consent.body.consent.version, CALENDAR_NOTICE_VERSION);
  const afterConsent = await call(handle, ctx(`/api/spaces/${spaceId}/home`, { cookie: owner.cookie }));
  assert.equal(afterConsent.body.calendar.consentAccepted, true);
});

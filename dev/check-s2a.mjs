// S2a 本地契约检查：真实 router/week-schedule 代码 + 内存假数据库。
// 证明本地校验、单行 CAS、幂等与授权逻辑；不证明真实 Provider 的权限、事务或并发语义。
//   node --test dev/check-s2a.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../functions/router.mjs';
import { NOTICE_VERSION } from '../functions/notices.mjs';
import {
  applyRuleSwitch, cellHasContent, cloneCell, cloneCellInto, countClassSlots, daySlideDuration,
  entriesEqual, entriesToSlots, planRuleSwitch, previousCell, scheduleKey, slotsToEntries,
  swipeDestination, swipeTargetDay, validateCell,
} from '../web/schedule-model.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s2a.test';
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

function fixture(options = {}) {
  const control = { writes: [] };
  const db = createFakeDb(control, { unique: UNIQUE, ...options });
  const handle = createApplication({ db, origin: PUBLIC_ORIGIN });
  return { control, db, handle };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function ctx(path, { method = 'GET', body, cookie, origin = PUBLIC_ORIGIN, headers = {} } = {}) {
  const merged = { ...headers };
  if (origin !== null) merged.origin = origin;
  if (cookie) merged.cookie = cookie;
  if (body !== undefined) merged['content-type'] = 'application/json';
  const target = `https://provider.internal/functions/v1/app-d${'a'.repeat(32)}${path}`;
  return {
    request: new Request(target, {
      method,
      headers: merged,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    requestId: 'local-s2a-check',
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

async function register(handle, username = `s2a_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, password = PASSWORD, nickname) {
  const body = { username, password, noticeAccepted: true };
  if (nickname !== undefined) body.nickname = nickname;
  return call(handle, ctx('/api/register', { method: 'POST', body }));
}

async function registerOk(handle, username, nickname) {
  const response = await register(handle, username, PASSWORD, nickname);
  assert.equal(response.status, 201, response.text);
  return {
    id: response.body.user.id,
    username: response.body.user.username,
    nickname: response.body.user.nickname,
    cookie: cookiePair(response),
  };
}

async function loginOk(handle, username, password = PASSWORD) {
  const response = await call(handle, ctx('/api/login', { method: 'POST', body: { username, password } }));
  assert.equal(response.status, 200, response.text);
  return { cookie: cookiePair(response), user: response.body.user };
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
    name: 'S2a 合成空间',
    ownerName: '合成负责人',
    mode: 'courses',
    weekRule: 'every',
    periods: makePeriods(12),
    visibility: 'masked_list',
    teaching: {
      timezone: 'Asia/Shanghai',
      firstWeekMonday: '2026-09-07',
      termStart: '2026-09-07',
      termEnd: '2027-01-17',
    },
    ...overrides,
  };
}

async function createSpaceOk(handle, cookie, overrides = {}) {
  const response = await call(handle, ctx('/api/spaces', { method: 'POST', cookie, body: spaceBody(overrides) }));
  assert.equal(response.status, 201, response.text);
  return response.body.space.id;
}

async function generateInviteOk(handle, cookie, spaceId) {
  const response = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, { method: 'POST', cookie }));
  assert.equal(response.status, 201, response.text);
  return response.body.code;
}

async function join(handle, cookie, code, name) {
  return call(handle, ctx('/api/join', {
    method: 'POST',
    cookie,
    body: { code, inSpaceName: name, noticeAccepted: true, noticeVersion: NOTICE_VERSION },
  }));
}

async function seedLegacySpace(db, ownerId) {
  const spaceId = crypto.randomUUID();
  await db.from('spaces').insertIfAbsent({
    id: spaceId,
    owner_id: ownerId,
    name: 'S0 旧空间',
    mode: 'courses',
    created_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  return spaceId;
}

async function readSchedule(handle, cookie, spaceId) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule`, { cookie }));
}

async function saveDraft(handle, cookie, spaceId, body) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule/draft`, { method: 'POST', cookie, body }));
}

async function publish(handle, cookie, spaceId, body) {
  return call(handle, ctx(`/api/spaces/${spaceId}/schedule/publish`, { method: 'POST', cookie, body }));
}

let requestSeq = 0;
function rid() {
  requestSeq += 1;
  return `req-${requestSeq}-${crypto.randomUUID()}`;
}

function entry(day, period, weekRule, courseName) {
  const value = { day, period, weekRule };
  if (courseName !== undefined) value.courseName = courseName;
  return value;
}

test('S2A-01 统一周次：成员只写空间规则，缺省归一，其他规则与重复格拒绝', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);

  const config = await readSchedule(handle, owner.cookie, spaceId);
  assert.equal(config.body.config.weekRule, 'every');
  assert.equal(config.body.weekRule.resolved, true);
  assert.equal(config.body.weekRule.rule, 'every');

  // 省略 weekRule 时由服务端按空间规则归一，成员端不需要也不允许选择。
  const saved = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(),
    baseRevision: 0,
    entries: [
      { day: 1, period: 1, courseName: '数学' },
      entry(1, 2, 'every', '物理'),
    ],
  });
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.body.schedule.revision, 1);
  assert.deepEqual(saved.body.schedule.draftEntries, [
    { day: 1, period: 1, weekRule: 'every', courseName: '数学' },
    { day: 1, period: 2, weekRule: 'every', courseName: '物理' },
  ]);
  assert.equal(saved.body.schedule.publishedEntries, null);
  assert.equal(saved.body.schedule.submitted, false);
  assert.equal(saved.body.configLocked, false);

  for (const rule of ['odd', 'even']) {
    const mismatch = await saveDraft(handle, owner.cookie, spaceId, {
      requestId: rid(),
      baseRevision: 1,
      entries: [entry(2, 1, rule, '物理')],
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, 'week_rule_mismatch');
  }

  const duplicate = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(),
    baseRevision: 1,
    entries: [entry(2, 1, 'every', '物理'), entry(2, 1, 'every', '化学')],
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error, 'duplicate_cell');

  const missingPeriod = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(),
    baseRevision: 1,
    entries: [entry(1, 99, 'every', '数学')],
  });
  assert.equal(missingPeriod.status, 400);
  assert.equal(missingPeriod.body.error, 'invalid_period');

  const current = await readSchedule(handle, owner.cookie, spaceId);
  assert.equal(current.body.schedule.revision, 1, '非法请求不得递增 revision');
  assert.equal(db.dump('schedule_documents').length, 1);
});

test('S2A-02 收集模式：presence 拒绝课程名，courses 要求非空课程名', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, `mode_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const presenceSpace = await createSpaceOk(handle, owner.cookie, { mode: 'presence', weekRule: 'every' });
  const coursesSpace = await createSpaceOk(handle, owner.cookie, { mode: 'courses', weekRule: 'every' });

  const rejectedPresence = await saveDraft(handle, owner.cookie, presenceSpace, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '数学')],
  });
  assert.equal(rejectedPresence.status, 400);
  assert.equal(rejectedPresence.body.error, 'invalid_course_name');

  const presence = await saveDraft(handle, owner.cookie, presenceSpace, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every')],
  });
  assert.equal(presence.status, 201, presence.text);
  assert.deepEqual(presence.body.schedule.draftEntries, [{ day: 1, period: 1, weekRule: 'every' }]);

  const rejectedCourse = await saveDraft(handle, owner.cookie, coursesSpace, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every')],
  });
  assert.equal(rejectedCourse.status, 400);
  assert.equal(rejectedCourse.body.error, 'invalid_course_name');

  const missingCourse = await saveDraft(handle, owner.cookie, coursesSpace, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '   ')],
  });
  assert.equal(missingCourse.status, 400);
  assert.equal(missingCourse.body.error, 'invalid_course_name');

  const oddWhenDisabled = await saveDraft(handle, owner.cookie, coursesSpace, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'odd', '数学')],
  });
  assert.equal(oddWhenDisabled.status, 400);
  assert.equal(oddWhenDisabled.body.error, 'week_rule_mismatch');
});

test('S2A-03 草稿与有效快照隔离；负责人只看到是否已提交，不看到草稿', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, `iso_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const member = await registerOk(handle, `ism_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  assert.equal((await join(handle, member.cookie, code, '草稿成员')).status, 201);

  const initial = await readSchedule(handle, member.cookie, spaceId);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.schedule.exists, false);
  assert.equal(initial.body.schedule.submitted, false);
  assert.equal(initial.body.schedule.publishedVersion, 0);

  const secretDraft = '草稿秘密课程';
  const draft = await saveDraft(handle, member.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(2, 1, 'every', secretDraft)],
  });
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.body.schedule.submitted, false);
  assert.equal(draft.body.configLocked, false);

  const ownerMembersAfterDraft = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(ownerMembersAfterDraft.status, 200);
  assert.ok(!ownerMembersAfterDraft.text.includes(secretDraft), '负责人响应不得包含成员草稿课程名');
  const memberRow = ownerMembersAfterDraft.body.members.find((row) => row.inSpaceName === '草稿成员');
  assert.equal(memberRow.hasSubmission, false);

  const published = await publish(handle, member.cookie, spaceId, {
    requestId: rid(), baseRevision: 1, entries: [entry(2, 1, 'every', '有效课程甲')],
  });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.body.schedule.publishedVersion, 1);
  assert.equal(published.body.schedule.submitted, true);
  assert.equal(published.body.configLocked, true);
  assert.deepEqual(published.body.schedule.publishedEntries, [
    { day: 2, period: 1, weekRule: 'every', courseName: '有效课程甲' },
  ]);

  const laterDraft = await saveDraft(handle, member.cookie, spaceId, {
    requestId: rid(), baseRevision: 2, entries: [entry(3, 2, 'every', '草稿课程乙')],
  });
  assert.equal(laterDraft.status, 200, laterDraft.text);
  assert.equal(laterDraft.body.schedule.publishedVersion, 1);
  assert.deepEqual(laterDraft.body.schedule.publishedEntries, [
    { day: 2, period: 1, weekRule: 'every', courseName: '有效课程甲' },
  ]);
  assert.deepEqual(laterDraft.body.schedule.draftEntries, [
    { day: 3, period: 2, weekRule: 'every', courseName: '草稿课程乙' },
  ]);

  const ownerMembersAfterPublish = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  const publishedRow = ownerMembersAfterPublish.body.members.find((row) => row.inSpaceName === '草稿成员');
  assert.equal(publishedRow.hasSubmission, true);
  assert.ok(!ownerMembersAfterPublish.text.includes('草稿课程乙'));
  assert.ok(!ownerMembersAfterPublish.text.includes('有效课程甲'), 'S2a 负责人成员视图不返回课程名');
});

test('S2A-04 零条目提交表示全周无课，并永久锁定配置', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, `zero_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);

  const before = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: owner.cookie }));
  assert.equal(before.body.configLocked, false);

  const result = await publish(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [],
  });
  assert.equal(result.status, 201, result.text);
  assert.equal(result.body.schedule.publishedVersion, 1);
  assert.deepEqual(result.body.schedule.publishedEntries, []);
  assert.equal(result.body.schedule.submitted, true);
  assert.equal(result.body.configLocked, true);

  const after = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: owner.cookie }));
  assert.equal(after.body.configLocked, true);

  const ownerMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(ownerMembers.body.members.find((row) => row.role === 'owner').hasSubmission, true);

  const configEdit = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { method: 'POST', cookie: owner.cookie, body: {} }));
  assert.equal(configEdit.status, 405, 'S2a 不提供配置编辑入口');
});

test('S2A-05 幂等：同 requestId 同内容重放不写入；不同内容拒绝；旧请求不能覆盖新数据', async () => {
  const { control, db, handle } = fixture();
  const owner = await registerOk(handle, `idem_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const requestId = rid();
  const firstBody = { requestId, baseRevision: 0, entries: [entry(1, 1, 'every', '数学')] };

  const first = await saveDraft(handle, owner.cookie, spaceId, firstBody);
  assert.equal(first.status, 201, first.text);
  const writesAfterFirst = control.writes.filter((table) => table === 'schedule_documents').length;

  const replay = await saveDraft(handle, owner.cookie, spaceId, firstBody);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.schedule.revision, 1);
  assert.equal(control.writes.filter((table) => table === 'schedule_documents').length, writesAfterFirst,
    '重放不得增加写入');

  const differentContent = await saveDraft(handle, owner.cookie, spaceId, {
    requestId, baseRevision: 0, entries: [entry(1, 1, 'every', '物理')],
  });
  assert.equal(differentContent.status, 409);
  assert.equal(differentContent.body.error, 'request_reuse_conflict');

  const differentBase = await saveDraft(handle, owner.cookie, spaceId, {
    requestId, baseRevision: 1, entries: [entry(1, 1, 'every', '数学')],
  });
  assert.equal(differentBase.status, 409);
  assert.equal(differentBase.body.error, 'request_reuse_conflict');

  const second = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '英语')],
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.schedule.revision, 2);

  const oldRetry = await saveDraft(handle, owner.cookie, spaceId, firstBody);
  assert.equal(oldRetry.status, 409);
  assert.equal(oldRetry.body.error, 'version_conflict');
  const stored = db.dump('schedule_documents')[0];
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.draft_entries, [{ day: 1, period: 1, weekRule: 'every', courseName: '英语' }]);
});

test('S2A-06 同 requestId 并发：同内容只写一次并重放，不同内容一方拒绝', async () => {
  const release = deferred();
  let arrivals = 0;
  let gated = true;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!gated || table !== 'schedule_documents' || mode !== 'insert') return;
      arrivals += 1;
      if (arrivals >= 2) {
        gated = false;
        release.resolve();
      }
      await release.promise;
    },
  });
  const owner = await registerOk(handle, `race_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const requestId = rid();
  const body = { requestId, baseRevision: 0, entries: [entry(1, 1, 'every', '数学')] };
  const timer = setTimeout(() => release.resolve(), 5000);
  try {
    const results = await Promise.all([
      saveDraft(handle, owner.cookie, spaceId, body),
      saveDraft(handle, owner.cookie, spaceId, body),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort((a, b) => a - b), [200, 201]);
    assert.equal(results.filter((result) => result.body.replayed === true).length, 1);
    assert.equal(db.dump('schedule_documents').length, 1);
    assert.equal(db.dump('schedule_documents')[0].revision, 1);
  } finally {
    clearTimeout(timer);
  }
});

test('S2A-07 并发写入同一 revision：一方成功，另一方 409，不静默覆盖', async () => {
  const release = deferred();
  let arrivals = 0;
  let gated = false;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!gated || table !== 'schedule_documents' || mode !== 'read') return;
      arrivals += 1;
      if (arrivals >= 2) {
        gated = false;
        release.resolve();
      }
      await release.promise;
    },
  });
  const owner = await registerOk(handle, `cas_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const seeded = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '初始课程')],
  });
  assert.equal(seeded.status, 201, seeded.text);

  const sessionTwo = await loginOk(handle, owner.username);
  gated = true;
  const timer = setTimeout(() => release.resolve(), 5000);
  try {
    const results = await Promise.all([
      publish(handle, owner.cookie, spaceId, {
        requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '会话甲课程')],
      }),
      publish(handle, sessionTwo.cookie, spaceId, {
        requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '会话乙课程')],
      }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort((a, b) => a - b), [200, 409]);
    const loser = results.find((result) => result.status === 409);
    assert.equal(loser.body.error, 'version_conflict');
    const stored = db.dump('schedule_documents')[0];
    assert.equal(stored.revision, 2);
    assert.equal(stored.published_version, 1);
    assert.equal(stored.published_entries.length, 1);
    assert.ok(['会话甲课程', '会话乙课程'].includes(stored.published_entries[0].courseName));
  } finally {
    clearTimeout(timer);
  }
});

test('S2A-08 旧会话在较新写入后提交：返回冲突，不覆盖新数据', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `old_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  assert.equal((await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '初始课程')],
  })).status, 201);

  const sessionTwo = await loginOk(handle, owner.username);
  assert.equal((await saveDraft(handle, sessionTwo.cookie, spaceId, {
    requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '新会话课程')],
  })).status, 200);

  const old = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '旧会话课程')],
  });
  assert.equal(old.status, 409);
  assert.equal(old.body.error, 'version_conflict');
  assert.deepEqual(db.dump('schedule_documents')[0].draft_entries, [
    { day: 1, period: 1, weekRule: 'every', courseName: '新会话课程' },
  ]);
});

test('S2A-09 授权：本人写入、负责人不能代写、跨空间与非成员拒绝、旧空间拒绝', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const member = await registerOk(handle, `am_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const outsider = await registerOk(handle, `ax_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const otherSpaceId = await createSpaceOk(handle, owner.cookie, { name: '另一个空间' });
  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  assert.equal((await join(handle, member.cookie, code, '空间成员')).status, 201);

  assert.equal((await readSchedule(handle, member.cookie, spaceId)).status, 200);
  assert.equal((await saveDraft(handle, member.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '成员课程')],
  })).status, 201);

  const proxy = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, memberId: member.id, entries: [entry(1, 1, 'every', '代写课程')],
  });
  assert.equal(proxy.status, 403);
  assert.equal(db.dump('schedule_documents').length, 1, '负责人代写不得创建第二份文档');

  assert.equal((await readSchedule(handle, outsider.cookie, spaceId)).status, 403);
  assert.equal((await readSchedule(handle, member.cookie, otherSpaceId)).status, 403);
  assert.equal((await saveDraft(handle, outsider.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '外人课程')],
  })).status, 403);

  assert.equal((await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(2, 2, 'every', '负责人自己的课程')],
  })).status, 201);

  const legacyId = await seedLegacySpace(db, owner.id);
  assert.equal((await readSchedule(handle, owner.cookie, legacyId)).status, 409);
  assert.equal((await saveDraft(handle, owner.cookie, legacyId, {
    requestId: rid(), baseRevision: 0, entries: [],
  })).status, 409);
});

test('S2A-10 请求校验与路由方法：非法 requestId/revision/entries 拒绝，错误方法 405', async () => {
  const { handle } = fixture();
  const owner = await registerOk(handle, `val_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);

  const missingRequestId = await saveDraft(handle, owner.cookie, spaceId, {
    baseRevision: 0, entries: [],
  });
  assert.equal(missingRequestId.status, 400);
  assert.equal(missingRequestId.body.error, 'invalid_request_id');

  const badRequestId = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: 'bad id!', baseRevision: 0, entries: [],
  });
  assert.equal(badRequestId.status, 400);
  assert.equal(badRequestId.body.error, 'invalid_request_id');

  const badRevision = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: -1, entries: [],
  });
  assert.equal(badRevision.status, 400);
  assert.equal(badRevision.body.error, 'invalid_input');

  const badEntries = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: { day: 1 },
  });
  assert.equal(badEntries.status, 400);
  assert.equal(badEntries.body.error, 'invalid_input');

  assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/schedule`, {
    method: 'POST', cookie: owner.cookie, body: {},
  }))).status, 405);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/schedule/draft`, {
    cookie: owner.cookie,
  }))).status, 405);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/schedule/publish`, {
    cookie: owner.cookie,
  }))).status, 405);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/schedule/draft`, {
    method: 'POST', cookie: owner.cookie, body: {}, origin: null,
  }))).status, 403);
});

test('S2A-11 前端模型：单双周不同内容合并每周必须选择，取消则原内容不变，每周只保存一条', () => {
  const mode = 'courses';
  const slots = entriesToSlots([
    { day: 1, period: 1, weekRule: 'odd', courseName: '物理' },
    { day: 1, period: 1, weekRule: 'even', courseName: '化学' },
    { day: 1, period: 2, weekRule: 'every', courseName: '数学' },
  ], mode);
  const splitCell = slots.get(scheduleKey(1, 1));
  assert.equal(splitCell.odd.courseName, '物理');
  assert.equal(splitCell.even.courseName, '化学');

  const choosePlan = planRuleSwitch(splitCell, 'every');
  assert.equal(choosePlan.kind, 'choose');
  assert.equal(choosePlan.odd.courseName, '物理');
  assert.equal(choosePlan.even.courseName, '化学');
  const beforeCancel = cloneCell(splitCell);
  // 用户取消切换时不调用 applyRuleSwitch；原编辑内容保持单/双周两条。
  assert.deepEqual(slotsToEntries(new Map([[scheduleKey(1, 1), beforeCancel]]), mode), [
    { day: 1, period: 1, weekRule: 'odd', courseName: '物理' },
    { day: 1, period: 1, weekRule: 'even', courseName: '化学' },
  ]);

  const merged = applyRuleSwitch(splitCell, 'every', choosePlan, 'even');
  assert.equal(merged.every.courseName, '化学');
  assert.equal(merged.odd, null);
  assert.equal(merged.even, null);
  const mergedEntries = slotsToEntries(new Map([[scheduleKey(1, 1), merged]]), mode);
  assert.deepEqual(mergedEntries, [{ day: 1, period: 1, weekRule: 'every', courseName: '化学' }]);
  assert.equal(mergedEntries.filter((item) => item.weekRule === 'every').length, 1);

  const sameContent = {
    day: 2, period: 1, every: null,
    odd: { hasClass: true, courseName: '同一课程' },
    even: { hasClass: true, courseName: '同一课程' },
  };
  const samePlan = planRuleSwitch(sameContent, 'every');
  assert.equal(samePlan.kind, 'merge');
  assert.equal(applyRuleSwitch(sameContent, 'every', samePlan, null).every.courseName, '同一课程');

  const weekly = slots.get(scheduleKey(1, 2));
  const expandPlan = planRuleSwitch(weekly, 'split');
  assert.equal(expandPlan.kind, 'expand');
  const expanded = applyRuleSwitch(weekly, 'split', expandPlan, null);
  assert.equal(expanded.odd.courseName, '数学');
  assert.equal(expanded.even.courseName, '数学');
  assert.deepEqual(
    slotsToEntries(new Map([[scheduleKey(1, 2), expanded]]), mode).map((item) => item.weekRule),
    ['odd', 'even'],
  );
});

test('S2A-12 前端模型：仅有课状态、零条目、清空与上一节快捷', () => {
  const presence = entriesToSlots([{ day: 3, period: 2, weekRule: 'odd' }], 'presence');
  const cell = presence.get(scheduleKey(3, 2));
  assert.equal(cell.odd.courseName, null);
  assert.deepEqual(slotsToEntries(presence, 'presence'), [{ day: 3, period: 2, weekRule: 'odd' }]);
  assert.equal(countClassSlots(presence), 1);
  assert.equal(cellHasContent(cell), true);

  const previous = previousCell(presence, 3, 3);
  assert.equal(previous.period, 2);
  assert.equal(previous.cell.odd.hasClass, true);
  const copied = cloneCellInto(previous.cell, 3, 3);
  assert.equal(copied.day, 3);
  assert.equal(copied.period, 3);
  assert.equal(copied.odd.hasClass, true);
  assert.equal(previousCell(presence, 4, 2), null);
  assert.equal(previousCell(presence, 3, 1), null);

  assert.equal(countClassSlots(new Map()), 0);
  assert.deepEqual(slotsToEntries(new Map(), 'courses'), []);
  assert.equal(entriesEqual([], []), true);
  assert.equal(entriesEqual(
    [{ day: 1, period: 1, weekRule: 'every', courseName: '课程' }],
    [{ day: 1, period: 1, weekRule: 'every', courseName: '课程' }],
  ), true);

  assert.equal(validateCell({
    day: 1, period: 1, every: { hasClass: true, courseName: '' }, odd: null, even: null,
  }, 'courses').ok, false);
  assert.equal(validateCell({
    day: 1, period: 1,
    every: { hasClass: true, courseName: '数学' },
    odd: { hasClass: true, courseName: '物理' },
    even: null,
  }, 'courses').code, 'week_rule_conflict');
  assert.equal(validateCell({
    day: 1, period: 1, every: null, odd: { hasClass: true, courseName: null }, even: null,
  }, 'presence').ok, true);
});

test('S2A-13 前端接线：周编辑器、幂等字段、冲突提示与文案（源码级）', async () => {
  const [source, scheduleSource, html, css] = await Promise.all([
    readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/schedule-page.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const needle of [
    'schedule/draft', 'schedule/publish', 'requestId', 'baseRevision', 'version_conflict',
    'request_reuse_conflict', 'state.pending = { requestId, operation, baseRevision, entries }',
    'beforeunload', '沿用上节',
    'weekRuleResolved', '本空间统一按', 'togglePresenceCell', 'cellEveryName.focus', 'week_rule_mismatch',
    'space_week_rule_unresolved', '仅有课状态',
    'cloneCellInto(previous.cell, target.day, target.period)',
  ]) {
    assert.ok(source.includes(needle) || scheduleSource.includes(needle), `前端缺少 ${needle}`);
  }
  for (const id of [
    'schedule-panel', 'schedule-grid', 'day-tabs', 'cell-editor', 'cell-rule-note',
    'cell-every-block', 'schedule-save-draft', 'schedule-publish', 'schedule-conflict',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 ${id}`);
  }
  for (const removed of ['cell-rule-split', 'cell-rule-every', 'cell-rule-choice', 'cell-odd-name']) {
    assert.ok(!html.includes(removed), `成员编辑器不得再出现 ${removed}`);
  }
  assert.ok(!scheduleSource.includes('renderRuleSwitcher'), '成员编辑器不得再渲染周次切换');
  assert.ok(!source.includes('仅到课'));
  assert.ok(!html.includes('仅到课'));
  assert.ok(css.includes('.week-table'));
  assert.ok(css.includes('@media (max-width: 760px)'));
  for (const file of [source, scheduleSource, html, css]) {
    for (const banned of ['code_hash', 'password_hash', 'password_salt', 'service_role', 'SUPABASE', 'DATABASE_URL', 'postgres://']) {
      assert.ok(!file.includes(banned), `静态文件不得包含 ${banned}`);
    }
    assert.ok(!/[0-9a-f]{32}/.test(file), '静态文件不得包含 32 位邀请码/摘要样式');
  }
});

test('S2A-14 日切换动效参数：跨度递增、上限、减弱动效与滑动不循环', () => {
  assert.equal(daySlideDuration(0), 220);
  assert.equal(daySlideDuration(1), 220);
  assert.equal(daySlideDuration(2), 310);
  assert.equal(daySlideDuration(3), 400);
  assert.equal(daySlideDuration(5), 580);
  assert.equal(daySlideDuration(6), 650);
  assert.equal(daySlideDuration(9), 650);
  assert.equal(daySlideDuration(3, true), 0);
  assert.equal(daySlideDuration(1, true), 0);

  assert.equal(swipeTargetDay(4, 0), 4);
  assert.equal(swipeTargetDay(4, 47), 4);
  assert.equal(swipeTargetDay(4, 48), 3);
  assert.equal(swipeTargetDay(4, -48), 5);
  assert.equal(swipeTargetDay(4, 10, 8), 3);
  assert.equal(swipeTargetDay(1, 200), 1);
  assert.equal(swipeTargetDay(7, -200), 7);
  assert.equal(swipeTargetDay(1, -100), 2);
  assert.equal(swipeTargetDay(7, 100), 6);

  assert.equal(swipeDestination(2, -20, 332, 0), 2);
  assert.equal(swipeDestination(2, -90, 332, 0), 3);
  assert.equal(swipeDestination(2, -55, 332, -1), 3);
  assert.equal(swipeDestination(2, -20, 332, 1.5), 2, '快速反向不能把方向判反');
  assert.equal(swipeDestination(2, 10, 332, -1), 2);
  assert.equal(swipeDestination(1, 200, 332, 1), 1, '起点边界不回绕');
  assert.equal(swipeDestination(7, -200, 332, -1), 7, '终点边界不回绕');
  assert.equal(swipeDestination(2, -560, 332, 0), 4, '长拖按可见位移跨页');
});

test('S2A-15 交互源码：PC 锚定气泡、手机行内编辑器、连续日轨与未应用输入保护', async () => {
  const [source, html, css] = await Promise.all([
    readFile(new URL('../web/schedule-page.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/styles.css', import.meta.url), 'utf8'),
  ]);
  for (const needle of [
    'requestOpenCellEditor', 'requestCloseCellEditor', 'resolveEditorBeforeAction',
    'settleEditorExit', 'editorHasChanges', 'positionCellPopover', 'schedulePopoverPosition',
    'is-popover', 'is-inline', "row.insertAdjacentElement('afterend', el.cellEditor)",
    'mountCellEditor', 'restorePopover', 'collapsePopover', 'trackTranslateX',
    'translate3d', 'daySlideDuration', 'swipeDestination', 'prefersReducedMotion',
    'syncDayHeight', 'ensureDayTabVisible', 'updateDayTabEdges', 'selectScheduleDay',
    'setCarouselPages', 'aria-hidden', 'inert', 'el.editorExitDialog.showModal()',
    'onPointerDown', 'onPointerMove', 'onPointerEnd',
    'suppressClickUntil', 'beforeunload', 'visualViewport', 'ResizeObserver',
  ]) {
    assert.ok(source.includes(needle), `课表前端缺少交互接线 ${needle}`);
  }
  assert.ok(!source.includes('window.scrollTo('), '不得用整页滚动代替日切换');
  assert.ok(source.includes("choice === 'apply'") && source.includes("choice === 'discard'"));
  assert.equal((html.match(/id="cell-editor"/g) ?? []).length, 1, '只允许一个编辑器节点');
  assert.equal((source.match(/id = 'cell-editor'/g) ?? []).length, 0, '不得为每格复制编辑器');
  for (const id of [
    'day-tabs-wrap', 'cell-editor-restore', 'editor-exit-dialog', 'editor-exit-apply',
    'editor-exit-discard', 'editor-exit-stay',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 ${id}`);
  }
  assert.ok(html.includes('class="actions cell-actions-main"'), 'index.html 缺少吸底操作行');
  for (const rule of [
    '.day-tabs', 'overflow-x: auto', '.day-tab', 'min-height: var(--touch-h)',
    '.day-viewport', '.day-track', '.cell-editor.is-popover', 'position: fixed',
    '.cell-editor.is-inline', 'touch-action: pan-y', '.day-row',
    '@media (prefers-reduced-motion: reduce)',
  ]) {
    assert.ok(css.includes(rule), `styles.css 缺少 ${rule}`);
  }
  assert.ok(!css.includes('scroll-snap-type: x mandatory'), '星期导航不使用强制吸附');
});

test('S2A-16 基础 UI 契约：短按钮文案、自托管字体、控件令牌与风险告知', async () => {
  const base = new URL('../web/', import.meta.url);
  const [source, scheduleSource, html, css, fontsCss, ofl] = await Promise.all([
    readFile(new URL('app.js', base), 'utf8'),
    readFile(new URL('schedule-page.mjs', base), 'utf8'),
    readFile(new URL('index.html', base), 'utf8'),
    readFile(new URL('styles.css', base), 'utf8'),
    readFile(new URL('fonts/fonts.css', base), 'utf8'),
    readFile(new URL('fonts/OFL.txt', base), 'utf8'),
  ]);
  const frontend = source + scheduleSource;

  // 同意弹窗的主按钮文案随待确认数量变化，允许到 8 字。
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((match) => ({
      tag: match[1],
      label: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim(),
    }))
    .filter((item) => item.label);
  assert.ok(buttons.length > 20);
  for (const { tag, label } of buttons) {
    let maxLength = 4;
    if (tag.includes('id="consent-continue"')) maxLength = 8;
    assert.ok([...label].length <= maxLength, `按钮可见文案超过 ${maxLength} 字：${label}`);
  }

  for (const [id, aria] of [
    ['register-submit', '注册并登录'],
    ['reload', '重新读取'],
    ['open-join', '使用邀请码'],
    ['create-submit', '保存并进入空间'],
    ['reset-periods', '恢复 12 节模板'],
    ['spaces-retry', '重新读取空间列表'],
    ['home-retry', '重新读取空间'],
    ['calendar-retry', '重新读取月历'],
    ['settings-retry', '重新读取空间设置'],
    ['collect-members-retry', '重新读取成员与提交状态'],
    ['schedule-error-retry', '重新读取课表'],
    ['schedule-save-draft', '保存草稿'],
    ['schedule-publish', '提交有效课表'],
    ['schedule-discard', '放弃本地修改'],
    ['schedule-reload', '重新读取课表'],
    ['invite-generate', '生成邀请码'],
    ['invite-rotate', '轮换邀请码'],
    ['invite-revoke', '撤销邀请码'],
    ['submit-schedule', '提交整表更新'],
    ['editor-exit-apply', '保存后继续'],
    ['editor-exit-discard', '放弃本次编辑'],
  ]) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
    assert.ok(tag.includes(`aria-label="${aria}`), `${id} 缺少 aria-label：${aria}`);
  }

  assert.ok(frontend.includes('沿用第 ${previous.period} 节的内容'));
  assert.ok(frontend.includes('previousSourceNote'));
  assert.ok(html.includes('id="cell-previous-note"'));
  assert.ok(frontend.includes('整表提交会用当前编辑的整周内容替换你在此空间的有效课表。'));
  assert.ok(frontend.includes('空白格表示无课；未填写的格子不会保留旧内容。'));
  assert.ok(frontend.includes('将清空本地整周内容'));
  assert.ok(frontend.includes('撤销后当前邀请码立即失效'));

  for (const family of ['Source Han Sans SC', 'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei']) {
    assert.ok(css.includes(`"${family}"`), `字体栈缺少 ${family}`);
  }
  assert.equal((fontsCss.match(/@font-face/g) ?? []).length, 2);
  assert.ok(fontsCss.includes('font-display: swap'));
  assert.ok(fontsCss.includes('./noto-sans-sc-ui-400.woff2'));
  assert.ok(fontsCss.includes('./noto-sans-sc-ui-600.woff2'));
  assert.ok(ofl.includes('SIL OPEN FONT LICENSE'));
  for (const name of ['noto-sans-sc-ui-400.woff2', 'noto-sans-sc-ui-600.woff2']) {
    const bin = await readFile(new URL(`fonts/${name}`, base));
    assert.equal(bin.subarray(0, 4).toString('latin1'), 'wOF2');
    assert.ok(bin.length > 1000);
  }
  assert.ok(html.includes('href="./fonts/fonts.css"'));
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(source + html + css + fontsCss));
  assert.ok(!source.includes('@font-face'), '字体只由 fonts.css 声明');

  for (const token of [
    '--control-h: 38px', '--control-h-sm: 36px', '--touch-h: 44px',
    '--radius-md: 8px', '--text-sm:', '--space-2:', '--danger:', '--warn:',
  ]) {
    assert.ok(css.includes(token), `控件令牌缺少 ${token}`);
  }
  assert.ok(css.includes('min-height: var(--touch-h)'));
  assert.ok(css.includes('@media (max-width: 680px)'));
  assert.ok(css.includes('font-family: var(--font-ui)'));
  assert.ok(css.includes('body.is-busy::before'));
  assert.ok(!css.includes('translateY(-1px)'), '按钮悬停不得位移');
  assert.ok(!css.includes('radial-gradient'), '基础 UI 不使用大面积装饰渐变');
  assert.ok(!css.includes('box-shadow: var(--shadow)'), '卡片不使用装饰阴影');
});

test('S2A-17 旧空间混合单双周：读取保留既有内容，写入返回未解决而不静默合并', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `legacy_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  assert.equal((await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 0, entries: [entry(1, 1, 'every', '原每周课程')],
  })).status, 201);

  const space = db.dump('spaces').find((row) => row.id === spaceId);
  const { weekRule: _weekRule, ...legacyConfig } = space.config;
  await db.from('spaces').update({
    config: { ...legacyConfig, oddEvenEnabled: true },
  }).eq('id', spaceId);
  const mixed = [
    { day: 1, period: 1, weekRule: 'odd', courseName: '单周物理' },
    { day: 1, period: 1, weekRule: 'even', courseName: '双周化学' },
  ];
  await db.from('schedule_documents').update({ draft_entries: mixed }).eq('space_id', spaceId);

  const read = await readSchedule(handle, owner.cookie, spaceId);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.config.weekRule, null);
  assert.equal(read.body.config.weekRuleResolved, false);
  assert.deepEqual(read.body.schedule.draftEntries, mixed, '旧混合内容必须原样保留');

  const blocked = await saveDraft(handle, owner.cookie, spaceId, {
    requestId: rid(), baseRevision: 1, entries: [entry(1, 1, 'every', '试图合并')],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'space_week_rule_unresolved');
  assert.deepEqual(db.dump('schedule_documents')[0].draft_entries, mixed, '被拒绝的写入不得改动旧内容');
});

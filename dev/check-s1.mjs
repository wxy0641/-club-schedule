// S1 本地契约检查：直接调用真实 router/http/passwords/sessions/limiter/validate/config/invites。
// 数据层是内存假数据库，只模拟条件更新、唯一约束与排序；不证明真实 Provider、网关准入或部署环境行为。
//   node --test dev/check-s1.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../functions/router.mjs';
import { PBKDF2_ITERATIONS, hashPassword } from '../functions/passwords.mjs';
import { SESSION_COOKIE, sha256Hex } from '../functions/sessions.mjs';
import { LIMITS } from '../functions/limiter.mjs';
import { NOTICE_TEXT, NOTICE_VERSION } from '../functions/notices.mjs';
import { INVITE_MAX_USES } from '../functions/invites.mjs';
import { collectVisible } from '../web/routes.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s1.test';
const PASSWORD = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const WRONG_PASSWORD = `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`;

const UNIQUE = {
  users: [['id'], ['username']],
  sessions: [['token_digest']],
  auth_limiter: [['key']],
  spaces: [['id']],
  memberships: [['space_id', 'user_id']],
  schedules: [['id'], ['space_id', 'member_id']],
  space_invites: [['space_id'], ['code_hash']],
  invite_slots: [['id'], ['space_id', 'generation', 'slot_no'], ['space_id', 'claimed_by']],
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
    requestId: 'local-s1-check',
  };
}

async function call(handle, context) {
  const response = await handle(context);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text, setCookie: response.headers.get('set-cookie'), headers: response.headers };
}

const cookiePair = (result) => result.setCookie?.split(';')[0] ?? null;

async function register(handle, username = `s1_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, password = PASSWORD, nickname) {
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

async function login(handle, username, password = PASSWORD) {
  return call(handle, ctx('/api/login', { method: 'POST', body: { username, password } }));
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
    name: 'S1 合成空间',
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

async function join(handle, cookie, code, name, extra = {}) {
  return call(handle, ctx('/api/join', {
    method: 'POST',
    cookie,
    body: {
      code, inSpaceName: name, noticeAccepted: true, noticeVersion: NOTICE_VERSION, ...extra,
    },
  }));
}

async function seedInviteSpace(db, ownerId, code, slotCount, { expired = false } = {}) {
  const spaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.from('spaces').insertIfAbsent({
    id: spaceId, owner_id: ownerId, name: `容量空间 ${slotCount}`, mode: 'presence',
    owner_name: '容量负责人',
    config: {
      version: 1, mode: 'presence', oddEvenEnabled: false, visibility: 'stats',
      periods: [{ index: 1, start: '08:00', end: '08:45' }],
    },
    created_at: now,
  }, { onConflict: 'id' });
  await db.from('space_invites').insertIfAbsent({
    space_id: spaceId,
    code_hash: await sha256Hex(code),
    generation: 1,
    max_uses: slotCount,
    expires_at: new Date(expired ? Date.now() - 1000 : Date.now() + 86400000).toISOString(),
    revoked: false,
    created_at: now,
    updated_at: now,
  }, { onConflict: 'space_id' });
  for (let slotNo = 1; slotNo <= slotCount; slotNo += 1) {
    await db.from('invite_slots').insertIfAbsent({
      id: crypto.randomUUID(), space_id: spaceId, generation: 1, slot_no: slotNo,
      claimed: false, claimed_by: null, in_space_name: null, notice_version: null,
      notice_ack_at: null, claimed_at: null,
    }, { onConflict: 'space_id,generation,slot_no' });
  }
  return spaceId;
}

async function seedLegacySpace(db, ownerId, memberIds = []) {
  const spaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.from('spaces').insertIfAbsent({
    id: spaceId, owner_id: ownerId, name: '旧探针空间', mode: 'courses',
    owner_name: null, config: null, created_at: now,
  }, { onConflict: 'id' });
  for (const userId of memberIds) {
    await db.from('memberships').insertIfAbsent({ space_id: spaceId, user_id: userId },
      { onConflict: 'space_id,user_id' });
  }
  return spaceId;
}

test('A1 注册成功：会话签发、数据库无明文、响应不含账号资料名', async () => {
  const { db, handle } = fixture();
  const username = `new_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const response = await register(handle, username);
  assert.equal(response.status, 201);
  assert.equal(response.body.user.username, username);
  assert.equal(response.body.user.nickname, null);
  assert.equal('fullName' in response.body.user, false);

  const me = await call(handle, ctx('/api/me', { cookie: cookiePair(response) }));
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, { id: response.body.user.id, username, nickname: null });

  const header = response.setCookie ?? '';
  assert.ok(header.startsWith(`${SESSION_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.ok(!/Domain=/i.test(header));

  const users = db.dump('users');
  assert.equal(users.length, 1);
  assert.equal(users[0].full_name, '');
  assert.equal(users[0].nickname, null);
  assert.equal(users[0].password_iterations, PBKDF2_ITERATIONS);
  assert.notEqual(users[0].password_hash, PASSWORD);
  assert.ok(!JSON.stringify(db.dump('users')).includes(PASSWORD));
  assert.ok(!JSON.stringify(db.dump('sessions')).includes(PASSWORD));

  const token = cookiePair(response).slice(SESSION_COOKIE.length + 1);
  assert.ok(!JSON.stringify(db.dump('sessions')).includes(token));
  assert.equal(db.dump('sessions')[0].token_digest, await sha256Hex(token));

  const routerSource = await readFile(new URL('../functions/router.mjs', import.meta.url), 'utf8');
  assert.ok(!routerSource.includes('console.log') && !routerSource.includes('console.error'));
});

test('A2 注册边界：告知确认、重复用户名、格式/长度与限流', async () => {
  const { db, handle } = fixture();
  const username = `dup_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const original = await registerOk(handle, username, '原昵称');
  assert.equal(original.username, username);

  const noNotice = await call(handle, ctx('/api/register', {
    method: 'POST', body: { username: `nn_${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  }));
  assert.equal(noNotice.status, 400);
  assert.equal(noNotice.body.error, 'notice_required');

  const duplicate = await register(handle, username.toUpperCase(), PASSWORD, '新昵称');
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'username_taken');
  assert.equal(db.dump('users').filter((row) => row.username === username).length, 1);
  assert.equal(db.dump('users')[0].nickname, '原昵称', '重复注册不得改写既有昵称');

  const spaced = await register(handle, `  ${username.toUpperCase()}  `, PASSWORD, '另一个昵称');
  assert.equal(spaced.status, 409);
  assert.equal(spaced.body.error, 'username_taken');
  assert.equal(db.dump('users').filter((row) => row.username === username).length, 1);

  const shortName = await register(handle, 'ab');
  assert.equal(shortName.status, 400);
  assert.equal(shortName.body.error, 'invalid_username');

  const badName = await register(handle, 'bad name!');
  assert.equal(badName.status, 400);

  const shortPassword = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: { username: `sp_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, password: 'x'.repeat(7), noticeAccepted: true },
  }));
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.body.error, 'invalid_password');

  const minName = `mn_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const minPassword = 'abcdefgh';
  const minRegister = await register(handle, minName, minPassword);
  assert.equal(minRegister.status, 201, minRegister.text);
  assert.equal((await login(handle, minName, minPassword)).status, 200);

  const fourEmoji = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: { username: `em_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, password: '😀😀😀😀', noticeAccepted: true },
  }));
  assert.equal(fourEmoji.status, 400, '按码点计数：4 个表情不足 8 字符');
  assert.equal(fourEmoji.body.error, 'invalid_password');

  const emojiName = `em_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const emojiPassword = '😀😀😀😀😀😀😀😀';
  assert.equal((await register(handle, emojiName, emojiPassword)).status, 201);
  assert.equal((await login(handle, emojiName, emojiPassword)).status, 200);

  const longName = `lg_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const longPassword = `L${'x'.repeat(63)}`;
  assert.equal((await register(handle, longName, longPassword)).status, 201);
  assert.equal((await login(handle, longName, longPassword)).status, 200);
  assert.equal((await login(handle, longName, longPassword.slice(0, 63))).status, 401, '长口令不得被截断');

  const spacedName = `ws_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const spacedPassword = `  ${spacedName}  `;
  assert.equal((await register(handle, spacedName, spacedPassword)).status, 201);
  assert.equal((await login(handle, spacedName, spacedPassword)).status, 200);
  assert.equal((await login(handle, spacedName, spacedName)).status, 401, '口令不得被 trim');

  const hugePassword = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: { username: `hp_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, password: 'x'.repeat(257), noticeAccepted: true },
  }));
  assert.equal(hugePassword.status, 400);
  assert.equal(hugePassword.body.error, 'invalid_password');

  const limitedName = `rl_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const statuses = [];
  for (let index = 0; index < LIMITS.register.maxAttempts; index += 1) {
    statuses.push((await register(handle, limitedName)).status);
  }
  const blocked = await register(handle, limitedName);
  // 第一次创建成功；后续同名尝试仍消耗限流配额，返回 username_taken。
  assert.deepEqual(statuses, [201, ...Array(LIMITS.register.maxAttempts - 1).fill(409)]);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
});

test('A2b 登录不套用注册最小长度：历史短口令账号仍可登录', async () => {
  const { db, handle } = fixture();
  const username = `legacy_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const legacyPassword = 'old6pw';
  const derived = await hashPassword(legacyPassword);
  await db.from('users').insertIfAbsent({
    id: crypto.randomUUID(),
    username,
    nickname: '历史账号',
    full_name: '',
    password_salt: derived.salt,
    password_hash: derived.hash,
    password_iterations: derived.iterations,
    created_at: new Date().toISOString(),
  });

  const ok = await login(handle, username, legacyPassword);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.setCookie?.startsWith(`${SESSION_COOKIE}=`));
  assert.equal((await login(handle, username, `${legacyPassword}!`)).status, 401);
});

test('A2c 密码规则前后端一致：注册 8 码点/256 字节，登录不套用注册下限', async () => {
  const [app, html, validate, router] = await Promise.all([
    readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../functions/validate.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../functions/router.mjs', import.meta.url), 'utf8'),
  ]);
  assert.ok(app.includes('const PASSWORD_MIN_CHARS = 8;'));
  assert.ok(app.includes('const PASSWORD_MAX_BYTES = 256;'));
  assert.ok(app.includes('const passwordChars = (value) => [...value].length;'));
  assert.ok(app.includes('passwordBytes'));
  assert.ok(app.includes('passwordChars(ui.registerPassword.value) < PASSWORD_MIN_CHARS'));
  assert.ok(app.includes('passwordBytes(ui.registerPassword.value) > PASSWORD_MAX_BYTES'));
  assert.ok(app.includes('ui.registerPassword.value !== ui.registerConfirm.value'));
  assert.ok(app.includes('密码不符合要求：至少 8 个字符'));

  assert.ok(html.includes('至少 8 个字符。'));
  assert.ok(!html.includes('15 个字符'));
  assert.ok(html.includes('autocomplete="new-password"'));

  assert.ok(validate.includes('export const PASSWORD_MIN_CHARS = 8;'));
  assert.ok(validate.includes('if ([...raw].length < PASSWORD_MIN_CHARS)'));
  assert.ok(validate.includes('new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES'));
  const passwordBody = validate.slice(validate.indexOf('export function validatePassword'), validate.indexOf('export function validateNickname'));
  assert.ok(!passwordBody.includes('trim()'), '口令不得 trim');
  assert.ok(!passwordBody.includes('toLowerCase()'), '口令不得转换大小写');

  const loginBody = router.slice(router.indexOf('async function login'), router.indexOf('async function logout'));
  assert.ok(loginBody.includes('boundedPassword(body?.password)'));
  assert.ok(!loginBody.includes('validatePassword'), '登录不得套用注册最小长度');
});

test('A3 并发注册同一规范化账号：仅一个请求创建账号与会话', async () => {
  const release = deferred();
  let arrivals = 0;
  let gated = true;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!gated || table !== 'users' || mode !== 'read') return;
      arrivals += 1;
      if (arrivals >= 2) {
        gated = false;
        release.resolve();
      }
      await release.promise;
    },
  });
  const timer = setTimeout(() => release.resolve(), 5000);
  try {
    const username = `race_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    // 两个请求都先通过“账号是否已存在”的预检查，再竞争唯一索引。
    const results = await Promise.all([
      register(handle, username),
      register(handle, `  ${username.toUpperCase()}  `),
    ]);
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);
    const winner = results.find((result) => result.status === 201);
    assert.equal(db.dump('users').filter((row) => row.username === username).length, 1);
    assert.equal(db.dump('users')[0].id, winner.body.user.id);
    assert.equal(db.dump('sessions').length, 1);
    assert.equal(db.dump('sessions')[0].user_id, winner.body.user.id);
  } finally {
    clearTimeout(timer);
  }
});

function conflictEchoUsersDb(base) {
  const from = base.from.bind(base);
  return {
    from(table) {
      const builder = from(table);
      if (table !== 'users') return builder;
      return {
        select: (columns) => builder.select(columns),
        insertIfAbsent: (row, options) => {
          const chain = builder.insertIfAbsent(row, options);
          return {
            select() {
              return {
                then(resolve, reject) {
                  return chain.then((result) => {
                    if (result.data.length > 0) return resolve(result);
                    // 模拟另一种 Provider 语义：冲突时回显既有行而不是空数据。
                    const existing = base.dump('users').find((item) => item.username === row.username);
                    return resolve({
                      data: existing ? [{ id: existing.id, username: existing.username }] : [],
                      error: null,
                    });
                  }, reject);
                },
              };
            },
          };
        },
      };
    },
    dump: (table) => base.dump(table),
  };
}

test('A4 冲突行回显：并发注册不得为既有账号签发新会话', async () => {
  const release = deferred();
  let arrivals = 0;
  let gated = true;
  const base = createFakeDb({ writes: [] }, {
    unique: UNIQUE,
    wait: async (table, mode) => {
      if (!gated || table !== 'users' || mode !== 'read') return;
      arrivals += 1;
      if (arrivals >= 2) {
        gated = false;
        release.resolve();
      }
      await release.promise;
    },
  });
  const handle = createApplication({ db: conflictEchoUsersDb(base), origin: PUBLIC_ORIGIN });
  const username = `echo_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const timer = setTimeout(() => release.resolve(), 5000);
  try {
    const results = await Promise.all([register(handle, username), register(handle, username)]);
    const statuses = results.map((result) => result.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);
    const winner = results.find((result) => result.status === 201);
    assert.equal(base.dump('users').length, 1);
    assert.equal(base.dump('users')[0].id, winner.body.user.id);
    assert.equal(base.dump('sessions').length, 1);
    assert.equal(base.dump('sessions')[0].user_id, winner.body.user.id);
  } finally {
    clearTimeout(timer);
  }
});

test('A5 昵称：不同账号可重复，非真实姓名可注册，仅本人资料返回', async () => {
  const { db, handle } = fixture();
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const nickname = '锅巴🌙';
  const first = await registerOk(handle, `nka_${suffix}`, nickname);
  const second = await registerOk(handle, `nkb_${suffix}`, nickname);
  assert.notEqual(first.id, second.id);
  assert.equal(first.nickname, nickname);
  assert.equal(second.nickname, nickname);
  assert.equal(db.dump('users').filter((row) => row.nickname === nickname).length, 2);
  assert.equal(db.dump('users').filter((row) => row.full_name === '').length, 2);

  const me = await call(handle, ctx('/api/me', { cookie: first.cookie }));
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, { id: first.id, username: first.username, nickname });

  const relogin = await login(handle, first.username);
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.id, first.id);
  assert.equal(relogin.body.user.nickname, nickname);

  const blank = await registerOk(handle, `nkc_${suffix}`, '   ');
  assert.equal(blank.nickname, null);

  const tooLong = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: `nkd_${suffix}`, nickname: 'x'.repeat(51), password: PASSWORD, noticeAccepted: true,
    },
  }));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, 'invalid_input');

  const control = await call(handle, ctx('/api/register', {
    method: 'POST',
    body: {
      username: `nke_${suffix}`, nickname: 'bad\nname', password: PASSWORD, noticeAccepted: true,
    },
  }));
  assert.equal(control.status, 400);
  assert.equal(control.body.error, 'invalid_input');
});

test('A6 重复昵称不改变 UID/登录/空间关联，且不进入成员可见信息', async () => {
  const { db, handle } = fixture();
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const nickname = `同昵称_${suffix}`;
  const owner = await registerOk(handle, `nno_${suffix}`, nickname);
  const member = await registerOk(handle, `nnm_${suffix}`, nickname);
  const spaceId = await createSpaceOk(handle, owner.cookie, {
    name: '昵称隔离空间', ownerName: '空间内负责人',
  });
  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  assert.equal((await join(handle, member.cookie, code, '空间内成员')).status, 201);

  const repeated = await register(handle, owner.username, PASSWORD, '改昵称尝试');
  assert.equal(repeated.status, 409);
  assert.equal(db.dump('users').find((row) => row.username === owner.username).id, owner.id);
  const relogin = await login(handle, owner.username);
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.id, owner.id);
  assert.equal(relogin.body.user.nickname, nickname);

  const members = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(members.status, 200);
  assert.ok(!members.text.includes(nickname));
  assert.ok(!members.text.includes(owner.username));
  assert.ok(members.body.members.some((row) => row.inSpaceName === '空间内成员'));
  assert.ok(members.body.members.some((row) => row.inSpaceName === '空间内负责人'));

  const list = await call(handle, ctx('/api/spaces', { cookie: member.cookie }));
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(nickname));
  assert.equal(list.body[0].inSpaceName, '空间内成员');

  const config = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: member.cookie }));
  assert.equal(config.status, 200);
  assert.ok(!config.text.includes(nickname));
});

test('A7 旧账号兼容：昵称缺失可登录，空间关联与空间内姓名不变，full_name 不外泄', async () => {
  const { db, handle } = fixture();
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const legacy = await registerOk(handle, `lg_${suffix}`, '旧行占位昵称');
  const spaceId = await createSpaceOk(handle, legacy.cookie, {
    name: '旧账号空间', ownerName: '旧空间内负责人姓名',
  });
  const code = await generateInviteOk(handle, legacy.cookie, spaceId);
  const member = await registerOk(handle, `lgm_${suffix}`, '成员昵称');
  assert.equal((await join(handle, member.cookie, code, '旧空间内成员姓名')).status, 201);

  // 模拟迁移前的旧行：昵称缺失；full_name 放哨兵值，验证它不被解释为昵称或外泄。
  await db.from('users').update({ nickname: null, full_name: '旧账号真实姓名哨兵' }).eq('id', legacy.id);

  const relogin = await login(handle, legacy.username);
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.id, legacy.id);
  assert.equal(relogin.body.user.nickname, null);
  assert.equal('fullName' in relogin.body.user, false);
  assert.ok(!relogin.text.includes('旧账号真实姓名哨兵'));

  const cookie = cookiePair(relogin);
  const me = await call(handle, ctx('/api/me', { cookie }));
  assert.deepEqual(me.body.user, { id: legacy.id, username: legacy.username, nickname: null });

  const list = await call(handle, ctx('/api/spaces', { cookie }));
  assert.equal(list.status, 200);
  const entry = list.body.find((row) => row.id === spaceId);
  assert.ok(entry, '旧账号仍能看到原有空间');
  assert.equal(entry.role, 'owner');
  assert.equal(entry.inSpaceName, '旧空间内负责人姓名');
  assert.ok(!list.text.includes('旧账号真实姓名哨兵'));

  const config = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie }));
  assert.equal(config.status, 200);
  assert.equal(config.body.viewer.inSpaceName, '旧空间内负责人姓名');
  assert.ok(!config.text.includes('旧账号真实姓名哨兵'));

  const members = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie }));
  assert.equal(members.status, 200);
  assert.ok(members.body.members.some((row) => row.inSpaceName === '旧空间内成员姓名'));
  assert.ok(!members.text.includes('旧账号真实姓名哨兵'));
  assert.ok(!members.text.includes(legacy.username));

  const memberConfig = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: member.cookie }));
  assert.equal(memberConfig.status, 200);
  assert.equal(memberConfig.body.viewer.inSpaceName, '旧空间内成员姓名');
});

test('B 登录/退出/刷新：正确与错误口令、会话撤销、Cookie 属性（本地响应）', async () => {
  const { handle } = fixture();
  const account = await registerOk(handle, `login_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);

  assert.equal((await call(handle, ctx('/api/me', { cookie: account.cookie }))).status, 200);
  const logout = await call(handle, ctx('/api/logout', { method: 'POST', cookie: account.cookie }));
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie ?? '', /Max-Age=0/);
  assert.equal((await call(handle, ctx('/api/me', { cookie: account.cookie }))).status, 401);

  const wrong = await login(handle, account.username, WRONG_PASSWORD);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'invalid_credentials');

  const good = await login(handle, account.username);
  assert.equal(good.status, 200);
  assert.equal(good.body.user.username, account.username);
  assert.equal('fullName' in good.body.user, false);
  const cookie = cookiePair(good);
  const restored = await call(handle, ctx('/api/me', { cookie }));
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user.username, account.username);

  // 登录与注册共用 canonicalUsername：大小写与前后空格只影响输入，不产生另一个账号。
  const variant = await login(handle, `  ${account.username.toUpperCase()}  `);
  assert.equal(variant.status, 200);
  assert.equal(variant.body.user.id, account.id);
  assert.equal(variant.body.user.username, account.username);

  const logout2 = await call(handle, ctx('/api/logout', { method: 'POST', cookie }));
  assert.equal(logout2.status, 200);
  assert.equal((await call(handle, ctx('/api/me', { cookie }))).status, 401);
});

test('C1 创建空间：单行所有者与配置、列表/配置读契约、无成员关系残留', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `own_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const body = spaceBody({ mode: 'presence', weekRule: 'every', visibility: 'stats', periods: makePeriods(7, 70) });
  const response = await call(handle, ctx('/api/spaces', { method: 'POST', cookie: owner.cookie, body }));
  assert.equal(response.status, 201, response.text);
  assert.equal(response.body.space.role, 'owner');
  assert.equal(response.body.config.visibility, 'stats');
  assert.equal(response.body.config.periods.length, 7);

  const rows = db.dump('spaces');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_id, owner.id);
  assert.equal(rows[0].owner_name, '合成负责人');
  assert.equal(rows[0].mode, 'presence');
  assert.equal(rows[0].config.visibility, 'stats');
  assert.equal(db.dump('memberships').length, 0, '所有者由 spaces.owner_id 直接确定，不写成员关系');

  const list = await call(handle, ctx('/api/spaces', { cookie: owner.cookie }));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].role, 'owner');
  assert.equal(list.body[0].inSpaceName, '合成负责人');

  const config = await call(handle, ctx(`/api/spaces/${response.body.space.id}/config`, { cookie: owner.cookie }));
  assert.equal(config.status, 200);
  assert.equal(config.body.space.role, 'owner');
  assert.equal(config.body.viewer.inSpaceName, '合成负责人');
  assert.deepEqual(config.body.config.periods, body.periods);
  assert.equal(config.body.noticeVersion, NOTICE_VERSION);
});

test('C2 配置校验：1/20 节可创建，21 节、重叠、倒序、非法字段全部拒绝且不写入', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `cfg_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);

  for (const count of [1, 20]) {
    const spaceId = await createSpaceOk(handle, owner.cookie, { periods: makePeriods(count, 50) });
    assert.ok(spaceId);
  }
  assert.equal(db.dump('spaces').length, 2);

  const invalidBodies = [
    spaceBody({ periods: makePeriods(21, 50) }),
    spaceBody({ periods: Array(21).fill(null).map((_, index) => ({ index: index + 1, start: formatTime(300 + index * 40), end: formatTime(330 + index * 40) })) }),
    spaceBody({ periods: [{ index: 1, start: '08:00', end: '08:45' }, { index: 2, start: '08:30', end: '09:15' }] }),
    spaceBody({ periods: [{ index: 1, start: '08:45', end: '08:00' }] }),
    spaceBody({ periods: [{ index: 2, start: '08:00', end: '08:45' }] }),
    spaceBody({ periods: [{ index: 1, start: '25:00', end: '25:45' }] }),
    spaceBody({ mode: 'other' }),
    spaceBody({ weekRule: 'biweekly' }),
    { ...spaceBody(), weekRule: undefined },
    { ...spaceBody(), weekRule: undefined, oddEvenEnabled: true },
    spaceBody({ visibility: 'public' }),
    spaceBody({ name: '' }),
    spaceBody({ ownerName: '   ' }),
  ];
  for (const body of invalidBodies) {
    const response = await call(handle, ctx('/api/spaces', { method: 'POST', cookie: owner.cookie, body }));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
  }
  assert.equal(db.dump('spaces').length, 2, '非法配置不得留下空间行');
});

test('D1 邀请与加入：所有者生成/成员拒绝、告知版本、认领槽位、重复幂等、角色不可自选', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `io_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const member = await registerOk(handle, `im_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const outsider = await registerOk(handle, `ix_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);

  const memberGenerate = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, { method: 'POST', cookie: member.cookie }));
  assert.equal(memberGenerate.status, 403);

  const beforeJoinNotice = await join(handle, member.cookie, 'a'.repeat(32), '成员甲', { noticeAccepted: false });
  assert.equal(beforeJoinNotice.status, 400);
  assert.equal(beforeJoinNotice.body.error, 'notice_required');

  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  assert.match(code, /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
  const storedInvite = db.dump('space_invites')[0];
  assert.ok(!JSON.stringify(storedInvite).includes(code.replace(/-/g, '')));
  assert.equal(storedInvite.code_hash, await sha256Hex(code.replace(/-/g, '')));
  assert.equal(db.dump('invite_slots').length, INVITE_MAX_USES);

  const joined = await join(handle, member.cookie, code, '空间内甲', { role: 'owner', userId: 'forged' });
  assert.equal(joined.status, 201, joined.text);
  assert.equal(joined.body.space.role, 'member');
  const slot = db.dump('invite_slots').find((row) => row.claimed === true);
  assert.equal(slot.in_space_name, '空间内甲');
  assert.equal(slot.notice_version, NOTICE_VERSION);
  assert.ok(slot.notice_ack_at);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);
  assert.equal(db.dump('memberships').length, 0);

  const duplicate = await join(handle, member.cookie, code, '另一个名字');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.alreadyMember, true);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);
  assert.equal(db.dump('invite_slots').find((row) => row.claimed === true).in_space_name, '空间内甲');

  const ownerSelf = await join(handle, owner.cookie, code, '负责人重复加入');
  assert.equal(ownerSelf.status, 200);
  assert.equal(ownerSelf.body.space.role, 'owner');
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);

  const memberList = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: member.cookie }));
  assert.equal(memberList.status, 403);
  const outsiderConfig = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: outsider.cookie }));
  assert.equal(outsiderConfig.status, 403);

  const ownerMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(ownerMembers.status, 200);
  assert.equal(ownerMembers.body.members.length, 2);
  assert.ok(ownerMembers.body.members.some((row) => row.inSpaceName === '空间内甲' && row.noticeVersion === NOTICE_VERSION));

  const memberList2 = await call(handle, ctx('/api/spaces', { cookie: member.cookie }));
  assert.equal(memberList2.body.length, 1);
  assert.equal(memberList2.body[0].role, 'member');
  assert.equal(memberList2.body[0].inSpaceName, '空间内甲');
});

test('D2 撤销/轮换/过期：旧码失效、既有成员保留、轮换后可加入', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `ro_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const first = await registerOk(handle, `rf_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const second = await registerOk(handle, `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const third = await registerOk(handle, `rt_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);

  assert.equal((await join(handle, first.cookie, code, '先加入')).status, 201);

  const revoked = await call(handle, ctx(`/api/spaces/${spaceId}/invite/revoke`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.invite.active, false);
  assert.equal((await join(handle, second.cookie, code, '撤销后')).status, 410);

  const rotated = await call(handle, ctx(`/api/spaces/${spaceId}/invite/rotate`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(rotated.status, 200, rotated.text);
  const newCode = rotated.body.code;
  assert.notEqual(newCode, code);
  assert.equal((await join(handle, second.cookie, code, '旧码')).status, 410);
  assert.equal((await join(handle, second.cookie, newCode, '新码成员')).status, 201);

  const members = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(members.status, 200);
  assert.ok(members.body.members.some((row) => row.inSpaceName === '先加入'));
  assert.ok(members.body.members.some((row) => row.inSpaceName === '新码成员'));

  const metadata = await call(handle, ctx(`/api/spaces/${spaceId}/invite`, { cookie: owner.cookie }));
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.used, 1);
  assert.equal(metadata.body.remaining, INVITE_MAX_USES - 1);
  assert.equal(metadata.body.active, true);
  assert.ok(!metadata.text.includes('code_hash'));

  await db.from('space_invites').update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('space_id', spaceId);
  assert.equal((await join(handle, third.cookie, newCode, '过期后')).status, 410);
});

test('E1 并发最后名额：容量 2 时两个用户成功、第三个满员，不超卖', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `co_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const users = await Promise.all([
    registerOk(handle, `c1_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
    registerOk(handle, `c2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
    registerOk(handle, `c3_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
  ]);
  const code = 'b'.repeat(32);
  const spaceId = await seedInviteSpace(db, db.dump('users').find((row) => row.username === owner.username).id, code, 2);

  const [one, two] = await Promise.all([
    join(handle, users[0].cookie, code, '并发甲'),
    join(handle, users[1].cookie, code, '并发乙'),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 201]);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 2);

  const three = await join(handle, users[2].cookie, code, '第三人');
  assert.equal(three.status, 409);
  assert.equal(three.body.error, 'invite_full');
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 2);
  assert.equal(db.dump('invite_slots').filter((row) => row.space_id === spaceId).length, 2);
});

test('E2 同一用户并发加入：只认领一个名额，另一个请求幂等返回既有成员', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `so_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const user = await registerOk(handle, `su_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const code = 'c'.repeat(32);
  await seedInviteSpace(db, db.dump('users').find((row) => row.username === owner.username).id, code, 2);

  const [first, second] = await Promise.all([
    join(handle, user.cookie, code, '名字甲'),
    join(handle, user.cookie, code, '名字乙'),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);
});

test('E3 单槽邀请：两个用户争最后一个名额只成功一人；同用户并发不重复占位', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `eo_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const ownerId = db.dump('users').find((row) => row.username === owner.username).id;
  const users = await Promise.all([
    registerOk(handle, `e1_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
    registerOk(handle, `e2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
    registerOk(handle, `e3_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`),
  ]);
  const code = 'd'.repeat(32);
  await seedInviteSpace(db, ownerId, code, 1);
  const [one, two] = await Promise.all([
    join(handle, users[0].cookie, code, '单槽甲'),
    join(handle, users[1].cookie, code, '单槽乙'),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 409]);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);

  const sameCode = 'e'.repeat(32);
  const sameHash = await sha256Hex(sameCode);
  await seedInviteSpace(db, ownerId, sameCode, 1);
  const [first, second] = await Promise.all([
    join(handle, users[2].cookie, sameCode, '同名甲'),
    join(handle, users[2].cookie, sameCode, '同名乙'),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  const sameSpaceId = db.dump('space_invites').find((row) => row.code_hash === sameHash).space_id;
  assert.equal(db.dump('invite_slots').filter((row) => row.space_id === sameSpaceId && row.claimed === true).length, 1);
});

test('F 所有者专属与跨空间：成员不能生成/轮换/撤销，其他所有者不能操作', async () => {
  const { handle } = fixture();
  const ownerA = await registerOk(handle, `fa_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const ownerB = await registerOk(handle, `fb_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const member = await registerOk(handle, `fm_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceA = await createSpaceOk(handle, ownerA.cookie);
  const codeA = await generateInviteOk(handle, ownerA.cookie, spaceA);
  assert.equal((await join(handle, member.cookie, codeA, '成员')).status, 201);

  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite`, { method: 'POST', cookie: member.cookie }))).status, 403);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite/rotate`, { method: 'POST', cookie: member.cookie }))).status, 403);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite/revoke`, { method: 'POST', cookie: member.cookie }))).status, 403);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite`, { cookie: member.cookie }))).status, 403);

  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite`, { method: 'POST', cookie: ownerB.cookie }))).status, 403);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/invite/rotate`, { method: 'POST', cookie: ownerB.cookie }))).status, 403);
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceA}/members`, { cookie: ownerB.cookie }))).status, 403);

  const again = await call(handle, ctx(`/api/spaces/${spaceA}/invite`, { method: 'POST', cookie: ownerA.cookie }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'invite_exists');
});

test('G 授权与字段：未登录/非成员拒绝，成员无名单，负责人不获得账号标识', async () => {
  const { db, handle } = fixture();
  const owner = await registerOk(handle, `ga_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const member = await registerOk(handle, `gm_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const outsider = await registerOk(handle, `gx_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  assert.equal((await join(handle, member.cookie, code, '成员姓名')).status, 201);

  for (const path of ['config', 'members', 'invite', 'overview', 'my-schedule']) {
    assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/${path}`))).status, 401);
    assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/${path}`, { cookie: outsider.cookie }))).status, 403);
  }

  const memberMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: member.cookie }));
  assert.equal(memberMembers.status, 403);
  const memberConfig = await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: member.cookie }));
  assert.equal(memberConfig.status, 200);
  assert.equal(memberConfig.body.viewer.inSpaceName, '成员姓名');
  assert.ok(!memberConfig.text.includes('members'));

  const ownerMembers = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(ownerMembers.status, 200);
  assert.ok(ownerMembers.text.includes('成员姓名'));
  assert.ok(!ownerMembers.text.includes(owner.username));
  assert.ok(!ownerMembers.text.includes(member.username));
  const ids = db.dump('users').map((row) => row.id);
  for (const id of ids) assert.ok(!ownerMembers.text.includes(id));

  for (const path of ['overview', 'my-schedule']) {
    for (const cookie of [owner.cookie, member.cookie]) {
      const blocked = await call(handle, ctx(`/api/spaces/${spaceId}/${path}`, { cookie }));
      assert.equal(blocked.status, 409, path);
      assert.equal(blocked.body.error, 'legacy_capability_unavailable');
    }
  }
  const memberSubmit = await call(handle, ctx(`/api/spaces/${spaceId}/submissions`, {
    method: 'POST',
    cookie: member.cookie,
    body: { version: 0, entries: [{ day: 1, period: 1, hasClass: true, courseName: '私密课程名' }] },
  }));
  assert.equal(memberSubmit.status, 409);
  assert.equal(memberSubmit.body.error, 'legacy_capability_unavailable');
  assert.equal(db.dump('schedules').length, 0, 'S1 空间不得经旧提交接口写入');

  // 旧 memberships 在 S1 空间不授予访问，也不进入名单。
  await db.from('memberships').insertIfAbsent({ space_id: spaceId, user_id: outsider.id },
    { onConflict: 'space_id,user_id' });
  assert.equal((await call(handle, ctx(`/api/spaces/${spaceId}/config`, { cookie: outsider.cookie }))).status, 403);
  const outsiderList = await call(handle, ctx('/api/spaces', { cookie: outsider.cookie }));
  assert.ok(!outsiderList.body.some((row) => row.id === spaceId));
  const membersAfterStray = await call(handle, ctx(`/api/spaces/${spaceId}/members`, { cookie: owner.cookie }));
  assert.equal(membersAfterStray.body.members.length, 2);

  // 旧空间仍保留旧探针能力；兼容由服务端 config=null 标记隔离。
  const legacyId = await seedLegacySpace(db, owner.id, [member.id]);
  const legacySubmit = await call(handle, ctx(`/api/spaces/${legacyId}/submissions`, {
    method: 'POST',
    cookie: member.cookie,
    body: { version: 0, entries: [{ day: 1, period: 1, hasClass: true, courseName: '私密课程名' }] },
  }));
  assert.equal(legacySubmit.status, 201, legacySubmit.text);

  const legacyMemberOverview = await call(handle, ctx(`/api/spaces/${legacyId}/overview`, { cookie: member.cookie }));
  assert.equal(legacyMemberOverview.status, 200);
  assert.equal(legacyMemberOverview.body.entries.length, 1);
  assert.ok(!('courseName' in legacyMemberOverview.body.entries[0]));
  assert.ok(!legacyMemberOverview.text.includes('私密课程名'));

  const legacyOwnerOverview = await call(handle, ctx(`/api/spaces/${legacyId}/overview`, { cookie: owner.cookie }));
  assert.equal(legacyOwnerOverview.status, 200);
  assert.equal(legacyOwnerOverview.body.entries[0].courseName, '私密课程名');
  assert.equal((await call(handle, ctx(`/api/spaces/${legacyId}/my-schedule`, { cookie: member.cookie }))).status, 200);
  const legacyMembers = await call(handle, ctx(`/api/spaces/${legacyId}/members`, { cookie: owner.cookie }));
  assert.equal(legacyMembers.status, 200);
  assert.equal(legacyMembers.body.members.length, 2);
  const legacyInvite = await call(handle, ctx(`/api/spaces/${legacyId}/invite`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(legacyInvite.status, 409);
  assert.equal(legacyInvite.body.error, 'space_kind_mismatch');

  const sources = await Promise.all(['app.js', 'index.html', 'styles.css'].map((name) => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8')));
  for (const source of sources) {
    for (const banned of ['code_hash', 'password_hash', 'password_salt', 'service_role', 'SUPABASE', 'DATABASE_URL', 'postgres://']) {
      assert.ok(!source.includes(banned), `静态文件不得包含 ${banned}`);
    }
    assert.ok(!/[0-9a-f]{32}/.test(source), '静态文件不得包含 32 位邀请码/摘要样式');
  }
});

test('J 撤销栅栏：兑换读取旧码后暂停，撤销完成后恢复仍不得认领', async () => {
  const reached = deferred();
  const release = deferred();
  let armed = true;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!armed || table !== 'invite_slots' || mode !== 'read') return;
      armed = false;
      reached.resolve();
      await release.promise;
    },
  });
  const owner = await registerOk(handle, `jo_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const joiner = await registerOk(handle, `jj_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);

  const pending = join(handle, joiner.cookie, code, '暂停后加入');
  await reached.promise;
  const revoked = await call(handle, ctx(`/api/spaces/${spaceId}/invite/revoke`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(revoked.status, 200, revoked.text);
  release.resolve();

  const result = await pending;
  assert.equal(result.status, 410, result.text);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 0);
  assert.equal(db.dump('space_invites')[0].revoked, true);
});

test('K 轮换栅栏：旧码兑换暂停后轮换完成，恢复后旧码不得认领，新码可用', async () => {
  const reached = deferred();
  const release = deferred();
  let armed = true;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!armed || table !== 'invite_slots' || mode !== 'read') return;
      armed = false;
      reached.resolve();
      await release.promise;
    },
  });
  const owner = await registerOk(handle, `ko_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const slow = await registerOk(handle, `ks_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const fresh = await registerOk(handle, `kf_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);

  const pending = join(handle, slow.cookie, code, '轮换中暂停');
  await reached.promise;
  const rotated = await call(handle, ctx(`/api/spaces/${spaceId}/invite/rotate`, { method: 'POST', cookie: owner.cookie }));
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal(rotated.body.generation, 2);
  release.resolve();

  const oldResult = await pending;
  assert.equal(oldResult.status, 410, oldResult.text);
  assert.equal(db.dump('invite_slots').filter((row) => row.generation === 1 && row.claimed === true).length, 0);
  assert.equal(db.dump('invite_slots').filter((row) => row.generation === 1 && row.claimed === false).length, 0);
  const newJoin = await join(handle, fresh.cookie, rotated.body.code, '新码成员');
  assert.equal(newJoin.status, 201, newJoin.text);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 1);
});

test('L 过期边界：兑换读取未过期邀请后暂停，恢复时已过期则拒绝并失效槽位', async () => {
  const reached = deferred();
  const release = deferred();
  let armed = true;
  const { db, handle } = fixture({
    wait: async (table, mode) => {
      if (!armed || table !== 'invite_slots' || mode !== 'read') return;
      armed = false;
      reached.resolve();
      await release.promise;
    },
  });
  const owner = await registerOk(handle, `lo_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const joiner = await registerOk(handle, `lj_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
  const spaceId = await createSpaceOk(handle, owner.cookie);
  const code = await generateInviteOk(handle, owner.cookie, spaceId);
  await db.from('space_invites').update({ expires_at: new Date(Date.now() + 3000).toISOString() })
    .eq('space_id', spaceId);

  const pending = join(handle, joiner.cookie, code, '过期边界');
  await reached.promise;
  await new Promise((settle) => setTimeout(settle, 3200));
  release.resolve();

  const result = await pending;
  assert.equal(result.status, 410, result.text);
  assert.equal(db.dump('invite_slots').filter((row) => row.claimed === true).length, 0);
  assert.equal(db.dump('invite_slots').filter((row) => row.generation === 1).length, 0);
});

test('H 前端真实状态回归（源码级）：忙状态不得吞掉首次空间加载，注册告知可见', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function activateHome');
  assert.ok(start >= 0);
  const next = source.indexOf('\nasync function', start + 1);
  const body = source.slice(start, next < 0 ? source.length : next);
  assert.ok(!body.includes('if (state.busy) return'), '首次空间页激活不得因 busy 提前返回');
  assert.ok(source.includes("if (route.name === 'home') void activateHome(space, routeToken);"));

  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const text of ['不提供短信/邮箱验证', '忘记密码可能无法恢复', '创建空间', '使用邀请码加入']) {
    assert.ok(html.includes(text), `页面缺少：${text}`);
  }
  assert.ok(html.includes('id="spaces-retry"'));
  assert.ok(html.includes('id="spaces-loading"'));
});

test('H2 邀请管理可见性回归：负责人可见，普通成员不可见（页面与接口同源）', async () => {
  assert.equal(collectVisible('owner'), true);
  assert.equal(collectVisible('member'), false);

  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function activateCollect');
  assert.ok(start >= 0);
  const end = source.indexOf('\nasync function', start + 1);
  const body = source.slice(start, end < 0 ? source.length : end);
  assert.ok(body.includes('if (!collectVisible(space.role))'));
  assert.ok(body.includes('ui.collectDenied.hidden = false'));
  assert.ok(body.includes('ui.collectContent.hidden = true'));

  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="collect-denied"[^>]*hidden/);
  assert.match(html, /id="collect-content"[^>]*hidden/);
});

test('H3 昵称与登录账号文案：注册页独立昵称字段、登录账号唯一提示', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="register-nickname"/);
  assert.ok(html.includes('可重复，不必填写真实姓名。'));
  assert.ok(html.includes('不能与其他账号重复。'));

  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes('registerNickname'));
  assert.ok(source.includes("JSON.stringify({ username, nickname, password, noticeAccepted: true })"));
  assert.ok(source.includes('const nickname = state.user?.nickname || username;'));
  assert.ok(source.includes('ui.accountName.textContent = nickname'));
});

test('H4 昵称展示：缺失回退登录账号，特殊字符按纯文本写入', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function showApp()');
  assert.ok(start >= 0);
  const end = source.indexOf('\nfunction ', start + 1);
  const body = source.slice(start, end < 0 ? source.length : end);
  assert.ok(body.includes('ui.accountName.textContent'), '昵称必须通过 textContent 写入');
  assert.ok(!body.includes('innerHTML'), '昵称不得通过 innerHTML 写入');
  const show = new Function('ui', 'state', 'setChip', 'setAccountMenu', `${body}\nshowApp();`);

  const accountName = { textContent: '' };
  let htmlWrites = 0;
  Object.defineProperty(accountName, 'innerHTML', { set() { htmlWrites += 1; } });
  const ui = {
    authPanel: { hidden: true }, appPanel: { hidden: true }, accountWrap: { hidden: true },
    accountButton: { setAttribute() {} }, accountName, chip: { hidden: false },
  };
  const state = { user: { username: 'legacy_user_1', nickname: null } };

  show(ui, state, () => {}, () => {});
  assert.equal(ui.appPanel.hidden, false);
  assert.equal(accountName.textContent, 'legacy_user_1');

  const raw = '<img src=x onerror="alert(1)"><b>纯文本</b>';
  state.user = { username: 'nick_user_1', nickname: raw };
  show(ui, state, () => {}, () => {});
  assert.equal(accountName.textContent, raw);
  assert.equal(htmlWrites, 0);
});

test('I S0 探针契约保留：seed 路由不存在，健康检查与匿名拒绝仍成立', async () => {
  const { handle } = fixture();
  assert.deepEqual((await call(handle, ctx('/api/health'))).body, { ok: true });
  assert.equal((await call(handle, ctx('/api/seed', { method: 'POST' }))).status, 404);
  assert.equal((await call(handle, ctx('/api/spaces'))).status, 401);
  assert.equal((await call(handle, ctx('/api/notice'))).body.version, NOTICE_VERSION);
  assert.ok((await call(handle, ctx('/api/notice'))).body.text.includes(NOTICE_TEXT.slice(0, 12)));
});

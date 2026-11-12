// 本地契约检查：直接调用真实 router/http/passwords/sessions/limiter/validate 模块，
// 只把数据层替换为内存假数据库。不证明真实 Provider、网关准入或部署环境行为。
//   node --test dev/check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApplication } from '../functions/router.mjs';
import { PBKDF2_ITERATIONS, hashPassword } from '../functions/passwords.mjs';
import { SESSION_COOKIE, sha256Hex } from '../functions/sessions.mjs';
import { LIMITS } from '../functions/limiter.mjs';
import { createFakeDb } from './fake-db.mjs';

const PUBLIC_ORIGIN = 'https://s0.test';
// 每次运行生成的临时口令，只存在于内存中，不在任何输出中打印。
const PASSWORDS = {
  owner_o: `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  member_a: `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  member_b: `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`,
};

function fixture() {
  const control = { writes: [] };
  const db = createFakeDb(control);
  const handle = createApplication({ db, origin: PUBLIC_ORIGIN });
  return { control, db, handle };
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
    requestId: 'local-check',
  };
}

async function call(handle, context) {
  const response = await handle(context);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return {
    status: response.status,
    body,
    text,
    setCookie: response.headers.get('set-cookie'),
    headers: response.headers,
  };
}

function cookiePair(result) {
  const header = result.setCookie;
  if (!header) return null;
  return header.split(';')[0];
}

function seedData() {
  const ids = {
    x: crypto.randomUUID(),
    y: crypto.randomUUID(),
    aX: crypto.randomUUID(),
    bX: crypto.randomUUID(),
    aY: crypto.randomUUID(),
  };
  const body = {
    users: [
      { username: 'owner_o', password: PASSWORDS.owner_o, fullName: '测试负责人' },
      { username: 'member_a', password: PASSWORDS.member_a, fullName: '测试成员甲' },
      { username: 'member_b', password: PASSWORDS.member_b, fullName: '测试成员乙' },
    ],
    spaces: [
      { id: ids.x, name: '测试空间 X', mode: 'courses', owner: 'owner_o', members: ['owner_o', 'member_a', 'member_b'] },
      { id: ids.y, name: '测试空间 Y', mode: 'presence', owner: 'member_a', members: ['member_a', 'owner_o'] },
    ],
    schedules: [
      {
        id: ids.aX, spaceId: ids.x, member: 'member_a', version: 1,
        entries: [
          { day: 1, period: 1, hasClass: true, courseName: '测试课程甲' },
          { day: 1, period: 2, hasClass: false, courseName: null },
        ],
      },
      {
        id: ids.bX, spaceId: ids.x, member: 'member_b', version: 1,
        entries: [{ day: 1, period: 1, hasClass: false, courseName: null }],
      },
      {
        id: ids.aY, spaceId: ids.y, member: 'member_a', version: 1,
        entries: [{ day: 2, period: 2, hasClass: true, courseName: null }],
      },
    ],
  };
  return { ids, body };
}

async function seeded() {
  const { control, db, handle } = fixture();
  const data = seedData();
  const now = new Date().toISOString();
  const userIds = {};

  for (const user of data.body.users) {
    const id = crypto.randomUUID();
    const password = await hashPassword(user.password);
    await db.from('users').insertIfAbsent({
      id,
      username: user.username,
      full_name: user.fullName,
      password_salt: password.salt,
      password_hash: password.hash,
      password_iterations: password.iterations,
      created_at: now,
    }, { onConflict: 'username' });
    userIds[user.username] = id;
  }

  for (const space of data.body.spaces) {
    await db.from('spaces').insertIfAbsent({
      id: space.id,
      owner_id: userIds[space.owner],
      name: space.name,
      mode: space.mode,
      created_at: now,
    }, { onConflict: 'id' });
    for (const member of space.members) {
      await db.from('memberships').insertIfAbsent({
        space_id: space.id,
        user_id: userIds[member],
      }, { onConflict: 'space_id,user_id' });
    }
  }

  for (const schedule of data.body.schedules) {
    await db.from('schedules').insertIfAbsent({
      id: schedule.id,
      space_id: schedule.spaceId,
      member_id: userIds[schedule.member],
      entries: schedule.entries,
      version: schedule.version,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' });
  }

  return { control, db, handle, ids: { ...data.ids, ...userIds } };
}

const login = (handle, username, password = PASSWORDS[username]) => call(handle,
  ctx('/api/login', { method: 'POST', body: { username, password } }));

async function loginOk(handle, username) {
  const response = await login(handle, username);
  assert.equal(response.status, 200);
  return cookiePair(response);
}

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value && typeof value === 'object') {
    return Object.keys(value).includes(key) || Object.values(value).some((item) => hasKey(item, key));
  }
  return false;
}

test('T01 预备：健康检查可用，未登录不能读取空间，前端不内嵌数据库凭据', async () => {
  const { handle, ids } = await seeded();
  const health = await call(handle, ctx('/api/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });

  const noSession = await call(handle, ctx(`/api/spaces/${ids.x}/overview`));
  assert.equal(noSession.status, 401);

  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  for (const banned of ['service_role', 'SUPABASE', 'DATABASE_URL', 'postgres://', 'password_hash', 'password_salt']) {
    assert.ok(!source.includes(banned), `前端不得包含 ${banned}`);
  }
});

test('T02 登录：PBKDF2 派生、会话 Cookie 标志与退出撤销', async () => {
  const { db, handle } = await seeded();
  const response = await login(handle, 'member_a');
  assert.equal(response.status, 200);
  assert.equal(response.body.user.username, 'member_a');
  // S1 契约变更：账号资料不再返回 fullName；空间内姓名按空间单独保存。
  assert.equal('fullName' in response.body.user, false);

  const header = response.setCookie ?? '';
  assert.ok(header.startsWith(`${SESSION_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.ok(!/Domain=/i.test(header));

  const cookie = cookiePair(response);
  const me = await call(handle, ctx('/api/me', { cookie }));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'member_a');

  const wrong = await login(handle, 'member_a', `${PASSWORDS.member_a}-wrong`);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: 'invalid_credentials' });

  const ghost = await login(handle, `ghost_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`, PASSWORDS.member_a);
  assert.equal(ghost.status, 401);
  assert.deepEqual(ghost.body, { error: 'invalid_credentials' });

  const users = db.dump('users');
  assert.equal(users.length, 3);
  const stored = JSON.stringify([...users, ...db.dump('sessions'), ...db.dump('auth_limiter')]);
  for (const password of Object.values(PASSWORDS)) assert.ok(!stored.includes(password), '数据库不得出现明文口令');
  const memberA = users.find((user) => user.username === 'member_a');
  assert.equal(memberA.password_iterations, PBKDF2_ITERATIONS);
  assert.notEqual(memberA.password_hash, PASSWORDS.member_a);
  assert.ok(memberA.password_salt.length > 0);

  const token = cookie.slice(SESSION_COOKIE.length + 1);
  assert.ok(!JSON.stringify(db.dump('sessions')).includes(token), '会话表不得保存明文令牌');
  assert.equal(db.dump('sessions')[0].token_digest, await sha256Hex(token));

  const logout = await call(handle, ctx('/api/logout', { method: 'POST', cookie }));
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie ?? '', /Max-Age=0/);
  assert.equal((await call(handle, ctx('/api/me', { cookie }))).status, 401);
});

test('T03 对象级授权：B 不能读 Y，A/B/O 不能越权写他人', async () => {
  const { handle, ids } = await seeded();
  const ownerCookie = await loginOk(handle, 'owner_o');
  const aCookie = await loginOk(handle, 'member_a');
  const bCookie = await loginOk(handle, 'member_b');

  const bX = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: bCookie }));
  assert.equal(bX.status, 200);
  assert.equal(bX.body.space.role, 'member');
  assert.ok(bX.body.entries.every((entry) => !('courseName' in entry)));
  assert.ok(bX.body.entries.some((entry) => entry.maskedName === '测***甲' && entry.hasClass === true));
  assert.ok(bX.body.entries.some((entry) => entry.isSelf === true && entry.maskedName === '测***乙'));

  const bY = await call(handle, ctx(`/api/spaces/${ids.y}/overview`, { cookie: bCookie }));
  assert.equal(bY.status, 403);
  assert.deepEqual(bY.body, { error: 'forbidden' });

  const noSession = await call(handle, ctx(`/api/spaces/${ids.x}/overview`));
  assert.equal(noSession.status, 401);

  const aOwn = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST',
    cookie: aCookie,
    body: {
      memberId: ids.member_a,
      version: 1,
      entries: [
        { day: 1, period: 1, hasClass: true, courseName: '测试课程甲-授权' },
        { day: 1, period: 2, hasClass: false, courseName: null },
      ],
    },
  }));
  assert.equal(aOwn.status, 200);
  assert.equal(aOwn.body.version, 2);

  const forbiddenBody = {
    memberId: ids.member_a,
    version: 2,
    entries: [{ day: 1, period: 1, hasClass: false, courseName: null }],
  };
  const ownerWritesA = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST', cookie: ownerCookie, body: forbiddenBody,
  }));
  assert.equal(ownerWritesA.status, 403);

  const bWritesA = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST', cookie: bCookie, body: forbiddenBody,
  }));
  assert.equal(bWritesA.status, 403);

  const aWritesB = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST',
    cookie: aCookie,
    body: { memberId: ids.member_b, version: 1, entries: [{ day: 1, period: 1, hasClass: true, courseName: '越权' }] },
  }));
  assert.equal(aWritesB.status, 403);

  const spoofed = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, {
    cookie: bCookie,
    headers: { 'x-user-id': ids.member_a, 'x-role': 'owner' },
  }));
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.body.space.role, 'member');
  assert.ok(spoofed.body.entries.every((entry) => !('courseName' in entry)));

  const ownerX = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: ownerCookie }));
  assert.equal(ownerX.status, 200);
  assert.equal(ownerX.body.space.role, 'owner');
  assert.ok(ownerX.body.entries.some((entry) => entry.memberName === '测试成员甲' && entry.courseName === '测试课程甲-授权'));

  const ownerY = await call(handle, ctx(`/api/spaces/${ids.y}/overview`, { cookie: ownerCookie }));
  assert.equal(ownerY.status, 200);
  assert.equal(ownerY.body.space.role, 'member');
  assert.ok(ownerY.body.entries.every((entry) => !('courseName' in entry)));
  assert.ok(ownerY.body.entries.some((entry) => entry.maskedName === '测***甲'));
});

test('T04 字段裁剪：B 不含他人全名/课程名/口令列；O 在自有空间可见', async () => {
  const { handle, ids } = await seeded();
  const bCookie = await loginOk(handle, 'member_b');
  const bX = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: bCookie }));
  assert.equal(bX.status, 200);
  assert.ok(!bX.text.includes('测试成员甲'));
  assert.ok(!bX.text.includes('测试课程甲'));
  assert.ok(!bX.text.includes('password_hash'));
  assert.ok(!bX.text.includes('password_salt'));
  assert.ok(!bX.text.includes('service_role'));
  assert.ok(!bX.text.includes('SUPABASE'));
  assert.ok(!hasKey(bX.body, 'courseName'));
  assert.ok(bX.text.includes('测***甲'));

  const bY = await call(handle, ctx(`/api/spaces/${ids.y}/overview`, { cookie: bCookie }));
  assert.equal(bY.status, 403);
  assert.ok(!bY.text.includes('测试成员甲'));
  assert.ok(!bY.text.includes('测试课程丙'));

  const ownerCookie = await loginOk(handle, 'owner_o');
  const ownerX = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: ownerCookie }));
  assert.equal(ownerX.status, 200);
  assert.ok(ownerX.text.includes('测试成员甲'));
  assert.ok(ownerX.text.includes('测试课程甲'));
  assert.ok(!ownerX.text.includes('password_hash'));
  assert.ok(!ownerX.text.includes('password_salt'));
});

test('T05 跨会话共享：A 写入后 B 读取，重新登录仍在', async () => {
  const { handle, ids } = await seeded();
  const a1 = await loginOk(handle, 'member_a');
  const a2 = await loginOk(handle, 'member_a');
  const b1 = await loginOk(handle, 'member_b');

  const update = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST',
    cookie: a1,
    body: {
      version: 1,
      entries: [
        { day: 1, period: 1, hasClass: true, courseName: '测试课程甲-共享' },
        { day: 1, period: 2, hasClass: false, courseName: null },
      ],
    },
  }));
  assert.equal(update.status, 200);
  assert.equal(update.body.version, 2);

  const bView = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: b1 }));
  assert.equal(bView.status, 200);
  const period1 = bView.body.entries.find((entry) => entry.maskedName === '测***甲' && entry.period === 1);
  const period2 = bView.body.entries.find((entry) => entry.maskedName === '测***甲' && entry.period === 2);
  assert.equal(period1.hasClass, true);
  assert.equal(period2.hasClass, false);
  assert.ok(!('courseName' in period1));

  const own = await call(handle, ctx(`/api/spaces/${ids.x}/my-schedule`, { cookie: a2 }));
  assert.equal(own.status, 200);
  assert.equal(own.body.schedule.version, 2);
  assert.equal(own.body.schedule.entries.find((entry) => entry.period === 1).courseName, '测试课程甲-共享');

  const a3 = await loginOk(handle, 'member_a');
  const afterRelogin = await call(handle, ctx(`/api/spaces/${ids.x}/my-schedule`, { cookie: a3 }));
  assert.equal(afterRelogin.status, 200);
  assert.equal(afterRelogin.body.schedule.version, 2);
  assert.equal(afterRelogin.body.schedule.entries.find((entry) => entry.period === 1).courseName, '测试课程甲-共享');

  const b2 = await loginOk(handle, 'member_b');
  const bAfterRelogin = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, { cookie: b2 }));
  assert.equal(bAfterRelogin.status, 200);
  assert.equal(bAfterRelogin.body.entries.find((entry) => entry.maskedName === '测***甲' && entry.period === 2).hasClass, false);
  assert.ok(!hasKey(bAfterRelogin.body, 'courseName'));
});

test('T06 一致性：唯一约束、版本 CAS 并发一胜一冲突、多格原子替换', async () => {
  const { db, handle, ids } = await seeded();
  const a1 = await loginOk(handle, 'member_a');
  const a2 = await loginOk(handle, 'member_a');

  const duplicate = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST',
    cookie: a1,
    body: { version: 0, entries: [{ day: 1, period: 1, hasClass: true, courseName: '测试课程甲-重复' }] },
  }));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'version_conflict');
  assert.equal(db.dump('schedules').filter((row) => row.space_id === ids.x && row.member_id === ids.member_a).length, 1);

  const entries1 = [
    { day: 1, period: 1, hasClass: true, courseName: '测试课程甲-并发一' },
    { day: 1, period: 2, hasClass: false, courseName: null },
  ];
  const entries2 = [
    { day: 1, period: 1, hasClass: false, courseName: null },
    { day: 1, period: 2, hasClass: true, courseName: '测试课程甲-并发二' },
  ];
  const [first, second] = await Promise.all([
    call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
      method: 'POST', cookie: a1, body: { version: 1, entries: entries1 },
    })),
    call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
      method: 'POST', cookie: a2, body: { version: 1, entries: entries2 },
    })),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);

  const winnerEntries = first.status === 200 ? entries1 : entries2;
  const loserEntries = first.status === 200 ? entries2 : entries1;
  const finalRows = db.dump('schedules').filter((row) => row.space_id === ids.x && row.member_id === ids.member_a);
  assert.equal(finalRows.length, 1, '同一成员在同一空间只能有一份整表文档');
  assert.equal(finalRows[0].version, 2);
  assert.deepEqual(finalRows[0].entries, winnerEntries);
  assert.notDeepEqual(finalRows[0].entries, loserEntries);
});

test('T07 CSRF：跨来源或缺少 Origin 的写请求被拒绝，会话不受影响', async () => {
  const { handle, ids } = await seeded();
  const aCookie = await loginOk(handle, 'member_a');
  const body = { version: 1, entries: [{ day: 1, period: 1, hasClass: false, courseName: null }] };

  const foreign = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST', cookie: aCookie, origin: 'https://evil.test', body,
  }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, 'origin_forbidden');
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  const noOrigin = await call(handle, ctx(`/api/spaces/${ids.x}/submissions`, {
    method: 'POST', cookie: aCookie, origin: null, body,
  }));
  assert.equal(noOrigin.status, 403);

  const foreignLogout = await call(handle, ctx('/api/logout', {
    method: 'POST', cookie: aCookie, origin: 'https://evil.test',
  }));
  assert.equal(foreignLogout.status, 403);
  assert.equal((await call(handle, ctx('/api/me', { cookie: aCookie }))).status, 200);

  const readNoOrigin = await call(handle, ctx(`/api/spaces/${ids.x}/overview`, {
    cookie: aCookie, origin: null,
  }));
  assert.equal(readNoOrigin.status, 200);
});

test('T08 限流：低阈值数据库计数，第 4 次登录返回 429', async () => {
  const { db, handle } = await seeded();
  const ghost = `ghost_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const statuses = [];
  for (let index = 0; index < LIMITS.login.maxAttempts; index += 1) {
    statuses.push((await login(handle, ghost, PASSWORDS.member_a)).status);
  }
  assert.deepEqual(statuses, Array(LIMITS.login.maxAttempts).fill(401));
  const blocked = await login(handle, ghost, PASSWORDS.member_a);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const bucket = db.dump('auth_limiter').find((row) => row.key === `login:${ghost}`);
  assert.equal(bucket.attempt_count, LIMITS.login.maxAttempts);
});

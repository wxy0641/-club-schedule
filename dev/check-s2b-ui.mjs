// S2b 浏览器检查：路由外壳、深链与登录目标、成员权限、月历告知与例外、
// 离开保护、旧响应隔离、移动导航与按钮实测。仅在装有 Edge/Chrome 的开发机运行；
// 使用本地预览与内存假数据库，不代表部署环境或真实 Provider 权限。
//   node dev/check-s2b-ui.mjs   （需要先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8787/';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const PASSWORD = `local-s2b-${randomUUID()}-${randomUUID()}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(fn, { timeout = 10000, interval = 60 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw lastError ?? new Error('waitFor timeout');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') {
          const detail = message.params?.exceptionDetails;
          this.pageErrors.push(detail?.exception?.description ?? detail?.text ?? 'exception');
        } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
          this.pageErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'evaluation failed';
      throw new Error(text);
    }
    return result.result.value;
  }
}

async function pageVisible(cdp, name) {
  return waitFor(() => cdp.evaluate(`document.getElementById('page-${name}').hidden === false`));
}

async function waitSpaceHome(cdp) {
  await pageVisible(cdp, 'home');
  await waitFor(() => cdp.evaluate("!document.getElementById('home-content').hidden"));
}

async function waitCalendar(cdp) {
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate(`!document.getElementById('calendar-table').hidden
    || !document.getElementById('calendar-empty').hidden`));
}

async function waitCalendarData(cdp) {
  const text = await cdp.evaluate("document.getElementById('calendar-month').textContent");
  const matched = /(\d{4}) 年 (\d+) 月/.exec(text);
  if (!matched) throw new Error(`月份未就绪：${text}`);
  const prefix = `${matched[1]}-${String(Number(matched[2])).padStart(2, '0')}`;
  await waitFor(() => cdp.evaluate(`(() => {
    const cell = document.querySelector('#calendar-grid .cal-cell[data-date]');
    return !!cell && cell.dataset.date.startsWith(${JSON.stringify(prefix)})
      && document.getElementById('calendar-skeleton').hidden;
  })()`));
}

async function hashPath(cdp) {
  return cdp.evaluate('location.hash');
}

async function spaceIdFromHash(cdp) {
  const hash = await hashPath(cdp);
  const matched = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(hash);
  return matched?.[0] ?? null;
}

async function setHash(cdp, hash) {
  await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`);
}

async function fill(cdp, pairs) {
  const entries = Object.entries(pairs);
  const script = entries.map(([id, value]) => {
    const input = `document.getElementById(${JSON.stringify(id)})`;
    return `${input}.value = ${JSON.stringify(value)};
      ${input}.dispatchEvent(new Event('input', { bubbles: true }));
      ${input}.dispatchEvent(new Event('change', { bubbles: true }));`;
  }).join('\n');
  await cdp.evaluate(`(() => { ${script} return true; })()`);
}

async function registerUi(cdp, username, nickname) {
  await cdp.evaluate(`(() => {
    document.getElementById('auth-tab-register').click();
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('register-username', ${JSON.stringify(username)});
    set('register-nickname', ${JSON.stringify(nickname)});
    set('register-password', ${JSON.stringify(PASSWORD)});
    set('register-confirm', ${JSON.stringify(PASSWORD)});
    document.getElementById('register-notice').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('register-submit').disabled"));
  await cdp.evaluate("document.getElementById('register-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"));
}

async function loginUi(cdp, username) {
  await cdp.evaluate(`(() => {
    document.getElementById('auth-tab-login').click();
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('login-username', ${JSON.stringify(username)});
    set('login-password', ${JSON.stringify(PASSWORD)});
    const terms = document.getElementById('login-terms');
    if (terms && !terms.checked) terms.click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('login-submit').disabled"));
  await cdp.evaluate("document.getElementById('login-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden || document.getElementById('consent-dialog').open"), { timeout: 15000 });
  await dismissConsentGate(cdp);
}

async function dismissConsentGate(cdp) {
  try {
    await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 1200 });
  } catch {
    return false;
  }
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  return true;
}

async function logoutUi(cdp) {
  await cdp.evaluate("document.getElementById('logout').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden && document.getElementById('app-panel').hidden"));
}

async function api(cdp, path, init = {}) {
  return cdp.evaluate(`(async () => {
    const response = await fetch('/functions/v1/app' + ${JSON.stringify(path)}, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ${init.method ? `method: ${JSON.stringify(init.method)},` : ''}
      ${init.body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(init.body))},`}
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  })()`);
}

async function navLabels(cdp) {
  return cdp.evaluate("[...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent)");
}

async function visiblePageNames(cdp) {
  return cdp.evaluate("[...document.querySelectorAll('.page')].filter((section) => !section.hidden).map((section) => section.id)");
}

async function settleSpaceConsent(cdp, spaceId) {
  const notice = await api(cdp, '/api/notice');
  const calendar = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: notice.body?.calendar?.version },
  });
  const share = await api(cdp, `/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST',
    body: { action: 'decline', noticeVersion: notice.body?.share?.version },
  });
  return { calendar: calendar.status, share: share.status };
}

async function setupOwner(cdp) {
  const username = `own_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  await registerUi(cdp, username, '负责人');
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("!document.getElementById('spaces-empty').hidden"));

  await cdp.evaluate("document.getElementById('open-create').click()");
  await pageVisible(cdp, 'create');
  const createPath = await hashPath(cdp);
  const blankPreview = await cdp.evaluate("document.getElementById('create-teaching-preview').textContent");
  await fill(cdp, {
    'create-name': '路由空间 A',
    'create-owner-name': '负责人甲',
    'create-timezone': 'Asia/Shanghai',
    'create-anchor': '2026-09-07',
    'create-term-start': '2026-09-07',
    'create-term-end': '2027-01-24',
  });
  await cdp.evaluate("document.querySelector('input[name=\"create-mode\"][value=\"courses\"]').click()");
  await cdp.evaluate("document.querySelector('input[name=\"create-visibility\"][value=\"masked_list\"]').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('create-submit').disabled"));
  const preview = await cdp.evaluate("document.getElementById('create-teaching-preview').textContent");
  await cdp.evaluate("document.getElementById('create-submit').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  await waitSpaceHome(cdp);
  const spaceA = await spaceIdFromHash(cdp);

  const createdB = await cdp.evaluate(`(async () => {
    const response = await fetch('/functions/v1/app/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '路由空间 B', ownerName: '负责人甲', mode: 'presence',
        oddEvenEnabled: false, visibility: 'stats',
        periods: [{ index: 1, start: '08:00', end: '08:45' }],
        teaching: {
          timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
          termStart: '2026-09-07', termEnd: '2027-01-24',
        },
      }),
    });
    const body = await response.json();
    return { status: response.status, id: body?.space?.id ?? null };
  })()`);
  const requestId = `s2bui_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const published = await api(cdp, `/api/spaces/${spaceA}/schedule/publish`, {
    method: 'POST',
    body: {
      requestId,
      baseRevision: 0,
      entries: [{ day: 1, period: 1, weekRule: 'every', courseName: '跨学科工程实践与创新设计基础（长名称）' }],
    },
  });

  return {
    username, spaceA, spaceB: createdB.id, createPath, blankPreview, preview,
    createdB: createdB.status, published: published.status,
  };
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const setup = await setupOwner(cdp);
  check('新建空间：独立创建页要求完整教学设置，提交后进入空间首页',
    setup.createPath === '#/spaces/new'
      && setup.blankPreview.includes('请显式选择')
      && setup.preview.includes('教学周')
      && Boolean(setup.spaceA) && setup.published === 201,
    JSON.stringify({ path: setup.createPath, blank: setup.blankPreview, published: setup.published }));
  check('新建第二个空间用于切换', setup.createdB === 201 && Boolean(setup.spaceB), JSON.stringify({ status: setup.createdB }));

  const ownerConsentA = await settleSpaceConsent(cdp, setup.spaceA);
  const ownerConsentB = await settleSpaceConsent(cdp, setup.spaceB);
  check('负责人告知与可选共享集中记录（测试前置，不算产品通过）',
    ownerConsentA.calendar === 200 && ownerConsentB.calendar === 200
      && ownerConsentA.share === 200 && ownerConsentB.share === 200,
    JSON.stringify({ ownerConsentA, ownerConsentB }));

  // 我的空间：只显示卡片与账号摘要，不带空间功能导航
  await cdp.evaluate("document.getElementById('side-spaces-link').click()");
  await pageVisible(cdp, 'spaces');
  await cdp.evaluate("document.getElementById('reload').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.space-button').length >= 2"));
  const spacesShell = await cdp.evaluate(`(() => ({
    sideSpaceHidden: document.getElementById('side-space').hidden,
    sideLinks: document.querySelectorAll('#side-space-links .side-link').length,
    crumbAbsent: document.querySelector('.crumb') === null,
    createPageHidden: document.getElementById('page-create').hidden,
    joinPageHidden: document.getElementById('page-join').hidden,
    account: document.getElementById('account-name').textContent.trim(),
  }))()`);
  check('我的空间：只有空间列表与创建/加入入口，账号只在顶栏',
    spacesShell.sideSpaceHidden && spacesShell.sideLinks === 0 && spacesShell.crumbAbsent
      && spacesShell.createPageHidden && spacesShell.joinPageHidden && spacesShell.account.length > 0,
    JSON.stringify(spacesShell));

  await cdp.evaluate("[...document.querySelectorAll('.space-button')].find((button) => button.textContent.includes('路由空间 A')).click()");
  await waitSpaceHome(cdp);
  const homeShell = await cdp.evaluate(`(() => ({
    title: document.getElementById('space-title').textContent,
    role: document.getElementById('space-role').textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
    stats: document.querySelectorAll('#home-status-grid .stat').length,
    collect: [...document.querySelectorAll('#home-status-grid .stat')].some((card) => card.textContent.includes('收集进度')),
    actions: [...document.querySelectorAll('#page-home button')].filter((button) => button.offsetParent !== null).map((button) => button.textContent),
    pageCount: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).length,
  }))()`);
  check('空间首页：名称、本人角色、少量状态与功能入口；负责人有收集入口',
    homeShell.title === '路由空间 A' && homeShell.role.includes('负责人')
      && homeShell.nav.includes('我的课表') && homeShell.nav.includes('我的日历')
      && homeShell.nav.includes('课表收集') && homeShell.stats >= 3 && homeShell.collect
      && homeShell.actions.length === 0 && homeShell.pageCount === 1,
    JSON.stringify(homeShell));

  const noAllMemberShell = await cdp.evaluate(`(() => {
    const text = document.getElementById('app-panel').textContent;
    return { all: /全员|可用性|活动发布|参与者申请/.test(text),
      pages: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).length };
  })()`);
  check('未出现全员可用性或活动空壳页面', !noAllMemberShell.all && noAllMemberShell.pages === 1, JSON.stringify(noAllMemberShell));

  // 深链刷新与路由
  await cdp.evaluate('location.reload()').catch(() => {});
  await waitSpaceHome(cdp);
  const reloadedTitle = await cdp.evaluate("document.getElementById('space-title').textContent");
  check('深链刷新：空间首页刷新后仍停留在该空间', reloadedTitle === '路由空间 A', reloadedTitle);

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/schedule\"]').click()");
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  const scheduleRoute = await cdp.evaluate(`(() => ({
    hash: location.hash,
    active: document.querySelector('#side-space-links .side-link[aria-current="page"]')?.textContent,
    crumbAbsent: document.querySelector('.crumb') === null,
    title: document.title,
  }))()`);
  check('路由：我的课表可定位，侧栏高亮同步且不重复面包屑',
    scheduleRoute.hash.endsWith('/schedule') && scheduleRoute.active === '我的课表'
      && scheduleRoute.crumbAbsent && scheduleRoute.title.includes('我的课表'),
    JSON.stringify(scheduleRoute));

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/calendar\"]').click()");
  await waitCalendar(cdp);
  const calendarRoute = await hashPath(cdp);
  check('路由：我的日历可定位并加载', calendarRoute.endsWith('/calendar'), calendarRoute);

  await cdp.evaluate('history.back()');
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("location.hash.endsWith('/schedule')"));
  const backHash = await hashPath(cdp);
  await cdp.evaluate('history.forward()');
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("location.hash.endsWith('/calendar')"));
  const forwardHash = await hashPath(cdp);
  check('前进/后退：在同空间页面间恢复路由与页面', backHash.endsWith('/schedule') && forwardHash.endsWith('/calendar'),
    JSON.stringify({ backHash, forwardHash }));

  await setHash(cdp, '#/oops');
  await pageVisible(cdp, 'notfound');
  const notfound = await cdp.evaluate("document.getElementById('page-notfound').textContent");
  check('未知路由：显示页面不存在，不显示空间数据', notfound.includes('页面不存在') && notfound.includes('返回空间'), notfound);
  await cdp.evaluate("document.querySelector('#page-notfound a[href=\"#/spaces\"]').click()");
  await pageVisible(cdp, 'spaces');

  const wrongSpace = randomUUID();
  await setHash(cdp, `#/spaces/${wrongSpace}/calendar`);
  await pageVisible(cdp, 'error');
  const routeError = await cdp.evaluate("document.getElementById('route-error-text').textContent");
  check('非法空间深链：显示错误页，不加载缓存内容', routeError.includes('找不到该空间'), routeError);
  await cdp.evaluate("document.getElementById('route-error-back').click()");
  await pageVisible(cdp, 'spaces');

  await setHash(cdp, `#/spaces/${setup.spaceB}`);
  await waitSpaceHome(cdp);
  const switched = await cdp.evaluate(`(() => ({
    title: document.getElementById('space-title').textContent,
    role: document.getElementById('space-role').textContent,
    active: document.querySelector('#side-space-links .side-link[aria-current="page"]')?.textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
  }))()`);
  check('切换空间：标题、角色、导航与首页数据随之更新',
    switched.title === '路由空间 B' && switched.role.includes('负责人')
      && switched.active === '首页' && switched.nav.includes('我的课表'), JSON.stringify(switched));
  await setHash(cdp, `#/spaces/${setup.spaceA}`);
  await waitSpaceHome(cdp);

  // 继续编辑的离开保护
  await setHash(cdp, `#/spaces/${setup.spaceA}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  await waitFor(() => cdp.evaluate("!document.body.classList.contains('is-busy')"));
  await sleep(150);
  await cdp.evaluate(`(async () => {
    const cell = document.querySelector('.week-cell[data-day="2"][data-period="2"]');
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    cell.click();
    return true;
  })()`);
  try {
    await waitFor(() => cdp.evaluate("!document.getElementById('cell-editor').hidden"));
  } catch (error) {
    console.log('DEBUG editor', JSON.stringify(await cdp.evaluate(`(() => {
      const cell = document.querySelector('.week-cell[data-day="2"][data-period="2"]');
      const rect = cell.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        consentOpen: document.getElementById('consent-dialog').open,
        busy: document.body.classList.contains('is-busy'),
        hit: hit?.className ?? null,
        cellVisible: rect.width > 0 && rect.height > 0,
        editorHidden: document.getElementById('cell-editor').hidden,
        page: [...document.querySelectorAll('.page')].filter((item) => !item.hidden).map((item) => item.id),
      };
    })()`)));
    throw error;
  }
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cell-every-name');
    input.value = '离开保护课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('cell-apply').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('schedule-discard').hidden"));
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/calendar\"]').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"));
  const leavePrompt = await cdp.evaluate("document.getElementById('leave-text').textContent");
  await cdp.evaluate("document.getElementById('leave-stay').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('leave-dialog').open"));
  const stayed = await cdp.evaluate(`(() => ({
    page: document.getElementById('page-schedule').hidden,
    title: document.getElementById('cell-title').textContent,
    dirty: !document.getElementById('schedule-discard').hidden,
  }))()`);
  check('离开保护：有未保存修改时选择留下，仍在本页且修改保留',
    leavePrompt.includes('未保存') && !stayed.page && stayed.dirty && stayed.title.includes('第2节'),
    JSON.stringify({ leavePrompt, stayed }));

  await sleep(250);
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/calendar\"]').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"));
  await cdp.evaluate("document.getElementById('leave-save').click()");
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("!document.getElementById('page-calendar').hidden"));
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open === false"));
  const draft = await api(cdp, `/api/spaces/${setup.spaceA}/schedule`);
  const draftCourse = (draft.body?.schedule?.draftEntries ?? []).some((entry) => entry.courseName === '离开保护课程');
  const publishedCourse = (draft.body?.schedule?.publishedEntries ?? []).some((entry) => entry.courseName === '离开保护课程');
  check('离开保护：保存草稿后离开，草稿写入但不自动发布',
    draft.status === 200 && draftCourse && !publishedCourse, JSON.stringify({ status: draft.status, draftCourse, publishedCourse }));

  // 月历：桌面七列、真实日期、今天与选中、学期外、按钮尺寸
  const desktopCalendar = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#calendar-grid .cal-row')];
    const allCells = rows.flatMap((row) => [...row.children]);
    const actual = allCells.filter((cell) => cell.dataset?.date);
    const weekdays = document.getElementById('calendar-table')
      .querySelector('.calendar-weekdays').children.length;
    const buttons = [...document.querySelectorAll('#page-calendar button, #page-calendar .button-link')]
      .filter((button) => !button.classList.contains('cal-cell') && button.offsetParent !== null && button.textContent.trim())
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent.trim(), h: rect.height, w: rect.width,
          fontSize: style.fontSize, minHeight: style.minHeight,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' '),
        };
      });
    return {
      rows: rows.length, perRow: rows.every((row) => row.children.length === 7), weekdays,
      actual: actual.length, fillers: allCells.length - actual.length,
      month: document.getElementById('calendar-month').textContent,
      term: document.getElementById('calendar-term').textContent,
      legend: document.querySelectorAll('#calendar-legend li').length,
      today: document.querySelectorAll('.cal-cell.is-today').length,
      buttons,
    };
  })()`);
  check('桌面月历：七列、真实日期、教学周与状态图例',
    desktopCalendar.rows > 0 && desktopCalendar.perRow && desktopCalendar.weekdays === 7
      && desktopCalendar.actual >= 28 && desktopCalendar.fillers >= 0 && desktopCalendar.legend === 8
      && desktopCalendar.month.includes('年') && desktopCalendar.term !== '',
    JSON.stringify({ ...desktopCalendar, buttons: desktopCalendar.buttons.length }));
  const desktopHeights = desktopCalendar.buttons.map((item) => item.h);
  const desktopWidths = new Set(desktopCalendar.buttons.map((item) => Math.round(item.w)));
  const detailActions = desktopCalendar.buttons
    .filter((item) => ['忙碌', '有空', '有课'].includes(item.text));
  check('桌面月历：导航按钮 36–40px，详情动作不小于 44px，宽度随文案变化',
    desktopHeights.length > 0 && Math.min(...desktopHeights) >= 36 && Math.max(...desktopHeights) <= 44
      && desktopWidths.size > 1 && detailActions.length > 0
      && detailActions.every((item) => item.h >= 43.5),
    JSON.stringify({ count: desktopHeights.length, min: Math.min(...desktopHeights), max: Math.max(...desktopHeights), widths: desktopWidths.size, detailActions: detailActions.map((item) => [item.text, item.h]) }));
  console.log('MEASURE desktop-calendar', JSON.stringify(desktopCalendar.buttons));

  // 告知前不能调整
  const todayDate = await cdp.evaluate("document.querySelector('.cal-cell.is-today')?.dataset.date ?? null");
  let futureClassDate = await cdp.evaluate(`(() => {
    const today = document.querySelector('.cal-cell.is-today')?.dataset.date;
    const cells = [...document.querySelectorAll('.cal-cell[data-date]')];
    return cells.find((cell) => (!today || cell.dataset.date > today) && cell.querySelector('.cal-stat.kind-class'))?.dataset.date ?? null;
  })()`);
  for (let index = 0; !futureClassDate && index < 6; index += 1) {
    const before = await cdp.evaluate("document.getElementById('calendar-month').textContent");
    await cdp.evaluate("document.getElementById('calendar-next').click()");
    await waitFor(async () => (await cdp.evaluate("document.getElementById('calendar-month').textContent")) !== before);
    await waitCalendarData(cdp);
    futureClassDate = await cdp.evaluate(`(() => {
      const cells = [...document.querySelectorAll('.cal-cell[data-date]')];
      return cells.find((cell) => cell.querySelector('.cal-stat.kind-class'))?.dataset.date ?? null;
    })()`);
  }
  if (!futureClassDate) throw new Error('no future class date found');
  await cdp.evaluate(`document.querySelector('.cal-cell[data-date="${futureClassDate}"]').click()`);
  await sleep(120);
  const consentShell = await cdp.evaluate(`(() => ({
    stripGone: !document.getElementById('calendar-consent-note')
      && !document.getElementById('calendar-share-open')
      && !document.getElementById('calendar-consent-open'),
    state: document.getElementById('calendar-state').textContent,
    adjust: document.querySelectorAll('#calendar-detail .detail-period button').length,
  }))()`);
  check('日历告知已集中确认：日历不再出现重复告知块，调整入口可用',
    consentShell.stripGone && consentShell.state === '已就绪' && consentShell.adjust > 0,
    JSON.stringify(consentShell));

  // A 类两态：有课 → 有空（同一例外原子写入）→ 有课（恢复课程占用）
  await cdp.evaluate(`document.querySelector('.cal-cell[data-date="${futureClassDate}"]').click()`);
  const classRow = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.querySelector('.detail-action')?.textContent === '有空');
    return row ? {
      status: row.dataset.status,
      action: row.querySelector('.detail-action').textContent,
      aria: row.querySelector('.detail-action').getAttribute('aria-label'),
      hint: row.textContent,
    } : null;
  })()`);
  check('个人日历单行操作：有课节次默认有课，右侧按钮为“有空”',
    classRow?.status === 'class_occupied' && classRow.action === '有空'
      && classRow.aria.includes('改为有空'),
    JSON.stringify(classRow));

  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.querySelector('.detail-action')?.textContent === '有空');
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'available' && entry.querySelector('.detail-action')?.textContent === '有课')`));
  const availableDetail = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'available');
    return { text: row?.textContent ?? '', action: row?.querySelector('.detail-action')?.textContent ?? null };
  })()`);
  const scheduleAfterAvailable = await api(cdp, `/api/spaces/${setup.spaceA}/schedule`);
  const weeklyStillHasClass = (scheduleAfterAvailable.body?.schedule?.publishedEntries ?? [])
    .some((entry) => entry.day === 1 && entry.period === 1 && entry.weekRule === 'every');
  check('A 类两态：有课→有空会取消本次占用并声明有空，周课表保持不变',
    availableDetail.action === '有课' && availableDetail.text.includes('已停课 · 有空')
      && weeklyStillHasClass,
    JSON.stringify({ availableDetail, weeklyStillHasClass }));

  await cdp.evaluate('location.reload()');
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden && !document.getElementById('page-calendar').hidden"), { timeout: 15000 });
  await waitCalendarData(cdp);
  await cdp.evaluate(`document.querySelector('.cal-cell[data-date="${futureClassDate}"]').click()`);
  const afterReloadRow = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'available');
    return row ? { action: row.querySelector('.detail-action')?.textContent ?? '', text: row.textContent } : null;
  })()`);
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'available');
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'class_occupied' && entry.querySelector('.detail-action')?.textContent === '有空')`));
  const restoredRow = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'class_occupied');
    return { action: row?.querySelector('.detail-action')?.textContent ?? '', text: row?.textContent ?? '' };
  })()`);
  check('A 类两态：刷新后仍为有空，再点“有课”恢复课程占用并清除个人声明',
    afterReloadRow?.action === '有课' && afterReloadRow.text.includes('已停课 · 有空')
      && restoredRow.action === '有空' && !restoredRow.text.includes('已停课'),
    JSON.stringify({ afterReloadRow, restoredRow }));

  // B 类两态：没课默认 → 忙碌 → 有空（清除声明，回到没课默认，不伪装成确认有空）
  const noClassPick = await cdp.evaluate(`(() => {
    const today = document.querySelector('.cal-cell.is-today')?.dataset.date ?? '';
    for (const cell of document.querySelectorAll('.cal-cell[data-date]')) {
      if (cell.dataset.date <= today) continue;
      cell.click();
      const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
        .find((entry) => entry.dataset.status === 'no_class'
          && entry.querySelector('.detail-action')?.textContent === '忙碌');
      if (row) return { date: cell.dataset.date, period: row.dataset.period };
    }
    return null;
  })()`);
  check('B 类两态：没课默认不是“有空”，右侧按钮为“忙碌”', Boolean(noClassPick), JSON.stringify(noClassPick));
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.period === ${JSON.stringify(noClassPick?.period ?? '')});
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'busy' && entry.querySelector('.detail-action')?.textContent === '有空')`));
  const busyRow = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'busy');
    return { action: row?.querySelector('.detail-action')?.textContent ?? '', text: row?.textContent ?? '' };
  })()`);
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'busy');
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'no_class' && entry.querySelector('.detail-action')?.textContent === '忙碌')`));
  const noClassRestored = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'no_class');
    return { action: row?.querySelector('.detail-action')?.textContent ?? '', text: row?.textContent ?? '' };
  })()`);
  const monthMatch = /(\d{4}) 年 (\d+) 月/.exec(await cdp.evaluate("document.getElementById('calendar-month').textContent"));
  const monthValue = monthMatch ? `${monthMatch[1]}-${String(monthMatch[2]).padStart(2, '0')}` : '';
  const cycleState = await api(cdp, `/api/spaces/${setup.spaceA}/calendar?month=${monthValue}`);
  const cycleDay = (cycleState.body?.days ?? []).find((day) => day.date === noClassPick?.date);
  const cyclePeriod = (cycleDay?.periods ?? []).find((entry) => entry.period === Number(noClassPick?.period));
  check('B 类两态：没课→忙碌→有空会清除忙碌并回到没课默认，不写成本人确认有空',
    busyRow.action === '有空' && busyRow.text.includes('忙碌')
      && noClassRestored.action === '忙碌' && noClassRestored.text.includes('没课')
      && !noClassRestored.text.includes('有空')
      && cyclePeriod?.status === 'no_class' && cyclePeriod?.personalState === 'none'
      && cyclePeriod?.cancelled === false,
    JSON.stringify({ busyRow, noClassRestored, cyclePeriod }));

  // 重复点击只提交一次；首次失败保留当前状态并允许用同一请求重试
  await cdp.evaluate(`(() => {
    window.__excOrig = window.fetch;
    window.__excBodies = [];
    window.__excFailed = false;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/exceptions')) {
        window.__excBodies.push(JSON.parse(init?.body ?? '{}'));
        if (!window.__excFailed) {
          window.__excFailed = true;
          return new Promise((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify({ error: 'server_error' }), {
              status: 500, headers: { 'content-type': 'application/json' },
            })), 250);
          });
        }
      }
      return window.__excOrig(input, init);
    };
    return true;
  })()`);
  await waitFor(() => cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.period === ${JSON.stringify(noClassPick?.period ?? '')});
    return Boolean(row) && !row.querySelector('.detail-action').disabled;
  })()`));
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.period === ${JSON.stringify(noClassPick?.period ?? '')});
    row.querySelector('.detail-action').click();
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-status').textContent.includes('未确认')"));
  const failedWrite = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.period === ${JSON.stringify(noClassPick?.period ?? '')});
    return {
      requests: window.__excBodies.length,
      status: row?.dataset.status ?? null,
      disabled: row?.querySelector('.detail-action')?.disabled ?? null,
      message: document.getElementById('calendar-status').textContent,
    };
  })()`);
  check('保存失败不伪装成功：重复点击只发一次请求，当前状态保留且按钮可重试',
    failedWrite.requests === 1 && failedWrite.status === 'no_class'
      && failedWrite.disabled === false && failedWrite.message.includes('可重试'),
    JSON.stringify(failedWrite));
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.period === ${JSON.stringify(noClassPick?.period ?? '')});
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'busy')`));
  const retryBodies = await cdp.evaluate("window.__excBodies");
  await cdp.evaluate("window.fetch = window.__excOrig");
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.dataset.status === 'busy');
    row.querySelector('.detail-action').click();
  })()`);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('#calendar-detail .detail-period')]
    .some((entry) => entry.dataset.status === 'no_class' && entry.querySelector('.detail-action')?.textContent === '忙碌')`));
  check('失败后重试沿用同一请求标识并最终写入成功',
    retryBodies.length >= 2 && retryBodies[0].requestId === retryBodies[1].requestId,
    JSON.stringify({ count: retryBodies.length, same: retryBodies[0]?.requestId === retryBodies[1]?.requestId }));

  // 今天按节次判断：未结束节次可调整，已结束节次只读
  await cdp.evaluate("document.querySelectorAll('.cal-cell.is-today')[0].click()");
  const todayDetail = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#calendar-detail .detail-period')];
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour').value);
    const minute = Number(parts.find((part) => part.type === 'minute').value);
    const nowMinutes = hour * 60 + minute;
    const expected = rows.filter((row) => {
      const time = row.querySelector('.detail-slot small')?.textContent ?? '';
      const end = time.split('–')[1] ?? '';
      const [endHour, endMinute] = end.split(':').map(Number);
      return Number.isFinite(endHour) && endHour * 60 + endMinute > nowMinutes;
    }).length;
    return {
      title: document.getElementById('calendar-detail-title').textContent,
      adjust: document.querySelectorAll('#calendar-detail .detail-period button').length,
      expected,
      periods: rows.length,
      note: document.querySelector('#calendar-detail .detail-note')?.textContent ?? '',
    };
  })()`);
  check('今天按节次只读：未结束节次显示操作按钮，已结束节次不显示',
    todayDetail.adjust === todayDetail.expected && todayDetail.adjust <= todayDetail.periods
      && todayDetail.title.includes(todayDate),
    JSON.stringify(todayDetail));

  // 学期外
  let outside = null;
  for (let index = 0; index < 12; index += 1) {
    const before = await cdp.evaluate("document.getElementById('calendar-month').textContent");
    const pre = await cdp.evaluate(`(() => ({
      disabled: document.getElementById('calendar-next').disabled,
      status: document.getElementById('calendar-status').textContent,
      switchStatus: document.getElementById('calendar-switch-status').textContent,
      busy: document.getElementById('calendar-table')?.getAttribute('aria-busy'),
    }))()`);
    await cdp.evaluate("document.getElementById('calendar-next').click()");
    try {
      await waitFor(async () => (await cdp.evaluate("document.getElementById('calendar-month').textContent")) !== before);
    } catch (error) {
      const post = await cdp.evaluate(`(() => ({
        month: document.getElementById('calendar-month').textContent,
        disabled: document.getElementById('calendar-next').disabled,
        status: document.getElementById('calendar-status').textContent,
        switchStatus: document.getElementById('calendar-switch-status').textContent,
        busy: document.getElementById('calendar-table')?.getAttribute('aria-busy'),
        error: document.getElementById('calendar-error')?.hidden === false,
      }))()`);
      console.log('OUTSIDE-STALL', index, JSON.stringify({ before, pre, post }));
      throw error;
    }
    await waitCalendarData(cdp);
    outside = await cdp.evaluate(`(() => ({
      term: document.getElementById('calendar-term').textContent,
      cells: document.querySelectorAll('.cal-cell.is-term-out[data-date]').length,
      state: document.getElementById('calendar-state').textContent,
    }))()`);
    if (outside.cells > 0 && outside.term.includes('不在学期')) break;
  }
  check('学期外月份：标记学期外并保留真实日期网格',
    outside && outside.cells > 0 && outside.term.includes('不在学期'), JSON.stringify(outside));
  await cdp.evaluate("document.getElementById('calendar-today').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-detail-title').textContent.includes(" + JSON.stringify(todayDate ?? '') + ")"));
  await waitCalendarData(cdp);

  const shiftLabel = (text, delta) => {
    const matched = /(\d{4}) 年 (\d+) 月/.exec(text);
    if (!matched) return null;
    const index = Number(matched[1]) * 12 + Number(matched[2]) - 1 + delta;
    return `${Math.floor(index / 12)} 年 ${index % 12 + 1} 月`;
  };
  const monthPrefix = (text) => {
    const matched = /(\d{4}) 年 (\d+) 月/.exec(text);
    return matched ? `${matched[1]}-${String(Number(matched[2])).padStart(2, '0')}` : null;
  };
  // 离开日历会丢弃整月缓存；关闭空闲预取，让慢速/离线用例命中真实请求。
  await cdp.evaluate(`(() => {
    window.__s2bIdleOrig = window.requestIdleCallback;
    window.__s2bCancelIdleOrig = window.cancelIdleCallback;
    window.requestIdleCallback = () => 0;
    window.cancelIdleCallback = () => {};
    return true;
  })()`);
  const reenterCalendar = async () => {
    await setHash(cdp, '#/spaces');
    await pageVisible(cdp, 'spaces');
    await setHash(cdp, `#/spaces/${setup.spaceA}/calendar`);
    await waitCalendar(cdp);
    await waitCalendarData(cdp);
  };

  await reenterCalendar();
  const slowBase = await cdp.evaluate("document.getElementById('calendar-month').textContent");
  const slowTarget = shiftLabel(slowBase, 2);
  await cdp.evaluate(`(() => {
    window.__s2bSlowOrig = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/calendar?month=' + ${JSON.stringify(monthPrefix(slowTarget))})) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(window.__s2bSlowOrig(input, init)), 900);
        });
      }
      return window.__s2bSlowOrig(input, init);
    };
    return true;
  })()`);
  await cdp.evaluate("document.getElementById('calendar-next').click(); document.getElementById('calendar-next').click(); true");
  await sleep(200);
  const slowPending = await cdp.evaluate(`(() => ({
    label: document.getElementById('calendar-month').textContent,
    status: document.getElementById('calendar-switch-status').textContent,
    statusHidden: document.getElementById('calendar-switch-status').hidden,
    tableHidden: document.getElementById('calendar-table').hidden,
    skeletonHidden: document.getElementById('calendar-skeleton').hidden,
    first: document.querySelector('#calendar-grid .cal-cell[data-date]')?.dataset.date ?? '',
  }))()`);
  check('慢响应切月：旧月份保持可见，不空白也不提前冒充目标月份',
    slowPending.label !== slowTarget && !slowPending.tableHidden && slowPending.skeletonHidden
      && slowPending.first.startsWith(monthPrefix(slowPending.label))
      && slowPending.status.includes('正在切换') && slowPending.statusHidden === false,
    JSON.stringify({ slowTarget, slowPending }));
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-month').textContent === ${JSON.stringify(slowTarget)}`));
  await waitCalendarData(cdp);
  await cdp.evaluate("window.fetch = window.__s2bSlowOrig; delete window.__s2bSlowOrig; true");

  await reenterCalendar();
  const rapidBase = await cdp.evaluate("document.getElementById('calendar-month').textContent");
  const staleLabel = shiftLabel(rapidBase, 1);
  const finalLabel = shiftLabel(rapidBase, 2);
  await cdp.evaluate(`(() => {
    window.__s2bStaleOrig = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/calendar?month=' + ${JSON.stringify(monthPrefix(staleLabel))})) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(window.__s2bStaleOrig(input, init)), 1200);
        });
      }
      return window.__s2bStaleOrig(input, init);
    };
    return true;
  })()`);
  await cdp.evaluate("document.getElementById('calendar-next').click()");
  await sleep(60);
  await cdp.evaluate("document.getElementById('calendar-next').click()");
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-month').textContent === ${JSON.stringify(finalLabel)}`), { timeout: 15000 });
  await waitCalendarData(cdp);
  await sleep(1400);
  const rapidFinal = await cdp.evaluate(`(() => ({
    label: document.getElementById('calendar-month').textContent,
    first: document.querySelector('#calendar-grid .cal-cell[data-date]')?.dataset.date ?? '',
    status: document.getElementById('calendar-status').textContent,
  }))()`);
  await cdp.evaluate("window.fetch = window.__s2bStaleOrig; delete window.__s2bStaleOrig; true");
  check('快速连点后旧响应晚到：最终停留在最后意图月份，不倒退到中间月份',
    rapidFinal.label === finalLabel && rapidFinal.first.startsWith(monthPrefix(finalLabel))
      && !rapidFinal.label.includes(staleLabel),
    JSON.stringify({ staleLabel, finalLabel, rapidFinal }));

  await reenterCalendar();
  await cdp.send('Network.enable');
  const offlineBase = await cdp.evaluate("document.getElementById('calendar-month').textContent");
  const offlineTarget = shiftLabel(offlineBase, 2);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none',
  });
  await cdp.evaluate("document.getElementById('calendar-next').click(); document.getElementById('calendar-next').click(); true");
  await sleep(900);
  const offline = await cdp.evaluate(`(() => ({
    label: document.getElementById('calendar-month').textContent,
    tableHidden: document.getElementById('calendar-table').hidden,
    skeletonHidden: document.getElementById('calendar-skeleton').hidden,
    errorHidden: document.getElementById('calendar-error').hidden,
    status: document.getElementById('calendar-switch-status').textContent,
    first: document.querySelector('#calendar-grid .cal-cell[data-date]')?.dataset.date ?? '',
  }))()`);
  check('离线切月：保留已加载月份与真实日期，明确提示仍显示旧月份',
    offline.label !== offlineTarget && !offline.tableHidden && offline.skeletonHidden
      && !offline.errorHidden && offline.status.includes('仍显示')
      && offline.first.startsWith(monthPrefix(offline.label)),
    JSON.stringify({ offlineTarget, offline }));
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'none',
  });
  await cdp.evaluate("document.getElementById('calendar-retry').click()");
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-month').textContent === ${JSON.stringify(offlineTarget)}`), { timeout: 15000 });
  await waitCalendarData(cdp);
  const afterOffline = await cdp.evaluate(`(() => ({
    label: document.getElementById('calendar-month').textContent,
    first: document.querySelector('#calendar-grid .cal-cell[data-date]')?.dataset.date ?? '',
    errorHidden: document.getElementById('calendar-error').hidden,
  }))()`);
  check('恢复网络后重试：加载离线时目标的月份并清除错误',
    afterOffline.label === offlineTarget && afterOffline.first.startsWith(monthPrefix(offlineTarget))
      && afterOffline.errorHidden,
    JSON.stringify(afterOffline));
  await cdp.evaluate(`(() => {
    if (window.__s2bIdleOrig) window.requestIdleCallback = window.__s2bIdleOrig;
    if (window.__s2bCancelIdleOrig) window.cancelIdleCallback = window.__s2bCancelIdleOrig;
    delete window.__s2bIdleOrig;
    delete window.__s2bCancelIdleOrig;
    return true;
  })()`);

  // 旧响应隔离：延迟 A 的月历响应，快速切到 B 首页
  await cdp.evaluate(`(() => {
    window.__s2bOrigFetch = window.fetch;
    window.__s2bDelayStarted = false;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!window.__s2bDelayStarted && url.includes('/calendar?month=') && url.includes(${JSON.stringify(setup.spaceA)})) {
        window.__s2bDelayStarted = true;
        return new Promise((resolve) => {
          setTimeout(() => resolve(window.__s2bOrigFetch(input, init)), 1200);
        });
      }
      return window.__s2bOrigFetch(input, init);
    };
    return true;
  })()`);
  await setHash(cdp, '#/spaces');
  await pageVisible(cdp, 'spaces');
  await setHash(cdp, `#/spaces/${setup.spaceA}/calendar`);
  await waitFor(() => cdp.evaluate("window.__s2bDelayStarted === true"));
  await setHash(cdp, `#/spaces/${setup.spaceB}`);
  await waitSpaceHome(cdp);
  await sleep(1400);
  const stale = await cdp.evaluate(`(() => ({
    page: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).map((section) => section.id),
    title: document.getElementById('space-title').textContent,
    calendarMonth: document.getElementById('calendar-month').textContent,
    error: !document.getElementById('home-error').hidden,
    flash: document.getElementById('flash').hidden,
  }))()`);
  await cdp.evaluate("window.fetch = window.__s2bOrigFetch");
  check('旧响应隔离：快速切空间后，延迟的月历响应不覆盖当前页',
    stale.page.length === 1 && stale.page[0] === 'page-home' && stale.title === '路由空间 B'
      && stale.calendarMonth === '' && !stale.error,
    JSON.stringify(stale));

  // 邀请码（不输出内容），随后退出并验证缓存清理与登录目标
  const invite = await api(cdp, `/api/spaces/${setup.spaceA}/invite`, { method: 'POST' });
  check('负责人可生成邀请码（本地假库）', invite.status === 201 && typeof invite.body?.code === 'string');
  const inviteCode = invite.body?.code;

  await setHash(cdp, `#/spaces/${setup.spaceA}/settings`);
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("!document.getElementById('settings-content').hidden"));
  const ownerSettings = await cdp.evaluate(`(() => ({
    form: document.getElementById('settings-form').hidden,
    note: document.getElementById('settings-teaching-note').textContent,
    participation: document.getElementById('settings-participation-status').textContent,
  }))()`);
  check('空间设置：教学周已设置时不再显示修改表单，参与收集归位设置',
    ownerSettings.form && ownerSettings.note.includes('不可更改') && ownerSettings.participation.length > 0,
    JSON.stringify(ownerSettings));

  await logoutUi(cdp);
  const cleared = await cdp.evaluate(`(() => ({
    appHidden: document.getElementById('app-panel').hidden,
    authVisible: !document.getElementById('auth-panel').hidden,
    spaceName: document.getElementById('space-title').textContent,
    nav: document.querySelectorAll('#side-space-links .side-link').length,
    list: document.querySelectorAll('#space-list .space-button').length,
    body: document.body.textContent,
    hits: [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0 && /路由空间 [AB]/.test(element.textContent))
      .map((element) => ({
        tag: element.tagName, id: element.id, cls: element.className,
        text: element.textContent.trim().slice(0, 50),
      })),
  }))()`);
  check('退出登录：清空当前空间导航、列表与敏感页面内容',
    cleared.appHidden && cleared.authVisible && cleared.spaceName === '' && cleared.nav === 0
      && cleared.list === 0 && !cleared.body.includes('路由空间 A') && !cleared.body.includes('路由空间 B'),
    JSON.stringify({
      appHidden: cleared.appHidden, authVisible: cleared.authVisible, spaceName: cleared.spaceName,
      nav: cleared.nav, list: cleared.list,
      hasA: cleared.body.includes('路由空间 A'), hasB: cleared.body.includes('路由空间 B'),
      hits: cleared.hits,
    }));

  await cdp.evaluate('history.back()');
  await sleep(300);
  const afterBack = await cdp.evaluate(`(() => ({
    auth: !document.getElementById('auth-panel').hidden,
    app: document.getElementById('app-panel').hidden,
    page: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).length,
  }))()`);
  check('退出后返回：不会重新显示已缓存的空间页面',
    afterBack.auth && afterBack.app, JSON.stringify(afterBack));

  // 合法登录目标恢复
  await setHash(cdp, `#/spaces/${setup.spaceA}/settings`);
  await loginUi(cdp, setup.username);
  await pageVisible(cdp, 'settings');
  const restoredLegal = await hashPath(cdp);
  check('登录恢复：合法空间深链在登录后恢复到原页面',
    restoredLegal.endsWith('/settings'), restoredLegal);
  await logoutUi(cdp);

  // 非法空间目标回退
  await setHash(cdp, `#/spaces/${randomUUID()}/calendar`);
  await loginUi(cdp, setup.username);
  await pageVisible(cdp, 'spaces');
  const restoredIllegal = await hashPath(cdp);
  check('登录恢复：不存在的空间目标回退到我的空间', restoredIllegal === '#/spaces', restoredIllegal);

  // 成员账号：注册、加入、权限与角色切换
  const memberUsername = `mem_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await logoutUi(cdp);
  await setHash(cdp, '#/spaces');
  await registerUi(cdp, memberUsername, '普通成员');
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("!document.getElementById('spaces-empty').hidden"));
  await cdp.evaluate("document.getElementById('open-join').click()");
  await pageVisible(cdp, 'join');
  await fill(cdp, { 'join-code': inviteCode, 'join-name': '成员乙' });
  await cdp.evaluate("document.getElementById('join-notice').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('join-submit').disabled"));
  await cdp.evaluate("document.getElementById('join-submit').click()");
  await waitSpaceHome(cdp);
  const memberConsentSeed = await settleSpaceConsent(cdp, setup.spaceA);
  const memberHome = await cdp.evaluate(`(() => ({
    role: document.getElementById('space-role').textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
    collectCard: [...document.querySelectorAll('#home-status-grid .stat')].some((card) => card.textContent.includes('收集进度')),
    actions: [...document.querySelectorAll('#page-home button')].filter((button) => button.offsetParent !== null).map((button) => button.textContent),
  }))()`);
  check('成员首页：显示成员角色，不出现课表收集或空间设置入口',
    memberHome.role.includes('普通成员') && memberHome.nav.includes('我的课表')
      && !memberHome.nav.includes('课表收集') && !memberHome.nav.includes('空间设置')
      && !memberHome.collectCard && !memberHome.actions.includes('课表收集')
      && memberConsentSeed.calendar === 200 && memberConsentSeed.share === 200,
    JSON.stringify({ ...memberHome, consent: memberConsentSeed }));

  await setHash(cdp, `#/spaces/${setup.spaceA}/collect`);
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-denied').hidden"));
  const collectGate = await cdp.evaluate(`(() => ({
    denied: !document.getElementById('collect-denied').hidden,
    content: document.getElementById('collect-content').hidden,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
  }))()`);
  check('成员直接访问收集页：页面级拒绝，不显示收集内容或邀请码',
    collectGate.denied && collectGate.content && !collectGate.nav.includes('课表收集'),
    JSON.stringify(collectGate));

  const memberAdmin = await cdp.evaluate(`(async () => {
    const call = async (path, method = 'GET', body) => {
      const response = await fetch('/functions/v1/app' + path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return response.status;
    };
    return {
      members: await call('/api/spaces/${setup.spaceA}/members'),
      invite: await call('/api/spaces/${setup.spaceA}/invite', 'POST'),
      teaching: await call('/api/spaces/${setup.spaceA}/teaching', 'POST', { teaching: {
        timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
        termStart: '2026-09-07', termEnd: '2027-01-24',
      } }),
      ownerCalendar: await call('/api/spaces/${setup.spaceA}/calendar?month=2026-11&memberId=' + crypto.randomUUID()),
    };
  })()`);
  check('成员服务端权限：收集、邀请、教学设置与他人日历均被拒绝',
    memberAdmin.members === 403 && memberAdmin.invite === 403 && memberAdmin.teaching === 403
      && memberAdmin.ownerCalendar === 403, JSON.stringify(memberAdmin));

  await setHash(cdp, `#/spaces/${setup.spaceA}/settings`);
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("!document.getElementById('settings-denied').hidden"));
  const memberSettings = await cdp.evaluate(`(() => ({
    denied: !document.getElementById('settings-denied').hidden,
    content: document.getElementById('settings-content').hidden,
    text: document.getElementById('settings-denied').textContent,
    back: document.getElementById('settings-denied-back').textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
  }))()`);
  check('成员设置页：页面级拒绝、无设置表单且提供返回入口',
    memberSettings.denied && memberSettings.content && memberSettings.text.includes('仅对负责人开放')
      && memberSettings.back.includes('返回空间') && !memberSettings.nav.includes('空间设置'),
    JSON.stringify(memberSettings));

  await setHash(cdp, `#/spaces/${setup.spaceB}/calendar`);
  await pageVisible(cdp, 'error');
  const crossSpace = await cdp.evaluate("document.getElementById('route-error-text').textContent");
  check('成员访问未加入空间：错误页拒绝，不加载该空间数据', crossSpace.includes('找不到该空间'), crossSpace);

  await logoutUi(cdp);
  await setHash(cdp, '#/spaces');
  await loginUi(cdp, setup.username);
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.space-button').length >= 2"));
  await cdp.evaluate("[...document.querySelectorAll('.space-button')].find((button) => button.textContent.includes('路由空间 A')).click()");
  await waitSpaceHome(cdp);
  const ownerBack = await cdp.evaluate(`(() => ({
    role: document.getElementById('space-role').textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
    collect: [...document.querySelectorAll('#home-status-grid .stat')].some((card) => card.textContent.includes('收集进度')),
  }))()`);
  check('账号切换回负责人：角色与收集进度恢复',
    ownerBack.role.includes('负责人') && ownerBack.nav.includes('课表收集') && ownerBack.collect,
    JSON.stringify(ownerBack));

  // 桌面按钮实测（持久导航；首页不再重复大功能按钮）
  const desktopMeasure = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('#side-space-links .side-link')]
      .filter((button) => button.offsetParent !== null && button.textContent.trim())
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent.trim(), h: rect.height, w: rect.width,
          fontSize: style.fontSize, minHeight: style.minHeight,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' '),
        };
      });
    return { items };
  })()`);
  const homeHeights = desktopMeasure.items.map((item) => item.h);
  check('桌面按钮：持久导航高度一致且在 36–40px',
    homeHeights.length > 0 && Math.min(...homeHeights) >= 36 && Math.max(...homeHeights) <= 40
      && Math.max(...homeHeights) - Math.min(...homeHeights) <= 1,
    JSON.stringify({ count: homeHeights.length, min: Math.min(...homeHeights), max: Math.max(...homeHeights) }));
  console.log('MEASURE desktop-home', JSON.stringify(desktopMeasure.items));

  // 移动端：导航与课表日期切换分离，按钮触达与月历
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(400);
  await setHash(cdp, `#/spaces/${setup.spaceA}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.day-tab').length === 7"));
  const mobileSchedule = await cdp.evaluate(`(() => {
    const side = getComputedStyle(document.querySelector('.shell-side')).display;
    const nav = document.getElementById('mobile-nav');
    const tabs = document.querySelector('.day-tabs');
    const navRect = nav.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#page-schedule button, #mobile-nav .mobile-link')]
      .filter((button) => button.offsetParent !== null && button.textContent.trim()
        && !button.classList.contains('week-cell') && !button.classList.contains('day-tab'))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent.trim(), h: rect.height, w: rect.width,
          fontSize: style.fontSize, minHeight: style.minHeight,
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' '),
        };
      });
    return {
      side, navVisible: !nav.hidden, tabsVisible: Boolean(tabs) && tabs.offsetParent !== null,
      navContainsTabs: nav.contains(tabs), separate: !nav.contains(tabs) && navRect.bottom <= tabsRect.top + 1,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      links: [...nav.querySelectorAll('.mobile-link')].map((link) => ({
        text: link.textContent.trim(), label: link.getAttribute('aria-label') ?? '',
      })),
      buttons,
    };
  })()`);
  check('手机导航：与日期切换分离、可横向滚动且不溢出',
    mobileSchedule.side === 'none' && mobileSchedule.navVisible && mobileSchedule.tabsVisible
      && !mobileSchedule.navContainsTabs && mobileSchedule.separate && !mobileSchedule.overflow
      && mobileSchedule.links.some((link) => link.text === '课表' && link.label === '我的课表')
      && mobileSchedule.links.some((link) => link.text === '日历' && link.label === '我的日历'),
    JSON.stringify({ side: mobileSchedule.side, nav: mobileSchedule.navVisible, separate: mobileSchedule.separate, overflow: mobileSchedule.overflow, links: mobileSchedule.links }));
  const mobileHeights = mobileSchedule.buttons.map((item) => item.h);
  // 设备像素比下 getBoundingClientRect 可能把 44px 报成 43.99994；计算样式仍是 44px。
  check('手机按钮：可见动作按钮与导航触达高度不小于 44px',
    mobileHeights.length > 0 && Math.min(...mobileHeights) >= 43.5
      && mobileSchedule.buttons.every((item) => item.minHeight === '44px'),
    JSON.stringify({ count: mobileHeights.length, min: Math.min(...mobileHeights), labels: mobileSchedule.buttons.map((item) => item.text).slice(0, 8) }));
  console.log('MEASURE mobile-schedule', JSON.stringify(mobileSchedule.buttons));

  await setHash(cdp, `#/spaces/${setup.spaceA}/calendar`);
  await waitCalendar(cdp);
  const mobileCalendar = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#calendar-grid .cal-row')];
    const table = document.getElementById('calendar-table').getBoundingClientRect();
    const detail = document.getElementById('calendar-detail').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#page-calendar button, #page-calendar .button-link')]
      .filter((button) => !button.classList.contains('cal-cell') && button.offsetParent !== null && button.textContent.trim())
      .map((button) => button.getBoundingClientRect().height);
    return {
      rows: rows.length, perRow: rows.every((row) => row.children.length === 7),
      detailBelow: detail.top >= table.bottom - 1,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      minButton: buttons.length ? Math.min(...buttons) : 0,
      today: document.querySelectorAll('.cal-cell.is-today').length,
      selected: document.querySelectorAll('.cal-cell.is-selected').length,
    };
  })()`);
  check('手机月历：七列、详情在下方、今天与选中可区分且无横向溢出',
    mobileCalendar.rows > 0 && mobileCalendar.perRow && mobileCalendar.detailBelow
      && !mobileCalendar.overflow && mobileCalendar.today === 1 && mobileCalendar.selected <= 1,
    JSON.stringify(mobileCalendar));
  check('手机月历：月份与详情按钮触达高度不小于 44px', mobileCalendar.minButton >= 44, String(mobileCalendar.minButton));

  const mobileSelect = await cdp.evaluate(`(async () => {
    const cells = [...document.querySelectorAll('.cal-cell[data-date]')];
    const target = cells.find((cell) => cell.dataset.date !== document.querySelector('.cal-cell.is-today')?.dataset.date)
      ?? cells[0];
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      selectedDate: document.querySelector('.cal-cell.is-selected')?.dataset.date ?? null,
      detail: document.getElementById('calendar-detail-title').textContent,
      todayStill: document.querySelectorAll('.cal-cell.is-today').length,
    };
  })()`);
  check('手机日期选择：详情随选中日期更新，今天标记不被覆盖',
    mobileSelect.selectedDate && mobileSelect.detail.includes(mobileSelect.selectedDate) && mobileSelect.todayStill === 1,
    JSON.stringify(mobileSelect));

  await cdp.evaluate(`document.querySelector('.cal-cell[data-date="${futureClassDate}"]').click()`);
  await sleep(120);
  const mobileDetail = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#calendar-detail .detail-period')]
      .find((entry) => entry.querySelector('.detail-state-text'));
    if (!row) return null;
    const state = row.querySelector('.detail-state-text');
    const action = row.querySelector('.detail-action');
    const rowRect = row.getBoundingClientRect();
    const actionRect = action?.getBoundingClientRect();
    return {
      stateText: state.textContent,
      stateClipped: state.scrollWidth > state.clientWidth + 1,
      actionLabel: action?.textContent ?? '',
      actionH: actionRect?.height ?? 0,
      actionW: actionRect?.width ?? 0,
      actionSameRow: actionRect
        ? Math.abs((actionRect.top + actionRect.bottom) / 2 - (rowRect.top + rowRect.bottom) / 2) < 20
        : false,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('手机详情单行：节次/状态/按钮同排，长文本不溢出且按钮不小于 44px',
    mobileDetail && mobileDetail.stateText.length > 0 && !mobileDetail.stateClipped
      && mobileDetail.actionH >= 44 && mobileDetail.actionW >= 44
      && mobileDetail.actionSameRow && !mobileDetail.overflow,
    JSON.stringify(mobileDetail));

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);
  const finalErrors = cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text));
  check('页面运行时无未捕获异常或 console.error', finalErrors.length === 0, finalErrors.slice(0, 3).join(' | '));

  return { setup, memberUsername };
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) {
    process.stdout.write('SKIP 未找到 Edge/Chrome，可跳过 S2b 浏览器检查\n');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 's2b-cdp-'));
  const browser = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (!response.ok) return false;
      const pages = await response.json();
      return pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
    }, { timeout: 15000 });
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = pages.find((page) => page.type === 'page');
    cdp = await Cdp.open(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE });
    await waitFor(() => cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('auth-panel')"));
    await run(cdp);
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    browser.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    const failed = results.filter((item) => !item.ok);
    process.stdout.write(`\nS2b 浏览器检查：${results.length - failed.length}/${results.length} 通过\n`);
    if (failed.length) process.exitCode = 1;
  }
}

await main();

// Batch G 浏览器检查：负责人事件通知、成员日历确认/撤回、负责人收集页安排、
// 内置确认框与移动端触达。使用本地预览与内存假数据库；不代表真实 Provider 或真机。
//   node dev/check-assignment-ui.mjs   （需要先启动 dev/preview-server.mjs）
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
const PORT = Number(process.env.CDP_PORT ?? 9342);
const PASSWORD = `local-assign-${randomUUID()}-${randomUUID()}`;
const TZ = 'Asia/Shanghai';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(fn, { timeout = 12000, interval = 60 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
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

function todayInSpace() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(date, count) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function weekdayMon1(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return ((value.getUTCDay() + 6) % 7) + 1;
}

function monthText(month) {
  return `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
}

function monthNumber(month) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
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
  let logged = false;
  return waitFor(async () => {
    const state = await cdp.evaluate(`(() => ({
      url: location.href,
      ready: document.readyState,
      title: document.title,
      has: Boolean(document.getElementById('page-${name}')),
      hidden: document.getElementById('page-${name}')?.hidden ?? null,
    }))()`);
    if (!state.has && !logged) {
      logged = true;
      console.log('DEBUG_PAGE_MISSING', name, JSON.stringify(state));
    }
    return state.hidden === false;
  });
}

const PAGES = ['spaces', 'home', 'schedule', 'calendar', 'collect', 'settings', 'create'];
async function gotoSpace(cdp, spaceId, page) {
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/${page}'`);
  await pageVisible(cdp, page);
  if (page === 'calendar') {
    await waitFor(() => cdp.evaluate("!document.getElementById('calendar-table').hidden || !document.getElementById('calendar-empty').hidden"));
  } else if (page === 'collect') {
    await waitFor(() => cdp.evaluate("!document.getElementById('collect-content').hidden"));
  } else if (page === 'home') {
    await waitFor(() => cdp.evaluate("!document.getElementById('home-content').hidden"));
  }
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
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
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
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
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
    if (!terms.checked) terms.click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('login-submit').disabled"));
  await cdp.evaluate("document.getElementById('login-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"), { timeout: 15000 });
  await passConsentGate(cdp);
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

async function passConsentGate(cdp) {
  try {
    await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 1200, interval: 80 });
  } catch {
    return false;
  }
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-continue').disabled"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  return true;
}

async function ensureMonth(cdp, { labelId, prevId, nextId }, month) {
  const target = monthNumber(month);
  for (let step = 0; step < 4; step += 1) {
    const text = await cdp.evaluate(`document.getElementById(${JSON.stringify(labelId)}).textContent`);
    if (text === monthText(month)) return;
    const matched = /(\d{4}) 年 (\d+) 月/.exec(text);
    if (!matched) throw new Error(`月份未就绪：${text}`);
    const current = Number(matched[1]) * 12 + Number(matched[2]);
    const id = target > current ? nextId : prevId;
    await cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await waitFor(() => cdp.evaluate(`document.getElementById(${JSON.stringify(labelId)}).textContent !== ${JSON.stringify(text)}`));
  }
}

async function openCalendarDate(cdp, month, date) {
  await ensureMonth(cdp, {
    labelId: 'calendar-month', prevId: 'calendar-prev', nextId: 'calendar-next',
  }, month);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('#calendar-grid button.cal-cell[data-date="${date}"]')`));
  await cdp.evaluate(`document.querySelector('#calendar-grid button.cal-cell[data-date="${date}"]').click()`);
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-detail-title').textContent.includes(${JSON.stringify(date)})`));
}

async function openCollectDate(cdp, month, date) {
  await cdp.evaluate("document.getElementById('collect-tab-calendar').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-calendar-table').hidden || !document.getElementById('collect-calendar-empty').hidden"));
  await ensureMonth(cdp, {
    labelId: 'collect-month', prevId: 'collect-prev', nextId: 'collect-next',
  }, month);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${date}"]')`));
  await cdp.evaluate(`document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${date}"]').click()`);
  await waitFor(() => cdp.evaluate(`document.getElementById('collect-detail-title').textContent.includes(${JSON.stringify(date)})`));
}

function periodRowSelector(page, date, period) {
  const grid = page === 'calendar' ? 'calendar-detail-body' : 'collect-detail-body';
  return `#${grid} .detail-period[data-date="${date}"][data-period="${period}"]`;
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const today = todayInSpace();
  const monday = addDays(today, -(weekdayMon1(today) - 1));
  const targetDate = addDays(today, 1);
  const targetMonth = targetDate.slice(0, 7);
  const termEnd = addDays(today, 180);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const spaceName = `安排空间 ${suffix}`;
  const eventTitle = `评审通知${suffix}`;
  const ownerUsername = `asg_own_${suffix}`;
  const memberUsername = `asg_mem_${suffix}`;
  const memberName = `成员甲${suffix.slice(0, 3)}`;

  await registerUi(cdp, ownerUsername, '负责人甲');
  await pageVisible(cdp, 'spaces');
  const notice = await api(cdp, '/api/notice');
  const created = await api(cdp, '/api/spaces', {
    method: 'POST',
    body: {
      name: spaceName,
      ownerName: '负责人甲',
      mode: 'courses',
      weekRule: 'every',
      periods: Array.from({ length: 6 }, (_, index) => {
        const start = 8 * 60 + index * 60;
        const text = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        return { index: index + 1, start: text(start), end: text(start + 45) };
      }),
      visibility: 'masked_list',
      teaching: {
        timezone: TZ, firstWeekMonday: monday, termStart: monday, termEnd,
      },
    },
  });
  check('准备：空间创建成功', created.status === 201 && Boolean(created.body?.space?.id),
    JSON.stringify({ status: created.status, error: created.body?.error }));
  const spaceId = created.body.space.id;
  const invite = await api(cdp, `/api/spaces/${spaceId}/invite`, { method: 'POST' });
  const inviteCode = invite.body?.code ?? invite.body?.invite?.code;
  check('准备：邀请码生成（不输出内容）', invite.status === 201 && Boolean(inviteCode));
  const ownerConsent = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: notice.body.calendar.version },
  });
  const ownerShare = await api(cdp, `/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST',
    body: { action: 'decline', noticeVersion: notice.body.share.version },
  });
  check('准备：负责人日历告知与可选共享已记录',
    ownerConsent.status === 200 && ownerShare.status === 200,
    JSON.stringify({ calendar: ownerConsent.status, share: ownerShare.status }));

  await logoutUi(cdp);
  await registerUi(cdp, memberUsername, memberName);
  const joined = await api(cdp, '/api/join', {
    method: 'POST',
    body: {
      code: inviteCode,
      inSpaceName: memberName,
      noticeAccepted: true,
      noticeVersion: notice.body.version,
      shareNoticeAccepted: true,
      shareNoticeVersion: notice.body.share.version,
    },
  });
  check('准备：成员加入并确认可选日期共享', joined.status === 201, JSON.stringify({ status: joined.status }));
  const me = await api(cdp, '/api/me');
  const memberId = me.body?.user?.id;
  const consent = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: notice.body.calendar.version },
  });
  check('准备：成员日历告知已记录', consent.status === 200, String(consent.status));
  const published = await api(cdp, `/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    body: {
      requestId: `asgui_${suffix}_pub`,
      baseRevision: 0,
      entries: [{
        day: weekdayMon1(targetDate), period: 1, weekRule: 'every', courseName: '数据结构与算法设计',
      }],
    },
  });
  check('准备：成员课表已发布', published.status === 201, String(published.status));

  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  await gotoSpace(cdp, spaceId, 'collect');
  await openCollectDate(cdp, targetMonth, targetDate);
  await cdp.evaluate("document.getElementById('collect-event-new').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('event-dialog').open"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#event-recipients input[name=\"event-recipient\"]').length > 0"));
  await cdp.evaluate("document.querySelector('input[name=\"event-visibility\"][value=\"invitees\"]').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('event-recipients').hidden"));
  await cdp.evaluate(`document.querySelector('#event-recipients input[value="${memberId}"]').click()`);
  await cdp.evaluate("document.querySelector('input[name=\"event-visibility\"][value=\"private\"]').click()");
  await cdp.evaluate("document.querySelector('input[name=\"event-visibility\"][value=\"invitees\"]').click()");
  const recipientKept = await cdp.evaluate(`(() => {
    const input = document.querySelector('#event-recipients input[value="${memberId}"]');
    return { checked: input?.checked === true, visible: !document.getElementById('event-recipients').hidden };
  })()`);
  await fill(cdp, { 'event-title': eventTitle });
  await cdp.evaluate(`(() => {
    document.getElementById('event-start').value = ${JSON.stringify(targetDate)};
    document.getElementById('event-end').value = ${JSON.stringify(targetDate)};
    return true;
  })()`);
  await cdp.evaluate("document.getElementById('event-save').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('event-dialog').open"));
  await waitFor(() => cdp.evaluate("document.getElementById('collect-events-status').textContent.includes('已向 1 位成员发送站内待确认')"));
  check('事件通知：仅受邀切换后保留勾选，保存后生成 1 条站内待确认',
    recipientKept.checked && recipientKept.visible,
    JSON.stringify(recipientKept));

  const otherDate = targetDate.slice(0, 7) === addDays(targetDate, 1).slice(0, 7)
    ? addDays(targetDate, 1)
    : addDays(targetDate, -1);
  await cdp.evaluate(`document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${otherDate}"]').click()`);
  await sleep(220);
  const collectMarker = await cdp.evaluate(`(() => {
    const cell = document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${targetDate}"]');
    const number = cell?.querySelector('.cal-day-num');
    const style = cell ? getComputedStyle(cell) : null;
    const marker = cell ? getComputedStyle(cell, '::before') : null;
    return {
      has: cell?.classList.contains('has-events') ?? false,
      selected: cell?.classList.contains('is-selected') ?? null,
      badge: cell?.querySelector('.cal-event-badge')?.textContent ?? '',
      aria: cell?.getAttribute('aria-label') ?? '',
      background: style?.backgroundColor ?? '',
      border: style?.borderColor ?? '',
      numberColor: number ? getComputedStyle(number).color : '',
      markerContent: marker?.content ?? 'none',
      markerColor: marker?.backgroundColor ?? '',
      markerWidth: marker?.width ?? '',
    };
  })()`);
  check('收集日历：事件日期用红色侧标与数量，日期保持可读，选中态仍可区分',
    collectMarker.has && collectMarker.selected === false
      && collectMarker.badge === '事件 1' && collectMarker.aria.includes('可见事件')
      && collectMarker.background === 'rgb(255, 255, 255)'
      && collectMarker.markerContent !== 'none'
      && collectMarker.markerColor === 'rgb(155, 44, 44)'
      && collectMarker.markerWidth === '3px'
      && collectMarker.numberColor === 'rgb(23, 39, 31)',
    JSON.stringify(collectMarker));

  await cdp.evaluate("document.getElementById('invite-rotate').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  const inviteConfirm = await cdp.evaluate(`(() => ({
    title: document.getElementById('confirm-title').textContent,
    text: document.getElementById('confirm-text').textContent,
  }))()`);
  await cdp.evaluate("document.getElementById('confirm-cancel').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('confirm-dialog').open"));
  check('邀请码轮换：使用内置确认框说明影响，取消不写入',
    inviteConfirm.title.includes('轮换邀请码') && inviteConfirm.text.includes('已加入成员不受影响'),
    JSON.stringify(inviteConfirm));

  let privateDate = addDays(targetDate, 2);
  if (privateDate.slice(0, 7) !== targetDate.slice(0, 7)) privateDate = addDays(targetDate, -2);
  const privateMade = await api(cdp, `/api/spaces/${spaceId}/events`, {
    method: 'POST',
    body: {
      id: crypto.randomUUID(),
      title: `私有事件${suffix}`,
      startDate: privateDate,
      endDate: privateDate,
      allDay: true,
      visibility: 'private',
      recipientScope: 'none',
      recipients: [],
    },
  });
  check('准备：负责人私有事件已创建（用于成员隐私检查）', privateMade.status === 201,
    String(privateMade.status));

  await logoutUi(cdp);
  await loginUi(cdp, memberUsername);
  await gotoSpace(cdp, spaceId, 'calendar');
  await waitFor(() => cdp.evaluate("!document.getElementById('calendar-assignments').hidden"));
  const pendingPanel = await cdp.evaluate(`(() => ({
    count: document.getElementById('calendar-assignment-count').textContent,
    title: document.querySelector('#calendar-assignment-list .assignment-card strong')?.textContent ?? '',
    hint: document.querySelector('#calendar-assignment-list .detail-hint')?.textContent ?? '',
  }))()`);
  await openCalendarDate(cdp, targetMonth, targetDate);
  const personalMarker = await cdp.evaluate(`(() => {
    const cell = document.querySelector('#calendar-grid button.cal-cell[data-date="${targetDate}"]');
    const number = cell?.querySelector('.cal-day-num');
    const privateCell = document.querySelector('#calendar-grid button.cal-cell[data-date="${privateDate}"]');
    const marker = cell ? getComputedStyle(cell, '::before') : null;
    return {
      has: cell?.classList.contains('has-events') ?? false,
      selected: cell?.classList.contains('is-selected') ?? null,
      badge: cell?.querySelector('.cal-event-badge')?.textContent ?? '',
      aria: cell?.getAttribute('aria-label') ?? '',
      numberColor: number ? getComputedStyle(number).color : '',
      markerContent: marker?.content ?? 'none',
      markerColor: marker?.backgroundColor ?? '',
      markerWidth: marker?.width ?? '',
      privateHas: privateCell?.classList.contains('has-events') ?? null,
      privateBadge: privateCell?.querySelector('.cal-event-badge')?.textContent ?? '',
    };
  })()`);
  const beforeRows = await cdp.evaluate(`(() => ({
    classStatus: document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 1))})?.dataset.status,
    freeStatus: document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 2))})?.dataset.status,
  }))()`);
  check('个人日历：事件日期红色侧标与数量，选中态可区分；他人私有事件不泄露红标',
    personalMarker.has && personalMarker.selected === true
      && personalMarker.badge === '事件 1' && personalMarker.aria.includes('可见事件')
      && personalMarker.markerContent !== 'none'
      && personalMarker.markerColor === 'rgb(155, 44, 44)'
      && personalMarker.markerWidth === '3px'
      && personalMarker.numberColor === 'rgb(23, 39, 31)'
      && personalMarker.privateHas === false && personalMarker.privateBadge === '',
    JSON.stringify(personalMarker));
  check('成员待确认：面板显示待确认数量与课程冲突，接受前不占忙',
    pendingPanel.count.includes('待确认 1') && pendingPanel.title === eventTitle
      && pendingPanel.hint.includes('与课程冲突') && pendingPanel.hint.includes('不会自动取消课程')
      && beforeRows.classStatus === 'class_occupied' && beforeRows.freeStatus === 'no_class',
    JSON.stringify({ pendingPanel, beforeRows }));

  await cdp.evaluate("[...document.querySelectorAll('#calendar-assignment-list .assignment-card button')].find((button) => button.textContent === '接受').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-status').textContent.includes('已确认')"));
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 2))})?.dataset.status === 'busy'`));
  const busyRow = await cdp.evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 2))});
    return {
      status: row.dataset.status,
      hint: row.querySelector('.detail-hint')?.textContent ?? '',
      action: row.querySelector('.detail-action')?.textContent ?? '',
      classStatus: document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 1))})?.dataset.status,
    };
  })()`);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(`${periodRowSelector('calendar', targetDate, 2)} .detail-action`)}).click()`);
  const focusInfo = await cdp.evaluate(`(() => ({
    tag: document.activeElement?.tagName ?? null,
    text: document.activeElement?.textContent?.slice(0, 20) ?? null,
    inside: Boolean(document.activeElement?.closest('#calendar-assignment-list')),
    buttons: document.querySelectorAll('#calendar-assignment-list button').length,
    panelHidden: document.getElementById('calendar-assignments').hidden,
  }))()`);
  const focusInPanel = focusInfo.inside;
  check('成员接受：课程保留、覆盖节次忙碌，普通按钮导向安排面板',
    busyRow.status === 'busy' && busyRow.classStatus === 'class_occupied'
      && busyRow.hint.includes('已被已接受事件占用') && busyRow.action === '安排' && focusInPanel,
    JSON.stringify({ busyRow, focusInPanel, focusInfo }));

  await cdp.evaluate("[...document.querySelectorAll('#calendar-assignment-list .assignment-card button')].find((button) => button.textContent === '撤回').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  const withdrawConfirm = await cdp.evaluate("document.getElementById('confirm-text').textContent");
  await cdp.evaluate("document.getElementById('confirm-ok').click()");
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 2))})?.dataset.status === 'no_class'`));
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-assignments').hidden"));
  check('成员撤回：内置确认框说明影响范围，撤回后立即释放占用',
    withdrawConfirm.includes('周课表与个人日期记录不受影响')
      && withdrawConfirm.includes('不再占用'),
    withdrawConfirm.slice(0, 60));

  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  await gotoSpace(cdp, spaceId, 'collect');
  await openCollectDate(cdp, targetMonth, targetDate);
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-detail-body .collect-member-wrap').length > 0"));
  await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#collect-detail-body .collect-detail-period')];
    const row = rows[1];
    const wrap = [...row.querySelectorAll('.collect-member-wrap')]
      .find((item) => item.textContent.includes(${JSON.stringify(memberName)}));
    wrap.querySelector('.mini-action').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("document.getElementById('arrangement-dialog').open"));
  const arrangementWhen = await cdp.evaluate("document.getElementById('arrangement-when').textContent");
  await cdp.evaluate("document.getElementById('arrangement-send').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('arrangement-dialog').open"));
  await waitFor(() => cdp.evaluate("document.getElementById('collect-events-status').textContent.includes('请求已发送')"));
  check('负责人安排：收集页指定成员与节次发送站内请求，不直接改写成员课表',
    arrangementWhen.includes(targetDate) && arrangementWhen.includes('第 2 节'),
    arrangementWhen);

  await logoutUi(cdp);
  await loginUi(cdp, memberUsername);
  await gotoSpace(cdp, spaceId, 'calendar');
  await waitFor(() => cdp.evaluate("!document.getElementById('calendar-assignments').hidden"));
  const pendingBefore = await cdp.evaluate("document.getElementById('calendar-assignment-count').textContent");
  await openCalendarDate(cdp, targetMonth, targetDate);
  await cdp.evaluate("[...document.querySelectorAll('#calendar-assignment-list .assignment-card button')].find((button) => button.textContent === '拒绝').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  await cdp.evaluate("document.getElementById('confirm-cancel').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('confirm-dialog').open"));
  const stillPending = await cdp.evaluate("!document.getElementById('calendar-assignments').hidden && document.getElementById('calendar-assignment-count').textContent");
  // 取消后立即再次发起：旧 close 事件可能晚于新对话框打开，不能把新确认误判为取消。
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('#calendar-assignment-list .assignment-card button')]
      .find((button) => button.textContent === '拒绝').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  await cdp.evaluate(`(() => {
    document.getElementById('confirm-cancel').click();
    [...document.querySelectorAll('#calendar-assignment-list .assignment-card button')]
      .find((button) => button.textContent === '拒绝').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  await cdp.evaluate("document.getElementById('confirm-ok').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-assignments').hidden"));
  const rejectedRow = await cdp.evaluate(`document.querySelector(${JSON.stringify(periodRowSelector('calendar', targetDate, 2))})?.dataset.status`);
  check('成员拒绝：取消内置确认不写入，确认后待办消失且不占忙',
    pendingBefore.includes('待确认 1') && stillPending.includes('待确认 1')
      && rejectedRow === 'no_class',
    JSON.stringify({ pendingBefore, stillPending, rejectedRow }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.evaluate("location.hash = '#/spaces'");
  await gotoSpace(cdp, spaceId, 'calendar');
  await openCalendarDate(cdp, targetMonth, targetDate);
  const mobileMetrics = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#calendar-detail-body .detail-action')];
    const heights = buttons.map((button) => Math.round(button.getBoundingClientRect().height));
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      heights,
      rowCount: document.querySelectorAll(${JSON.stringify(periodRowSelector('calendar', targetDate, 1))}).length,
    };
  })()`);
  check('手机：单节行按钮触达高度不小于 44px 且无横向溢出',
    mobileMetrics.overflow <= 1 && mobileMetrics.heights.length > 0
      && mobileMetrics.heights.every((height) => height >= 44) && mobileMetrics.rowCount === 1,
    JSON.stringify(mobileMetrics));

  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  const ownerCalendar = await api(cdp, `/api/spaces/${spaceId}/calendar?month=${targetMonth}`);
  const createdEvent = (ownerCalendar.body?.events ?? []).find((entry) => entry.title === eventTitle);
  const removed = createdEvent
    ? await api(cdp, `/api/spaces/${spaceId}/events/delete`, {
      method: 'POST',
      body: { id: createdEvent.id, version: createdEvent.version },
    })
    : { status: 0 };
  check('准备：负责人删除事件以验证红标消失', removed.status === 200,
    JSON.stringify({ status: removed.status, found: Boolean(createdEvent) }));
  await logoutUi(cdp);
  await loginUi(cdp, memberUsername);
  await gotoSpace(cdp, spaceId, 'calendar');
  await openCalendarDate(cdp, targetMonth, targetDate);
  const markerGone = await cdp.evaluate(`(() => {
    const cell = document.querySelector('#calendar-grid button.cal-cell[data-date="${targetDate}"]');
    return {
      has: cell?.classList.contains('has-events') ?? null,
      badge: cell?.querySelector('.cal-event-badge')?.textContent ?? '',
    };
  })()`);
  check('删除后重新读取：事件红标与数量消失',
    markerGone.has === false && markerGone.badge === '', JSON.stringify(markerGone));

  check('页面运行时无未捕获异常或 console.error', cdp.pageErrors.length === 0,
    cdp.pageErrors.slice(0, 3).join(' | '));
}

async function main() {
  const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!edge) throw new Error('未找到 Edge/Chrome 可执行文件');
  const profile = await mkdtemp(join(tmpdir(), 'assignment-ui-'));
  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    let version = null;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (!response.ok) return null;
      version = await response.json();
      return version;
    }, { timeout: 15000 });
    const page = await (async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const found = pages.find((item) => item.type === 'page');
        if (found) return found;
        await sleep(100);
      }
      throw new Error('未找到可调试页面');
    })();
    cdp = await Cdp.open(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(600);
    await run(cdp);
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    child.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  const passed = results.filter((item) => item.ok).length;
  process.stdout.write(`\n安排浏览器检查：${passed}/${results.length} 通过\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

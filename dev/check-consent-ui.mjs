// 集中告知与可选共享浏览器检查：登录后待确认、拒绝可选仍可进入、
// 账号隐私入口批准/撤回、新建空间一次确认、公开条款页与登录草稿。
// 仅连接本地预览与内存假数据库，不代表托管环境。
//   node dev/check-consent-ui.mjs   （需先启动 dev/preview-server.mjs）
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
const PORT = Number(process.env.CDP_PORT ?? 9341);
const PASSWORD = `local-consent-${randomUUID()}-${randomUUID()}`;
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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.pageErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
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

async function registerUi(cdp, username, nickname = '负责人甲') {
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
    terms.checked = false;
    terms.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const disabledBefore = await cdp.evaluate("document.getElementById('login-submit').disabled");
  await cdp.evaluate(`(() => {
    const terms = document.getElementById('login-terms');
    terms.checked = true;
    terms.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('login-submit').disabled"));
  await cdp.evaluate("document.getElementById('login-submit').click()");
  await waitFor(() => cdp.evaluate(
    "document.getElementById('consent-dialog').open || !document.getElementById('app-panel').hidden",
  ), { timeout: 15000 });
  return disabledBefore;
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

async function createSpace(cdp, name) {
  return cdp.evaluate(`(async () => {
    const response = await fetch('/functions/v1/app/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: ${JSON.stringify(name)}, ownerName: '负责人甲', mode: 'courses',
        weekRule: 'every', visibility: 'masked_list',
        periods: [
          { index: 1, start: '08:00', end: '08:45' },
          { index: 2, start: '08:55', end: '09:40' },
          { index: 3, start: '10:00', end: '10:45' },
        ],
        teaching: {
          timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
          termStart: '2026-09-07', termEnd: '2027-01-24',
        },
      }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, id: body?.space?.id ?? null, body };
  })()`);
}

async function createSpaceUi(cdp, name) {
  await cdp.evaluate("location.hash = '#/spaces/new'");
  await pageVisible(cdp, 'create');
  await cdp.evaluate(`(() => {
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('create-name', ${JSON.stringify(name)});
    set('create-owner-name', '负责人甲');
    set('create-timezone', 'Asia/Shanghai');
    set('create-anchor', '2026-09-07');
    set('create-term-start', '2026-09-07');
    set('create-term-end', '2027-01-24');
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('create-submit').disabled"));
  await cdp.evaluate("document.getElementById('create-submit').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 15000 });
  const list = await api(cdp, '/api/spaces');
  return (list.body ?? []).find((space) => space.name === name) ?? null;
}

function monthNow() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).format(new Date());
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(120);
}

async function logoutUi(cdp) {
  await cdp.evaluate("document.getElementById('logout').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden && document.getElementById('app-panel').hidden"));
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const username = `consent_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const firstSpace = '同意流程空间';
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  const termsLinks = await cdp.evaluate("document.querySelectorAll('a[href*=\"terms.html\"]').length");
  await registerUi(cdp, username);
  await pageVisible(cdp, 'spaces');
  const created = await createSpace(cdp, firstSpace);
  check('账号与空间准备：注册可在未确认空间告知时完成，空间创建成功',
    termsLinks >= 2 && created.status === 201 && Boolean(created.id),
    JSON.stringify({ termsLinks, created }));

  await cdp.evaluate('location.reload()').catch(() => {});
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 15000 });
  const gate = await cdp.evaluate(`(() => {
    const row = document.querySelector('#consent-body .consent-space');
    return {
      title: document.getElementById('consent-title').textContent,
      versionHidden: document.getElementById('consent-version').hidden,
      hint: document.getElementById('consent-hint').textContent,
      rows: document.querySelectorAll('#consent-body .consent-space').length,
      summary: document.getElementById('consent-body').textContent,
      checkboxes: document.querySelectorAll('#consent-body .consent-switch input').length,
      switchChecked: row?.querySelector('.consent-switch input')?.checked ?? null,
      calendarPicks: row?.querySelectorAll('.consent-pick').length ?? 0,
      details: row?.querySelectorAll('.consent-details').length ?? 0,
      primary: document.getElementById('consent-continue').textContent,
      primaryDisabled: document.getElementById('consent-continue').disabled,
      necessaryHidden: document.getElementById('consent-necessary').hidden,
      necessary: document.getElementById('consent-necessary').textContent,
    };
  })()`);
  check('登录后集中告知：每个空间一行，日历必选与日期共享开关分离，共享默认关闭',
    gate.title === '隐私与共享' && gate.versionHidden === true
      && gate.hint.includes('日期共享可选，默认关闭') && gate.hint.includes('仅必要项')
      && gate.rows === 1 && gate.summary.includes(firstSpace)
      && gate.checkboxes === 1 && gate.switchChecked === false
      && gate.calendarPicks === 2 && gate.details === 1
      && gate.primary === '全部同意' && gate.primaryDisabled === false
      && gate.necessaryHidden === false && gate.necessary === '仅必要项',
    JSON.stringify(gate));

  const pendingState = await api(cdp, '/api/consents');
  const pendingItem = pendingState.body?.items?.find((item) => item.spaceId === created.id);
  check('仅展示不等于同意：弹窗打开时服务端仍为未确认，未提前写入任何授权',
    pendingState.status === 200 && pendingItem?.calendar?.status === 'unset'
      && pendingItem.calendar.accepted === false && pendingItem.calendar.pending === true
      && pendingItem.share.status === 'unset' && pendingItem.share.accepted === false
      && pendingItem.share.pending === true,
    JSON.stringify(pendingItem));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(160);
  const mobile = await cdp.evaluate(`(() => {
    const dialog = document.getElementById('consent-dialog');
    const body = document.getElementById('consent-body');
    const rect = dialog.getBoundingClientRect();
    const style = getComputedStyle(body);
    return {
      width: rect.width, left: rect.left, right: rect.right, top: rect.top,
      bodyOverflow: style.overflowY, bodyMaxHeight: style.maxHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    };
  })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  check('手机宽度下弹窗不溢出视口，正文可滚动且不锁整页滚动',
    mobile.width <= 390 && mobile.left >= 0 && mobile.right <= 390 && mobile.top >= 0
      && mobile.bodyOverflow === 'auto' && mobile.bodyMaxHeight !== 'none',
    JSON.stringify(mobile));

  await pressEscape(cdp);
  const stillOpen = await cdp.evaluate("document.getElementById('consent-dialog').open");
  check('必选告知未决定时 Esc 不绕过：弹窗保持打开', stillOpen === true, String(stillOpen));

  const rowState = await cdp.evaluate(`(() => {
    const row = document.querySelector('#consent-body .consent-space');
    return {
      sections: document.querySelectorAll('#consent-body .consent-space').length,
      calendarTitle: row.querySelector('.consent-line[data-kind="calendar"] strong').textContent,
      shareLabel: row.querySelector('.consent-switch span').textContent,
      picks: row.querySelectorAll('.consent-pick').length,
      pressed: [...row.querySelectorAll('.consent-pick')]
        .filter((button) => button.getAttribute('aria-pressed') === 'true').length,
      switchChecked: row.querySelector('.consent-switch input').checked,
      details: row.querySelectorAll('.consent-details').length,
      primary: document.getElementById('consent-continue').textContent,
    };
  })()`);
  check('空间行内日历必选与共享开关分开，无预选，主按钮仍为全部同意',
    rowState.sections === 1 && rowState.calendarTitle === '日历告知'
      && rowState.shareLabel === '向负责人共享日期状态'
      && rowState.picks === 2 && rowState.pressed === 0
      && rowState.switchChecked === false && rowState.details === 1
      && rowState.primary === '全部同意',
    JSON.stringify(rowState));

  const shareSwitch = "document.querySelector('#consent-body .consent-switch input')";
  const calendarBlock = "document.querySelector('#consent-body .consent-space')";
  await cdp.evaluate(`${shareSwitch}.click()`);
  const stagedShare = await cdp.evaluate(`(() => ({
    primary: document.getElementById('consent-continue').textContent,
    primaryDisabled: document.getElementById('consent-continue').disabled,
    shareChecked: ${shareSwitch}.checked,
    messageHidden: document.getElementById('consent-message').hidden,
  }))()`);
  const stagedServer = await api(cdp, '/api/consents');
  const stagedItem = stagedServer.body?.items?.find((item) => item.spaceId === created.id);
  check('切换共享开关先只保留选择：必选未决时不能继续，服务端仍无写入',
    stagedShare.primary === '按当前选择继续' && stagedShare.primaryDisabled === true
      && stagedShare.shareChecked === true && stagedShare.messageHidden === true
      && stagedItem?.share?.status === 'unset' && stagedItem.calendar.status === 'unset',
    JSON.stringify({ stagedShare, stagedItem }));

  await cdp.evaluate(`${calendarBlock}.querySelector('button[aria-label="同意当前日历告知"]').click()`);
  const retained = await cdp.evaluate(`(() => ({
    primary: document.getElementById('consent-continue').textContent,
    disabled: document.getElementById('consent-continue').disabled,
    shareChecked: ${shareSwitch}.checked,
    calendarPressed: ${calendarBlock}.querySelector('button[aria-label="同意当前日历告知"]').getAttribute('aria-pressed'),
  }))()`);
  check('日历与共享选择同时保留：主按钮改为按当前选择继续，仍不自动提交',
    retained.primary === '按当前选择继续' && retained.disabled === false
      && retained.shareChecked === true && retained.calendarPressed === 'true',
    JSON.stringify(retained));

  const beforeSubmit = await api(cdp, '/api/consents');
  const beforeItem = beforeSubmit.body?.items?.find((item) => item.spaceId === created.id);
  check('显式选择后才写授权：提交前服务端仍为未确认',
    beforeItem?.calendar?.status === 'unset' && beforeItem.share.status === 'unset',
    JSON.stringify(beforeItem));

  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  const afterSubmit = await api(cdp, '/api/consents');
  const afterItem = afterSubmit.body?.items?.find((item) => item.spaceId === created.id);
  check('按当前选择提交：日历同意与共享同意分别落版本/时间/状态',
    afterSubmit.status === 200 && afterItem?.calendar?.accepted === true
      && afterItem.calendar.status === 'accepted' && Boolean(afterItem.calendar.acceptedAt)
      && Boolean(afterItem.calendar.updatedAt)
      && afterItem.share.status === 'accepted' && afterItem.share.accepted === true
      && Boolean(afterItem.share.acceptedAt) && Boolean(afterItem.share.updatedAt),
    JSON.stringify(afterItem));

  await cdp.evaluate('location.reload()').catch(() => {});
  await waitFor(() => cdp.evaluate("!document.getElementById('page-spaces').hidden"), { timeout: 15000 });
  await sleep(400);
  const afterReload = await cdp.evaluate("document.getElementById('consent-dialog').open");
  check('版本未变不重复确认：刷新后不再弹出集中告知', afterReload === false, String(afterReload));

  await cdp.evaluate("location.hash = '#/spaces'");
  await pageVisible(cdp, 'spaces');
  const accountBefore = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#open-privacy')];
    const panel = document.getElementById('account-panel');
    return {
      text: buttons[0]?.textContent ?? '',
      tag: buttons[0]?.tagName ?? '',
      count: buttons.length,
      oldList: Boolean(document.getElementById('account-consents')),
      panelItems: [...(panel?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent.trim()),
    };
  })()`);
  check('账号只保留一个低频“隐私设置”入口：不重复罗列各空间全文或开关',
    accountBefore.text === '隐私设置' && accountBefore.tag === 'BUTTON'
      && accountBefore.count === 1 && accountBefore.oldList === false
      && accountBefore.panelItems.join('|') === '隐私设置|退出登录',
    JSON.stringify(accountBefore));

  await cdp.evaluate(`(() => {
    const button = document.getElementById('open-privacy');
    button.focus();
    button.click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  const manageCalendarBlock = "document.querySelector('#consent-body .consent-line[data-kind=\"calendar\"]')";
  const manageShareBlock = "document.querySelector('#consent-body .consent-line[data-kind=\"share\"]')";
  const manageShareSwitch = "document.querySelector('#consent-body .consent-switch input')";
  const manageState = await cdp.evaluate(`(() => ({
    summary: document.getElementById('consent-body').textContent,
    hint: document.getElementById('consent-hint').textContent,
    calendar: ${manageCalendarBlock}.textContent,
    share: ${manageShareBlock}.textContent,
    switchChecked: ${manageShareSwitch}.checked,
    gateContinue: document.getElementById('consent-continue').textContent,
    necessaryHidden: document.getElementById('consent-necessary').hidden,
    sections: document.querySelectorAll('#consent-body .consent-space').length,
    versionHidden: document.getElementById('consent-version').hidden,
  }))()`);
  check('隐私设置复用同一告知来源：每个空间一行，显示当前已同意/已共享状态',
    manageState.hint.includes('日期共享可选，默认关闭')
      && manageState.calendar.includes('已同意') && manageState.share.includes('已共享')
      && manageState.switchChecked === true
      && manageState.gateContinue === '完成' && manageState.necessaryHidden === true
      && manageState.sections === 1 && manageState.versionHidden === true,
    JSON.stringify(manageState));

  await cdp.evaluate(`${manageShareSwitch}.click()`);
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate(`${manageShareBlock}.textContent.includes('已撤回')`));
  const afterRevoke = await api(cdp, '/api/consents');
  check('关闭共享开关即撤回：状态为撤回且不影响空间访问',
    afterRevoke.status === 200
      && afterRevoke.body?.items?.find((item) => item.spaceId === created.id)?.share?.status === 'revoked'
      && afterRevoke.body?.items?.find((item) => item.spaceId === created.id)?.calendar?.accepted === true,
    JSON.stringify(afterRevoke.body?.items?.find((item) => item.spaceId === created.id)));
  await pressEscape(cdp);
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  const focusReturned = await cdp.evaluate(`(() => {
    const active = document.activeElement;
    return { text: active?.textContent ?? '', tag: active?.tagName ?? '' };
  })()`);
  check('隐私设置 Esc 关闭后焦点回到“隐私设置”入口', focusReturned.text === '隐私设置'
    && focusReturned.tag === 'BUTTON', JSON.stringify(focusReturned));

  const staleAccept = await api(cdp, `/api/spaces/${created.id}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: 's2b-calendar-1' },
  });
  const currentMonth = monthNow();
  const calendarState = await api(cdp, `/api/spaces/${created.id}/calendar?month=${currentMonth}`);
  check('旧版本告知不能冒充当前同意：过期版本写入被拒绝，当前记录未改变',
    staleAccept.status === 403 && staleAccept.body?.error === 'calendar_notice_required'
      && calendarState.body?.consent?.accepted === true,
    JSON.stringify({ stale: staleAccept.status, consent: calendarState.body?.consent }));

  const createdSecond = await createSpaceUi(cdp, '同意流程空间二');
  const createdSecondId = createdSecond?.id ?? null;
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  const createGate = await cdp.evaluate(`(() => ({
    spaces: [...document.querySelectorAll('#consent-body .consent-space')]
      .map((row) => row.dataset.space),
    primary: document.getElementById('consent-continue').textContent,
    disabled: document.getElementById('consent-continue').disabled,
    necessaryHidden: document.getElementById('consent-necessary').hidden,
    summary: document.getElementById('consent-body').textContent,
  }))()`);
  check('新建空间不要求退出重登：创建后先出现一次收起确认，只含当前空间',
    Boolean(createdSecondId) && createGate.spaces.length === 1
      && createGate.spaces[0] === createdSecondId
      && createGate.primary === '全部同意' && createGate.disabled === false
      && createGate.necessaryHidden === false
      && createGate.summary.includes('同意流程空间二'),
    JSON.stringify({ createdSecondId, createGate }));

  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  await pageVisible(cdp, 'home');
  const afterBulk = await api(cdp, '/api/consents');
  const bulkA = afterBulk.body?.items?.find((item) => item.spaceId === created.id);
  const bulkB = afterBulk.body?.items?.find((item) => item.spaceId === createdSecondId);
  check('一键全部同意只写当前待确认项：已撤回共享保持撤回，新空间的日期共享仍默认关闭',
    bulkA?.share?.status === 'revoked' && bulkA.share.accepted === false
      && bulkA.calendar.accepted === true
      && bulkB?.calendar?.accepted === true && bulkB.share.accepted === false
      && bulkB.share.status === 'unset' && bulkB.share.pending === true,
    JSON.stringify({ a: bulkA, b: bulkB }));

  const createdThird = await createSpace(cdp, '同意流程空间三');
  await logoutUi(cdp);
  const reloginDisabled = await loginUi(cdp, username);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 15000 });
  const bulkGate = await cdp.evaluate(`(() => ({
    spaces: [...document.querySelectorAll('#consent-body .consent-space')]
      .map((row) => row.dataset.space),
    primary: document.getElementById('consent-continue').textContent,
    disabled: document.getElementById('consent-continue').disabled,
    necessary: document.getElementById('consent-necessary').textContent,
    necessaryHidden: document.getElementById('consent-necessary').hidden,
    summary: document.getElementById('consent-body').textContent,
  }))()`);
  check('再次登录只展示当前待确认项：已撤回/已同意的旧空间不进入一键范围，且登录必须勾选条款',
    reloginDisabled === true && bulkGate.spaces.length === 1
      && bulkGate.spaces[0] === createdThird.id
      && bulkGate.primary === '全部同意' && bulkGate.disabled === false
      && bulkGate.necessaryHidden === false && bulkGate.necessary === '仅必要项'
      && bulkGate.summary.includes('同意流程空间三')
      && !bulkGate.summary.includes('同意流程空间二'),
    JSON.stringify({ reloginDisabled, bulkGate }));

  await cdp.evaluate("document.getElementById('consent-necessary').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"), { timeout: 15000 });
  await pageVisible(cdp, 'spaces');
  const afterNecessary = await api(cdp, '/api/consents');
  const necessaryThird = afterNecessary.body?.items?.find((item) => item.spaceId === createdThird.id);
  const necessaryFirst = afterNecessary.body?.items?.find((item) => item.spaceId === created.id);
  check('“仅必要项”同意日历告知并拒绝可选共享：不阻断登录，且不覆盖已撤回记录',
    necessaryThird?.calendar?.accepted === true
      && necessaryThird.share.status === 'declined' && necessaryThird.share.accepted === false
      && necessaryFirst?.share?.status === 'revoked'
      && necessaryFirst.calendar.accepted === true,
    JSON.stringify({ necessaryThird, necessaryFirst }));

  const createdFourth = await createSpace(cdp, '同意流程空间四');
  await logoutUi(cdp);
  await loginUi(cdp, username);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 15000 });
  await cdp.evaluate(`(() => {
    window.__origFetch = window.fetch.bind(window);
    window.__failConsentShareOnce = true;
    window.fetch = (input, init) => {
      const url = String(input);
      if (window.__failConsentShareOnce && url.includes('/calendar/share')
        && url.includes(${JSON.stringify(createdFourth.id)})) {
        window.__failConsentShareOnce = false;
        return Promise.resolve(new Response(JSON.stringify({ error: 'synthetic_partial_failure' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        }));
      }
      return window.__origFetch(input, init);
    };
    return true;
  })()`);
  await cdp.evaluate("document.querySelector('#consent-body .consent-pick[aria-label=\"同意当前日历告知\"]').click()");
  await cdp.evaluate("document.querySelector('#consent-body .consent-switch input').click()");
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-message').hidden"));
  const partial = await cdp.evaluate(`(() => ({
    open: document.getElementById('consent-dialog').open,
    message: document.getElementById('consent-message').textContent,
    primary: document.getElementById('consent-continue').textContent,
  }))()`);
  const partialState = await api(cdp, '/api/consents');
  const partialItem = partialState.body?.items?.find((item) => item.spaceId === createdFourth.id);
  check('部分失败如实展示：完成项与未完成项分开，不宣称全部成功并保留可重试选择',
    partial.open === true && partial.message.includes('1 项未完成')
      && partial.message.includes('同意流程空间四')
      && !partial.message.includes('已记录 2 项决定')
      && partial.primary === '按当前选择继续'
      && partialItem?.calendar?.accepted === true
      && partialItem.share.status === 'unset' && partialItem.share.pending === true,
    JSON.stringify({ partial, partialItem }));

  await cdp.evaluate("window.fetch = window.__origFetch; delete window.__origFetch; true");
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"), { timeout: 15000 });
  const retried = await api(cdp, '/api/consents');
  const retriedItem = retried.body?.items?.find((item) => item.spaceId === createdFourth.id);
  check('失败项可重试且结果落服务端：重试后两项均已确认',
    retriedItem?.calendar?.accepted === true && retriedItem.share.accepted === true
      && retriedItem.share.status === 'accepted',
    JSON.stringify(retriedItem));

  await cdp.evaluate(`(() => {
    const id = ${JSON.stringify(created.id)};
    window.__consentCalOrig = window.fetch.bind(window);
    window.__consentCalFetches = 0;
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('/calendar?month=') && url.includes(id)) window.__consentCalFetches += 1;
      return window.__consentCalOrig(input, init);
    };
    return true;
  })()`);
  await cdp.evaluate(`location.hash = '#/spaces/${created.id}/calendar'`);
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate(
    "!document.getElementById('calendar-table').hidden || !document.getElementById('calendar-empty').hidden",
  ));
  await sleep(200);
  const afterRevokeView = await cdp.evaluate(`(() => ({
    fetches: window.__consentCalFetches,
    oldAccountList: Boolean(document.getElementById('account-consents')),
    oldCalendarNote: Boolean(document.getElementById('calendar-consent-note')),
    oldCalendarText: Boolean(document.getElementById('calendar-consent-text')),
    oldShareEntry: Boolean(document.getElementById('calendar-share-open')),
    hasConsentItem: Boolean(document.querySelector('#page-calendar .consent-space, #page-calendar .consent-line')),
  }))()`);
  await cdp.evaluate("window.fetch = window.__consentCalOrig; delete window.__consentCalOrig; true");
  const afterRevokeCalendar = await api(cdp, `/api/spaces/${created.id}/calendar?month=${currentMonth}`);
  check('撤回后重新进入日历会重新读取：不再渲染旧告知/共享提示，服务端为已撤回',
    afterRevokeView.fetches >= 1 && !afterRevokeView.oldAccountList
      && !afterRevokeView.oldCalendarNote && !afterRevokeView.oldCalendarText
      && !afterRevokeView.oldShareEntry && !afterRevokeView.hasConsentItem
      && afterRevokeCalendar.body?.share?.consent?.status === 'revoked'
      && afterRevokeCalendar.body?.share?.consent?.accepted === false
      && afterRevokeCalendar.body?.share?.consent?.acceptedAt === null,
    JSON.stringify({ afterRevokeView, consent: afterRevokeCalendar.body?.share?.consent }));

  await cdp.evaluate(`location.hash = '#/spaces/${created.id}/schedule'`);
  await pageVisible(cdp, 'schedule');
  await sleep(250);
  const scheduleConsent = await cdp.evaluate(`(() => ({
    items: document.querySelectorAll('#page-schedule .consent-space, #page-schedule .consent-line').length,
    text: document.getElementById('page-schedule').innerText,
    oldNote: Boolean(document.getElementById('schedule-consent-note')),
  }))()`);
  check('课表页不再嵌入整段告知或重复隐私开关',
    scheduleConsent.items === 0 && !scheduleConsent.oldNote
      && !scheduleConsent.text.includes('日历告知')
      && !scheduleConsent.text.includes('日期状态共享'),
    JSON.stringify({ items: scheduleConsent.items, oldNote: scheduleConsent.oldNote }));

  await logoutUi(cdp);
  await cdp.evaluate(`(() => {
    document.getElementById('auth-tab-login').click();
    const username = document.getElementById('login-username');
    username.value = ${JSON.stringify(username)};
    username.dispatchEvent(new Event('input', { bubbles: true }));
    const terms = document.getElementById('login-terms');
    terms.checked = true;
    terms.dispatchEvent(new Event('change', { bubbles: true }));
    const password = document.getElementById('login-password');
    password.value = 'secret-not-persisted';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const loginDraft = await cdp.evaluate(`(() => {
    const raw = sessionStorage.getItem('s0-login-draft-v1') ?? '';
    const draft = JSON.parse(raw || 'null');
    return {
      username: draft?.username ?? '',
      terms: draft?.terms === true,
      hasPassword: raw.includes('secret-not-persisted'),
      urlHasPassword: location.href.includes('secret-not-persisted'),
    };
  })()`);
  check('返回登录页保留账号与条款勾选，口令不写 URL 或持久存储',
    loginDraft.username === username && loginDraft.terms === true
      && loginDraft.hasPassword === false && loginDraft.urlHasPassword === false,
    JSON.stringify(loginDraft));

  await cdp.evaluate("location.href = './terms.html?from=login'");
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('terms-content')"));
  await waitFor(() => cdp.evaluate("!document.getElementById('terms-content').hidden"), { timeout: 15000 });
  const terms = await cdp.evaluate(`(() => ({
    title: document.title,
    general: document.querySelectorAll('#terms-general li').length,
    join: document.getElementById('terms-join').textContent,
    calendar: document.getElementById('terms-calendar').textContent,
    share: document.getElementById('terms-share').textContent,
    note: document.body.textContent,
    back: document.getElementById('terms-back').textContent,
    authVisible: Boolean(document.getElementById('auth-panel')),
  }))()`);
  check('独立条款页未登录可读：一般规则、必选告知与可选共享完整展示',
    terms.title.includes('条款') && terms.general >= 4 && terms.join.length > 0
      && terms.calendar.includes('日期') && terms.share.includes('共享')
      && terms.note.includes('可选共享不是使用课表、日历或收集功能的前提')
      && terms.note.includes('已经下载或截图的文件无法收回')
      && terms.note.includes('已经拒绝或撤回的项不会因一键同意自动恢复')
      && terms.back === '返回' && !terms.authVisible,
    JSON.stringify({ title: terms.title, general: terms.general, back: terms.back }));

  await cdp.evaluate("document.getElementById('terms-back').click()");
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('auth-panel')"));
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  const restored = await cdp.evaluate(`(() => ({
    username: document.getElementById('login-username').value,
    terms: document.getElementById('login-terms').checked,
    password: document.getElementById('login-password').value,
  }))()`);
  check('从条款页返回登录后恢复已填账号与勾选，口令需要重新输入',
    restored.username === username && restored.terms === true && restored.password === '',
    JSON.stringify(restored));

  const finalLoginDisabled = await loginUi(cdp, username);
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"), { timeout: 15000 });
  await pageVisible(cdp, 'spaces');
  check('再次登录仍要求勾选条款，登录后无待确认项直接进入应用',
    finalLoginDisabled === true && !(await cdp.evaluate("document.getElementById('consent-dialog').open")),
    String(finalLoginDisabled));

  const finalErrors = cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text));
  check('页面运行时无未捕获异常或 console.error', finalErrors.length === 0, finalErrors.slice(0, 3).join(' | '));

  return { username, spaceId: created.id, secondId: createdSecondId };
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) {
    process.stdout.write('SKIP 未找到 Edge/Chrome，可跳过同意流程浏览器检查\n');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 'consent-cdp-'));
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
  }
  const passed = results.filter((item) => item.ok).length;
  process.stdout.write(`\n同意流程浏览器检查：${passed}/${results.length} 通过\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();

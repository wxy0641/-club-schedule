// S3 浏览器检查：负责人参与、共享同意、收集日历、真实 XLSX 下载、
// 空间事件可见性、页面切换与移动端触达。仅在装有 Edge/Chrome 的开发机运行；
// 使用本地预览与内存假数据库，不代表部署环境或真实 Provider 权限。
//   node dev/check-s3-ui.mjs   （需要先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
const PORT = Number(process.env.CDP_PORT ?? 9336);
const PASSWORD = `local-s3-${randomUUID()}-${randomUUID()}`;
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
  return waitFor(() => cdp.evaluate(`document.getElementById('page-${name}').hidden === false`));
}

async function waitSpaceHome(cdp) {
  await pageVisible(cdp, 'home');
  await waitFor(() => cdp.evaluate("!document.getElementById('home-content').hidden"));
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

async function setChecked(cdp, id, checked = true) {
  await cdp.evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    if (input.checked !== ${checked}) input.click();
    return input.checked;
  })()`);
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

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(120);
}

async function loginUi(cdp, username, { dismissOptionalGate = false } = {}) {
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
  await passConsentGate(cdp, { dismiss: dismissOptionalGate });
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

async function settleSpaceConsent(cdp, spaceId, { share = 'decline' } = {}) {
  const notice = await api(cdp, '/api/notice');
  const calendar = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: notice.body?.calendar?.version },
  });
  let shareStatus = null;
  if (share) {
    const response = await api(cdp, `/api/spaces/${spaceId}/calendar/share`, {
      method: 'POST',
      body: { action: share, noticeVersion: notice.body?.share?.version },
    });
    shareStatus = response.status;
  }
  return { calendar: calendar.status, share: shareStatus };
}

async function passConsentGate(cdp, { dismiss = false } = {}) {
  try {
    await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 1200, interval: 80 });
  } catch {
    return false;
  }
  if (dismiss) {
    await pressEscape(cdp);
    await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
    return true;
  }
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-continue').disabled"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  return true;
}

async function openSpaceCard(cdp, name) {
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.space-button').length > 0"));
  await cdp.evaluate(`[...document.querySelectorAll('.space-button')]
    .find((button) => button.textContent.includes(${JSON.stringify(name)})).click()`);
  await waitSpaceHome(cdp);
}

async function pickDateInDialog(cdp, buttonId, date, { invalidDate = '' } = {}) {
  await cdp.evaluate(`document.getElementById(${JSON.stringify(buttonId)}).click()`);
  await waitFor(() => cdp.evaluate("document.getElementById('date-picker-dialog').open"));
  const nativeInputs = await cdp.evaluate(`document.querySelectorAll('#date-picker-dialog input[type="date"], #date-picker-dialog input[type="time"], #date-picker-dialog select').length`);
  let invalidStatus = '';
  if (invalidDate) {
    await cdp.evaluate(`(() => {
      const input = document.getElementById('date-picker-input');
      input.value = ${JSON.stringify(invalidDate)};
      document.getElementById('date-picker-apply-text').click();
      return true;
    })()`);
    invalidStatus = await cdp.evaluate("document.getElementById('date-picker-status').textContent");
  }
  await cdp.evaluate(`(() => {
    const input = document.getElementById('date-picker-input');
    input.value = ${JSON.stringify(date)};
    document.getElementById('date-picker-apply-text').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('date-picker-confirm').disabled"));
  await cdp.evaluate("document.getElementById('date-picker-confirm').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('date-picker-dialog').open"));
  return {
    nativeInputs,
    invalidStatus,
    hidden: await cdp.evaluate(`document.getElementById(${JSON.stringify(buttonId.replace(/-button$/, ''))}).value`),
    buttonText: await cdp.evaluate(`document.getElementById(${JSON.stringify(buttonId)}).textContent`),
  };
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

async function openCollectTarget(cdp, month, date) {
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-content').hidden"));
  await cdp.evaluate("document.getElementById('collect-tab-calendar').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-calendar-table').hidden || !document.getElementById('collect-calendar-empty').hidden"));
  await ensureMonth(cdp, {
    labelId: 'collect-month', prevId: 'collect-prev', nextId: 'collect-next',
  }, month);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${date}"]')`));
  await cdp.evaluate(`document.querySelector('#collect-calendar-grid button.cal-cell[data-date="${date}"]').click()`);
  await waitFor(() => cdp.evaluate(`document.getElementById('collect-detail-title').textContent.includes(${JSON.stringify(date)})`));
}

async function openPersonalTarget(cdp, month, date) {
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("!document.getElementById('calendar-table').hidden || !document.getElementById('calendar-empty').hidden"));
  await ensureMonth(cdp, {
    labelId: 'calendar-month', prevId: 'calendar-prev', nextId: 'calendar-next',
  }, month);
  await waitFor(() => cdp.evaluate(`!!document.querySelector('#calendar-grid button.cal-cell[data-date="${date}"]')`));
  await cdp.evaluate(`document.querySelector('#calendar-grid button.cal-cell[data-date="${date}"]').click()`);
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-detail-title').textContent.includes(${JSON.stringify(date)})`));
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags & 0x0008) throw new Error('xlsx 不应依赖 data descriptor');
    if (method !== 0) throw new Error('xlsx 条目应为 store 模式');
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + size;
  }
  return entries;
}

function sheetNames(workbookText) {
  return [...workbookText.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((match) => match[1]);
}

async function waitDownload(directory, timeout = 12000) {
  const started = Date.now();
  let lastSize = -1;
  while (Date.now() - started < timeout) {
    const names = (await readdir(directory)).filter((name) => !name.endsWith('.crdownload'));
    for (const name of names) {
      if (!name.endsWith('.xlsx')) continue;
      const path = join(directory, name);
      const info = await stat(path).catch(() => null);
      if (info && info.size > 0 && info.size === lastSize) return { name, path, size: info.size };
      if (info) lastSize = info.size;
    }
    await sleep(120);
  }
  throw new Error('等待下载超时');
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
  const spaceName = `S3 路由空间 ${suffix}`;
  const eventTitle = `S3事件${suffix}`;
  const ownerUsername = `own_${suffix}`;
  const memberUsername = `mem_${suffix}`;
  const memberName = '=SUM(1,1)';

  // 注册即时校验：未触碰字段不报错，触碰后即时显示；清空后错误消失。
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  await cdp.evaluate("document.getElementById('auth-tab-register').click()");
  const untouched = await cdp.evaluate(`(() => ({
    username: document.getElementById('register-username-error').hidden,
    password: document.getElementById('register-password-error').hidden,
    confirm: document.getElementById('register-confirm-error').hidden,
    submit: document.getElementById('register-submit').disabled,
  }))()`);
  await cdp.evaluate(`(() => {
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('register-username', 'A!');
    set('register-password', 'short');
    set('register-confirm', 'different');
    return true;
  })()`);
  const invalid = await cdp.evaluate(`(() => ({
    username: document.getElementById('register-username-error').textContent,
    password: document.getElementById('register-password-error').textContent,
    confirm: document.getElementById('register-confirm-error').textContent,
    submit: document.getElementById('register-submit').disabled,
  }))()`);
  await cdp.evaluate(`(() => {
    for (const id of ['register-username', 'register-password', 'register-confirm']) {
      const input = document.getElementById(id);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
  const cleared = await cdp.evaluate(`(() => ({
    username: document.getElementById('register-username-error').textContent,
    passwordHidden: document.getElementById('register-password-error').hidden,
    confirmHidden: document.getElementById('register-confirm-error').hidden,
    submit: document.getElementById('register-submit').disabled,
  }))()`);
  check('注册即时校验：未触碰不报错，格式/长度/一致性即时提示，清空后仅保留必填提示',
    untouched.username && untouched.password && untouched.confirm && untouched.submit
      && invalid.username.includes('3–32') && invalid.password.includes('至少需要 8 个字符')
      && invalid.confirm.includes('不一致') && invalid.submit
      && cleared.username === '请输入登录账号。' && cleared.passwordHidden
      && cleared.confirmHidden && cleared.submit,
    JSON.stringify({ untouched, invalid, cleared }));

  await registerUi(cdp, ownerUsername, '负责人甲');
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("!document.getElementById('spaces-empty').hidden"));
  await cdp.evaluate("document.getElementById('open-create').click()");
  await pageVisible(cdp, 'create');
  const createNative = await cdp.evaluate(`document.querySelectorAll('#create-form input[type="date"], #create-form select').length`);
  const blankTimezone = await cdp.evaluate(`(() => ({
    value: document.getElementById('create-timezone').value,
    text: document.getElementById('create-timezone-button').textContent,
  }))()`);
  await cdp.evaluate("document.getElementById('create-timezone-button').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('create-timezone-panel').hidden === false"));
  await fill(cdp, { 'create-timezone-search': 'shang' });
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#create-timezone-list .tz-option').length > 0"));
  const tzOptions = await cdp.evaluate("[...document.querySelectorAll('#create-timezone-list .tz-option')].map((button) => button.dataset.value)");
  await cdp.evaluate("document.querySelector('#create-timezone-list .tz-option[data-value=\"Asia/Shanghai\"]').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('create-timezone-panel').hidden === true"));
  const timezonePicked = await cdp.evaluate(`(() => ({
    value: document.getElementById('create-timezone').value,
    text: document.getElementById('create-timezone-button').textContent,
  }))()`);
  const anchorPick = await pickDateInDialog(cdp, 'create-anchor-button', monday, { invalidDate: addDays(monday, 1) });
  const startPick = await pickDateInDialog(cdp, 'create-term-start-button', monday);
  const endPick = await pickDateInDialog(cdp, 'create-term-end-button', termEnd);
  await fill(cdp, {
    'create-name': spaceName,
    'create-owner-name': '负责人甲',
  });
  await cdp.evaluate("document.querySelector('input[name=\"create-mode\"][value=\"courses\"]').click()");
  await cdp.evaluate("document.querySelector('input[name=\"create-visibility\"][value=\"masked_list\"]').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('create-submit').disabled"));
  const previewText = await cdp.evaluate("document.getElementById('create-teaching-preview').textContent");
  check('应用内日期/时区选择：无原生日期控件，周一限制可见，手动识别后显式确认',
    createNative === 0 && blankTimezone.value === '' && blankTimezone.text.includes('选择时区')
      && tzOptions.includes('Asia/Shanghai') && timezonePicked.value === 'Asia/Shanghai'
      && timezonePicked.text === '北京时间（UTC+8）'
      && anchorPick.nativeInputs === 0 && anchorPick.invalidStatus.includes('周一')
      && anchorPick.hidden === monday && startPick.hidden === monday && endPick.hidden === termEnd
      && previewText.includes('教学周'),
    JSON.stringify({ createNative, blankTimezone, anchorPick, startPick, endPick, previewText }));
  await cdp.evaluate("document.getElementById('create-submit').click()");
  await passConsentGate(cdp);
  await waitSpaceHome(cdp);
  const spaceId = await spaceIdFromHash(cdp);
  check('创建空间：选择结果进入首页并带有效空间标识', Boolean(spaceId), String(spaceId));

  const publishedOwner = await api(cdp, `/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    body: {
      requestId: `s3ui_${suffix}_own`,
      baseRevision: 0,
      entries: [{ day: 1, period: 1, weekRule: 'every', courseName: '负责人课程' }],
    },
  });
  check('负责人课表提交：有效课表已发布', publishedOwner.status === 201, String(publishedOwner.status));

  const ownerConsent = await settleSpaceConsent(cdp, spaceId);
  check('负责人日历告知与可选共享集中记录（测试前置）',
    ownerConsent.calendar === 200 && ownerConsent.share === 200, JSON.stringify(ownerConsent));

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/schedule\"]').click()");
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  const ownerSchedule = await cdp.evaluate(`(() => ({
    collection: Boolean(document.getElementById('schedule-collection')),
    periodsSummary: Boolean(document.getElementById('schedule-periods-text')),
    weekDays: document.querySelectorAll('.week-table thead th').length,
    calendarEntry: Boolean(document.getElementById('schedule-calendar')),
    weekSwitcher: Boolean(document.getElementById('schedule-week-label')),
  }))()`);
  check('负责人课表：纯周模板，不常驻参与/作息说明，不提供具体周切换或重复日历入口',
    ownerSchedule.collection === false && ownerSchedule.periodsSummary === false
      && ownerSchedule.weekDays === 8 && !ownerSchedule.calendarEntry && !ownerSchedule.weekSwitcher,
    JSON.stringify(ownerSchedule));

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/settings\"]').click()");
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.length > 0"));
  const beforeJoin = await cdp.evaluate(`(() => ({
    checked: document.getElementById('settings-participation-check').checked,
    status: document.getElementById('settings-participation-status').textContent,
  }))()`);
  check('负责人参与归位空间设置：初始未选择且不计入收集',
    beforeJoin.checked === false && beforeJoin.status.includes('尚未选择'), JSON.stringify(beforeJoin));

  await setChecked(cdp, 'settings-participation-check', true);
  await waitFor(() => cdp.evaluate("!document.getElementById('settings-participation-choice').hidden"));
  const joinChoice = await cdp.evaluate(`(() => ({
    status: document.getElementById('settings-participation-status').textContent,
    keep: document.getElementById('settings-participation-keep').textContent,
    edit: document.getElementById('settings-participation-edit').textContent,
  }))()`);
  await cdp.evaluate("document.getElementById('settings-participation-keep').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.startsWith('已参与')"));
  const ownerParticipation = await api(cdp, `/api/spaces/${spaceId}/participation`);
  check('负责人参与：已有有效课表时先选择沿用/改后提交，沿用后计入收集',
    joinChoice.keep === '沿用已交' && joinChoice.edit === '重新提交'
      && ownerParticipation.body?.participation?.status === 'joined',
    JSON.stringify({ joinChoice, status: ownerParticipation.status }));

  const invite = await api(cdp, `/api/spaces/${spaceId}/invite`, { method: 'POST' });
  const inviteCode = invite.body?.code;
  check('负责人可生成邀请码（不输出内容）', invite.status === 201 && typeof inviteCode === 'string');

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-content').hidden"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-summary .stat').length === 3"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-members-body tr').length >= 1"));
  const collectOwnerOnly = await cdp.evaluate(`(() => ({
    summary: [...document.querySelectorAll('#collect-summary .stat')].map((card) => card.textContent),
    rows: [...document.querySelectorAll('#collect-members-body tr')].map((row) => row.textContent),
    tabs: [...document.querySelectorAll('#collect-tabs button')].map((button) => button.textContent),
    exportText: document.getElementById('collect-export').textContent,
  }))()`);
  check('负责人收集概览：仅统计参与负责人一次，入口含概览/日历/导出',
    collectOwnerOnly.summary.some((text) => text.includes('成员总数') && text.includes('1'))
      && collectOwnerOnly.summary.some((text) => text.includes('已提交') && text.includes('1'))
      && collectOwnerOnly.rows.some((text) => text.includes('负责人甲') && text.includes('已参与') && text.includes('已提交'))
      && collectOwnerOnly.tabs.includes('收集概览') && collectOwnerOnly.tabs.includes('收集日历')
      && collectOwnerOnly.exportText === '导出课表',
    JSON.stringify(collectOwnerOnly));

  // 成员注册、加入、权限边界与共享前状态
  await logoutUi(cdp);
  await registerUi(cdp, memberUsername, '成员乙');
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("!document.getElementById('spaces-empty').hidden"));
  await cdp.evaluate("document.getElementById('open-join').click()");
  await pageVisible(cdp, 'join');
  await fill(cdp, { 'join-code': inviteCode, 'join-name': memberName });
  await cdp.evaluate("document.getElementById('join-notice').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('join-submit').disabled"));
  const shareUnchecked = await cdp.evaluate("document.getElementById('join-share').checked");
  await cdp.evaluate("document.getElementById('join-submit').click()");
  await waitSpaceHome(cdp);
  const memberConsent = await settleSpaceConsent(cdp, spaceId, { share: null });
  const memberHome = await cdp.evaluate(`(() => ({
    role: document.getElementById('space-role').textContent,
    nav: [...document.querySelectorAll('#side-space-links .side-link')].map((link) => link.textContent),
    collect: [...document.querySelectorAll('#home-status-grid .stat')].some((card) => card.textContent.includes('收集进度')),
  }))()`);
  check('成员加入：默认不勾选日期共享，导航不出现收集或设置',
    !shareUnchecked && memberHome.nav.includes('我的课表') && memberHome.nav.includes('我的日历')
      && !memberHome.nav.includes('课表收集') && !memberHome.nav.includes('空间设置')
      && !memberHome.collect && memberConsent.calendar === 200,
    JSON.stringify({ ...memberHome, consent: memberConsent }));

  await setHash(cdp, `#/spaces/${spaceId}/collect`);
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-denied').hidden"));
  const collectGate = await cdp.evaluate(`(() => ({
    denied: !document.getElementById('collect-denied').hidden,
    content: document.getElementById('collect-content').hidden,
  }))()`);
  await setHash(cdp, `#/spaces/${spaceId}/settings`);
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("!document.getElementById('settings-denied').hidden"));
  const memberGates = await cdp.evaluate(`(() => ({
    collectDenied: ${collectGate.denied},
    collectContent: ${collectGate.content},
    settingsDenied: !document.getElementById('settings-denied').hidden,
    settingsContent: document.getElementById('settings-content').hidden,
    back: document.getElementById('settings-denied-back').textContent,
  }))()`);
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
      members: await call('/api/spaces/${spaceId}/members'),
      invite: await call('/api/spaces/${spaceId}/invite', 'POST'),
      teaching: await call('/api/spaces/${spaceId}/teaching', 'POST', { teaching: {
        timezone: 'Asia/Shanghai', firstWeekMonday: '${monday}',
        termStart: '${monday}', termEnd: '${termEnd}',
      } }),
      participation: await call('/api/spaces/${spaceId}/participation'),
      collection: await call('/api/spaces/${spaceId}/collection?month=${targetMonth}'),
      export: await call('/api/spaces/${spaceId}/collection/export?month=${targetMonth}&date=${targetDate}'),
      events: await call('/api/spaces/${spaceId}/events', 'POST', { id: crypto.randomUUID(), title: 'x', startDate: '${targetDate}' }),
    };
  })()`);
  check('成员权限边界：页面拒绝收集/设置，服务端拒绝管理接口、导出和事件写入',
    memberGates.collectDenied && memberGates.collectContent
      && memberGates.settingsDenied && memberGates.settingsContent && memberGates.back.includes('返回空间')
      && Object.values(memberAdmin).every((status) => status === 403),
    JSON.stringify({ memberGates, memberAdmin }));

  await setHash(cdp, `#/spaces/${spaceId}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  const memberSchedule = await cdp.evaluate(`(() => ({
    collection: Boolean(document.getElementById('schedule-collection')),
    periodsSummary: Boolean(document.getElementById('schedule-periods-text')),
    calendarEntry: Boolean(document.getElementById('schedule-calendar')),
    weekDays: document.querySelectorAll('.week-table thead th').length,
  }))()`);
  check('成员课表：不显示参与收集和常驻作息说明，也不重复日历入口',
    !memberSchedule.collection && memberSchedule.periodsSummary === false
      && !memberSchedule.calendarEntry && memberSchedule.weekDays === 8,
    JSON.stringify(memberSchedule));

  const publishedMember = await api(cdp, `/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    body: { requestId: `s3ui_${suffix}_mem`, baseRevision: 0, entries: [] },
  });
  const memberCalendar = await api(cdp, `/api/spaces/${spaceId}/calendar?month=${targetMonth}`);
  const calendarNoticeVersion = memberCalendar.body?.notice?.version;
  const calendarConsent = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { noticeAccepted: true, noticeVersion: calendarNoticeVersion },
  });
  const exception = await api(cdp, `/api/spaces/${spaceId}/exceptions`, {
    method: 'POST',
    body: {
      requestId: `s3ui_${suffix}_ex`,
      baseVersion: 0,
      action: 'save',
      date: targetDate,
      period: 1,
      cancelClass: false,
      personalState: 'available',
      noticeAccepted: true,
      noticeVersion: calendarNoticeVersion,
    },
  });
  check('成员提交空课表并声明一个未来节次“有空”',
    publishedMember.status === 201 && calendarConsent.status === 200 && exception.status === 201,
    JSON.stringify({
      publish: publishedMember.status,
      consent: calendarConsent.status,
      exception: exception.status,
      error: exception.body?.error,
    }));

  await setHash(cdp, `#/spaces/${spaceId}/calendar`);
  await pageVisible(cdp, 'calendar');
  const shareBefore = await cdp.evaluate(`(() => ({
    strips: ['calendar-consent-note', 'calendar-share-open', 'calendar-consent-open', 'calendar-consent-text']
      .filter((id) => document.getElementById(id)),
    calendarText: document.getElementById('page-calendar').textContent,
  }))()`);
  const shareStateBefore = await api(cdp, `/api/spaces/${spaceId}/calendar?month=${targetMonth}`);
  const shareConsentBefore = shareStateBefore.body?.share?.consent;
  check('成员共享前：日历不再重复整段告知或开关，服务端共享仍为未确认',
    shareBefore.strips.length === 0
      && !shareBefore.calendarText.includes('我同意按上述范围共享')
      && !shareBefore.calendarText.includes('负责人可以在收集日历中看到')
      && shareConsentBefore?.accepted === false && shareConsentBefore?.pending === true,
    JSON.stringify({ shareBefore, shareConsentBefore }));

  // 共享前，负责人只看到已提交课表的有课/没课，看不到日期级的“有空”声明，也不进入待确认。
  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  await openSpaceCard(cdp, spaceName);
  await setHash(cdp, `#/spaces/${spaceId}/collect`);
  await openCollectTarget(cdp, targetMonth, targetDate);
  const ownerHasClass = weekdayMon1(targetDate) === 1;
  const preConsent = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#collect-detail-body .collect-detail-period')]
      .find((item) => item.textContent.includes('第 1 节'));
    return {
      counts: [...row.querySelectorAll('.collect-counts .cal-token')].map((tag) => tag.textContent),
      groups: [...row.querySelectorAll('.collect-group')].map((item) => item.textContent),
      pendingSummary: row.querySelector('.collect-pending summary')?.textContent ?? '',
      pendingOpen: row.querySelector('.collect-pending')?.open ?? null,
      text: row.textContent,
    };
  })()`);
  const freeBefore = preConsent.groups.filter((text) => text.startsWith('没课'));
  check('共享前投影：只按已提交课表显示有课/没课，不泄露主动有空也不进入待确认',
    preConsent.counts.includes(`有课 ${ownerHasClass ? 1 : 0}`)
      && preConsent.counts.includes('忙碌 0')
      && preConsent.counts.includes(`没课/有空 ${ownerHasClass ? 1 : 2}`)
      && preConsent.counts.every((text) => !text.startsWith('待确认'))
      && freeBefore.some((text) => text.includes(memberName))
      && freeBefore.every((text) => !text.includes('（主动）'))
      && !preConsent.groups.some((text) => text.startsWith('忙碌'))
      && (ownerHasClass || !preConsent.groups.some((text) => text.startsWith('有课')))
      && preConsent.pendingOpen === null
      && !preConsent.text.includes('明确可用'),
    JSON.stringify(preConsent));

  // 成员确认共享后，负责人才能看到“明确可用”
  await logoutUi(cdp);
  await loginUi(cdp, memberUsername, { dismissOptionalGate: true });
  const gateDismissed = await api(cdp, `/api/spaces/${spaceId}/calendar?month=${targetMonth}`);
  check('成员重新登录关闭可选共享告知：未点击不写决定，共享仍待确认',
    gateDismissed.body?.share?.consent?.pending === true
      && gateDismissed.body?.share?.consent?.accepted === false,
    JSON.stringify(gateDismissed.body?.share?.consent));
  // 可选共享只在低频“隐私设置”中处理，不再占用日历页面。
  await setHash(cdp, '#/spaces');
  await pageVisible(cdp, 'spaces');
  await cdp.evaluate("document.getElementById('open-privacy').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  const shareBlock = "document.querySelector('#consent-body .consent-line[data-kind=\"share\"]')";
  await cdp.evaluate(`${shareBlock}.querySelector('.consent-switch input').click()`);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-continue').textContent === '按当前选择继续'"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate(`${shareBlock}.textContent.includes('已共享')`));
  const shareStateAfter = await api(cdp, `/api/spaces/${spaceId}/calendar?month=${targetMonth}`);
  const shareConsentAfter = shareStateAfter.body?.share?.consent;
  check('成员在隐私设置中确认共享：服务端记录已允许共享，可随时撤回',
    shareConsentAfter?.accepted === true && shareConsentAfter?.pending === false,
    JSON.stringify(shareConsentAfter));
  await pressEscape(cdp);
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));

  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  await openSpaceCard(cdp, spaceName);
  await setHash(cdp, `#/spaces/${spaceId}/collect`);
  await openCollectTarget(cdp, targetMonth, targetDate);
  const postConsent = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('#collect-detail-body .collect-detail-period')]
      .find((item) => item.textContent.includes('第 1 节'));
    return {
      counts: [...row.querySelectorAll('.collect-counts .cal-token')].map((tag) => tag.textContent),
      groups: [...row.querySelectorAll('.collect-group')].map((item) => item.textContent),
      pending: Boolean(row.querySelector('.collect-pending')),
      pendingSummary: row.querySelector('.collect-pending summary')?.textContent ?? '',
    };
  })()`);
  const freeAfter = postConsent.groups.find((text) => text.startsWith('没课')) ?? '';
  check('共享后投影：主动有空在没课组内单独计数并加深标记，待确认入口仍不存在',
    postConsent.counts.includes(`没课/有空 ${ownerHasClass ? 1 : 2}`)
      && postConsent.counts.every((text) => !text.startsWith('待确认'))
      && freeAfter.includes(memberName) && freeAfter.includes('（主动）')
      && !postConsent.pending,
    JSON.stringify(postConsent));

  // 负责人退出/重新参与不重复计数
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/settings\"]').click()");
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.length > 0"));
  await waitFor(() => cdp.evaluate("(() => { const input = document.getElementById('settings-participation-check'); return !input.disabled && input.checked; })()"));
  await setChecked(cdp, 'settings-participation-check', false);
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.startsWith('未参与')"));
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-summary .stat').length === 3"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-members-body tr').length >= 1"));
  await waitFor(() => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#collect-members-body tr')].map((row) => row.textContent);
    const summary = [...document.querySelectorAll('#collect-summary .stat')].map((card) => card.textContent);
    return rows.some((text) => text.includes('负责人甲') && text.includes('未参与'))
      && summary.some((text) => text.includes('成员总数') && text.includes('1'));
  })()`));
  const afterLeave = await cdp.evaluate(`(() => ({
    summary: [...document.querySelectorAll('#collect-summary .stat')].map((card) => card.textContent),
    rows: [...document.querySelectorAll('#collect-members-body tr')].map((row) => row.textContent),
  }))()`);
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/settings\"]').click()");
  await pageVisible(cdp, 'settings');
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.length > 0"));
  await waitFor(() => cdp.evaluate("(() => { const input = document.getElementById('settings-participation-check'); return !input.disabled && !input.checked; })()"));
  await setChecked(cdp, 'settings-participation-check', true);
  await waitFor(() => cdp.evaluate("!document.getElementById('settings-participation-choice').hidden"));
  await cdp.evaluate("document.getElementById('settings-participation-keep').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('settings-participation-status').textContent.startsWith('已参与')"));
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-summary .stat').length === 3"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-members-body tr').length >= 2"));
  await waitFor(() => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#collect-members-body tr')].map((row) => row.textContent);
    const summary = [...document.querySelectorAll('#collect-summary .stat')].map((card) => card.textContent);
    return rows.some((text) => text.includes('负责人甲') && text.includes('已参与'))
      && summary.some((text) => text.includes('成员总数') && text.includes('2'));
  })()`));
  const afterRejoin = await cdp.evaluate(`(() => ({
    summary: [...document.querySelectorAll('#collect-summary .stat')].map((card) => card.textContent),
    rows: [...document.querySelectorAll('#collect-members-body tr')].map((row) => row.textContent),
    memberNameVisible: document.getElementById('app-panel').textContent.includes(${JSON.stringify(memberName)}),
  }))()`);
  check('负责人参与状态：退出后不计入且课表保留，重新参与只计一次',
    afterLeave.summary.some((text) => text.includes('成员总数') && text.includes('1'))
      && afterLeave.rows.some((text) => text.includes('负责人甲') && text.includes('未参与'))
      && afterRejoin.summary.some((text) => text.includes('成员总数') && text.includes('2'))
      && afterRejoin.summary.some((text) => text.includes('已提交') && text.includes('2'))
      && afterRejoin.rows.some((text) => text.includes('负责人甲') && text.includes('已参与'))
      && afterRejoin.rows.some((text) => text.includes(memberName) && text.includes('已确认')),
    JSON.stringify({ afterLeave, afterRejoin }));

  // 空间事件：默认私有 → 公开 → 私有，真实导出不泄露私有事件
  await openCollectTarget(cdp, targetMonth, targetDate);
  await cdp.evaluate("document.getElementById('collect-event-new').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('event-dialog').open"));
  const eventDefaults = await cdp.evaluate(`(() => ({
    privateChecked: document.querySelector('input[name="event-visibility"][value="private"]').checked,
    date: document.getElementById('event-start').value,
    endDate: document.getElementById('event-end').value,
    single: document.getElementById('event-single-day').checked,
    allDay: document.getElementById('event-all-day').checked,
  }))()`);
  const eventDatePick = await pickDateInDialog(cdp, 'event-start-button', targetDate);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('event-title');
    input.value = ${JSON.stringify(eventTitle)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('event-save').click();
    return true;
  })()`);
  const eventSaveOutcome = await waitFor(() => cdp.evaluate(`(() => {
    if (!document.getElementById('event-dialog').open) return { open: false };
    if (document.getElementById('event-status').hidden) return null;
    if (document.getElementById('event-status').textContent.startsWith('正在保存')) return null;
    return {
      open: true,
      status: document.getElementById('event-status').textContent,
      title: document.getElementById('event-title').value,
      start: document.getElementById('event-start').value,
      end: document.getElementById('event-end').value,
      single: document.getElementById('event-single-day').checked,
      allDay: document.getElementById('event-all-day').checked,
    };
  })()`));
  if (eventSaveOutcome.open) {
    throw new Error(`事件保存失败：${JSON.stringify(eventSaveOutcome)}`);
  }
  await waitFor(() => cdp.evaluate(`document.getElementById('collect-events-list').textContent.includes(${JSON.stringify(eventTitle)})`));
  const privateEvent = await cdp.evaluate(`(() => ({
    card: document.getElementById('collect-events-list').textContent,
    meta: document.querySelector('#collect-events-list .event-card .note')?.textContent ?? '',
    badge: [...document.querySelectorAll('#collect-calendar-grid .cal-event-badge')].map((item) => item.textContent),
  }))()`);
  check('事件默认私有：当前选择日期预填，应用内日期确认后可保存，仅本人可见',
    eventDefaults.privateChecked && eventDefaults.date === targetDate
      && eventDefaults.endDate === targetDate && eventDefaults.single && eventDefaults.allDay
      && eventDatePick.hidden === targetDate && privateEvent.meta.includes('仅自己')
      && privateEvent.badge.includes('事件 1'),
    JSON.stringify({ eventDefaults, eventDatePick, privateEvent }));

  // 真实下载：浏览器下载路径 + ZIP/工作表内容
  const downloadDir = await mkdtemp(join(tmpdir(), 's3-download-'));
  try {
    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true,
      });
    } catch {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    }
    const exportWeekStart = addDays(targetDate, 1 - weekdayMon1(targetDate));
    const exportWeekEnd = addDays(exportWeekStart, 6);
    const exportRange = await cdp.evaluate("document.getElementById('collect-export-range').textContent");
    await cdp.evaluate(`(() => {
      window.__exportCalls = 0;
      if (!window.__exportOrigFetch) window.__exportOrigFetch = window.fetch;
      window.fetch = async function delayedExportFetch(input, init) {
        if (String(input).includes('/collection/export')) {
          window.__exportCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return window.__exportOrigFetch.call(this, input, init);
      };
      return true;
    })()`);
    await cdp.evaluate("document.getElementById('collect-export').click()");
    await sleep(60);
    const exportBusy = await cdp.evaluate("document.getElementById('collect-export').disabled");
    await cdp.evaluate("document.getElementById('collect-export').click()");
    const file = await waitDownload(downloadDir);
    await waitFor(() => cdp.evaluate("document.getElementById('collect-calendar-status').textContent.includes('已下载')"));
    const exportCalls = await cdp.evaluate("window.__exportCalls");
    await cdp.evaluate(`(() => {
      if (window.__exportOrigFetch) window.fetch = window.__exportOrigFetch;
      delete window.__exportOrigFetch;
      return true;
    })()`);
    const buffer = await readFile(file.path);
    const entries = zipEntries(buffer);
    const textOf = (name) => entries.find((entry) => entry.name === name)?.data.toString('utf8') ?? '';
    const workbook = textOf('xl/workbook.xml');
    const names = sheetNames(workbook);
    const allSheetText = entries
      .filter((entry) => entry.name.startsWith('xl/worksheets/'))
      .map((entry) => entry.data.toString('utf8'))
      .join('\n');
    const exportStatus = await cdp.evaluate("document.getElementById('collect-calendar-status').textContent");
    const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const expectedSheets = weekdays.map((label, index) => `${label}_${addDays(exportWeekStart, index).slice(5)}`);
    check('真实导出：一键立即下载恰好 7 张工作日课程表，中文文件名、日期范围、防重复点击且无公式注入',
      buffer.subarray(0, 2).toString() === 'PK'
        && file.name === `${spaceName}_课程表_${exportWeekStart}至${exportWeekEnd}.xlsx`
        && exportRange.includes(exportWeekStart.slice(5)) && exportRange.includes(exportWeekEnd.slice(5))
        && JSON.stringify(names) === JSON.stringify(expectedSheets)
        && names.length === 7 && !names.includes('说明')
        && !names.includes('汇总') && !names.includes('周课表') && !names.includes('日期状态')
        && exportBusy === true && exportCalls === 1
        && !allSheetText.includes('<f>') && !allSheetText.includes('<f ')
        && allSheetText.includes(memberName) && !allSheetText.includes(eventTitle)
        && !allSheetText.includes(inviteCode)
        && allSheetText.includes('没课不代表有空参加活动')
        && allSheetText.includes('未确定')
        && exportStatus.includes('已下载'),
      JSON.stringify({ name: file.name, size: file.size, names, range: exportRange, exportBusy, exportCalls, formula: allSheetText.includes('<f'), leak: allSheetText.includes(eventTitle) }));
  } finally {
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }

  await cdp.evaluate("[...document.querySelectorAll('#collect-events-list button')].find((button) => button.textContent === '编辑').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('event-dialog').open"));
  await cdp.evaluate("document.querySelector('input[name=\"event-visibility\"][value=\"space\"]').click()");
  await cdp.evaluate("document.getElementById('event-save').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  const publicConfirmText = await cdp.evaluate("document.getElementById('confirm-text').textContent");
  await cdp.evaluate("document.getElementById('confirm-ok').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('event-dialog').open"));
  await waitFor(() => cdp.evaluate("document.querySelector('#collect-events-list .event-card .note')?.textContent.includes('全空间')"));
  const publicEvent = await cdp.evaluate("document.querySelector('#collect-events-list .event-card .note')?.textContent ?? ''");
  check('事件公开：首次公开前有内置不可撤回警告，保存后标记为全空间',
    publicConfirmText.includes('已查看或截图无法撤回') && publicEvent.includes('全空间'),
    JSON.stringify({ publicConfirmText, publicEvent }));
  // 页面切换：相邻/跨页动画、无中间页业务读取、快速点击最新目标优先、减少动效
  await cdp.evaluate(`(() => {
    window.__slideAnims = [];
    window.__fetchLog = [];
    if (!window.__s3OrigAnimate) {
      window.__s3OrigAnimate = Element.prototype.animate;
      Element.prototype.animate = function patchedAnimate(keyframes, options) {
        if (this.classList?.contains('page-slide-track')) {
          window.__slideAnims.push({ duration: options?.duration ?? null, slides: this.children.length });
        }
        return window.__s3OrigAnimate.call(this, keyframes, options);
      };
    }
    if (!window.__s3OrigFetch) {
      window.__s3OrigFetch = window.fetch;
      window.fetch = async function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        window.__fetchLog.push(url);
        if (window.__s3DelayConfig && /\\/config$/.test(url)) {
          await new Promise((resolve) => setTimeout(resolve, window.__s3DelayConfig));
        }
        return window.__s3OrigFetch.call(this, input, init);
      };
    }
    return true;
  })()`);
  await setHash(cdp, `#/spaces/${spaceId}/home`);
  await waitSpaceHome(cdp);
  await cdp.evaluate("window.__fetchLog = []; window.__slideAnims = []");
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-content').hidden"));
  await sleep(700);
  const farAnim = await cdp.evaluate(`(() => ({
    anims: window.__slideAnims.slice(),
    overlay: document.querySelectorAll('.page-slide-overlay').length,
    pages: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).map((section) => section.id),
    content: !document.getElementById('collect-content').hidden,
    fetches: window.__fetchLog.slice(),
  }))()`);
  check('桌面跨功能切换：不横向滑动，直接显示目标内容且无动画残留',
    farAnim.anims.length === 0 && farAnim.overlay === 0
      && farAnim.pages.length === 1 && farAnim.pages[0] === 'page-collect' && farAnim.content,
    JSON.stringify(farAnim));

  await setHash(cdp, `#/spaces/${spaceId}/home`);
  await waitSpaceHome(cdp);
  await cdp.evaluate("window.__slideAnims = []");
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/schedule\"]').click()");
  await pageVisible(cdp, 'schedule');
  await sleep(400);
  const adjacentAnim = await cdp.evaluate(`(() => ({
    anims: window.__slideAnims.slice(),
    overlay: document.querySelectorAll('.page-slide-overlay').length,
    pages: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).map((section) => section.id),
  }))()`);
  check('桌面相邻切换：直接切换页面，不产生滑动动画或遮罩残留',
    adjacentAnim.anims.length === 0 && adjacentAnim.overlay === 0
      && adjacentAnim.pages.length === 1 && adjacentAnim.pages[0] === 'page-schedule',
    JSON.stringify(adjacentAnim));

  // 快速点击：延迟第一目标，第二次点击只保留最新目标
  await setHash(cdp, `#/spaces/${spaceId}/home`);
  await waitSpaceHome(cdp);
  await cdp.evaluate("window.__s3DelayConfig = 350; window.__fetchLog = []");
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/schedule\"]').click()");
  await sleep(20);
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await sleep(1200);
  await waitFor(() => cdp.evaluate("!document.getElementById('page-collect').hidden"));
  const latest = await cdp.evaluate(`(() => ({
    page: [...document.querySelectorAll('.page')].filter((section) => !section.hidden).map((section) => section.id),
    hash: location.hash,
    overlay: document.querySelectorAll('.page-slide-overlay').length,
    content: !document.getElementById('collect-content').hidden,
  }))()`);
  await cdp.evaluate("window.__s3DelayConfig = 0");
  check('快速点击：路由串行处理，最新目标优先且不残留旧页面动画',
    latest.page.length === 1 && latest.page[0] === 'page-collect'
      && latest.hash.endsWith('/collect') && latest.overlay === 0 && latest.content,
    JSON.stringify(latest));

  // 减少动效
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await setHash(cdp, `#/spaces/${spaceId}/home`);
  await waitSpaceHome(cdp);
  await cdp.evaluate("window.__slideAnims = []");
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/calendar\"]').click()");
  await pageVisible(cdp, 'calendar');
  await sleep(300);
  const reduced = await cdp.evaluate(`(() => ({
    anims: window.__slideAnims.length,
    overlay: document.querySelectorAll('.page-slide-overlay').length,
  }))()`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  check('减少动效：系统偏好为 reduce 时不做页面滑动', reduced.anims === 0 && reduced.overlay === 0, JSON.stringify(reduced));

  // 离页保护优先于动画和页面切换
  await setHash(cdp, `#/spaces/${spaceId}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  await waitFor(() => cdp.evaluate("!document.body.classList.contains('is-busy')"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.page-slide-overlay').length === 0"));
  await cdp.evaluate(`(() => {
    const cell = document.querySelector('.week-cell[data-day="2"][data-period="2"]');
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    cell.click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('cell-editor').hidden"));
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cell-every-name');
    input.value = 'S3离开保护课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('cell-apply').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('schedule-discard').hidden"));
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"));
  const protection = await cdp.evaluate(`(() => ({
    schedule: !document.getElementById('page-schedule').hidden,
    collect: document.getElementById('page-collect').hidden,
    overlay: document.querySelectorAll('.page-slide-overlay').length,
  }))()`);
  await cdp.evaluate("document.getElementById('leave-stay').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('leave-dialog').open"));
  const stayed = await cdp.evaluate(`(() => ({
    hash: location.hash,
    schedule: !document.getElementById('page-schedule').hidden,
    dirty: !document.getElementById('schedule-discard').hidden,
  }))()`);
  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/collect\"]').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"));
  await cdp.evaluate("document.getElementById('leave-discard').click()");
  await pageVisible(cdp, 'collect');
  check('离开保护：未保存时先询问，不播放切换动画；留下后保持页面与修改',
    protection.schedule && protection.collect && protection.overlay === 0
      && stayed.hash.endsWith('/schedule') && stayed.schedule && stayed.dirty,
    JSON.stringify({ protection, stayed }));

  // 移动端：收集页与事件弹窗触达、无横向溢出
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(300);
  await setHash(cdp, `#/spaces/${spaceId}/collect`);
  await pageVisible(cdp, 'collect');
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-content').hidden"));
  await cdp.evaluate("document.getElementById('collect-tab-calendar').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('collect-calendar-table').hidden || !document.getElementById('collect-calendar-empty').hidden"));
  const mobileCollect = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('#page-collect button, #page-collect .button-link')]
      .filter((button) => button.offsetParent !== null && button.textContent.trim()
        && !button.classList.contains('cal-cell') && !button.classList.contains('day-tab')
        && !button.classList.contains('week-day'))
      .map((button) => ({ text: button.textContent.trim(), h: button.getBoundingClientRect().height }));
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      min: buttons.length ? Math.min(...buttons.map((item) => item.h)) : 0,
      labels: buttons.map((item) => item.text).slice(0, 10),
      tabs: [...document.querySelectorAll('#collect-tabs button')].map((button) => button.textContent),
    };
  })()`);
  await cdp.evaluate("document.getElementById('collect-event-new').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('event-dialog').open"));
  const mobileDialog = await cdp.evaluate(`(() => {
    const rect = document.querySelector('#event-dialog .event-body').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#event-dialog button')]
      .filter((button) => button.offsetParent !== null && button.textContent.trim())
      .map((button) => button.getBoundingClientRect().height);
    return {
      width: rect.width, viewport: innerWidth,
      min: buttons.length ? Math.min(...buttons) : 0,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  await cdp.evaluate("document.getElementById('event-close').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('event-dialog').open"));
  check('手机收集页：无横向溢出，可见动作按钮触达高度不小于 44px',
    !mobileCollect.overflow && mobileCollect.min >= 44
      && mobileCollect.tabs.includes('收集概览') && mobileCollect.tabs.includes('收集日历'),
    JSON.stringify(mobileCollect));
  check('手机事件弹窗：宽度不超出视口，按钮触达高度不小于 44px',
    mobileDialog.width <= mobileDialog.viewport && !mobileDialog.overflow && mobileDialog.min >= 44,
    JSON.stringify(mobileDialog));

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  // 成员立即可见公开事件；周模板保持纯规则，事件只在日历日期标记
  await logoutUi(cdp);
  await loginUi(cdp, memberUsername);
  await openSpaceCard(cdp, spaceName);
  await setHash(cdp, `#/spaces/${spaceId}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  const memberWeekly = await cdp.evaluate(`(() => ({
    markers: document.querySelectorAll('.week-day-marker').length,
    calendarEntry: Boolean(document.getElementById('schedule-calendar')),
    weekSwitcher: Boolean(document.getElementById('schedule-week-label')),
  }))()`);
  await setHash(cdp, `#/spaces/${spaceId}/calendar`);
  await openPersonalTarget(cdp, targetMonth, targetDate);
  const memberCalendarBadge = await cdp.evaluate(`(() => ({
    target: document.querySelector('#calendar-grid button.cal-cell[data-date="${targetDate}"] .cal-event-badge')?.textContent ?? '',
    dates: [...document.querySelectorAll('#calendar-grid button.cal-cell .cal-event-badge')]
      .map((badge) => badge.closest('button').dataset.date),
  }))()`);
  const memberCalendarEvent = await cdp.evaluate("document.querySelector('#calendar-detail-body .detail-events')?.textContent ?? ''");
  const memberEvents = await api(cdp, `/api/spaces/${spaceId}/events?month=${targetMonth}`);
  const memberEvent = memberEvents.body?.events?.find((event) => event.title === eventTitle);
  const memberEventWrite = await cdp.evaluate(`(async () => {
    const call = async (path, body) => {
      const response = await fetch('/functions/v1/app' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return response.status;
    };
    return {
      update: await call('/api/spaces/${spaceId}/events/update', { id: ${JSON.stringify(memberEvent?.id ?? '00000000-0000-0000-0000-000000000000')}, version: ${Number(memberEvent?.version ?? 1)}, title: 'x', startDate: '${targetDate}' }),
      delete: await call('/api/spaces/${spaceId}/events/delete', { id: ${JSON.stringify(memberEvent?.id ?? '00000000-0000-0000-0000-000000000000')}, version: ${Number(memberEvent?.version ?? 1)} }),
    };
  })()`);
  check('成员公开事件：只在日历事件日期标记，周模板不复制事件',
    memberWeekly.markers === 0 && !memberWeekly.calendarEntry && !memberWeekly.weekSwitcher
      && memberCalendarBadge.target.includes('事件 1')
      && memberCalendarBadge.dates.length === 1 && memberCalendarBadge.dates[0] === targetDate,
    JSON.stringify({ memberWeekly, memberCalendarBadge }));
  check('成员公开事件：日历详情可见，服务端可见且不可修改/删除',
    memberCalendarEvent.includes(eventTitle) && memberCalendarEvent.includes('全空间')
      && Boolean(memberEvent) && memberEventWrite.update === 403 && memberEventWrite.delete === 403,
    JSON.stringify({ memberCalendarEvent, visible: Boolean(memberEvent), memberEventWrite }));

  await logoutUi(cdp);
  await loginUi(cdp, ownerUsername);
  await openSpaceCard(cdp, spaceName);
  await setHash(cdp, `#/spaces/${spaceId}/collect`);
  await openCollectTarget(cdp, targetMonth, targetDate);
  await waitFor(() => cdp.evaluate(`document.getElementById('collect-events-list').textContent.includes(${JSON.stringify(eventTitle)})`));
  await cdp.evaluate("[...document.querySelectorAll('#collect-events-list button')].find((button) => button.textContent === '编辑').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('event-dialog').open"));
  await cdp.evaluate("document.querySelector('input[name=\"event-visibility\"][value=\"private\"]').click()");
  await cdp.evaluate("document.getElementById('event-save').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('event-dialog').open"));
  await waitFor(() => cdp.evaluate("document.querySelector('#collect-events-list .event-card .note')?.textContent.includes('仅自己')"));

  await logoutUi(cdp);
  await loginUi(cdp, memberUsername);
  await openSpaceCard(cdp, spaceName);
  await setHash(cdp, `#/spaces/${spaceId}/schedule`);
  await pageVisible(cdp, 'schedule');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.week-cell').length === 84"));
  const privateWeekly = await cdp.evaluate(`(() => ({
    markers: document.querySelectorAll('.week-day-marker').length,
    text: document.getElementById('schedule-grid').textContent,
  }))()`);
  await setHash(cdp, `#/spaces/${spaceId}/calendar`);
  await openPersonalTarget(cdp, targetMonth, targetDate);
  const privateBadge = await cdp.evaluate(`document.querySelector('#calendar-grid button.cal-cell[data-date="${targetDate}"] .cal-event-badge')?.textContent ?? ''`);
  const privateCalendarText = await cdp.evaluate("document.querySelector('#calendar-detail-body .detail-events')?.textContent ?? ''");
  const privateEvents = await api(cdp, `/api/spaces/${spaceId}/events?month=${targetMonth}`);
  check('事件切回私有：成员日历与服务端响应立即移除，周模板无事件标记',
    privateWeekly.markers === 0 && !privateWeekly.text.includes(eventTitle)
      && privateBadge === '' && !privateCalendarText.includes(eventTitle)
      && !(privateEvents.body?.events ?? []).some((event) => event.title === eventTitle),
    JSON.stringify({ privateWeekly: privateWeekly.markers, privateBadge, privateCalendarText, count: privateEvents.body?.events?.length }));

  const finalErrors = cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text));
  check('页面运行时无未捕获异常或 console.error', finalErrors.length === 0, finalErrors.slice(0, 3).join(' | '));

  return { spaceId, targetDate, targetMonth };
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) {
    process.stdout.write('SKIP 未找到 Edge/Chrome，可跳过 S3 浏览器检查\n');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 's3-cdp-'));
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
    process.stdout.write(`\nS3 浏览器检查：${results.length - failed.length}/${results.length} 通过\n`);
    if (failed.length) process.exitCode = 1;
  }
}

await main();

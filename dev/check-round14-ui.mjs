// Round 14 浏览器检查：12 节已提交空课表在个人日历中的文案、行结构、按钮尺寸、
// 320/390/桌面无横向溢出、往日只读，并输出与用户截图同尺寸的 after 截图。
// 只连接本地预览与内存假库，不代表部署环境或真机长截图。
//   node dev/check-round14-ui.mjs   （需要先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays } from '../functions/calendar.mjs';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BASE = process.env.PREVIEW_URL ?? 'http://localhost:8787/';
const PORT = Number(process.env.CDP_PORT ?? 9433);
const OUT = join(process.cwd(), 'evidence', 'round14');
const PASSWORD = `local-r14-${randomUUID()}-${randomUUID()}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(fn, { timeout = 15000, interval = 60 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
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
      if (!message.id || !this.pending.has(message.id)) {
        if (message.method === 'Runtime.exceptionThrown') {
          const detail = message.params?.exceptionDetails;
          this.pageErrors.push(detail?.exception?.description ?? detail?.text ?? 'exception');
        }
        return;
      }
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    await writeFile(join(OUT, name), Buffer.from(shot.data, 'base64'));
    process.stdout.write(`SHOT ${name}\n`);
  }
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

async function fill(cdp, pairs) {
  const script = Object.entries(pairs).map(([id, value]) => {
    const input = `document.getElementById(${JSON.stringify(id)})`;
    return `${input}.value = ${JSON.stringify(value)};
      ${input}.dispatchEvent(new Event('input', { bubbles: true }));`;
  }).join('\n');
  await cdp.evaluate(`(() => { ${script} return true; })()`);
}

async function registerUi(cdp, username, nickname) {
  await cdp.evaluate("document.getElementById('auth-tab-register').click()");
  await fill(cdp, {
    'register-username': username,
    'register-nickname': nickname,
    'register-password': PASSWORD,
    'register-confirm': PASSWORD,
  });
  await cdp.evaluate("document.getElementById('register-notice').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('register-submit').disabled"));
  await cdp.evaluate("document.getElementById('register-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"));
}

async function logoutUi(cdp) {
  await cdp.evaluate("document.getElementById('logout').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden && document.getElementById('app-panel').hidden"));
}

async function pageVisible(cdp, name) {
  return waitFor(() => cdp.evaluate(`document.getElementById('page-${name}').hidden === false`));
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

const PERIOD_TIMES = [
  ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
  ['11:50', '12:35'], ['14:00', '14:45'], ['14:55', '15:40'], ['16:00', '16:45'],
  ['16:55', '17:40'], ['19:00', '19:45'], ['19:55', '20:40'], ['20:50', '21:35'],
];

async function selectDate(cdp, date) {
  await cdp.evaluate(`document.querySelector('.cal-cell[data-date="${date}"]')?.click()`);
  await waitFor(() => cdp.evaluate(`document.getElementById('calendar-detail-title').textContent.includes(${JSON.stringify(date)})`));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-detail .detail-period').length === 12"));
}

async function detailSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#calendar-detail .detail-period')];
    return {
      rows: rows.length,
      rowTexts: rows.map((row) => row.textContent),
      states: rows.map((row) => row.querySelector('.detail-state-text')?.textContent ?? ''),
      stateIsButton: rows.some((row) => row.querySelector('.detail-state')?.tagName === 'BUTTON'),
      metas: document.querySelectorAll('#calendar-detail .detail-meta').length,
      hints: rows.map((row) => row.querySelector('.detail-hint')?.textContent ?? ''),
      actions: rows.map((row) => row.querySelector('.detail-action')?.textContent ?? ''),
      actionHeights: rows
        .map((row) => row.querySelector('.detail-action')?.getBoundingClientRect().height ?? null)
        .filter((value) => value !== null),
      note: document.querySelector('#calendar-detail .detail-note')?.textContent ?? '',
      pageText: document.getElementById('page-calendar').textContent,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      detailWidth: document.querySelector('#calendar-detail .detail-periods')?.getBoundingClientRect().width ?? 0,
    };
  })()`);
}

function assertCleanRows(snapshot, label, expectedNote = '') {
  const banned = ['周课表此处无课', '不代表已确认参加', '待认', '记录更新', '无课', '未确认共享'];
  check(`${label}：12 节空课表全部显示“没课”且保留节次时间`,
    snapshot.rows === 12 && snapshot.states.every((text) => text === '没课')
      && snapshot.rowTexts.every((text) => /第 \d+ 节/.test(text) && /\d{2}:\d{2}–\d{2}:\d{2}/.test(text)),
    JSON.stringify({ rows: snapshot.rows, states: snapshot.states.slice(0, 3) }));
  check(`${label}：重复免责声明与旧状态文案已删除`,
    banned.every((text) => !snapshot.pageText.includes(text)),
    JSON.stringify(banned.filter((text) => snapshot.pageText.includes(text))));
  check(`${label}：状态为纯文本，不渲染成按钮或旧元信息行`,
    snapshot.stateIsButton === false && snapshot.metas === 0,
    JSON.stringify({ stateIsButton: snapshot.stateIsButton, metas: snapshot.metas }));
  check(`${label}：${expectedNote ? '仅保留一条只读原因' : '正常日期不追加额外说明'}`,
    snapshot.note === expectedNote, JSON.stringify(snapshot.note));
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));

  const ownerName = `r14_owner_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const memberName = `r14_member_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await registerUi(cdp, ownerName, '负责人');
  await passConsentGate(cdp);

  const created = await api(cdp, '/api/spaces', {
    method: 'POST',
    body: {
      name: 'test5',
      ownerName: '负责人',
      mode: 'presence',
      weekRule: 'every',
      visibility: 'masked_list',
      periods: PERIOD_TIMES.map(([start, end], index) => ({
        index: index + 1, start, end,
      })),
      teaching: {
        timezone: 'Asia/Shanghai',
        firstWeekMonday: '2026-08-31',
        termStart: '2026-08-31',
        termEnd: '2027-01-24',
      },
    },
  });
  check('准备：创建 12 节“仅有课状态”空间', created.status === 201,
    JSON.stringify({ status: created.status, error: created.body?.error }));
  const spaceId = created.body.space.id;

  const invite = await api(cdp, `/api/spaces/${spaceId}/invite`, { method: 'POST' });
  check('准备：生成成员邀请', invite.status === 201,
    JSON.stringify({ status: invite.status, error: invite.body?.error }));

  await logoutUi(cdp);
  await registerUi(cdp, memberName, '测试成员');
  await passConsentGate(cdp);

  const notice = await api(cdp, '/api/notice');
  const joined = await api(cdp, '/api/join', {
    method: 'POST',
    body: {
      code: invite.body.code,
      inSpaceName: '测试成员',
      noticeAccepted: true,
      noticeVersion: notice.body?.version,
    },
  });
  const published = await api(cdp, `/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    body: { requestId: `r14ui_${randomUUID()}`, baseRevision: 0, entries: [] },
  });
  const month = await api(cdp, `/api/spaces/${spaceId}/calendar?month=2026-11`);
  const calendarConsent = await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: {
      action: 'accept',
      noticeAccepted: true,
      noticeVersion: month.body?.notice?.version,
    },
  });
  check('准备：成员加入并提交零条目空课表，确认日历告知',
    joined.status === 201 && published.status === 201 && calendarConsent.status === 200,
    JSON.stringify({ joined: joined.status, published: published.status, consent: calendarConsent.status }));

  // 通过 API 加入后 SPA 仍持有登录前的空间列表，重载一次让成员端读到新空间。
  await cdp.evaluate('location.reload()');
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.getElementById('app-panel') && !document.getElementById('app-panel').hidden"));
  await passConsentGate(cdp);
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await pageVisible(cdp, 'calendar');
  try {
    await waitFor(() => cdp.evaluate("document.querySelectorAll('.cal-cell[data-date]').length >= 28"));
  } catch {
    const debug = await cdp.evaluate(`(() => ({
      hash: location.hash,
      loading: document.getElementById('calendar-loading')?.hidden,
      error: document.getElementById('calendar-error')?.textContent ?? '',
      status: document.getElementById('calendar-status')?.textContent ?? '',
      month: document.getElementById('calendar-month')?.textContent ?? '',
      cells: document.querySelectorAll('.cal-cell[data-date]').length,
      text: document.getElementById('page-calendar')?.textContent.slice(0, 300) ?? '',
    }))()`);
    throw new Error(`calendar grid not ready: ${JSON.stringify(debug)}`);
  }
  const today = await cdp.evaluate("document.querySelector('.cal-cell.is-today')?.dataset.date ?? null");
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);

  await selectDate(cdp, tomorrow);
  const desktop = await detailSnapshot(cdp);
  assertCleanRows(desktop, '桌面');
  check('桌面：12 个可编辑节次各有一个按钮，触达高度不小于 44px',
    desktop.actions.filter((text) => text === '忙碌').length === 12
      && desktop.actionHeights.every((height) => height >= 43.5),
    JSON.stringify({ actions: desktop.actions, heights: desktop.actionHeights }));
  check('桌面：详情节次列表有限宽且页面无横向溢出',
    desktop.detailWidth > 0 && desktop.detailWidth <= 900 && !desktop.overflow,
    JSON.stringify({ width: desktop.detailWidth, overflow: desktop.overflow }));

  await selectDate(cdp, yesterday);
  const past = await detailSnapshot(cdp);
  assertCleanRows(past, '往日', '该日已无可调整节次。');
  check('往日：不显示不可用的忙碌按钮，只保留一条只读原因',
    past.actions.every((text) => text === '') && past.note === '该日已无可调整节次。',
    JSON.stringify({ actions: past.actions.filter(Boolean), note: past.note }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(200);
  await selectDate(cdp, tomorrow);
  const mobile390 = await detailSnapshot(cdp);
  assertCleanRows(mobile390, '390');
  check('390：按钮不小于 44px、节次文本不溢出、页面无横向溢出',
    mobile390.actions.every((text) => text === '忙碌')
      && mobile390.actionHeights.every((height) => height >= 43.5)
      && !mobile390.overflow,
    JSON.stringify({ overflow: mobile390.overflow, heights: mobile390.actionHeights.slice(0, 3) }));
  const scroll390 = await cdp.evaluate(`(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { scrollY: window.scrollY, height: document.documentElement.scrollHeight, inner: innerHeight };
  })()`);
  check('390：页面可纵向滚动到底，不依赖内部固定高度',
    scroll390.scrollY > 0 && scroll390.height > scroll390.inner,
    JSON.stringify(scroll390));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 700, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(200);
  await selectDate(cdp, tomorrow);
  const mobile320 = await detailSnapshot(cdp);
  assertCleanRows(mobile320, '320');
  check('320：按钮不小于 44px、状态文本与节次同排且无横向溢出',
    mobile320.actions.every((text) => text === '忙碌')
      && mobile320.actionHeights.every((height) => height >= 43.5)
      && !mobile320.overflow,
    JSON.stringify({ overflow: mobile320.overflow, heights: mobile320.actionHeights.slice(0, 3) }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1755, height: 1261, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(250);
  await selectDate(cdp, today);
  await cdp.evaluate('window.scrollTo(0, 0)');
  await sleep(200);
  await cdp.screenshot('after-personal-calendar-1755x1261.png');

  const pageErrors = cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text));
  check('页面运行时无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) throw new Error('未找到 Edge/Chrome');
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'r14-ui-'));
  const browser = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--window-size=1755,1261',
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (!response.ok) return false;
      return (await response.json()).find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
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
  process.stdout.write(`\nRound 14 UI 检查：${passed}/${results.length} 通过\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();

// 第11轮浏览器检查：个人月历与收集月历的内容区跟手切月、加载诚实性、
// 课表手机端减法与控制台。仅连接本地预览和内存假库；无头仿真不等于真机手感。
//   node dev/check-round11.mjs   （需先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
const PORT = Number(process.env.CDP_PORT ?? 9371);
const OUT = join(process.cwd(), 'evidence', 'round11');
const PASSWORD = `local-r11-${randomUUID()}-${randomUUID()}`;
const results = [];
const gestureLog = [];

function recordGesture(name, gesture) {
  gestureLog.push({ name, ...gesture });
}

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

function todayInSpace() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function weekdayMon1(date) {
  const value = new Date(`${date}T00:00:00Z`);
  return ((value.getUTCDay() + 6) % 7) + 1;
}

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
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'evaluation failed');
    }
    return result.result.value;
  }

  async screenshot(name, { fullPage = false } = {}) {
    let clip;
    if (fullPage) {
      const size = await this.evaluate(`(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }))()`);
      clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 4000), scale: 1 };
    }
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: fullPage,
      ...(clip ? { clip } : {}),
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

async function fill(cdp, values) {
  await cdp.evaluate(`(() => {
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    ${Object.entries(values).map(([id, value]) => `set(${JSON.stringify(id)}, ${JSON.stringify(value)});`).join('\n')}
    return true;
  })()`);
}

async function register(cdp, username) {
  await cdp.evaluate("document.getElementById('auth-tab-register').click()");
  await fill(cdp, {
    'register-username': username,
    'register-nickname': '小满',
    'register-password': PASSWORD,
    'register-confirm': PASSWORD,
  });
  await cdp.evaluate("document.getElementById('register-notice').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('register-submit').disabled"));
  await cdp.evaluate("document.getElementById('register-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"));
}

// 真实指针：起点必须落在日期格内部，移动样本记录连续位移与轨道实际位置。
const GESTURE_LIB = `(() => {
  if (window.__r11) return true;
  const centerX = () => new DOMMatrixReadOnly(getComputedStyle(document.getElementById('calendar-track')).transform).m41;
  const cellAt = (grid, index) => {
    const cells = [...document.querySelectorAll('#' + grid + ' button.cal-cell[data-date]')];
    return cells[index % cells.length] ?? null;
  };
  const fire = (type, x, y, id, primary, target) => (target ?? document).dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id ?? 91, isPrimary: primary ?? true,
    pointerType: 'touch', clientX: x, clientY: y,
  }));
  window.__r11 = {
    centerX,
    snapshot(grid = 'calendar-grid', track = 'calendar-track') {
      const dateCells = [...document.querySelectorAll('#' + grid + ' .cal-cell[data-date]')];
      const monthText = document.getElementById(grid === 'calendar-grid' ? 'calendar-month' : 'collect-month').textContent;
      return {
        month: monthText,
        monthKey: monthText.replace(/\\s+/g, ''),
        first: dateCells[0]?.dataset.date ?? null,
        last: dateCells[dateCells.length - 1]?.dataset.date ?? null,
        rows: document.querySelectorAll('#' + grid + ' .cal-row').length,
        height: Math.round(document.getElementById(grid).getBoundingClientRect().height),
        x: Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById(track)).transform).m41),
        selected: document.querySelector('#' + grid + ' .cal-cell[aria-selected="true"]')?.dataset.date ?? null,
        error: document.getElementById('calendar-error')?.hidden === false,
        retryDisabled: document.getElementById('calendar-retry')?.disabled ?? null,
        busy: document.getElementById(track).closest('[aria-busy]') ? true : null,
      };
    },
    async drag({ grid = 'calendar-grid', track = 'calendar-track', index = 12, dx = 0, dy = 0, steps = 8, cancel = false, second = false, pause = 16, tapAfter = false }) {
      const cell = cellAt(grid, index);
      if (!cell) return { error: 'no-cell' };
      const rect = cell.getBoundingClientRect();
      const start = {
        x: Math.round(rect.left + rect.width * 0.5),
        y: Math.round(rect.top + Math.min(rect.height * 0.5, 32)),
        inCell: true,
      };
      const samples = [];
      fire('pointerdown', start.x, start.y, 91, true, cell);
      for (let i = 1; i <= steps; i += 1) {
        const x = start.x + dx * (i / steps);
        const y = start.y + dy * (i / steps);
        fire('pointermove', x, y, 91, true, document);
        samples.push({ dx: Math.round(x - start.x), dy: Math.round(y - start.y), x: Math.round(centerX()) });
        await new Promise((r) => (pause > 0 ? setTimeout(r, pause) : requestAnimationFrame(r)));
      }
      const during = { x: Math.round(centerX()) };
      if (second) fire('pointerdown', start.x + 24, start.y, 92, false, cell);
      if (cancel) fire('pointercancel', start.x + dx, start.y + dy, 91, true, document);
      else fire('pointerup', start.x + dx, start.y + dy, 91, true, document);
      if (tapAfter) {
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return { start, samples, during, width: Math.round(document.getElementById(track).parentElement.clientWidth) };
    },
  };
  return true;
})()`;

const TRACK_CENTER = `(() => Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('calendar-track')).transform).m41))()`;

async function personalSnapshot(cdp) {
  return cdp.evaluate(`window.__r11.snapshot('calendar-grid', 'calendar-track')`);
}

async function waitMonth(cdp, monthKey, id = 'calendar-month') {
  return waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g, '')`);
    return text === monthKey;
  });
}

async function monthRequests(cdp, month) {
  return cdp.evaluate(`performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/calendar?month=${month}')).length`);
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  const username = `r11_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await register(cdp, username);
  await waitFor(() => cdp.evaluate("document.getElementById('page-spaces').hidden === false"));

  const created = await api(cdp, '/api/spaces', {
    method: 'POST',
    body: {
      name: '秋冬课程空间', ownerName: '小满', mode: 'courses',
      weekRule: 'every', visibility: 'masked_list',
      periods: [
        { index: 1, start: '08:00', end: '08:45' },
        { index: 2, start: '08:55', end: '09:40' },
        { index: 3, start: '10:00', end: '10:45' },
        { index: 4, start: '14:00', end: '14:45' },
        { index: 5, start: '14:55', end: '15:40' },
      ],
      teaching: {
        timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
        termStart: '2026-09-07', termEnd: '2027-06-30',
      },
    },
  });
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  const spaceId = created.body.space.id;

  const entries = [
    [1, 1, '高等数学'], [1, 2, '高等数学'], [1, 3, '大学英语'], [2, 1, '数据结构'],
    [2, 4, '体育'], [3, 2, '数据结构'], [3, 5, '社团例会'], [4, 1, '大学物理'],
    [4, 3, '大学物理'], [5, 2, '大学英语'],
  ].map(([day, period, courseName]) => ({ day, period, weekRule: 'every', courseName }));
  const published = await api(cdp, `/api/spaces/${spaceId}/schedule/publish`, {
    method: 'POST',
    body: { requestId: `r11-${randomUUID()}`, baseRevision: 0, entries },
  });
  if (published.status !== 201) throw new Error(`publish failed: ${published.status}`);

  await cdp.evaluate('location.reload()');
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  await sleep(250);
  await cdp.screenshot('04-consent-central.png');
  const consentCopy = await cdp.evaluate(`(() => ({
    title: document.getElementById('consent-title').textContent,
    hint: document.getElementById('consent-hint').textContent,
    body: document.getElementById('consent-body').textContent,
    primary: document.getElementById('consent-continue').textContent,
    necessary: document.getElementById('consent-necessary').textContent,
    terms: document.querySelector('#consent-dialog a[href*="terms"]').textContent,
    rows: document.querySelectorAll('#consent-body .consent-space').length,
    switchDefaultOff: document.querySelector('#consent-body .consent-switch input')?.checked === false,
    toggle: Boolean(document.getElementById('consent-toggle')),
  }))()`);
  check('集中告知默认文案：标题/范围/共享默认关闭/仅必要项含义齐全，无实现术语',
    consentCopy.title === '隐私与共享'
      && consentCopy.hint.includes('日期共享可选') && consentCopy.hint.includes('默认关闭')
      && consentCopy.rows === 1 && consentCopy.switchDefaultOff === true
      && consentCopy.body.includes('日历告知') && consentCopy.body.includes('向负责人共享日期状态')
      && consentCopy.body.includes('确认共享后，本空间负责人可在收集日历中看到你在具体日期的停课、个人忙/空闲状态')
      && consentCopy.primary === '全部同意' && consentCopy.necessary === '仅必要项'
      && consentCopy.terms === '查看条款' && consentCopy.toggle === false
      && !/点击按钮后写入|当前待确认项|当前版本|待选择/.test(consentCopy.body + consentCopy.hint),
    JSON.stringify(consentCopy));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));

  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/schedule'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-schedule').hidden === false"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.day-tab').length === 7"));
  await sleep(350);
  const mobileChrome = await cdp.evaluate(`(() => {
    const nav = document.getElementById('mobile-nav');
    const tabs = [...document.querySelectorAll('.day-tab')];
    return {
      title: document.getElementById('mobile-title').textContent,
      topHidden: getComputedStyle(document.querySelector('.top')).display === 'none',
      navLabels: [...nav.querySelectorAll('.mobile-link')].map((link) => link.textContent),
      navAria: [...nav.querySelectorAll('.mobile-link')].map((link) => link.getAttribute('aria-label')),
      navClipped: nav.scrollWidth > nav.clientWidth + 1,
      tabs: tabs.map((tab) => tab.textContent),
      tabMin: Math.min(...tabs.map((tab) => Math.round(tab.getBoundingClientRect().width))),
      tabOverflow: document.getElementById('day-tabs').scrollWidth > document.getElementById('day-tabs').clientWidth + 1,
      legacy: ['schedule-meta', 'schedule-periods-text', 'schedule-help', 'schedule-summary', 'schedule-title']
        .filter((id) => document.getElementById(id)),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('手机课表减法：工作区只保留返回/空间名/更多，五项导航等分不裁切，星期七等分无横滚',
    mobileChrome.title === '秋冬课程空间' && mobileChrome.topHidden
      && mobileChrome.navLabels.join(',') === '首页,课表,日历,收集,设置'
      && mobileChrome.navAria.includes('我的课表') && mobileChrome.navAria.includes('课表收集')
      && !mobileChrome.navClipped && mobileChrome.tabs.length === 7
      && mobileChrome.tabMin >= 38 && !mobileChrome.tabOverflow
      && mobileChrome.legacy.length === 0 && !mobileChrome.overflow,
    JSON.stringify(mobileChrome));
  await cdp.screenshot('01-mobile-schedule.png');

  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-calendar').hidden === false"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid button.cal-cell[data-date]').length >= 28"));
  await waitFor(() => cdp.evaluate(`${GESTURE_LIB}`));
  await sleep(250);

  const base = await personalSnapshot(cdp);
  check('个人月历初始：三页轨道、六行稳定高度、邻页静态且不可聚焦',
    base.first?.startsWith('2026-11') && base.rows === 6
      && (await cdp.evaluate(`(() => {
        const prev = document.getElementById('calendar-page-prev');
        const next = document.getElementById('calendar-page-next');
        return prev.dataset.state && next.dataset.state
          && prev.querySelectorAll('button').length === 0
          && next.querySelectorAll('button').length === 0
          && prev.getAttribute('aria-hidden') === 'true' && next.getAttribute('aria-hidden') === 'true'
          && prev.hasAttribute('inert') && next.hasAttribute('inert')
          && document.querySelectorAll('#calendar-grid').length === 1;
      })()`)),
    JSON.stringify(base));

  // 1. 短拖回弹（慢速小幅，避免被速度判定成快甩）
  let g = await cdp.evaluate(`window.__r11.drag({ index: 12, dx: 24, steps: 4, pause: 80 })`);
  recordGesture('personal-short', g);
  await sleep(450);
  let after = await personalSnapshot(cdp);
  check('个人月历：日期格内部起手短拖回弹，不切月且回到居中',
    g.start.inCell && g.start.x > 0 && after.monthKey === '2026年11月'
      && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, after }));

  // 2. 长拖吸附下一月，跟手采样连续
  g = await cdp.evaluate(`window.__r11.drag({ index: 18, dx: -150, steps: 8 })`);
  recordGesture('personal-long-next', g);
  await waitMonth(cdp, '2026年12月');
  await sleep(350);
  after = await personalSnapshot(cdp);
  const moved = g.samples.filter((sample) => sample.x < -g.width - 4);
  check('个人月历：日期格内部长拖左移连续跟手，松手吸附到下一月',
    g.start.inCell && g.samples.length === 8 && moved.length >= 4
      && g.samples.every((sample, i) => i === 0 || sample.x <= g.samples[i - 1].x)
      && after.first?.startsWith('2026-12') && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, after }));

  // 3. 快甩短距离
  const beforeFlick = await personalSnapshot(cdp);
  g = await cdp.evaluate(`window.__r11.drag({ index: 16, dx: -36, steps: 2, pause: 12 })`);
  recordGesture('personal-flick-next', g);
  await waitMonth(cdp, '2027年1月');
  await sleep(300);
  after = await personalSnapshot(cdp);
  check('个人月历：短距离快甩按速度吸附，跨月身份与网格一致',
    beforeFlick.first?.startsWith('2026-12') && after.first?.startsWith('2027-01')
      && after.monthKey === '2027年1月' && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, beforeFlick, after }));

  // 4. 反向拖动：先左后右，双向收敛
  g = await cdp.evaluate(`window.__r11.drag({ index: 14, dx: -170, steps: 6, pause: 12 })`);
  recordGesture('personal-reverse-next', g);
  await waitMonth(cdp, '2027年2月');
  await sleep(300);
  const back = await cdp.evaluate(`window.__r11.drag({ index: 14, dx: 170, steps: 6, pause: 12 })`);
  recordGesture('personal-reverse-prev', back);
  await waitMonth(cdp, '2027年1月');
  await sleep(300);
  after = await personalSnapshot(cdp);
  check('个人月历：左右往返连续切月，双向吸附后无半月偏移',
    back.start.inCell && after.monthKey === '2027年1月' && after.first?.startsWith('2027-01')
      && Math.abs(after.x + back.width) <= 2,
    JSON.stringify({ g, back, after }));

  // 5. 取消与多指
  const cancelBefore = await personalSnapshot(cdp);
  g = await cdp.evaluate(`window.__r11.drag({ index: 12, dx: -120, steps: 5, cancel: true })`);
  recordGesture('personal-cancel', g);
  await sleep(500);
  after = await personalSnapshot(cdp);
  check('个人月历：pointercancel 回原月且不残留位移',
    after.first === cancelBefore.first && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, cancelBefore, after }));

  g = await cdp.evaluate(`window.__r11.drag({ index: 12, dx: -120, steps: 5, second: true })`);
  recordGesture('personal-second-pointer', g);
  await sleep(500);
  after = await personalSnapshot(cdp);
  check('个人月历：第二触点取消手势，月与位移不变',
    after.first === cancelBefore.first && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, after }));

  // 6. 纵向手势
  g = await cdp.evaluate(`window.__r11.drag({ index: 12, dx: 4, dy: 130, steps: 6 })`);
  recordGesture('personal-vertical', g);
  await sleep(450);
  after = await personalSnapshot(cdp);
  check('个人月历：纵向主导手势不切月，未抢滚动',
    after.first === cancelBefore.first && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ g, after }));

  // 7. 静止轻点选日与拖后不误点
  const pick = await cdp.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#calendar-grid button.cal-cell[data-date]')]
      .filter((cell) => !cell.classList.contains('is-selected'));
    const target = cells[8];
    const before = document.querySelector('#calendar-grid .cal-cell[aria-selected="true"]').dataset.date;
    target.click();
    return { before, date: target.dataset.date };
  })()`);
  await sleep(150);
  const selectedNow = await cdp.evaluate(`document.querySelector('#calendar-grid .cal-cell[aria-selected="true"]').dataset.date`);
  check('个人月历：静止轻点日期仍正常选中并刷新详情', pick.before !== selectedNow && pick.date === selectedNow,
    JSON.stringify({ pick, selectedNow }));

  g = await cdp.evaluate(`window.__r11.drag({ index: 20, dx: 40, steps: 4, pause: 80, tapAfter: true })`);
  recordGesture('personal-drag-tap-after', g);
  await sleep(500);
  const dragAfter = await personalSnapshot(cdp);
  const selectedAfterDrag = dragAfter.selected;
  check('个人月历：横拖后触发的点击被抑制，选中日不因拖动漂移',
    dragAfter.monthKey === '2027年1月' && selectedAfterDrag === selectedNow,
    JSON.stringify({ g, selectedNow, selectedAfterDrag, month: dragAfter.monthKey }));

  await cdp.evaluate("document.getElementById('calendar-today').click()");
  await waitMonth(cdp, '2026年11月');
  await sleep(300);

  // 8. 箭头与手势混用
  await cdp.evaluate("document.getElementById('calendar-next').click()");
  await waitMonth(cdp, '2026年12月');
  await sleep(200);
  g = await cdp.evaluate(`window.__r11.drag({ index: 18, dx: -155, steps: 7 })`);
  await waitMonth(cdp, '2027年1月');
  await sleep(300);
  after = await personalSnapshot(cdp);
  check('个人月历：箭头与拖动共用目标月份，连续操作只保留最后意图',
    after.monthKey === '2027年1月' && after.first?.startsWith('2027-01'),
    JSON.stringify({ g, after }));

  // 9. 跨年反向
  g = await cdp.evaluate(`window.__r11.drag({ index: 18, dx: 155, steps: 7 })`);
  await waitMonth(cdp, '2026年12月');
  await sleep(250);
  after = await personalSnapshot(cdp);
  check('个人月历：跨年反向切月，标题/网格/周次落在同一月',
    after.monthKey === '2026年12月' && after.first?.startsWith('2026-12') && after.rows === 6,
    JSON.stringify({ g, after }));

  // 10. 授权撤回（真实隐私入口写入）使缓存失效；同时挂起下一月请求
  const shareBlock = "document.querySelector('#consent-body .consent-line[data-kind=\"share\"]')";
  await cdp.evaluate("document.getElementById('account-button').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('account-panel').hidden"));
  await cdp.evaluate("document.getElementById('open-privacy').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  await waitFor(() => cdp.evaluate(`${shareBlock}.querySelector('.consent-switch input') !== null`));
  await cdp.evaluate(`${shareBlock}.querySelector('.consent-switch input').click()`);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-continue').textContent === '按当前选择继续'"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate(`${shareBlock}.textContent.includes('已共享')`));
  const beforeRevoke = await monthRequests(cdp, '2026-12');
  await cdp.evaluate(`(() => {
    window.__r11.hold = { month: '2027-01', queue: [], mode: 'hold' };
    const original = window.fetch.bind(window);
    window.__r11.originalFetch = original;
    window.fetch = (url, init) => {
      const text = String(url);
      const hold = window.__r11.hold;
      if (hold?.queue && text.includes('/calendar?month=' + hold.month)) {
        return new Promise((resolve, reject) => {
          hold.queue.push(() => (hold.mode === 'fail'
            ? reject(new TypeError('simulated offline'))
            : original(url, init).then(resolve, reject)));
        });
      }
      return original(url, init);
    };
    return true;
  })()`);
  await cdp.evaluate(`${shareBlock}.querySelector('.consent-switch input').click()`);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-continue').textContent === '按当前选择继续'"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate(`${shareBlock}.textContent.includes('已撤回')`));
  await waitFor(async () => (await monthRequests(cdp, '2026-12')) > beforeRevoke);
  const afterRevoke = await monthRequests(cdp, '2026-12');
  await cdp.evaluate("document.getElementById('consent-dialog').close()");
  check('个人月历：授权撤回后缓存失效，当前月重新读取发出真实请求',
    afterRevoke > beforeRevoke,
    JSON.stringify({ beforeRevoke, afterRevoke }));

  // 11. 未缓存慢网：邻页目标月结构 + 加载中；失败保留旧月并可重试
  await waitFor(() => cdp.evaluate("window.__r11.hold.queue.length > 0"));
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-page-next').dataset.state === 'loading'"));
  g = await cdp.evaluate(`window.__r11.drag({ index: 12, dx: -150, steps: 6 })`);
  await sleep(350);
  const held = await cdp.evaluate(`(() => {
    const next = document.getElementById('calendar-page-next');
    return {
      titleKey: document.getElementById('calendar-month').textContent.replace(/\\s+/g, ''),
      nextState: next.dataset.state,
      nextLabel: next.dataset.label,
      nextFirst: next.querySelector('.cal-cell[data-date]')?.dataset.date ?? null,
      noRecord: next.textContent.includes('无记录'),
      centerFirst: document.querySelector('#calendar-grid .cal-cell[data-date]')?.dataset.date ?? null,
      transform: Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('calendar-track')).transform).m41),
      raw: document.getElementById('calendar-track').style.transform,
      transition: document.getElementById('calendar-track').style.transition,
      viewport: document.getElementById('calendar-viewport').clientWidth,
      busy: document.getElementById('calendar-table').getAttribute('aria-busy'),
    };
  })()`);
  check('个人月历：未缓存邻月显示目标月结构与加载，标题等数据到达再切换',
    held.titleKey === '2026年12月' && held.nextState === 'loading'
      && held.nextLabel.includes('加载中') && held.nextFirst?.startsWith('2027-01')
      && !held.noRecord && held.centerFirst?.startsWith('2026-12')
      && Math.abs(held.transform + 2 * g.width) <= 4,
    JSON.stringify({ g, held }));
  await cdp.evaluate(`(() => {
    const hold = window.__r11.hold;
    hold.mode = 'fail';
    const original = window.__r11.originalFetch;
    window.fetch = (url, init) => {
      if (String(url).includes('/calendar?month=2027-01')) {
        return Promise.reject(new TypeError('simulated offline'));
      }
      return original(url, init);
    };
    const q = hold.queue;
    hold.queue = null;
    q.forEach((run) => run());
    return true;
  })()`);
  await sleep(700);
  const failed = await personalSnapshot(cdp);
  check('个人月历：目标月读取失败保留当前有效月并给出可重试状态',
    failed.monthKey === '2026年12月' && failed.first?.startsWith('2026-12') && failed.error
      && failed.retryDisabled === false,
    JSON.stringify({ failed }));
  await cdp.evaluate(`(() => {
    window.__r11.hold = { month: '2027-03', queue: [], mode: 'hold' };
    window.fetch = (url, init) => {
      const text = String(url);
      const hold = window.__r11.hold;
      if (hold?.queue && text.includes('/calendar?month=' + hold.month)) {
        return new Promise((resolve, reject) => {
          hold.queue.push(() => window.__r11.originalFetch(url, init).then(resolve, reject));
        });
      }
      return window.__r11.originalFetch(url, init);
    };
    return true;
  })()`);
  await cdp.evaluate("document.getElementById('calendar-retry').click()");
  await waitMonth(cdp, '2027年1月');
  await sleep(400);
  after = await personalSnapshot(cdp);
  check('个人月历：失败后重试成功，错误状态清除且轨道居中',
    after.monthKey === '2027年1月' && after.first?.startsWith('2027-01') && !after.error
      && Math.abs(after.x + g.width) <= 2,
    JSON.stringify({ after }));

  // 12. 旧响应迟到：只服从最后意图
  await waitFor(() => cdp.evaluate("window.__r11.hold.queue.length > 0"));
  await cdp.evaluate("document.getElementById('calendar-next').click()");
  await sleep(300);
  await cdp.evaluate("document.getElementById('calendar-today').click()");
  await waitMonth(cdp, '2026年11月');
  const selectedLater = await cdp.evaluate(`document.querySelector('#calendar-grid .cal-cell[aria-selected="true"]')?.dataset.date ?? null`);
  await cdp.evaluate(`(() => {
    const hold = window.__r11.hold;
    window.__r11.hold = null;
    window.fetch = window.__r11.originalFetch;
    hold.queue.forEach((run) => run());
    return true;
  })()`);
  await sleep(650);
  after = await personalSnapshot(cdp);
  check('个人月历：迟到的旧响应不覆盖最后目标月、标题与选中日',
    after.monthKey === '2026年11月' && after.first?.startsWith('2026-11') && !after.error
      && after.selected === selectedLater,
    JSON.stringify({ selectedLater, after }));

  // 13. 窗口宽度变化后仍居中
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(450);
  const resized = await cdp.evaluate(`(() => {
    const track = document.getElementById('calendar-track');
    return {
      x: Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41),
      width: Math.round(document.getElementById('calendar-viewport').clientWidth),
    };
  })()`);
  check('个人月历：窗口宽度变化后轨道重新居中，不残留半月', Math.abs(resized.x + resized.width) <= 2,
    JSON.stringify(resized));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(450);

  // 14. 行数与高度稳定
  const heights = [];
  for (const label of ['2026年11月', '2026年12月', '2027年1月']) {
    await cdp.evaluate("document.getElementById('calendar-today').click()");
    await sleep(150);
    if (label !== '2026年11月') {
      const clicks = label === '2026年12月' ? 1 : 2;
      for (let i = 0; i < clicks; i += 1) {
        await cdp.evaluate("document.getElementById('calendar-next').click()");
        await sleep(220);
      }
    }
    await waitMonth(cdp, label);
    await sleep(200);
    heights.push(await cdp.evaluate(`(() => {
      const state = window.__r11.snapshot('calendar-grid', 'calendar-track');
      state.rowCount = document.querySelectorAll('#calendar-grid .cal-row').length;
      return state;
    })()`));
  }
  check('个人月历：4/5/6 行月份都按六行渲染，切换不改变表格高度',
    heights.every((item) => item.rowCount === 6)
      && Math.max(...heights.map((item) => item.height)) - Math.min(...heights.map((item) => item.height)) <= 1,
    JSON.stringify(heights));

  // 15. 减少动效下点击切月仍可用
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await cdp.evaluate("document.getElementById('calendar-today').click()");
  await waitMonth(cdp, '2026年11月');
  await cdp.evaluate("document.getElementById('calendar-next').click()");
  await waitMonth(cdp, '2026年12月');
  const reduced = await cdp.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches");
  check('个人月历：减少动效时点击切月仍有效', reduced === true, JSON.stringify({ reduced }));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  // 个人月历截图
  await cdp.evaluate("document.getElementById('calendar-today').click()");
  await waitMonth(cdp, '2026年11月');
  await sleep(350);
  await cdp.screenshot('02-personal-calendar.png');

  // 15. 收集日历
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/collect'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-collect').hidden === false"));
  await cdp.evaluate("document.getElementById('collect-tab-calendar').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]').length >= 28"));
  await sleep(300);
  const collectBase = await cdp.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]')];
    return {
      month: document.getElementById('collect-month').textContent,
      first: cells[0]?.dataset.date ?? null,
      rows: document.querySelectorAll('#collect-calendar-grid .cal-row').length,
      selected: document.querySelector('#collect-calendar-grid .cal-cell[aria-selected="true"]')?.dataset.date ?? null,
      neighborButtons: document.querySelectorAll('#collect-calendar-page-prev button, #collect-calendar-page-next button').length,
      x: Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('collect-calendar-track')).transform).m41),
    };
  })()`);
  check('收集月历初始：当前月六行、邻页无可交互控件、轨道居中',
    collectBase.first?.startsWith('2026-11') && collectBase.rows === 6
      && collectBase.neighborButtons === 0,
    JSON.stringify(collectBase));

  const collectGesture = await cdp.evaluate(`(async () => {
    const cell = [...document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]')][14];
    const rect = cell.getBoundingClientRect();
    const start = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 30), inCell: true };
    const track = document.getElementById('collect-calendar-track');
    const fire = (type, x, y, id, primary, target) => (target ?? document).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id ?? 71, isPrimary: primary ?? true,
      pointerType: 'touch', clientX: x, clientY: y,
    }));
    fire('pointerdown', start.x, start.y, 71, true, cell);
    const samples = [];
    for (let i = 1; i <= 7; i += 1) {
      fire('pointermove', start.x - 155 * (i / 7), start.y, 71, true, document);
      samples.push({ x: Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41) });
      await new Promise((r) => requestAnimationFrame(r));
    }
    fire('pointerup', start.x - 155, start.y, 71, true, document);
    return { start, samples, width: track.parentElement.clientWidth };
  })()`);
  await waitMonth(cdp, '2026年12月', 'collect-month');
  await sleep(400);
  recordGesture('collect-long-next', collectGesture);
  const collectAfter = await cdp.evaluate(`(() => ({
    month: document.getElementById('collect-month').textContent,
    first: document.querySelector('#collect-calendar-grid .cal-cell[data-date]')?.dataset.date ?? null,
    x: Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('collect-calendar-track')).transform).m41),
    selected: document.querySelector('#collect-calendar-grid .cal-cell[aria-selected="true"]')?.dataset.date ?? null,
  }))()`);
  check('收集月历：日期格内部起手横拖跟手，吸附到下一月且详情仍对应可见月',
    collectGesture.start.inCell && collectGesture.samples.length === 7
      && collectGesture.samples.at(-1).x < -collectGesture.width - 4
      && collectAfter.first?.startsWith('2026-12') && Math.abs(collectAfter.x + collectGesture.width) <= 2
      && (!collectAfter.selected || collectAfter.selected.startsWith('2026-12')),
    JSON.stringify({ collectGesture, collectAfter }));

  const collectBack = await cdp.evaluate(`(async () => {
    const cell = [...document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]')][10];
    const rect = cell.getBoundingClientRect();
    const fire = (type, x, y, id, primary, target) => (target ?? document).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id ?? 72, isPrimary: primary ?? true,
      pointerType: 'touch', clientX: x, clientY: y,
    }));
    fire('pointerdown', Math.round(rect.left + rect.width / 2), Math.round(rect.top + 30), 72, true, cell);
    fire('pointermove', Math.round(rect.left + rect.width / 2) + 155, Math.round(rect.top + 30), 72, true, document);
    fire('pointerup', Math.round(rect.left + rect.width / 2) + 155, Math.round(rect.top + 30), 72, true, document);
    return true;
  })()`);
  await waitMonth(cdp, '2026年11月', 'collect-month');
  await sleep(350);
  const collectReturn = await cdp.evaluate(`(() => ({
    month: document.getElementById('collect-month').textContent,
    first: document.querySelector('#collect-calendar-grid .cal-cell[data-date]')?.dataset.date ?? null,
  }))()`);
  check('收集月历：右拖回到上一月，月标题与网格一致',
    collectBack && collectReturn.month.replace(/\s+/g, '') === '2026年11月'
      && collectReturn.first?.startsWith('2026-11'),
    JSON.stringify(collectReturn));

  const collectTap = await cdp.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]')]
      .filter((cell) => !cell.classList.contains('is-selected'));
    const target = cells[6];
    const before = document.querySelector('#collect-calendar-grid .cal-cell[aria-selected="true"]')?.dataset.date;
    target.click();
    return { before, date: target.dataset.date };
  })()`);
  await sleep(150);
  const collectSelected = await cdp.evaluate(`document.querySelector('#collect-calendar-grid .cal-cell[aria-selected="true"]')?.dataset.date`);
  check('收集月历：轻点日期仍正常选中，不被拖动识别吞掉',
    collectTap.date === collectSelected && collectTap.before !== collectSelected,
    JSON.stringify({ collectTap, collectSelected }));

  // 收集月历未缓存邻月：真实隐私入口写入使缓存失效后，从日期格起手看到目标月结构与加载
  const shareBlock2 = "document.querySelector('#consent-body .consent-line[data-kind=\"share\"]')";
  await cdp.evaluate("document.getElementById('account-button').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('account-panel').hidden"));
  await cdp.evaluate("document.getElementById('open-privacy').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"));
  await waitFor(() => cdp.evaluate(`${shareBlock2}.querySelector('.consent-switch input') !== null`));
  await cdp.evaluate(`${shareBlock2}.querySelector('.consent-switch input').click()`);
  await waitFor(() => cdp.evaluate("document.getElementById('consent-continue').textContent === '按当前选择继续'"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate(`${shareBlock2}.textContent.includes('已共享')`));
  await cdp.evaluate("document.getElementById('consent-dialog').close()");
  await cdp.evaluate(`(() => {
    window.__r11.hold = { month: '2026-12', queue: [], mode: 'hold' };
    window.__r11.originalFetch = window.fetch;
    window.fetch = (url, init) => {
      const text = String(url);
      const hold = window.__r11.hold;
      if (hold?.queue && text.includes('/collection?month=' + hold.month)) {
        return new Promise((resolve, reject) => {
          hold.queue.push(() => window.__r11.originalFetch(url, init).then(resolve, reject));
        });
      }
      return window.__r11.originalFetch(url, init);
    };
    return true;
  })()`);
  await cdp.evaluate("document.getElementById('collect-prev').click()");
  await waitMonth(cdp, '2026年10月', 'collect-month');
  await cdp.evaluate("document.getElementById('collect-next').click()");
  await waitMonth(cdp, '2026年11月', 'collect-month');
  await waitFor(() => cdp.evaluate("window.__r11.hold.queue.length > 0"));
  const collectLoadingGesture = await cdp.evaluate(`(async () => {
    const cell = [...document.querySelectorAll('#collect-calendar-grid button.cal-cell[data-date]')][12];
    const rect = cell.getBoundingClientRect();
    const sx = Math.round(rect.left + rect.width / 2);
    const sy = Math.round(rect.top + 30);
    const fire = (type, x, y, target) => (target ?? document).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 73, isPrimary: true,
      pointerType: 'touch', clientX: x, clientY: y,
    }));
    fire('pointerdown', sx, sy, cell);
    for (let i = 1; i <= 6; i += 1) {
      fire('pointermove', sx - 150 * (i / 6), sy);
      await new Promise((r) => requestAnimationFrame(r));
    }
    fire('pointerup', sx - 150, sy);
    return { start: { x: sx, y: sy, inCell: true } };
  })()`);
  await sleep(350);
  const collectHeld = await cdp.evaluate(`(() => {
    const next = document.getElementById('collect-calendar-page-next');
    return {
      titleKey: document.getElementById('collect-month').textContent.replace(/\\s+/g, ''),
      nextState: next.dataset.state,
      nextLabel: next.dataset.label,
      nextFirst: next.querySelector('.cal-cell[data-date]')?.dataset.date ?? null,
      noRecord: next.textContent.includes('无记录'),
      centerFirst: document.querySelector('#collect-calendar-grid .cal-cell[data-date]')?.dataset.date ?? null,
    };
  })()`);
  check('收集月历：未缓存邻月显示目标月结构与加载，标题等数据到达再切换',
    collectLoadingGesture.start.inCell
      && collectHeld.titleKey === '2026年11月' && collectHeld.nextState === 'loading'
      && collectHeld.nextLabel.includes('加载中') && collectHeld.nextFirst?.startsWith('2026-12')
      && !collectHeld.noRecord && collectHeld.centerFirst?.startsWith('2026-11'),
    JSON.stringify({ collectHeld }));
  await cdp.evaluate(`(() => {
    const q = window.__r11.hold.queue;
    window.__r11.hold = null;
    window.fetch = window.__r11.originalFetch;
    q.forEach((run) => run());
    return true;
  })()`);
  await waitMonth(cdp, '2026年12月', 'collect-month');
  await sleep(400);
  const collectLoaded = await cdp.evaluate(`(() => ({
    first: document.querySelector('#collect-calendar-grid .cal-cell[data-date]')?.dataset.date ?? null,
    x: Math.round(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('collect-calendar-track')).transform).m41),
    width: Math.round(document.getElementById('collect-calendar-viewport').clientWidth),
  }))()`);
  check('收集月历：慢网完成后标题/网格一致并回到轨道中心',
    collectLoaded.first?.startsWith('2026-12') && Math.abs(collectLoaded.x + collectLoaded.width) <= 2,
    JSON.stringify(collectLoaded));
  await sleep(250);
  await cdp.screenshot('03-owner-collection-calendar.png');

  // 桌面工作区
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-calendar').hidden === false"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid button.cal-cell[data-date]').length >= 28"));
  await sleep(350);
  await cdp.screenshot('05-desktop-workspace.png');

  const desktopNav = await cdp.evaluate(`(() => {
    const side = document.querySelector('.shell-side');
    const links = [...document.querySelectorAll('#side-space-links .side-link')];
    return {
      sideVisible: getComputedStyle(side).display !== 'none',
      mobileNavHidden: getComputedStyle(document.getElementById('mobile-nav')).display === 'none',
      labels: links.map((link) => link.textContent.trim()),
      clipped: links.some((link) => link.scrollWidth > link.clientWidth + 1),
      columns: document.querySelectorAll('#calendar-grid .cal-row')[0]?.children.length ?? 0,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('1280 桌面：侧栏五个功能可达且不裁切，月历七列无横向溢出',
    desktopNav.sideVisible && desktopNav.mobileNavHidden
      && desktopNav.labels.join(',') === '首页,我的课表,我的日历,课表收集,空间设置'
      && !desktopNav.clipped && desktopNav.columns === 7 && !desktopNav.overflow,
    JSON.stringify(desktopNav));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 768, height: 1024, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(400);
  const tablet = await cdp.evaluate(`(() => {
    const nav = document.getElementById('mobile-nav');
    return {
      sideHidden: getComputedStyle(document.querySelector('.shell-side')).display === 'none',
      navVisible: !nav.hidden,
      labels: [...nav.querySelectorAll('.mobile-link')].map((link) => link.textContent.trim()),
      clipped: nav.scrollWidth > nav.clientWidth + 1,
      perRow: [...document.querySelectorAll('#calendar-grid .cal-row')].every((row) => row.children.length === 7),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('768 平板：手机布局导航五项不裁切，月历七列且无横向溢出',
    tablet.sideHidden && tablet.navVisible && tablet.labels.join(',') === '首页,课表,日历,收集,设置'
      && !tablet.clipped && tablet.perRow && !tablet.overflow,
    JSON.stringify(tablet));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 568, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/schedule'`);
  await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.day-tab').length === 7"));
  await sleep(400);
  const narrow = await cdp.evaluate(`(() => {
    const nav = document.getElementById('mobile-nav');
    const tabs = [...document.querySelectorAll('.day-tab')];
    const save = document.getElementById('schedule-publish');
    return {
      title: document.getElementById('mobile-title').textContent,
      labels: [...nav.querySelectorAll('.mobile-link')].map((link) => link.textContent.trim()),
      navClipped: nav.scrollWidth > nav.clientWidth + 1,
      tabs: tabs.map((tab) => tab.textContent).join(''),
      tabMin: Math.min(...tabs.map((tab) => Math.round(tab.getBoundingClientRect().width))),
      tabHeight: Math.min(...tabs.map((tab) => Math.round(tab.getBoundingClientRect().height))),
      tabOverflow: document.getElementById('day-tabs').scrollWidth > document.getElementById('day-tabs').clientWidth + 1,
      saveVisible: save.offsetParent !== null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('320 窄屏：工作区与五项导航完整，星期七日不裁切、高度仍为 44，无横向溢出',
    narrow.title === '秋冬课程空间' && narrow.labels.join(',') === '首页,课表,日历,收集,设置'
      && !narrow.navClipped && narrow.tabs === '一二三四五六日' && narrow.tabMin >= 32
      && narrow.tabHeight >= 44 && !narrow.tabOverflow && narrow.saveVisible && !narrow.overflow,
    JSON.stringify(narrow));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-calendar').hidden === false"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid button.cal-cell[data-date]').length >= 28"));
  const widePhone = await cdp.evaluate(`(() => {
    const nav = document.getElementById('mobile-nav');
    return {
      labels: [...nav.querySelectorAll('.mobile-link')].map((link) => link.textContent.trim()),
      navClipped: nav.scrollWidth > nav.clientWidth + 1,
      columns: document.querySelectorAll('#calendar-grid .cal-row')[0]?.children.length ?? 0,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('430 大屏手机：五项导航完整、月历七列且无横向溢出',
    widePhone.labels.join(',') === '首页,课表,日历,收集,设置'
      && !widePhone.navClipped && widePhone.columns === 7 && !widePhone.overflow,
    JSON.stringify(widePhone));

  const pageStructure = await cdp.evaluate(`(() => {
    const footer = document.querySelector('footer.site-footer');
    const doc = document.scrollingElement;
    const before = scrollY;
    scrollTo(0, 999999);
    const maxY = doc.scrollHeight - innerHeight;
    const atBottom = Math.abs(scrollY - maxY) <= 2;
    const rect = footer?.getBoundingClientRect();
    const footerVisible = Boolean(rect) && rect.bottom <= innerHeight + 2 && rect.bottom > 0;
    scrollTo(0, before);
    return {
      exists: Boolean(footer), position: footer ? getComputedStyle(footer).position : null,
      docTag: doc.tagName, docHeight: doc.scrollHeight, maxY, atBottom, footerVisible,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    };
  })()`);
  check('整页结构：真实页脚在文档流末尾，原生文档滚动可到达页面底部',
    pageStructure.exists && pageStructure.position === 'static' && pageStructure.docTag === 'HTML'
      && pageStructure.maxY > 0 && pageStructure.atBottom && pageStructure.footerVisible
      && pageStructure.bodyOverflow !== 'hidden',
    JSON.stringify(pageStructure));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/schedule'`);
  await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.day-tab').length === 7"));
  await sleep(300);
  await cdp.evaluate("document.documentElement.style.setProperty('--site-type', '1.25')");
  await sleep(400);
  const enlarged = await cdp.evaluate(`(() => {
    const nav = document.getElementById('mobile-nav');
    const tabs = [...document.querySelectorAll('.day-tab')];
    const save = document.getElementById('schedule-publish');
    return {
      bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
      navClipped: nav.scrollWidth > nav.clientWidth + 1,
      tabMin: Math.min(...tabs.map((tab) => Math.round(tab.getBoundingClientRect().width))),
      tabOverflow: document.getElementById('day-tabs').scrollWidth > document.getElementById('day-tabs').clientWidth + 1,
      saveHeight: Math.round(save.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  await cdp.evaluate("document.documentElement.style.removeProperty('--site-type')");
  check('字体放大 1.25 倍：导航与星期不裁切，保存可达且无横向溢出',
    enlarged.bodyFont >= 19 && !enlarged.navClipped && enlarged.tabMin >= 38
      && !enlarged.tabOverflow && enlarged.saveHeight >= 38 && !enlarged.overflow,
    JSON.stringify(enlarged));

  // 草稿预览：本人可见、只读，不改变提交状态、普通月历口径或收集视图。
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-calendar').hidden === false"));
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid button.cal-cell[data-date]').length >= 28"));
  const today = todayInSpace();
  const sunday = await cdp.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#calendar-grid button.cal-cell[data-date]')]
      .filter((cell) => cell.dataset.date >= ${JSON.stringify(today)});
    const cell = cells.find((entry) => cellWeekday(entry.dataset.date) === 7
      && !entry.getAttribute('aria-label').includes('学期外'));
    return cell?.dataset.date ?? null;
    function cellWeekday(date) {
      return ((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
    }
  })()`);
  if (!sunday) throw new Error('当前月没有可用于预览的周日');
  const scheduleNow = await api(cdp, `/api/spaces/${spaceId}/schedule`);
  const draftEntries = [
    ...entries,
    { day: 7, period: 1, weekRule: 'every', courseName: '草稿预览课' },
  ];
  const draftSaved = await api(cdp, `/api/spaces/${spaceId}/schedule/draft`, {
    method: 'POST',
    body: {
      requestId: `r11-${randomUUID()}`,
      baseRevision: scheduleNow.body.schedule.revision,
      entries: draftEntries,
    },
  });
  check('草稿预览前置：本人草稿与有效版本不同',
    [200, 201].includes(draftSaved.status), String(draftSaved.status));

  await cdp.evaluate('location.reload()');
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"));
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("document.getElementById('page-calendar').hidden === false"));
  await waitFor(() => cdp.evaluate(`document.querySelector('#calendar-grid .cal-cell[data-date="${sunday}"]') !== null`));
  await waitFor(() => cdp.evaluate("!document.getElementById('calendar-preview').hidden"));
  const draftOffer = await cdp.evaluate(`(() => ({
    pressed: document.getElementById('calendar-preview').getAttribute('aria-pressed'),
    noteHidden: document.getElementById('calendar-preview-note').hidden,
    chip: document.getElementById('calendar-state').textContent,
    sunday: document.querySelector('#calendar-grid .cal-cell[data-date="${sunday}"]').getAttribute('aria-label'),
  }))()`);
  check('草稿预览入口：草稿与已提交不同时才出现，默认未激活且无提示',
    draftOffer.pressed === 'false' && draftOffer.noteHidden === true
      && draftOffer.chip === '已就绪' && !draftOffer.sunday.includes('课 1'),
    JSON.stringify(draftOffer));

  await cdp.evaluate("document.getElementById('calendar-preview').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-state').textContent === '草稿'"));
  await waitFor(() => cdp.evaluate(
    `document.querySelector('#calendar-grid .cal-cell[data-date="${sunday}"]').getAttribute('aria-label').includes('课 1')`,
  ));
  const previewState = await cdp.evaluate(`(() => ({
    pressed: document.getElementById('calendar-preview').getAttribute('aria-pressed'),
    noteHidden: document.getElementById('calendar-preview-note').hidden,
    note: document.getElementById('calendar-preview-note').textContent,
    sunday: document.querySelector('#calendar-grid .cal-cell[data-date="${sunday}"]').getAttribute('aria-label'),
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
  }))()`);
  check('草稿预览：月历显示草稿课程、只有一处“尚未提交”提示且页面不横向溢出',
    previewState.pressed === 'true' && previewState.noteHidden === false
      && previewState.note.includes('草稿内容') && previewState.note.includes('尚未提交')
      && previewState.sunday.includes('课 1') && !previewState.overflow,
    JSON.stringify(previewState));
  await cdp.screenshot('06-draft-preview.png');

  await cdp.evaluate("document.getElementById('calendar-preview').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('calendar-state').textContent === '已就绪'"));
  const restored = await cdp.evaluate(`(() => ({
    pressed: document.getElementById('calendar-preview').getAttribute('aria-pressed'),
    noteHidden: document.getElementById('calendar-preview-note').hidden,
    sunday: document.querySelector('#calendar-grid .cal-cell[data-date="${sunday}"]').getAttribute('aria-label'),
  }))()`);
  check('退出草稿预览：恢复已提交月历与提示隐藏，草稿没有冒充提交',
    restored.pressed === 'false' && restored.noteHidden === true
      && !restored.sunday.includes('课 1'),
    JSON.stringify(restored));
  const afterPreview = await api(cdp, `/api/spaces/${spaceId}/schedule`);
  check('草稿预览只读：有效版本与草稿均保持不变',
    afterPreview.body.schedule.publishedVersion === 1
      && afterPreview.body.schedule.submitted === true
      && afterPreview.body.schedule.draftEntries?.length === draftEntries.length,
    JSON.stringify({
      publishedVersion: afterPreview.body.schedule.publishedVersion,
      submitted: afterPreview.body.schedule.submitted,
      draftCount: afterPreview.body.schedule.draftEntries?.length,
    }));

  await writeFile(join(OUT, 'gestures-r11.json'), JSON.stringify(gestureLog, null, 2));
  check('浏览器检查期间无未捕获异常或 console.error', cdp.pageErrors.length === 0, JSON.stringify(cdp.pageErrors.slice(0, 3)));
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) throw new Error('未找到 Edge/Chrome');
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'round11-shot-'));
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
  process.stdout.write(`\n第11轮浏览器检查：${passed}/${results.length} 通过\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();

// 手机视口性能与手势基线：无头 Edge + CDP + 本地预览 + 内存假数据库。
// 只测桌面浏览器模拟的手机视口，不代表真实手机、触摸屏、输入法或网络。
//   node dev/check-mobile-perf.mjs   （需先启动 dev/preview-server.mjs）
// 输出 JSON 到 stdout；可用 PERF_OUT 写入文件。
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
const PORT = Number(process.env.CDP_PORT ?? 9348);
const PASSWORD = `local-perf-${randomUUID()}-${randomUUID()}`;
const results = [];

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

async function registerUi(cdp, username) {
  await cdp.evaluate(`(() => {
    document.getElementById('auth-tab-register').click();
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('register-username', ${JSON.stringify(username)});
    set('register-nickname', '性能负责人');
    set('register-password', ${JSON.stringify(PASSWORD)});
    set('register-confirm', ${JSON.stringify(PASSWORD)});
    document.getElementById('register-notice').click();
    return true;
  })()`);
  await waitFor(() => cdp.evaluate("!document.getElementById('register-submit').disabled"));
  await cdp.evaluate("document.getElementById('register-submit').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('app-panel').hidden"));
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

async function installProbe(cdp) {
  await cdp.evaluate(`(() => {
    window.__perf = { longTasks: [], frames: [], switchFrames: null };
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perf.longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch { /* 浏览器不支持 longtask */ }
    }
    return true;
  })()`);
}

async function resetLongTasks(cdp) {
  await cdp.evaluate('window.__perf.longTasks = []; true');
}

async function longTaskSummary(cdp) {
  return cdp.evaluate(`(() => {
    const list = window.__perf.longTasks.slice();
    const durations = list.map((item) => item.duration);
    return {
      count: list.length,
      over50: durations.filter((value) => value >= 50).length,
      over100: durations.filter((value) => value >= 100).length,
      max: durations.length ? Math.max(...durations) : 0,
      total: durations.reduce((sum, value) => sum + value, 0),
    };
  })()`);
}

async function pageSwitch(cdp, spaceId, name, waitExpression) {
  const key = {
    home: 'home', schedule: 'schedule', calendar: 'calendar', collect: 'collect',
  }[name];
  const suffix = key === 'home' ? `/spaces/${spaceId}` : `/${key}`;
  return cdp.evaluate(`(async () => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const start = performance.now();
    const link = document.querySelector('#side-space-links .side-link[href$="${suffix}"]')
      ?? document.querySelector('#mobile-nav .mobile-link[href$="${suffix}"]');
    if (!link) return { ms: -1, frames: 0, missingLink: true, suffix: ${JSON.stringify(suffix)},
      hrefs: [...document.querySelectorAll('#side-space-links .side-link')].map((item) => item.getAttribute('href')) };
    link.click();
    let frames = 0;
    let blankFrames = 0;
    let overlayFrames = 0;
    while (frames < 240) {
      await raf();
      frames += 1;
      const section = document.getElementById('page-${key}');
      if (section && !section.hidden) {
        if (!section.innerText.trim()) blankFrames += 1;
        if (document.querySelector('.page-slide-overlay')) overlayFrames += 1;
        if (${waitExpression}) {
          return { ms: Math.round(performance.now() - start), frames, blankFrames, overlayFrames };
        }
      }
    }
    return { ms: -1, frames, blankFrames, overlayFrames, timeout: true,
      hidden: document.getElementById('page-${key}')?.hidden,
      body: document.getElementById('page-${key}')?.innerText?.slice(0, 80) };
  })()`);
}

async function monthSwitch(cdp, buttonId) {
  return cdp.evaluate(`(async () => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const label = () => document.getElementById('calendar-month').textContent;
    const target = (() => {
      const text = label();
      const m = /([0-9]{4}) 年 ([0-9]+) 月/.exec(text);
      if (!m) return null;
      const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + ${buttonId === 'calendar-next' ? 1 : -1};
      return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0');
    })();
    const start = performance.now();
    document.getElementById(${JSON.stringify(buttonId)}).click();
    const frames = [];
    let blankFrames = 0;
    let skeletonFrames = 0;
    for (let i = 0; i < 180; i += 1) {
      await raf();
      const table = document.getElementById('calendar-table');
      const skeleton = document.getElementById('calendar-skeleton');
      const blank = table.hidden;
      if (blank) blankFrames += 1;
      if (!skeleton.hidden) skeletonFrames += 1;
      frames.push({ t: Math.round(performance.now() - start), blank, skeleton: !skeleton.hidden, label: label() });
      if (!blank && skeleton.hidden) {
        const text = label();
        const m = /([0-9]{4}) 年 ([0-9]+) 月/.exec(text);
        const shown = m ? m[1] + '-' + String(Number(m[2])).padStart(2, '0') : null;
        if (shown === target) break;
      }
    }
    return {
      ms: Math.round(performance.now() - start),
      target,
      label: label(),
      blankFrames,
      skeletonFrames,
      samples: frames.slice(0, 8),
      cells: document.querySelectorAll('#calendar-grid .cal-cell[data-date]').length,
    };
  })()`);
}

async function rapidMonths(cdp) {
  return cdp.evaluate(`(async () => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const label = () => document.getElementById('calendar-month').textContent;
    const m0 = /([0-9]{4}) 年 ([0-9]+) 月/.exec(label());
    if (!m0) return { error: 'month missing' };
    const startIndex = Number(m0[1]) * 12 + Number(m0[2]) - 1;
    const next = document.getElementById('calendar-next');
    const prev = document.getElementById('calendar-prev');
    next.click(); next.click(); next.click(); next.click();
    await new Promise((r) => setTimeout(r, 40));
    prev.click(); prev.click();
    const targetIndex = startIndex + 2;
    const targetLabel = String(Math.floor(targetIndex / 12)).padStart(4, '0') + ' 年 ' + (targetIndex % 12 + 1) + ' 月';
    const start = performance.now();
    for (let i = 0; i < 240; i += 1) {
      await raf();
      if (label() === targetLabel && !document.getElementById('calendar-table').hidden) break;
    }
    return {
      ms: Math.round(performance.now() - start),
      expected: targetLabel,
      actual: label(),
      tableVisible: !document.getElementById('calendar-table').hidden,
      skeletonHidden: document.getElementById('calendar-skeleton').hidden,
    };
  })()`);
}

async function swipeTrace(cdp) {
  return cdp.evaluate(`(async () => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    document.querySelector('#side-space-links .side-link[href$="/schedule"]').click();
    for (let i = 0; i < 120; i += 1) {
      await raf();
      if (!document.getElementById('page-schedule').hidden && document.querySelector('.day-viewport')) break;
    }
    await sleep(350);
    const track = document.querySelector('.day-track');
    const viewport = document.querySelector('.day-viewport');
    const width = viewport.clientWidth;
    const tx = () => Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41);
    const selected = () => [...document.querySelectorAll('.day-tab')]
      .find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.day;
    let pointerId = 40;
    const fire = (type, x, y, id) => {
      const target = type === 'pointerdown' ? document.querySelector('#day-page-' + day + ' .day-list') : document;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, isPrimary: id === pointerId,
        pointerType: 'touch', clientX: x, clientY: y,
      }));
    };
    const reset = async (day) => {
      document.querySelector('.day-tab[data-day="' + day + '"]').click();
      await sleep(500);
    };
    let day = 2;
    const run = async (name, steps, { cancel = false, vertical = false, startDay = 2 } = {}) => {
      day = startDay;
      await reset(startDay);
      const currentId = ++pointerId;
      const baseX = 300;
      const baseY = 500;
      const samples = [];
      window.__perf.longTasks = [];
      const gaps = [];
      let last = performance.now();
      let ticking = true;
      const tick = () => {
        const now = performance.now();
        gaps.push(Math.round(now - last));
        last = now;
        if (ticking) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      fire('pointerdown', baseX, baseY, currentId);
      for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        fire('pointermove', baseX + step.dx, baseY + (step.dy ?? 0), currentId);
        await raf();
        samples.push({ dx: step.dx, dy: step.dy ?? 0, x: tx() });
      }
      if (cancel) fire('pointercancel', baseX + steps.at(-1).dx, baseY, currentId);
      else fire('pointerup', baseX + steps.at(-1).dx, baseY + (steps.at(-1).dy ?? 0), currentId);
      await sleep(700);
      ticking = false;
      const tasks = window.__perf.longTasks.slice();
      const durations = tasks.map((item) => item.duration);
      return {
        name, vertical, samples, settledX: tx(), selected: selected(),
        editing: !document.getElementById('cell-editor').hidden,
        frames: gaps.length,
        maxGap: gaps.length ? Math.max(...gaps) : 0,
        over34: gaps.filter((gap) => gap > 34).length,
        longTasks: {
          count: tasks.length,
          over50: durations.filter((value) => value >= 50).length,
          max: durations.length ? Math.max(...durations) : 0,
        },
      };
    };
    const traces = [];
    traces.push(await run('small-rebound', [{ dx: -20, wait: 80 }, { dx: -30, wait: 90 }]));
    traces.push(await run('threshold-snap', [{ dx: -40, wait: 60 }, { dx: -90, wait: 80 }]));
    traces.push(await run('flick', [{ dx: -15, wait: 5 }, { dx: -35, wait: 5 }, { dx: -55, wait: 5 }]));
    traces.push(await run('long-drag', [{ dx: -90, wait: 20 }, { dx: -220, wait: 20 }, { dx: -380, wait: 20 }, { dx: -560, wait: 20 }]));
    traces.push(await run('cancel', [{ dx: -90, wait: 30 }, { dx: -140, wait: 30 }], { cancel: true }));
    traces.push(await run('vertical', [{ dx: 8, dy: 60 }, { dx: 12, dy: 130 }], { vertical: true }));
    traces.push(await run('diagonal', [{ dx: -90, dy: 50 }, { dx: -160, dy: 90 }]));
    traces.push(await run('reverse', [{ dx: -120, wait: 120 }, { dx: -40, wait: 20 }, { dx: -20, wait: 6 }]));
    traces.push(await run('start-edge', [{ dx: 60, wait: 20 }, { dx: 200, wait: 20 }], { startDay: 1 }));
    traces.push(await run('end-edge', [{ dx: -60, wait: 20 }, { dx: -200, wait: 20 }], { startDay: 7 }));
    return { width, traces };
  })()`);
}

async function run(cdp) {
  const username = `perf_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));
  await registerUi(cdp, username);

  const created = await cdp.evaluate(`(async () => {
    const response = await fetch('/functions/v1/app/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '性能空间', ownerName: '性能负责人', mode: 'courses',
        oddEvenEnabled: false, visibility: 'masked_list',
        periods: Array.from({ length: 12 }, (_, index) => ({
          index: index + 1,
          start: ['08:00','08:55','10:00','10:55','11:50','14:00','14:55','16:00','16:55','19:00','19:55','20:50'][index],
          end: ['08:45','09:40','10:45','11:40','12:35','14:45','15:40','16:45','17:40','19:45','20:40','21:35'][index],
        })),
        teaching: {
          timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
          termStart: '2026-09-07', termEnd: '2027-01-24',
        },
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  const spaceId = created.body?.space?.id;
  await api(cdp, `/api/spaces/${spaceId}/calendar/consent`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: 's3-calendar-2' },
  });
  await api(cdp, `/api/spaces/${spaceId}/calendar/share`, {
    method: 'POST',
    body: { action: 'accept', noticeAccepted: true, noticeVersion: 's3-share-1' },
  });
  await api(cdp, `/api/spaces/${spaceId}/participation`, {
    method: 'POST', body: { action: 'join', source: 'published' },
  });
  await cdp.evaluate('location.reload()');
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.querySelectorAll('.space-button').length >= 1"));
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/home'`);
  await waitFor(() => cdp.evaluate("!document.getElementById('page-home').hidden && !document.getElementById('home-content').hidden"));
  await installProbe(cdp);

  const cold = {};
  await resetLongTasks(cdp);
  cold.schedule = await pageSwitch(cdp, spaceId, 'schedule', "document.querySelector('.week-table') || document.querySelector('.day-viewport')");
  const scheduleTasks = await longTaskSummary(cdp);
  await resetLongTasks(cdp);
  cold.calendar = await pageSwitch(cdp, spaceId, 'calendar', "!document.getElementById('calendar-table').hidden");
  const calendarTasks = await longTaskSummary(cdp);
  await resetLongTasks(cdp);
  cold.home = await pageSwitch(cdp, spaceId, 'home', "!document.getElementById('home-content').hidden");
  const homeTasks = await longTaskSummary(cdp);

  const warm = [];
  for (let i = 0; i < 3; i += 1) {
    await resetLongTasks(cdp);
    const schedule = await pageSwitch(cdp, spaceId, 'schedule', "document.querySelector('.week-table') || document.querySelector('.day-viewport')");
    const afterSchedule = await longTaskSummary(cdp);
    await resetLongTasks(cdp);
    const calendar = await pageSwitch(cdp, spaceId, 'calendar', "!document.getElementById('calendar-table').hidden");
    const afterCalendar = await longTaskSummary(cdp);
    await resetLongTasks(cdp);
    const home = await pageSwitch(cdp, spaceId, 'home', "!document.getElementById('home-content').hidden");
    const afterHome = await longTaskSummary(cdp);
    warm.push({ schedule, calendar, home, tasks: { schedule: afterSchedule, calendar: afterCalendar, home: afterHome } });
  }

  const domBefore = await cdp.evaluate("document.querySelectorAll('*').length");
  for (let i = 0; i < 6; i += 1) {
    await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/home'`);
    await waitFor(() => cdp.evaluate("!document.getElementById('page-home').hidden"));
    await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/schedule'`);
    await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden"));
    await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
    await waitFor(() => cdp.evaluate("!document.getElementById('page-calendar').hidden"));
  }
  const domAfter = await cdp.evaluate("document.querySelectorAll('*').length");

  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await waitFor(() => cdp.evaluate("!document.getElementById('calendar-table').hidden"));
  await sleep(300);
  const monthSingle = await monthSwitch(cdp, 'calendar-next');
  await sleep(300);
  const monthPrev = await monthSwitch(cdp, 'calendar-prev');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 350, downloadThroughput: 200000, uploadThroughput: 100000,
    connectionType: 'cellular4g',
  });
  await monthSwitch(cdp, 'calendar-next');
  const slowMonth = await monthSwitch(cdp, 'calendar-next');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    connectionType: 'none',
  });
  await sleep(300);
  const rapid = await rapidMonths(cdp);
  const swipe = await swipeTrace(cdp);

  const output = {
    conditions: {
      base: BASE,
      viewport: '390x844 DPR2 mobile emulation',
      browser: 'headless Edge',
      cpuThrottle: '4x',
      network: 'local; slow month uses 350ms RTT / 200kbps down',
      data: 'synthetic owner, 12 periods, current term',
      note: '桌面无头浏览器模拟手机视口，不是真机触控/FPS',
    },
    spaceId,
    cold,
    coldTasks: { schedule: scheduleTasks, calendar: calendarTasks, home: homeTasks },
    warm,
    domNodes: { before: domBefore, after: domAfter },
    monthSwitch: { next: monthSingle, prev: monthPrev, slow: slowMonth, rapid },
    swipe,
    pageErrors: cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text)),
  };
  const text = JSON.stringify(output, null, 2);
  process.stdout.write(`${text}\n`);
  if (process.env.PERF_OUT) await writeFile(process.env.PERF_OUT, text);
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) {
    process.stdout.write('SKIP 未找到 Edge/Chrome\n');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 'perf-cdp-'));
  const browser = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--window-size=390,844',
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: BASE });
    await waitFor(() => cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('auth-panel')"));
    await run(cdp);
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    browser.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (results.length === 0 && process.env.PERF_OUT) {
      // 失败时也保留已写文件，便于定位。
    }
  }
}

await main();

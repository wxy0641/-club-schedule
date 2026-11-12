// Round 15 浏览器检查：桌面工作区恢复单行标签页导航 + 常驻“← 我的空间”，
// 验证当前页高亮、返回只回空间列表且保留会话/成员关系、窄桌面不裁切、手机导航不变。
// 只连接本地预览与内存假库，不代表部署环境或真机。
//   node dev/check-round15-ui.mjs   （需要先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
const PORT = Number(process.env.CDP_PORT ?? 9435);
const OUT = join(process.cwd(), 'evidence', 'round15');
const PASSWORD = `local-r15-${randomUUID()}-${randomUUID()}`;
const SPACE_NAME = '电脑端导航空间';
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

async function passConsentGate(cdp) {
  try {
    await waitFor(() => cdp.evaluate("document.getElementById('consent-dialog').open"), { timeout: 1500, interval: 80 });
  } catch {
    return false;
  }
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-continue').disabled"));
  await cdp.evaluate("document.getElementById('consent-continue').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('consent-dialog').open"));
  return true;
}

async function pageVisible(cdp, name) {
  return waitFor(() => cdp.evaluate(`document.getElementById('page-${name}').hidden === false`));
}

async function navSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const bar = document.querySelector('.shell-side');
    const back = document.getElementById('side-spaces-link');
    const tabs = [...document.querySelectorAll('#side-space-links .side-link')];
    const active = tabs.filter((link) => link.getAttribute('aria-current') === 'page');
    const inactive = tabs.find((link) => link.getAttribute('aria-current') !== 'page');
    const barStyle = getComputedStyle(bar);
    const barRect = bar.getBoundingClientRect();
    const backRect = back.getBoundingClientRect();
    const activeStyle = active[0] ? getComputedStyle(active[0]) : null;
    const inactiveStyle = inactive ? getComputedStyle(inactive) : null;
    const mobileNav = document.getElementById('mobile-nav');
    const mobileHead = document.getElementById('mobile-head');
    return {
      bar: {
        display: barStyle.display, position: barStyle.position, visible: bar.offsetParent !== null,
        top: barRect.top, height: barRect.height, width: barRect.width,
      },
      back: {
        visible: back.offsetParent !== null, text: back.textContent.trim(),
        href: back.getAttribute('href'), label: back.getAttribute('aria-label'),
        icon: back.querySelector('.back-icon')?.textContent ?? '',
        height: backRect.height, width: backRect.width, top: backRect.top,
        clipped: back.scrollWidth > back.clientWidth + 1,
      },
      tabs: tabs.map((link) => {
        const rect = link.getBoundingClientRect();
        return {
          text: link.textContent.trim(), href: link.getAttribute('href'),
          height: rect.height, width: rect.width, top: rect.top,
          clipped: link.scrollWidth > link.clientWidth + 1,
        };
      }),
      active: active.map((link) => link.textContent.trim()),
      activeBg: activeStyle?.backgroundColor ?? '',
      inactiveBg: inactiveStyle?.backgroundColor ?? '',
      mobileNavDisplay: getComputedStyle(mobileNav).display,
      mobileHeadDisplay: getComputedStyle(mobileHead).display,
      mobileNavVisible: mobileNav.offsetParent !== null,
      mobileBackVisible: document.getElementById('mobile-back').offsetParent !== null,
      mobileLinks: [...mobileNav.querySelectorAll('.mobile-link')].map((link) => ({
        text: link.textContent.trim(), label: link.getAttribute('aria-label'),
        height: link.getBoundingClientRect().height,
        current: link.getAttribute('aria-current'),
      })),
      mobileTitle: document.getElementById('mobile-title').textContent,
      spaceTitleVisible: document.getElementById('space-title').offsetParent !== null,
      spaceRoleVisible: document.getElementById('space-role').offsetParent !== null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      page: [...document.querySelectorAll('.page')].filter((page) => !page.hidden).map((page) => page.id),
      hash: location.hash,
      account: document.getElementById('account-name').textContent,
      authHidden: document.getElementById('auth-panel').hidden,
      appVisible: !document.getElementById('app-panel').hidden,
      scrollY: window.scrollY,
    };
  })()`);
}

async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await waitFor(() => cdp.evaluate("!document.getElementById('auth-panel').hidden"));

  const username = `r15_owner_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await registerUi(cdp, username, '负责人');
  await passConsentGate(cdp);

  const created = await api(cdp, '/api/spaces', {
    method: 'POST',
    body: {
      name: SPACE_NAME,
      ownerName: '负责人',
      mode: 'presence',
      weekRule: 'every',
      visibility: 'masked_list',
      periods: [
        ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
        ['11:50', '12:35'], ['14:00', '14:45'], ['14:55', '15:40'], ['16:00', '16:45'],
        ['16:55', '17:40'], ['19:00', '19:45'], ['19:55', '20:40'], ['20:50', '21:35'],
      ].map(([start, end], index) => ({ index: index + 1, start, end })),
      teaching: {
        timezone: 'Asia/Shanghai',
        firstWeekMonday: '2026-08-31',
        termStart: '2026-08-31',
        termEnd: '2027-01-24',
      },
    },
  });
  check('准备：创建用于导航验证的空间', created.status === 201,
    JSON.stringify({ status: created.status, error: created.body?.error }));
  const spaceId = created.body.space.id;

  await cdp.evaluate("location.hash = '#/spaces'");
  await pageVisible(cdp, 'spaces');
  await cdp.evaluate("document.getElementById('reload').click()");
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.space-button')].some((button) => button.textContent.includes(${JSON.stringify(SPACE_NAME)}))`));
  await cdp.evaluate(`[...document.querySelectorAll('.space-button')].find((button) => button.textContent.includes(${JSON.stringify(SPACE_NAME)}))?.click()`);
  await pageVisible(cdp, 'home');
  await passConsentGate(cdp);
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#side-space-links .side-link').length === 5"));

  const home = await navSnapshot(cdp);
  check('桌面：单行标签导航常驻，左侧“← 我的空间”清晰可见',
    home.bar.visible && home.bar.position === 'sticky'
      && home.back.visible && home.back.text === '←我的空间'
      && home.back.icon === '←' && home.back.href === '#/spaces'
      && home.back.label === '返回我的空间' && home.back.height >= 36 && home.back.height <= 40
      && !home.back.clipped,
    JSON.stringify(home.back));
  check('桌面：五个功能标签同一行、不裁切、高度 36–40px',
    home.tabs.length === 5
      && home.tabs.every((tab) => !tab.clipped && tab.height >= 36 && tab.height <= 40)
      && new Set(home.tabs.map((tab) => Math.round(tab.top))).size === 1
      && home.tabs.every((tab) => Math.abs(tab.top - home.back.top) <= 1),
    JSON.stringify(home.tabs.map(({ text, top, height, clipped }) => ({ text, top, height, clipped }))));
  check('桌面：当前页“首页”高亮，且只有一套可见导航、无重复空间标题',
    home.active.join(',') === '首页'
      && home.activeBg !== home.inactiveBg
      && home.mobileNavDisplay === 'none' && home.mobileHeadDisplay === 'none'
      && home.spaceTitleVisible === false && home.spaceRoleVisible === false
      && !home.overflow,
    JSON.stringify({
      active: home.active, activeBg: home.activeBg, inactiveBg: home.inactiveBg,
      mobileNavDisplay: home.mobileNavDisplay, mobileHeadDisplay: home.mobileHeadDisplay,
      spaceTitleVisible: home.spaceTitleVisible, overflow: home.overflow,
    }));

  await cdp.evaluate("document.querySelector('#side-space-links .side-link[href$=\"/calendar\"]').click()");
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid .cal-cell[data-date]').length >= 28"));
  const calendar = await navSnapshot(cdp);
  check('桌面：切换“我的日历”后标签高亮跟随，返回入口仍在',
    calendar.active.join(',') === '我的日历' && calendar.back.visible
      && calendar.tabs.filter((tab) => tab.text === '我的日历').length === 1,
    JSON.stringify({ active: calendar.active, back: calendar.back.visible }));

  await cdp.evaluate('window.scrollTo(0, 700)');
  await sleep(120);
  const scrolled = await navSnapshot(cdp);
  check('桌面：长页面滚动后导航仍吸附在顶部，返回入口不消失',
    scrolled.scrollY > 500 && scrolled.bar.visible
      && scrolled.bar.top >= 0 && scrolled.bar.top <= 20 && scrolled.back.visible,
    JSON.stringify({ scrollY: scrolled.scrollY, barTop: scrolled.bar.top, back: scrolled.back.visible }));
  await cdp.evaluate('window.scrollTo(0, 0)');
  await sleep(100);

  const beforeBack = await navSnapshot(cdp);
  await cdp.evaluate("document.getElementById('side-spaces-link').click()");
  await pageVisible(cdp, 'spaces');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('.space-button').length >= 1"));
  const spaces = await navSnapshot(cdp);
  const spacesApi = await api(cdp, '/api/spaces');
  const spaceEntry = Array.isArray(spacesApi.body)
    ? spacesApi.body.find((item) => item.id === spaceId)
    : null;
  check('返回：只到“我的空间”，仍保持登录且不退出成员关系',
    spaces.hash === '#/spaces' && spaces.page.includes('page-spaces')
      && spaces.authHidden && spaces.appVisible
      && spaces.account === beforeBack.account
      && spaceEntry?.role === 'owner'
      && spacesApi.status === 200,
    JSON.stringify({
      hash: spaces.hash, page: spaces.page, authHidden: spaces.authHidden,
      sameAccount: spaces.account === beforeBack.account,
      role: spaceEntry?.role ?? null, status: spacesApi.status,
    }));
  check('返回：空间列表页没有多余的工作区导航',
    spaces.mobileNavDisplay === 'none' && !spaces.back.visible,
    JSON.stringify({ mobileNav: spaces.mobileNavDisplay, backVisible: spaces.back.visible }));

  await cdp.evaluate(`[...document.querySelectorAll('.space-button')].find((button) => button.textContent.includes(${JSON.stringify(SPACE_NAME)}))?.click()`);
  await pageVisible(cdp, 'home');
  const reentered = await navSnapshot(cdp);
  check('返回后可再次进入同一空间，标签与返回入口恢复',
    reentered.bar.visible && reentered.back.visible
      && reentered.active.join(',') === '首页'
      && (reentered.hash === `#/spaces/${spaceId}` || reentered.hash === `#/spaces/${spaceId}/home`),
    JSON.stringify({ hash: reentered.hash, active: reentered.active }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(250);
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid .cal-cell[data-date]').length >= 28"));
  const mobile = await navSnapshot(cdp);
  check('390 手机：现有工作区栏与五项导航不变，桌面标签栏不出现',
    mobile.bar.display === 'none' && mobile.mobileNavVisible
      && mobile.mobileHeadDisplay !== 'none' && mobile.mobileBackVisible
      && mobile.mobileTitle === SPACE_NAME
      && mobile.mobileLinks.map((link) => link.text).join(',') === '首页,课表,日历,收集,设置'
      && mobile.mobileLinks.every((link) => link.height >= 43.5)
      && mobile.mobileLinks.filter((link) => link.current === 'page').length === 1
      && !mobile.overflow,
    JSON.stringify({
      bar: mobile.bar.display, nav: mobile.mobileLinks.map((link) => link.text),
      heights: mobile.mobileLinks.map((link) => link.height), overflow: mobile.overflow,
    }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320, height: 700, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(250);
  const narrow = await navSnapshot(cdp);
  check('320 手机：导航不裁切、无横向溢出',
    narrow.bar.display === 'none' && narrow.mobileNavVisible && !narrow.overflow
      && narrow.mobileLinks.every((link) => link.height >= 43.5),
    JSON.stringify({ overflow: narrow.overflow, heights: narrow.mobileLinks.map((link) => link.height) }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(250);
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/home'`);
  await pageVisible(cdp, 'home');
  const tablet = await navSnapshot(cdp);
  check('1024 窄桌面：返回入口与标签同排，无裁切和横向溢出',
    tablet.bar.visible && tablet.back.visible && tablet.tabs.length === 5
      && new Set(tablet.tabs.map((tab) => Math.round(tab.top))).size === 1
      && tablet.tabs.every((tab) => !tab.clipped)
      && !tablet.overflow,
    JSON.stringify({ tops: tablet.tabs.map((tab) => tab.top), overflow: tablet.overflow }));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(250);
  await cdp.evaluate(`location.hash = '#/spaces/${spaceId}/calendar'`);
  await pageVisible(cdp, 'calendar');
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#calendar-grid .cal-cell[data-date]').length >= 28"));
  await cdp.evaluate('window.scrollTo(0, 0)');
  await sleep(250);
  await cdp.screenshot('desktop-navigation-1440x900.png');

  const pageErrors = cdp.pageErrors.filter((text) => !/favicon|fonts?|net::ERR_ABORTED/i.test(text));
  check('页面运行时无未捕获异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) throw new Error('未找到 Edge/Chrome');
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'r15-ui-'));
  const browser = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--window-size=1440,900',
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
  process.stdout.write(`\nRound 15 UI 检查：${passed}/${results.length} 通过\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();

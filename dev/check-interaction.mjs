// S2a 交互本地检查：启动无头 Edge，经 CDP 打开本地预览，验证桌面气泡、手机行内编辑器、
// 日轨滑动、输入保护与断点切换。仅在装有 Edge 的开发机运行；使用内存假数据库，不代表部署环境。
//   node dev/check-interaction.mjs   （需要先启动 dev/preview-server.mjs）
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
const PORT = Number(process.env.CDP_PORT ?? 9333);
const SHOT_DIR = process.env.SHOT_DIR ?? join(tmpdir(), 's2a-interaction-shots');
const PASSWORD = `local-check-${randomUUID()}`;
const results = [];
let shotIndex = 0;
let spaceIds = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
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

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'evaluation failed';
      throw new Error(text);
    }
    return result.result.value;
  }

  async key(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  }

  async enter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r',
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(SHOT_DIR, { recursive: true });
    const file = join(SHOT_DIR, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
    await writeFile(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function main() {
  const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
  if (!edge) {
    process.stdout.write('SKIP 未找到 Edge/Chrome，可跳过交互本地检查\n');
    return;
  }
  const profile = await mkdtemp(join(tmpdir(), 's2a-cdp-'));
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
    process.stdout.write(`\n交互本地检查：${results.length - failed.length}/${results.length} 通过\n`);
    if (failed.length) process.exitCode = 1;
  }
}

async function run(cdp) {
  const passwordUi = await cdp.evaluate(`(() => {
    document.getElementById('auth-tab-register').click();
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('register-username', 'pwcheck_' + Math.random().toString(36).slice(2, 10));
    set('register-password', '1234567');
    set('register-confirm', '1234567');
    document.getElementById('register-notice').click();
    const shortDisabled = document.getElementById('register-submit').disabled;
    set('register-password', '12345678');
    set('register-confirm', '12345678');
    const eightEnabled = !document.getElementById('register-submit').disabled;
    const note = document.getElementById('register-password-note').textContent.trim();
    document.getElementById('auth-tab-login').click();
    return { shortDisabled, eightEnabled, note };
  })()`);
  check('注册页：7 字符不可提交、8 字符可提交且提示文案一致',
    passwordUi.shortDisabled && passwordUi.eightEnabled
      && passwordUi.note === '至少 8 个字符。',
    JSON.stringify(passwordUi));

  const setup = await cdp.evaluate(`(async () => {
    const call = async (path, init = {}) => {
      const response = await fetch('/functions/v1/app' + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const username = 'desk_' + Math.random().toString(36).slice(2, 10);
    const password = ${JSON.stringify(PASSWORD)};
    const register = await call('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, nickname: '桌面检查', noticeAccepted: true }),
    });
    if (register.status !== 201) return { error: 'register ' + register.status, body: register.body };
    const template = [
      ['08:00','08:45'],['08:55','09:40'],['10:00','10:45'],['10:55','11:40'],
      ['11:50','12:35'],['14:00','14:45'],['14:55','15:40'],['16:00','16:45'],
      ['16:55','17:40'],['19:00','19:45'],['19:55','20:40'],['20:50','21:35'],
    ];
    const periods = template.map(([start, end], index) => ({ index: index + 1, start, end }));
    const teaching = {
      timezone: 'Asia/Shanghai', firstWeekMonday: '2026-09-07',
      termStart: '2026-09-07', termEnd: '2027-01-24',
    };
    const courses = await call('/api/spaces', {
      method: 'POST',
      body: JSON.stringify({
        name: 'A-Courses', ownerName: '负责人甲', mode: 'courses',
        weekRule: 'every', visibility: 'masked_list', periods, teaching,
      }),
    });
    const presence = await call('/api/spaces', {
      method: 'POST',
      body: JSON.stringify({
        name: 'B-Presence', ownerName: '负责人甲', mode: 'presence',
        weekRule: 'every', visibility: 'stats', periods: periods.slice(0, 3), teaching,
      }),
    });
    const consentNotice = await call('/api/notice');
    const consent = [];
    for (const id of [courses.body?.space?.id, presence.body?.space?.id]) {
      if (!id) continue;
      consent.push({
        calendar: (await call('/api/spaces/' + id + '/calendar/consent', {
          method: 'POST',
          body: JSON.stringify({
            action: 'accept', noticeAccepted: true, noticeVersion: consentNotice.body?.calendar?.version,
          }),
        })).status,
        share: (await call('/api/spaces/' + id + '/calendar/share', {
          method: 'POST',
          body: JSON.stringify({
            action: 'decline', noticeVersion: consentNotice.body?.share?.version,
          }),
        })).status,
      });
    }
    return {
      username, consent,
      courses: courses.status, presence: presence.status,
      coursesId: courses.body?.space?.id, presenceId: presence.body?.space?.id,
    };
  })()`);
  if (setup.error) throw new Error(setup.error);
  spaceIds = { coursesId: setup.coursesId, presenceId: setup.presenceId };
  check('本地检查账号与两个空间创建成功', setup.courses === 201 && setup.presence === 201
    && Boolean(setup.coursesId) && Boolean(setup.presenceId)
    && setup.consent.length === 2 && setup.consent.every((item) => item.calendar === 200 && item.share === 200),
  JSON.stringify(setup));

  await cdp.evaluate('location.reload()').catch(() => {});
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && document.querySelectorAll('.space-button').length >= 2"));
  await cdp.evaluate(`location.hash = '#/spaces/${setup.coursesId}/schedule'`);
  await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden && document.querySelectorAll('.week-cell[data-day=\"1\"][data-period=\"1\"]').length === 1"));
  await sleep(250);
  await cdp.evaluate(`(() => {
    window.__t = {
      cell: (d, p) => document.querySelector('.week-cell[data-day="' + d + '"][data-period="' + p + '"]'),
      editor: () => document.getElementById('cell-editor'),
      rect: (el) => { const r = el.getBoundingClientRect(); return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        right: Math.round(r.right), bottom: Math.round(r.bottom) }; },
      settle: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      clickCell: async (d, p) => { const el = window.__t.cell(d, p); el.scrollIntoView({ block: 'center', inline: 'center' }); await window.__t.settle(); const r = window.__t.rect(el); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; },
    };
    return true;
  })()`);
  check('桌面周视图渲染 84 个格子', await cdp.evaluate("document.querySelectorAll('.week-cell').length === 84 && !!document.querySelector('.week-table')"));

  await cdp.evaluate('document.fonts.ready.then(() => true)');
  const fontState = await cdp.evaluate(`(() => {
    const family = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily;
    return {
      faces: [...document.fonts]
        .filter((face) => face.family.includes('Noto Sans SC'))
        .map((face) => ({ weight: face.weight, status: face.status })),
      body: family('body'),
      input: family('#create-name'),
      button: family('#schedule-save-draft'),
      cell: family('.week-cell'),
      bodyWeight: getComputedStyle(document.body).fontWeight,
      headingWeight: getComputedStyle(document.querySelector('h1')).fontWeight,
    };
  })()`);
  const loadedFaces = fontState.faces.filter((face) => face.status === 'loaded');
  check('字体：400/600 本地子集实际加载完成', loadedFaces.length === 2
    && loadedFaces.some((face) => face.weight === '400') && loadedFaces.some((face) => face.weight === '600'),
  JSON.stringify(fontState.faces));
  check('字体：正文/输入/按钮/课表使用同一中文字体栈',
    [fontState.body, fontState.input, fontState.button, fontState.cell]
      .every((value) => value.includes('Source Han Sans SC') && value.includes('Noto Sans SC')),
    JSON.stringify({ body: fontState.body, input: fontState.input, button: fontState.button, cell: fontState.cell }));
  check('字体：正文常规字重、标题半粗', fontState.bodyWeight === '400' && fontState.headingWeight === '600',
    JSON.stringify({ body: fontState.bodyWeight, heading: fontState.headingWeight }));

  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const fontDom = await cdp.send('DOM.getDocument', { depth: 1 });
  const headingNode = await cdp.send('DOM.querySelector', { nodeId: fontDom.root.nodeId, selector: 'h1' });
  const platform = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: headingNode.nodeId });
  const platformFonts = (platform.fonts ?? []).map((font) => ({
    family: font.familyName, custom: font.isCustomFont, glyphs: font.glyphCount,
  }));
  check('字体：标题实际由自托管 Noto Sans SC 渲染（平台字体查询）',
    platformFonts.some((font) => font.custom && font.family.includes('Noto Sans SC') && font.glyphs > 0),
    JSON.stringify(platformFonts));

  const uiContract = await cdp.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null && el.getClientRects().length > 0;
    const action = [...document.querySelectorAll('button')].filter(visible)
      .filter((button) => !button.classList.contains('week-cell')
        && !button.classList.contains('space-button')
        && !button.classList.contains('day-tab')
        && !button.classList.contains('week-day')
        && button.id !== 'account-button');
    return {
      badLabels: action
        .filter((button) => [...button.textContent.replace(/\\s+/g, '')].length > 4)
        .map((button) => button.id || button.textContent.trim()),
      heights: action.map((button) => ({
        id: button.id || button.className, h: Math.round(button.getBoundingClientRect().height),
      })),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('桌面：动作按钮文案不超过 4 字且高度 36–40px',
    uiContract.badLabels.length === 0
      && uiContract.heights.every((item) => item.h >= 36 && item.h <= 40),
    JSON.stringify({ badLabels: uiContract.badLabels, heights: uiContract.heights }));
  check('桌面：页面无横向溢出', !uiContract.overflow, JSON.stringify(uiContract));

  // 1. 中间格：气泡贴格、视口内、焦点进入
  let point = await cdp.evaluate('window.__t.clickCell(4, 6)');
  await cdp.clickAt(point.x, point.y);
  await waitFor(() => cdp.evaluate("!document.getElementById('cell-editor').hidden"));
  await cdp.evaluate('window.__t.settle()');
  let info = await evaluateEditorState(cdp, 4, 6);
  check('桌面中间格：单一编辑器挂在 body、fixed 定位', info.cls.includes('is-popover') && info.parent && info.position === 'fixed' && info.editors === 1, JSON.stringify(info));
  check('桌面中间格：气泡不覆盖目标格且在视口内', info.er.x >= 12 && info.er.right <= info.vw - 12 && info.er.y >= 12 && info.er.bottom <= info.vh - 12 && (info.er.right <= info.cr.x || info.er.x >= info.cr.right), JSON.stringify({ er: info.er, cr: info.cr }));
  check('桌面中间格：打开后焦点落到课程名输入且目标格 aria-expanded=true', info.focused && info.focusedInput && info.expanded === 'true');
  await cdp.screenshot('desktop-middle-popover');
  await cdp.key('Escape', 'Escape', 27);
  await sleep(200);

  // 2. 最右列：向左翻转
  point = await cdp.evaluate('window.__t.clickCell(7, 6)');
  await cdp.clickAt(point.x, point.y);
  await cdp.evaluate('window.__t.settle()');
  info = await cdp.evaluate(`(() => {
    const er = window.__t.rect(window.__t.editor());
    const cr = window.__t.rect(window.__t.cell(7, 6));
    return { er, cr, vw: innerWidth, vh: innerHeight, title: document.getElementById('cell-title').textContent };
  })()`);
  check('桌面最右列：气泡向左翻转且不越界', info.er.right <= info.cr.x && info.er.x >= 12 && info.er.right <= info.vw - 12 && info.title.includes('周日'), JSON.stringify(info));
  await cdp.screenshot('desktop-right-column');
  await cdp.key('Escape', 'Escape', 27);
  await sleep(200);

  // 3. 底部格：高度受限、操作可见或可滚动
  point = await cdp.evaluate('window.__t.clickCell(1, 12)');
  await cdp.clickAt(point.x, point.y);
  await cdp.evaluate('window.__t.settle()');
  info = await cdp.evaluate(`(() => {
    const ed = window.__t.editor();
    const er = window.__t.rect(ed);
    return {
      er, vh: innerHeight,
      within: ed.scrollHeight <= ed.clientHeight + 1,
      overflow: getComputedStyle(ed).overflowY,
      title: document.getElementById('cell-title').textContent,
    };
  })()`);
  check('桌面底部格：气泡在视口内且可操作（超长时内部滚动）', info.er.bottom <= info.vh - 12 && (info.within || info.overflow === 'auto') && info.title.includes('第12节'), JSON.stringify(info));
  await cdp.screenshot('desktop-bottom-cell');

  // 4. 键盘：Enter 打开、Tab 在气泡内、Esc 关闭并回焦
  await cdp.evaluate("(() => { const cell = window.__t.cell(2, 2); cell.scrollIntoView({ block: 'center', inline: 'center' }); cell.focus(); return true; })()");
  await cdp.enter();
  await waitFor(() => cdp.evaluate("!document.getElementById('cell-editor').hidden && document.getElementById('cell-title').textContent.includes('周二·第2节')"));
  await cdp.evaluate('window.__t.settle()');
  const enterFocus = await cdp.evaluate("document.getElementById('cell-editor').contains(document.activeElement)")
    && await cdp.evaluate("document.activeElement === document.getElementById('cell-every-name')");
  await cdp.key('Tab', 'Tab', 9);
  const tabInside = await cdp.evaluate("document.getElementById('cell-editor').contains(document.activeElement)");
  await cdp.key('Escape', 'Escape', 27);
  await waitFor(() => cdp.evaluate("document.getElementById('cell-editor').hidden"));
  await sleep(120);
  const escState = await cdp.evaluate(`(() => ({
    hidden: document.getElementById('cell-editor').hidden,
    focusedCell: document.activeElement === window.__t.cell(2, 2),
  }))()`);
  check('桌面键盘：Enter 打开且焦点入气泡，Tab 在气泡内', enterFocus && tabInside);
  check('桌面键盘：Esc 关闭并把焦点还给原格', escState.hidden && escState.focusedCell, JSON.stringify(escState));

  // 5. 空白点击关闭；未应用输入三选一保护
  point = await cdp.evaluate('window.__t.clickCell(4, 4)');
  await cdp.clickAt(point.x, point.y);
  await cdp.evaluate('window.__t.settle()');
  const corner = await cdp.evaluate('({ x: innerWidth - 4, y: 4 })');
  await cdp.clickAt(corner.x, corner.y);
  await sleep(150);
  check('桌面空白点击：无改动时直接关闭，不弹确认', await cdp.evaluate("document.getElementById('cell-editor').hidden && !document.getElementById('editor-exit-dialog').open"));

  point = await cdp.evaluate('window.__t.clickCell(4, 4)');
  await cdp.clickAt(point.x, point.y);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cell-every-name');
    input.value = '临时课程甲';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  point = await cdp.evaluate('window.__t.clickCell(4, 5)');
  await cdp.clickAt(point.x, point.y);
  await waitFor(() => cdp.evaluate("document.getElementById('editor-exit-dialog').open"));
  const dialogButtons = await cdp.evaluate("[...document.querySelectorAll('#editor-exit-dialog button')].map((b) => b.value)");
  check('未应用输入：切换格子弹出三选一对话框', dialogButtons.join(',') === 'apply,discard,stay', dialogButtons.join(','));
  await cdp.evaluate("document.getElementById('editor-exit-stay').click()");
  await sleep(120);
  info = await cdp.evaluate(`(() => ({
    dialogOpen: document.getElementById('editor-exit-dialog').open,
    editorOpen: !document.getElementById('cell-editor').hidden,
    value: document.getElementById('cell-every-name').value,
    title: document.getElementById('cell-title').textContent,
    cellStillEmpty: window.__t.cell(4, 4).textContent.includes('无课'),
  }))()`);
  check('未应用输入：选择“留在当前”保留临时内容和当前格', !info.dialogOpen && info.editorOpen && info.value === '临时课程甲' && info.title.includes('周四') && info.cellStillEmpty, JSON.stringify(info));

  point = await cdp.evaluate('window.__t.clickCell(4, 5)');
  await cdp.clickAt(point.x, point.y);
  await waitFor(() => cdp.evaluate("document.getElementById('editor-exit-dialog').open"));
  await cdp.evaluate("document.getElementById('editor-exit-discard').click()");
  await sleep(220);
  info = await cdp.evaluate(`(() => ({
    title: document.getElementById('cell-title').textContent,
    editorOpen: !document.getElementById('cell-editor').hidden,
    cellStillEmpty: window.__t.cell(4, 4).textContent.includes('无课'),
  }))()`);
  check('未应用输入：选择“放弃”丢弃临时内容并打开目标格', info.cellStillEmpty && info.editorOpen && info.title.includes('第5节'), JSON.stringify(info));

  // 6. 应用后继续：应用前一格并打开目标格
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cell-every-name');
    input.value = '应用后继续课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  point = await cdp.evaluate('window.__t.clickCell(4, 6)');
  await cdp.clickAt(point.x, point.y);
  await waitFor(() => cdp.evaluate("document.getElementById('editor-exit-dialog').open"));
  await cdp.evaluate("document.getElementById('editor-exit-apply').click()");
  await sleep(300);
  info = await cdp.evaluate(`(() => ({
    cellText: window.__t.cell(4, 5).textContent,
    title: document.getElementById('cell-title').textContent,
    dirtyVisible: !document.getElementById('schedule-discard').hidden,
    editors: document.querySelectorAll('#cell-editor').length,
  }))()`);
  check('未应用输入：选择“应用后继续”写入本地并打开目标格', info.cellText.includes('应用后继续课程') && info.title.includes('第6节') && info.dirtyVisible && info.editors === 1, JSON.stringify(info));

  // 7. 窗口滚动导致目标不可见：折叠为恢复入口
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cell-every-name');
    input.value = '滚动保留课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.style.paddingBottom = '420px';
    window.scrollTo(0, document.documentElement.scrollHeight);
    return true;
  })()`);
  await sleep(300);
  info = await cdp.evaluate(`(() => ({
    editorHidden: document.getElementById('cell-editor').hidden,
    restoreHidden: document.getElementById('cell-editor-restore').hidden,
    restoreText: document.getElementById('cell-editor-restore').textContent,
    scrollY, scrollHeight: document.documentElement.scrollHeight, vh: innerHeight,
    cell: (() => { const r = window.__t.cell(4, 6).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })(),
    grid: (() => { const r = document.getElementById('schedule-grid').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })(),
  }))()`);
  check('桌面滚动出视野：有未应用内容时折叠为恢复入口', info.editorHidden && !info.restoreHidden && info.restoreText.includes('继续编辑'), JSON.stringify(info));
  await cdp.screenshot('desktop-collapsed-restore');
  await cdp.evaluate("document.getElementById('cell-editor-restore').click()");
  await sleep(400);
  info = await cdp.evaluate(`(() => ({
    editorHidden: document.getElementById('cell-editor').hidden,
    restoreHidden: document.getElementById('cell-editor-restore').hidden,
    value: document.getElementById('cell-every-name').value,
    er: window.__t.rect(document.getElementById('cell-editor')),
    vw: innerWidth, vh: innerHeight,
  }))()`);
  check('恢复入口：回到目标格并保留未应用内容', !info.editorHidden && info.restoreHidden && info.value === '滚动保留课程' && info.er.x >= 12 && info.er.right <= info.vw - 12, JSON.stringify(info));
  await cdp.evaluate("document.body.style.paddingBottom = ''");

  // 调整桌面窗口尺寸：气泡仍在视口内
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  info = await cdp.evaluate(`(() => {
    const er = window.__t.rect(document.getElementById('cell-editor'));
    return { er, vw: innerWidth, vh: innerHeight };
  })()`);
  check('桌面窗口调整：气泡重新定位且不越界', info.er.x >= 12 && info.er.right <= info.vw - 12 && info.er.y >= 12 && info.er.bottom <= info.vh - 12, JSON.stringify(info));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);
  await cdp.key('Escape', 'Escape', 27);
  await waitFor(() => cdp.evaluate("document.getElementById('editor-exit-dialog').open"));
  await cdp.evaluate("document.getElementById('editor-exit-discard').click()");
  await sleep(150);

  // 8. 手机视图
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(450);
  await verifyMobile(cdp);
  await verifyBreakpoint(cdp);
  await verifyBusiness(cdp);
  check('页面运行时无未捕获异常或 console.error', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '));

  // 字体加载失败：阻断本地 WOFF2 后重载，确认回退字体仍可渲染、无横向溢出。
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.setBlockedURLs', { urls: ['*.woff2'] });
  await cdp.evaluate('location.reload()').catch(() => {});
  await waitFor(() => cdp.evaluate("document.readyState === 'complete' && !!document.getElementById('auth-panel')"));
  await sleep(700);
  const fallback = await cdp.evaluate(`(async () => {
    await document.fonts.ready;
    const h1 = document.querySelector('h1');
    return {
      loaded: [...document.fonts]
        .filter((face) => face.family.includes('Noto Sans SC') && face.status === 'loaded').length,
      statuses: [...document.fonts]
        .filter((face) => face.family.includes('Noto Sans SC')).map((face) => face.status),
      text: document.body.innerText.includes('社团协同课表') && document.body.innerText.length > 40,
      headingH: Math.round(h1.getBoundingClientRect().height),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  const fallbackDom = await cdp.send('DOM.getDocument', { depth: 1 });
  const fallbackNode = await cdp.send('DOM.querySelector', { nodeId: fallbackDom.root.nodeId, selector: 'h1' });
  const fallbackPlatform = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: fallbackNode.nodeId });
  const fallbackFonts = (fallbackPlatform.fonts ?? []).map((font) => ({
    family: font.familyName, custom: font.isCustomFont, glyphs: font.glyphCount,
  }));
  check('字体加载失败：回退系统无衬线，文字完整且无横向溢出',
    fallback.loaded === 0
      && fallbackFonts.length > 0
      && fallbackFonts.every((font) => !font.custom && font.glyphs > 0)
      && fallback.text && fallback.headingH > 0 && !fallback.overflow,
    JSON.stringify({ fallback, fallbackFonts }));
}

async function evaluateEditorState(cdp, day, period) {
  return cdp.evaluate(`(() => {
    const ed = window.__t.editor();
    const cell = window.__t.cell(${day}, ${period});
    const er = window.__t.rect(ed);
    const cr = window.__t.rect(cell);
    return {
      cls: ed.className, parent: ed.parentElement === document.body,
      position: getComputedStyle(ed).position,
      er, cr, vw: innerWidth, vh: innerHeight,
      focused: ed.contains(document.activeElement),
      focusedInput: document.activeElement === document.getElementById('cell-every-name'),
      expanded: cell.getAttribute('aria-expanded'),
      editors: document.querySelectorAll('#cell-editor').length,
    };
  })()`);
}

async function verifyMobile(cdp) {
  const mobileUi = await cdp.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null && el.getClientRects().length > 0;
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const action = buttons
      .filter((button) => !button.classList.contains('week-cell')
        && !button.classList.contains('space-button')
        && !button.classList.contains('day-tab')
        && !button.classList.contains('week-day')
        && button.id !== 'account-button');
    return {
      short: buttons.map((button) => ({
        id: button.id || button.className, h: Math.round(button.getBoundingClientRect().height),
      })).filter((item) => item.h < 44),
      badLabels: action
        .filter((button) => [...button.textContent.replace(/\\s+/g, '')].length > 4)
        .map((button) => button.id || button.textContent.trim()),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      font: getComputedStyle(document.querySelector('.week-cell')).fontFamily,
    };
  })()`);
  check('手机：可见按钮触达高度均不小于 44px、短文案不超过 4 字',
    mobileUi.short.length === 0 && mobileUi.badLabels.length === 0,
    JSON.stringify({ short: mobileUi.short, badLabels: mobileUi.badLabels }));
  check('手机：页面无横向溢出且课表沿用同一字体栈',
    !mobileUi.overflow && mobileUi.font.includes('Noto Sans SC'),
    JSON.stringify({ overflow: mobileUi.overflow, font: mobileUi.font }));

  let info = await cdp.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.day-tab')];
    const sizes = tabs.map((tab) => window.__t.rect(tab));
    const box = document.getElementById('day-tabs');
    return {
      count: tabs.length,
      minW: Math.min(...sizes.map((r) => r.w)),
      minH: Math.min(...sizes.map((r) => r.h)),
      scrollable: box.scrollWidth > box.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  check('手机：7 个星期标签七等分、高度不小于 44 且无需横向滚动', info.count === 7 && info.minW >= 38 && info.minH >= 44 && !info.scrollable, JSON.stringify(info));
  check('手机：页面无横向溢出', !info.pageOverflow, JSON.stringify(info));

  info = await cdp.evaluate(`(() => {
    const box = document.getElementById('day-tabs');
    const last = document.querySelector('.day-tab[data-day="7"]');
    const b = box.getBoundingClientRect();
    const r = last.getBoundingClientRect();
    return { visible: r.left >= b.left - 1 && r.right <= b.right + 1, max: box.scrollWidth - box.clientWidth };
  })()`);
  check('手机：星期导航无横向裁切且周日完整可见', info.visible && info.max === 0, JSON.stringify(info));

  await cdp.evaluate("document.querySelector('.day-tab[data-day=\"1\"]').click()");
  await sleep(800);

  const sample = await cdp.evaluate(`(async () => {
    document.querySelector('.day-tab[data-day="6"]').click();
    const track = document.querySelector('.day-track');
    const start = performance.now();
    const points = [];
    await new Promise((resolve) => {
      const tick = () => {
        const m = new DOMMatrixReadOnly(getComputedStyle(track).transform);
        points.push({ t: Math.round(performance.now() - start), x: Math.round(m.m41) });
        if (performance.now() - start < 760) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const width = document.querySelector('.day-viewport').clientWidth;
    return {
      points, width,
      selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day,
      finalX: Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41),
      targetX: -5 * width,
    };
  })()`);
  const moves = sample.points.filter((p) => p.x < -1 && p.x > sample.targetX + 1);
  const monotonic = sample.points.every((p, i) => i === 0 || p.x <= sample.points[i - 1].x + 1);
  check('手机：周一→周六连续经过中间日期且最终停在周六', moves.length >= 3 && monotonic && Math.abs(sample.finalX - sample.targetX) <= 1 && sample.selected === '6', JSON.stringify({ moves: moves.slice(0, 4), finalX: sample.finalX, targetX: sample.targetX, selected: sample.selected }));

  const reverse = await cdp.evaluate(`(async () => {
    document.querySelector('.day-tab[data-day="2"]').click();
    const track = document.querySelector('.day-track');
    const width = document.querySelector('.day-viewport').clientWidth;
    const start = performance.now();
    const xs = [];
    await new Promise((resolve) => {
      const tick = () => {
        xs.push(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41);
        if (performance.now() - start < 700) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { xs, width, selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day };
  })()`);
  const reverseMoves = reverse.xs.filter((x) => x > -(4 * reverse.width) + 1 && x < -reverse.width - 1);
  const reverseMonotonic = reverse.xs.every((x, i) => i === 0 || x >= reverse.xs[i - 1] - 1);
  check('手机：周六→周二反向连续经过中间日期', reverseMoves.length >= 3 && reverseMonotonic && reverse.selected === '2', JSON.stringify({ samples: reverseMoves.length, selected: reverse.selected }));

  const rapid = await cdp.evaluate(`(async () => {
    document.querySelector('.day-tab[data-day="6"]').click();
    setTimeout(() => document.querySelector('.day-tab[data-day="3"]').click(), 60);
    await new Promise((r) => setTimeout(r, 1400));
    const track = document.querySelector('.day-track');
    const width = document.querySelector('.day-viewport').clientWidth;
    return {
      selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day,
      x: Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41),
      target: -2 * width,
      activePage: document.querySelector('.day-page[aria-hidden="false"]').id,
    };
  })()`);
  check('手机：快速连点最后目标获胜，无回跳', rapid.selected === '3' && Math.abs(rapid.x - rapid.target) <= 1 && rapid.activePage === 'day-page-3', JSON.stringify(rapid));

  const swipe = await cdp.evaluate(`(async () => {
    const fire = (type, x, y, target = document) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 21, isPrimary: true,
        pointerType: 'touch', clientX: x, clientY: y,
      }));
    };
    // 起点必须在节次行内，而不是只从星期条开始。
    const row = document.querySelector('#day-page-3 .day-row[data-period="5"]');
    row.scrollIntoView({ block: 'center' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = row.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width * 0.72);
    const y = Math.round(rect.top + rect.height / 2);
    const startsInRow = y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right
      && !!document.elementFromPoint(x, y)?.closest('.day-row[data-period="5"]');
    fire('pointerdown', x, y, row);
    fire('pointermove', x - 130, y + 4);
    fire('pointerup', x - 130, y + 4);
    await new Promise((r) => setTimeout(r, 700));
    const afterHorizontal = [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day;
    const editorOpen = !document.getElementById('cell-editor').hidden;
    fire('pointerdown', x, y, row);
    fire('pointermove', x + 4, y + 130);
    fire('pointerup', x + 4, y + 130);
    await new Promise((r) => setTimeout(r, 500));
    const afterVertical = [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day;
    return { afterHorizontal, afterVertical, editorOpen, startsInRow, x, y, top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
  })()`);
  check('手机：从节次行内容区横向滑动切换相邻日，纵向手势不切换且不误开编辑器', swipe.startsInRow && swipe.afterHorizontal === '4' && swipe.afterVertical === '4' && !swipe.editorOpen, JSON.stringify(swipe));

  const gestures = await cdp.evaluate(`(async () => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const track = document.querySelector('.day-track');
    const width = document.querySelector('.day-viewport').clientWidth;
    const tx = () => Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41);
    const selected = () => [...document.querySelectorAll('.day-tab')]
      .find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.day;
    const reset = async (day) => {
      document.querySelector('.day-tab[data-day="' + day + '"]').click();
      await sleep(750);
    };
    let nextId = 70;
    const run = async ({ day = 2, steps, end = 'up', second = null, tap = false }) => {
      await reset(day);
      const id = ++nextId;
      const target = () => document.querySelector('.day-page[aria-hidden="false"] .day-row[data-period="5"]');
      const row = target();
      row.scrollIntoView({ block: 'center' });
      await raf();
      const rect = row.getBoundingClientRect();
      const startX = Math.round(rect.left + rect.width * 0.72);
      const startY = Math.round(rect.top + rect.height / 2);
      const startsInRow = startY >= rect.top && startY <= rect.bottom;
      const fire = (type, x, y, pointerId = id) => target().dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, isPrimary: pointerId === id,
        pointerType: 'touch', clientX: x, clientY: y,
      }));
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
      fire('pointerdown', startX, startY);
      const samples = [];
      for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        fire('pointermove', startX + step.dx, startY + (step.dy ?? 0));
        await raf();
        samples.push({ dx: step.dx, dy: step.dy ?? 0, x: tx() });
      }
      if (second) {
        const other = id + 100;
        fire('pointerdown', startX, startY, other);
        for (const step of second) {
          if (step.wait) await sleep(step.wait);
          fire('pointermove', startX + step.dx, startY, other);
          await raf();
        }
      }
      const lastStep = steps.at(-1);
      fire(end === 'cancel' ? 'pointercancel' : 'pointerup', startX + lastStep.dx, startY + (lastStep.dy ?? 0));
      let tapped = null;
      if (tap) {
        document.querySelector('.day-page[aria-hidden="false"] .week-cell').click();
        tapped = !document.getElementById('cell-editor').hidden;
      }
      await sleep(700);
      ticking = false;
      return {
        selected: selected(), x: tx(), width, samples, startsInRow,
        maxGap: Math.max(...gaps), over34: gaps.filter((gap) => gap > 34).length,
        tapped,
      };
    };
    return {
      rebound: await run({ steps: [{ dx: -20, wait: 80 }, { dx: -30, wait: 90 }] }),
      snap: await run({ steps: [{ dx: -40, wait: 60 }, { dx: -90, wait: 80 }] }),
      flick: await run({ steps: [{ dx: -15, wait: 5 }, { dx: -35, wait: 5 }, { dx: -55, wait: 5 }] }),
      longDrag: await run({ steps: [{ dx: -90, wait: 20 }, { dx: -220, wait: 20 }, { dx: -380, wait: 20 }, { dx: -560, wait: 20 }] }),
      cancel: await run({ end: 'cancel', steps: [{ dx: -90, wait: 30 }, { dx: -140, wait: 30 }] }),
      vertical: await run({ steps: [{ dx: 8, dy: 60 }, { dx: 12, dy: 130 }] }),
      diagonalX: await run({ steps: [{ dx: -90, dy: 50 }, { dx: -160, dy: 90 }] }),
      diagonalY: await run({ steps: [{ dx: -40, dy: 90 }, { dx: -50, dy: 160 }] }),
      reverse: await run({ steps: [{ dx: -120, wait: 120 }, { dx: -40, wait: 20 }, { dx: -20, wait: 6 }] }),
      startEdge: await run({ day: 1, steps: [{ dx: 60, wait: 20 }, { dx: 200, wait: 20 }] }),
      endEdge: await run({ day: 7, steps: [{ dx: -60, wait: 20 }, { dx: -200, wait: 20 }] }),
      multiTouch: await run({ steps: [{ dx: -90, wait: 30 }], second: [{ dx: 300, wait: 10 }] }),
      tapDuringSwipe: await run({ tap: true, steps: [{ dx: -90, wait: 20 }, { dx: -140, wait: 20 }] }),
    };
  })()`);
  const settled = (trace, day) => trace.selected === String(day)
    && Math.abs(trace.x + (day - 1) * trace.width) <= 1;
  check('手机手势：全部自动化起点都在节次行内容区，而不只在星期条',
    Object.values(gestures).every((trace) => trace.startsInRow === true),
    JSON.stringify(Object.fromEntries(Object.entries(gestures).map(([name, trace]) => [name, trace.startsInRow]))));
  check('手机手势：慢拖不足阈值回弹，足够位移吸附相邻日',
    settled(gestures.rebound, 2) && settled(gestures.snap, 3),
    JSON.stringify({ rebound: gestures.rebound, snap: gestures.snap }));
  check('手机手势：快甩短距离也跨一天，长拖按可见位移吸附',
    settled(gestures.flick, 3) && settled(gestures.longDrag, 4),
    JSON.stringify({ flick: gestures.flick, longDrag: gestures.longDrag }));
  check('手机手势：取消回原位，纵向与纵向主导斜拖不切日',
    settled(gestures.cancel, 2) && settled(gestures.vertical, 2) && settled(gestures.diagonalY, 2),
    JSON.stringify({ cancel: gestures.cancel, vertical: gestures.vertical, diagonalY: gestures.diagonalY }));
  check('手机手势：横向主导斜拖切日，快速反向不按错误方向吸附',
    settled(gestures.diagonalX, 3) && settled(gestures.reverse, 2),
    JSON.stringify({ diagonalX: gestures.diagonalX, reverse: gestures.reverse }));
  check('手机手势：首尾边界不回绕，多指第二触点不改变目标',
    settled(gestures.startEdge, 1) && settled(gestures.endEdge, 7) && settled(gestures.multiTouch, 3),
    JSON.stringify({ startEdge: gestures.startEdge, endEdge: gestures.endEdge, multiTouch: gestures.multiTouch }));
  check('手机手势：拖动后立即点击不会误开编辑器',
    gestures.tapDuringSwipe.tapped === false && settled(gestures.tapDuringSwipe, 3),
    JSON.stringify(gestures.tapDuringSwipe));
  const gapSummary = Object.fromEntries(['longDrag', 'multiTouch', 'tapDuringSwipe']
    .map((name) => [name, { maxGap: gestures[name].maxGap, over34: gestures[name].over34 }]));
  check('手机手势：拖动采样帧无长时间空档', Object.values(gapSummary).every((item) => item.maxGap <= 120),
    JSON.stringify(gapSummary));

  await cdp.evaluate("document.querySelector('.day-tab[data-day=\"4\"]').click()");
  await sleep(750);

  const positions = await cdp.evaluate(`(async () => {
    const open = async (period) => {
      const cell = document.querySelector('#day-page-4 .week-cell[data-period="' + period + '"]');
      cell.scrollIntoView({ block: 'center' });
      await window.__t.settle();
      cell.click();
      await new Promise((r) => setTimeout(r, 250));
      const ed = document.getElementById('cell-editor');
      const row = document.querySelector('#day-page-4 .day-row[data-period="' + period + '"]');
      return {
        afterRow: ed.previousElementSibling === row,
        parentPage: ed.closest('.day-page')?.id ?? null,
        previousHidden: document.getElementById('cell-previous').hidden,
        activeIsInput: !!document.activeElement.closest?.('#cell-editor input'),
      };
    };
    const first = await open(1);
    document.getElementById('cell-cancel').click();
    await new Promise((r) => setTimeout(r, 200));
    const middle = await open(5);
    document.getElementById('cell-cancel').click();
    await new Promise((r) => setTimeout(r, 200));
    const last = await open(12);
    const viewport = document.querySelector('.day-viewport');
    const page = document.getElementById('day-page-4');
    return {
      first, middle, last,
      viewportH: viewport.style.height,
      pageH: Math.round(page.offsetHeight),
      editorBottom: window.__t.rect(document.getElementById('cell-editor')).bottom,
      vh: innerHeight,
    };
  })()`);
  check('手机行内编辑器：首节在首行下方；首节不显示“沿用上节”；点空格直接聚焦课程名', positions.first.afterRow && positions.first.parentPage === 'day-page-4' && positions.first.previousHidden && positions.first.activeIsInput, JSON.stringify(positions.first));
  check('手机行内编辑器：中间节在对应行下方', positions.middle.afterRow && positions.middle.parentPage === 'day-page-4', JSON.stringify(positions.middle));
  check('手机行内编辑器：末节在末行下方，内容高度随编辑展开', positions.last.afterRow && positions.pageH > 900 && positions.viewportH !== '', JSON.stringify(positions.last));
  await cdp.evaluate("document.getElementById('cell-editor').scrollIntoView({ block: 'center' }); window.__t.settle()");
  await cdp.screenshot('mobile-last-period-inline');
  await cdp.evaluate("document.getElementById('cell-cancel').click()");
  await sleep(200);

  const applied = await cdp.evaluate(`(async () => {
    const cell = document.querySelector('#day-page-4 .week-cell[data-period="2"]');
    cell.scrollIntoView({ block: 'center' });
    await window.__t.settle();
    cell.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById('cell-every-name');
    input.value = '跨日保留课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('cell-apply').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.day-tab[data-day="5"]').click();
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('.day-tab[data-day="4"]').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      text: document.querySelector('#day-page-4 .week-cell[data-period="2"]').textContent,
      dirty: !document.getElementById('schedule-save-draft').disabled,
      editorHidden: document.getElementById('cell-editor').hidden,
    };
  })()`);
  check('手机：已应用的本地修改跨日保留且保持未保存标记', applied.text.includes('跨日保留课程') && applied.dirty && applied.editorHidden, JSON.stringify(applied));

  const protectedSwitch = await cdp.evaluate(`(async () => {
    const cell = document.querySelector('#day-page-4 .week-cell[data-period="3"]');
    cell.scrollIntoView({ block: 'center' });
    await window.__t.settle();
    cell.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById('cell-every-name');
    input.value = '未应用切日课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.day-tab[data-day="5"]').click();
    await new Promise((r) => setTimeout(r, 250));
    const opened = document.getElementById('editor-exit-dialog').open;
    document.getElementById('editor-exit-stay').click();
    await new Promise((r) => setTimeout(r, 250));
    const stayed = {
      selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day,
      value: document.getElementById('cell-every-name').value,
      open: !document.getElementById('cell-editor').hidden,
    };
    document.getElementById('cell-cancel').click();
    await new Promise((r) => setTimeout(r, 250));
    const secondDialog = document.getElementById('editor-exit-dialog').open;
    document.getElementById('editor-exit-discard').click();
    await new Promise((r) => setTimeout(r, 250));
    return {
      opened, stayed, secondDialog,
      cellText: document.querySelector('#day-page-4 .week-cell[data-period="3"]').textContent,
    };
  })()`);
  check('手机：切日前未应用输入需确认，留在当前保留内容，放弃后不写入', protectedSwitch.opened && protectedSwitch.stayed.selected === '4' && protectedSwitch.stayed.value === '未应用切日课程' && protectedSwitch.stayed.open && protectedSwitch.secondDialog && protectedSwitch.cellText.includes('无课'), JSON.stringify(protectedSwitch));

  const heights = await cdp.evaluate(`(async () => {
    document.querySelector('.day-tab[data-day="7"]').click();
    await new Promise((r) => setTimeout(r, 800));
    const viewport = document.querySelector('.day-viewport');
    const current = document.getElementById('day-page-7');
    return { viewport: Math.round(parseFloat(viewport.style.height)), current: Math.round(current.offsetHeight) };
  })()`);
  check('手机：日视图高度适配当前日（不永久取最高页）', Math.abs(heights.viewport - heights.current) <= 2, JSON.stringify(heights));

  for (const width of [320, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(350);
    const data = await cdp.evaluate(`(() => {
      const box = document.getElementById('day-tabs');
      box.scrollIntoView({ block: 'nearest' });
      box.scrollLeft = box.scrollWidth;
      const last = document.querySelector('.day-tab[data-day="7"]');
      const b = box.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      const visible = (el) => el.offsetParent !== null && el.getClientRects().length > 0;
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        reachable: r.left >= b.left - 1 && r.right <= b.right + 1,
        width: innerWidth,
        short: buttons.map((button) => ({
          id: button.id || button.className, h: Math.round(button.getBoundingClientRect().height),
        })).filter((item) => item.h < 44),
        clipped: buttons
          .filter((button) => !button.classList.contains('week-cell') && !button.classList.contains('space-button'))
          .filter((button) => button.scrollWidth > button.clientWidth + 1)
          .map((button) => button.id || button.textContent.trim()),
      };
    })()`);
    check(`手机 ${width}px：星期导航可到周日、页面无横向溢出且按钮不挤压`,
      data.reachable && !data.overflow && data.short.length === 0 && data.clipped.length === 0,
      JSON.stringify(data));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(300);

  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await cdp.evaluate(`(async () => {
    document.querySelector('.day-tab[data-day="1"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.day-tab[data-day="6"]').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const track = document.querySelector('.day-track');
    const width = document.querySelector('.day-viewport').clientWidth;
    return {
      x: Math.round(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41),
      target: -5 * width,
      selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day,
    };
  })()`);
  check('手机：减少动效时立即到位，不强制长动画', Math.abs(reduced.x - reduced.target) <= 1 && reduced.selected === '6', JSON.stringify(reduced));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
}

async function verifyBreakpoint(cdp) {
  // 当前在手机视图、第 6 天；先切到第 2 天并打开行内编辑器
  await cdp.evaluate("document.querySelector('.day-tab[data-day=\"2\"]').click()");
  await sleep(900);
  const opened = await cdp.evaluate(`(async () => {
    const cell = document.querySelector('#day-page-2 .week-cell[data-period="4"]');
    cell.scrollIntoView({ block: 'center' });
    await window.__t.settle();
    cell.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById('cell-every-name');
    input.value = '断点保留课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      cls: document.getElementById('cell-editor').className,
      parentPage: document.getElementById('cell-editor').closest('.day-page')?.id ?? null,
      value: document.getElementById('cell-every-name').value,
    };
  })()`);
  check('断点前：手机行内编辑器可输入', opened.cls.includes('is-inline') && opened.parentPage === 'day-page-2' && opened.value === '断点保留课程', JSON.stringify(opened));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
  let info = await cdp.evaluate(`(() => ({
    narrow: matchMedia('(max-width: 760px)').matches,
    cls: document.getElementById('cell-editor').className,
    parentBody: document.getElementById('cell-editor').parentElement === document.body,
    value: document.getElementById('cell-every-name').value,
    editors: document.querySelectorAll('#cell-editor').length,
  }))()`);
  check('断点切换：手机→桌面恢复单一锚定气泡并保留输入', !info.narrow && info.cls.includes('is-popover') && info.parentBody && info.value === '断点保留课程' && info.editors === 1, JSON.stringify(info));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(450);
  info = await cdp.evaluate(`(() => ({
    narrow: matchMedia('(max-width: 760px)').matches,
    cls: document.getElementById('cell-editor').className,
    parentPage: document.getElementById('cell-editor').closest('.day-page')?.id ?? null,
    value: document.getElementById('cell-every-name').value,
    editors: document.querySelectorAll('#cell-editor').length,
    selected: [...document.querySelectorAll('.day-tab')].find((t) => t.getAttribute('aria-selected') === 'true')?.dataset.day,
  }))()`);
  check('断点切换：桌面→手机再次变行内且只有一份编辑器', info.narrow && info.cls.includes('is-inline') && info.parentPage === 'day-page-2' && info.value === '断点保留课程' && info.editors === 1 && info.selected === '2', JSON.stringify(info));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(450);
  await cdp.evaluate("document.getElementById('cell-apply').click()");
  await sleep(250);
  info = await cdp.evaluate(`(() => ({
    text: window.__t.cell(2, 4).textContent,
    editorHidden: document.getElementById('cell-editor').hidden,
    focused: document.activeElement === window.__t.cell(2, 4),
  }))()`);
  check('应用本格：写入本地、关闭气泡并回焦目标格', info.text.includes('断点保留课程') && info.editorHidden && info.focused, JSON.stringify(info));
}

async function verifyBusiness(cdp) {
  await cdp.evaluate(`(async () => {
    const setCell = async (day, period, name) => {
      const cell = window.__t.cell(day, period);
      cell.scrollIntoView({ block: 'center', inline: 'center' });
      await window.__t.settle();
      cell.click();
      await new Promise((r) => setTimeout(r, 150));
      const input = document.getElementById('cell-every-name');
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('cell-apply').click();
      await new Promise((r) => setTimeout(r, 150));
      return true;
    };
    await setCell(1, 1, '数学');
    await setCell(1, 2, '物理');
    return true;
  })()`);

  let info = await cdp.evaluate(`(async () => {
    const cell = window.__t.cell(1, 1);
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    await window.__t.settle();
    cell.click();
    await new Promise((r) => setTimeout(r, 150));
    const stale = ['cell-rule-split', 'cell-rule-every', 'cell-rule-change', 'cell-rule-choice', 'cell-rule-confirm', 'cell-odd-name', 'cell-even-name'];
    return {
      stale: stale.filter((id) => document.getElementById(id)),
      ruleNote: document.getElementById('cell-rule-note').textContent,
      everyVisible: !document.getElementById('cell-every-block').hidden,
      ruleInputs: document.querySelectorAll('#cell-editor input[name="cell-rule-choice"], #cell-editor [name="cell-week-rule"]').length,
      legacyMeta: Boolean(document.getElementById('schedule-meta')),
    };
  })()`);
  check('成员填课：编辑器没有每周/单双周切换，只说明继承空间统一规则',
    info.stale.length === 0 && info.ruleInputs === 0 && info.ruleNote.includes('统一按每周')
      && info.everyVisible && info.legacyMeta === false,
    JSON.stringify(info));
  await cdp.evaluate("document.getElementById('cell-cancel').click()");

  const ruleBypass = await cdp.evaluate(`(async () => {
    const id = ${JSON.stringify(spaceIds.coursesId)};
    const read = await (await fetch('/functions/v1/app/api/spaces/' + id + '/schedule')).json();
    const before = read.schedule.revision;
    const mismatch = await fetch('/functions/v1/app/api/spaces/' + id + '/schedule/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'rule-bypass-' + Date.now(), baseRevision: before,
        entries: [{ day: 2, period: 3, weekRule: 'odd', courseName: '越权单周' }],
      }),
    });
    const mismatchBody = await mismatch.json().catch(() => null);
    const after = await (await fetch('/functions/v1/app/api/spaces/' + id + '/schedule')).json();
    return {
      rule: read.weekRule?.rule ?? null,
      before, status: mismatch.status, error: mismatchBody?.error ?? null,
      after: after.schedule.revision,
      entries: after.schedule.draftEntries,
    };
  })()`);
  check('服务端统一周次：绕过界面写入其他周次被拒绝，已有课表不变',
    ruleBypass.rule === 'every' && ruleBypass.status === 400 && ruleBypass.error === 'week_rule_mismatch'
      && ruleBypass.after === ruleBypass.before,
    JSON.stringify(ruleBypass));

  // 上一节快捷：写入当前目标格
  const sourceText = await cdp.evaluate("window.__t.cell(1, 1).textContent");
  const targetBefore = await cdp.evaluate("window.__t.cell(1, 2).textContent");
  info = await cdp.evaluate(`(async () => {
    const cell = window.__t.cell(1, 2);
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    cell.click();
    await new Promise((r) => setTimeout(r, 150));
    const visible = !document.getElementById('cell-previous').hidden;
    document.getElementById('cell-previous').click();
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      if (document.getElementById('confirm-dialog').open) break;
    }
    const confirmOpened = document.getElementById('confirm-dialog').open;
    if (confirmOpened) document.getElementById('confirm-ok').click();
    await new Promise((r) => setTimeout(r, 100));
    return {
      visible,
      confirmOpened,
      title: document.getElementById('cell-title').textContent,
      ruleNote: document.getElementById('cell-rule-note').textContent,
    };
  })()`);
  await cdp.evaluate("document.getElementById('cell-apply').click()");
  await sleep(180);
  const targetText = await cdp.evaluate("window.__t.cell(1, 2).textContent");
  const sourceAfter = await cdp.evaluate("window.__t.cell(1, 1).textContent");
  check('上一节：该格已有内容时用内置确认，确认后沿用源格且源格不变', info.visible && info.confirmOpened && info.title.includes('第2节') && info.ruleNote.includes('统一按每周') && targetText === sourceText && targetBefore !== targetText && sourceAfter === sourceText, JSON.stringify({ info, targetBefore, targetText, sourceText, sourceAfter }));

  // 仅有课空间（路由切换；有未保存内容时明确放弃，模拟用户选择）
  await cdp.evaluate(`location.hash = '#/spaces/${spaceIds.presenceId}/schedule'`);
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"), { timeout: 4000 });
  await cdp.evaluate("document.getElementById('leave-discard').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden && document.querySelectorAll('.week-table tbody tr').length === 3"));
  const presence = await cdp.evaluate(`(async () => {
    const cell = document.querySelector('.week-cell[data-day="2"][data-period="2"]');
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    cell.click();
    await new Promise((r) => setTimeout(r, 200));
    const updated = document.querySelector('.week-cell[data-day="2"][data-period="2"]');
    return {
      periods: document.querySelectorAll('.week-table tbody tr').length,
      editorHidden: document.getElementById('cell-editor').hidden,
      text: updated.textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  check('仅有课状态：3 节动态配置、一次点击标记有课且不弹中间面板', presence.periods === 3 && presence.editorHidden && presence.text.includes('有课'), JSON.stringify(presence));

  // 回到课程空间：先处理离页确认，再等课程配置（12 节）就绪后编辑
  await cdp.evaluate(`location.hash = '#/spaces/${spaceIds.coursesId}/schedule'`);
  await waitFor(() => cdp.evaluate("document.getElementById('leave-dialog').open"), { timeout: 4000 });
  await cdp.evaluate("document.getElementById('leave-discard').click()");
  await waitFor(() => cdp.evaluate("!document.getElementById('page-schedule').hidden && document.querySelectorAll('.week-table tbody tr').length === 12"));
  await cdp.evaluate(`(async () => {
    const cell = window.__t.cell(3, 3);
    cell.scrollIntoView({ block: 'center', inline: 'center' });
    await window.__t.settle();
    cell.click();
    await new Promise((r) => setTimeout(r, 180));
    const input = document.getElementById('cell-every-name');
    input.value = '草稿课程';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('cell-apply').click();
    return true;
  })()`);
  await sleep(300);
  await cdp.evaluate("document.getElementById('schedule-save-draft').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('schedule-status').textContent.includes('草稿已保存')"));
  info = await cdp.evaluate(`(() => ({
    status: document.getElementById('schedule-status').textContent,
    chip: document.getElementById('schedule-state').textContent,
  }))()`);
  check('草稿：保存成功并更新状态', info.status.includes('草稿已保存'), JSON.stringify(info));

  const storedRule = await cdp.evaluate(`(async () => {
    const read = await (await fetch('/functions/v1/app/api/spaces/' + ${JSON.stringify(spaceIds.coursesId)} + '/schedule')).json();
    return {
      rule: read.weekRule?.rule ?? null,
      entries: read.schedule.draftEntries,
    };
  })()`);
  check('草稿写入服务端：条目统一标记为空间规则，不出现单双周混合',
    storedRule.rule === 'every'
      && Array.isArray(storedRule.entries) && storedRule.entries.length > 0
      && storedRule.entries.every((entry) => entry.weekRule === 'every'),
    JSON.stringify(storedRule));

  const conflict = await cdp.evaluate(`(async () => {
    const spaceId = ${JSON.stringify(spaceIds.coursesId)};
    const read = await (await fetch('/functions/v1/app/api/spaces/' + spaceId + '/schedule')).json();
    const entries = [{ day: 7, period: 12, courseName: '并发写入课程' }];
    const advance = await fetch('/functions/v1/app/api/spaces/' + spaceId + '/schedule/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'localadvance' + Date.now(), baseRevision: read.schedule.revision, entries }),
    });
    document.getElementById('schedule-publish').click();
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.getElementById('confirm-dialog').open) {
        document.getElementById('confirm-ok').click();
        break;
      }
    }
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (!document.getElementById('schedule-conflict').hidden) break;
    }
    return {
      advance: advance.status,
      conflictVisible: !document.getElementById('schedule-conflict').hidden,
      text: document.getElementById('schedule-conflict-text').textContent,
      localKept: !document.getElementById('schedule-discard').hidden,
    };
  })()`);
  check('并发保护：旧版本提交返回冲突并显示提示，不覆盖新数据', (conflict.advance === 200 || conflict.advance === 201) && conflict.conflictVisible && conflict.text.includes('版本冲突') && conflict.localKept, JSON.stringify(conflict));

  await cdp.evaluate("document.getElementById('schedule-conflict-reload').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('schedule-conflict-text').textContent.includes('已读取最新服务端版本')"));
  info = await cdp.evaluate(`(() => ({
    conflictVisible: !document.getElementById('schedule-conflict').hidden,
    text: document.getElementById('schedule-conflict-text').textContent,
  }))()`);
  check('冲突后读取最新：提示服务端版本且保留本地输入', info.conflictVisible && info.text.includes('已读取最新服务端版本'), JSON.stringify(info));

  await cdp.evaluate("document.getElementById('schedule-publish').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('confirm-dialog').open"));
  await cdp.evaluate("document.getElementById('confirm-ok').click()");
  await waitFor(() => cdp.evaluate("document.getElementById('schedule-state').textContent.includes('课表已提交') && document.getElementById('schedule-conflict').hidden"));
  info = await cdp.evaluate(`(() => ({
    state: document.getElementById('schedule-state').textContent,
    lockNote: Boolean(document.getElementById('schedule-lock-note')),
    conflict: !document.getElementById('schedule-conflict').hidden,
    status: document.getElementById('schedule-status').textContent,
  }))()`);
  check('重新提交：状态显示已提交、不再重复配置锁定提示且不显示内部版本号',
    info.state.includes('课表已提交') && !/v\d+/.test(info.state) && !info.lockNote && !info.conflict,
    JSON.stringify(info));
  await cdp.screenshot('desktop-published');
}

await main();

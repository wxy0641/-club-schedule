// 我的课表页面：按空间挂载，离开时保护未应用的本格编辑与本地未保存修改。
// 数据只通过当前空间接口读取；路由切换由 app.js 负责，这里只暴露 activate/deactivate。
import {
  DAY_LABELS, RULE_LABELS, WEEK_RULES, canonicalEntries, cellHasContent,
  cloneCell, cloneCellInto, countClassSlots, daySlideDuration, describeRuleValue, emptyCell,
  entriesEqual, entriesToSlots, normalizeCell, previousCell,
  scheduleKey, slotsToEntries, swipeDestination, validateCell,
} from './schedule-model.mjs';

export function createSchedulePage(shared) {
  const DAY_SHORT_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'];
  const el = {
    panel: document.getElementById('schedule-panel'),
    state: document.getElementById('schedule-state'),
    teachingNote: document.getElementById('schedule-teaching-note'),
    loading: document.getElementById('schedule-loading'),
    error: document.getElementById('schedule-error'),
    errorText: document.getElementById('schedule-error-text'),
    errorRetry: document.getElementById('schedule-error-retry'),
    legacyNote: document.getElementById('schedule-legacy-note'),
    legacyOpen: document.getElementById('schedule-open-legacy'),
    viewBar: document.getElementById('schedule-view-bar'),
    dayTabsWrap: document.getElementById('day-tabs-wrap'),
    dayTabs: document.getElementById('day-tabs'),
    grid: document.getElementById('schedule-grid'),
    actions: document.getElementById('schedule-actions'),
    cellEditor: document.getElementById('cell-editor'),
    cellEditorRestore: document.getElementById('cell-editor-restore'),
    editorExitDialog: document.getElementById('editor-exit-dialog'),
    editorExitText: document.getElementById('editor-exit-text'),
    cellTitle: document.getElementById('cell-title'),
    cellRuleNote: document.getElementById('cell-rule-note'),
    cellEveryBlock: document.getElementById('cell-every-block'),
    cellEveryCourse: document.getElementById('cell-every-course'),
    cellEveryName: document.getElementById('cell-every-name'),
    cellCourseLabel: document.getElementById('cell-course-label'),
    cellHint: document.getElementById('cell-hint'),
    cellPrevious: document.getElementById('cell-previous'),
    cellPreviousNote: document.getElementById('cell-previous-note'),
    cellClear: document.getElementById('cell-clear'),
    cellCancel: document.getElementById('cell-cancel'),
    cellApply: document.getElementById('cell-apply'),
    saveDraft: document.getElementById('schedule-save-draft'),
    publish: document.getElementById('schedule-publish'),
    clear: document.getElementById('schedule-clear'),
    discard: document.getElementById('schedule-discard'),
    reload: document.getElementById('schedule-reload'),
    conflict: document.getElementById('schedule-conflict'),
    conflictText: document.getElementById('schedule-conflict-text'),
    conflictReload: document.getElementById('schedule-conflict-reload'),
    status: document.getElementById('schedule-status'),
  };

  let spaceId = null;
  let token = 0;
  let loadedRevision = -1;
  let detail = null;
  let config = null;
  let configLocked = false;
  let weekRule = null;
  let weekRuleResolved = false;
  let legacy = false;
  let busy = false;
  let role = null;
  let pendingJoin = false;
  let pendingJoinSpaceId = null;

  const state = {
    doc: null,
    slots: new Map(),
    baseRevision: 0,
    baseEntries: [],
    dirty: false,
    pending: null,
    editing: null,
    edit: null,
    editBaseline: null,
    message: '',
    conflictMessage: '',
    viewDay: 1,
    popoverCollapsed: false,
    animating: false,
    suppressClickUntil: 0,
    narrow: typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 760px)').matches
      : false,
  };

  const carousel = {
    viewport: null, track: null, pages: [], settledDay: 1, targetDay: 1, settleTimer: 0, pageObserver: null,
  };
  let editorExitPromise = null;
  let swipeGesture = null;
  let popoverFrame = 0;

  const current = (checkToken, id) => checkToken === token && shared.currentSpaceId() === id;
  const canUse = () => Boolean(config && state.doc && !legacy && weekRuleResolved);

  function formatSlot(day, period) {
    return `${DAY_LABELS[day] ?? `第 ${day} 天`} · 第 ${period} 节`;
  }

  function refreshControls() {
    const loaded = canUse();
    const scheduleMode = config?.mode ?? 'presence';
    const localEntries = loaded ? slotsToEntries(state.slots, scheduleMode) : [];
    const publishedEntries = state.doc?.publishedEntries ?? [];
    const canPublish = loaded && (
      pendingJoin
      || (state.doc.publishedVersion ?? 0) === 0
      || !entriesEqual(localEntries, publishedEntries)
    );
    el.saveDraft.disabled = busy || !loaded || !state.dirty;
    el.publish.disabled = busy || !canPublish;
    el.reload.disabled = busy || !loaded;
    el.discard.disabled = busy || !state.dirty;
    el.clear.disabled = busy || !loaded || countClassSlots(state.slots) === 0;
    el.conflictReload.disabled = busy;
    el.errorRetry.disabled = busy;

    const editing = Boolean(state.edit && state.editing);
    const cellValidation = editing ? validateCell(state.edit, scheduleMode) : { ok: false };
    el.cellApply.disabled = busy || !editing || !cellValidation.ok;
    el.cellClear.disabled = busy || !editing;
    el.cellCancel.disabled = busy;
    el.cellEveryName.disabled = busy || !editing;
    el.cellPrevious.disabled = busy;
  }

  function setBusy(value) {
    busy = value;
    shared.setBusy(value);
    refreshControls();
  }

  function clearEditingClasses() {
    for (const cell of el.grid.querySelectorAll('.week-cell.is-editing')) {
      cell.classList.remove('is-editing');
      cell.setAttribute('aria-expanded', 'false');
    }
  }

  function resetEditorState() {
    state.editing = null;
    state.edit = null;
    state.editBaseline = null;
    state.popoverCollapsed = false;
    clearEditingClasses();
    el.cellEditor.hidden = true;
    el.cellEditorRestore.hidden = true;
    if (el.cellEditor.parentElement !== el.panel) el.panel.append(el.cellEditor);
  }

  function resetUi() {
    loadedRevision = -1;
    state.doc = null;
    state.slots = new Map();
    state.baseRevision = 0;
    state.baseEntries = [];
    state.dirty = false;
    state.pending = null;
    state.message = '';
    state.conflictMessage = '';
    state.viewDay = 1;
    state.animating = false;
    state.suppressClickUntil = 0;
    legacy = false;
    weekRule = null;
    weekRuleResolved = false;
    config = null;
    detail = null;
    configLocked = false;
    role = null;
    pendingJoin = false;
    if (carousel.settleTimer) clearTimeout(carousel.settleTimer);
    disconnectDayObserver();
    carousel.viewport = null;
    carousel.track = null;
    carousel.pages = [];
    carousel.settledDay = 1;
    carousel.targetDay = 1;
    carousel.settleTimer = 0;
    if (el.editorExitDialog.open) el.editorExitDialog.close('stay');
    resetEditorState();
    el.loading.hidden = true;
    el.error.hidden = true;
    el.errorText.textContent = '';
    el.grid.replaceChildren();
    el.dayTabs.replaceChildren();
    el.dayTabsWrap.classList.remove('can-left', 'can-right');
    el.status.textContent = '';
    el.conflict.hidden = true;
    el.conflictText.textContent = '';
    el.teachingNote.hidden = true;
    el.legacyNote.hidden = true;
    el.state.textContent = '正在读取…';
    el.state.className = 'chip chip-idle';
    el.viewBar.hidden = false;
    el.actions.hidden = false;
    refreshControls();
  }

  function showError(message) {
    el.loading.hidden = true;
    state.doc = null;
    state.slots = new Map();
    state.dirty = false;
    state.pending = null;
    resetEditorState();
    el.grid.replaceChildren();
    el.status.textContent = '';
    el.errorText.textContent = message;
    el.error.hidden = false;
    el.state.textContent = '读取失败';
    el.state.className = 'chip chip-warn';
    refreshControls();
  }

  function renderTeachingNote(info) {
    el.teachingNote.replaceChildren();
    el.teachingNote.hidden = true;
    if (!info.teaching) {
      const title = document.createElement('strong');
      title.textContent = info.teachingState === 'invalid' ? '教学周设置无效' : '尚未设置教学周';
      const text = document.createElement('p');
      text.textContent = info.teachingState === 'invalid'
        ? '服务端保存的教学周设置无法通过校验，请联系负责人检查；周课表仍可填报。'
        : '负责人尚未设置教学周；本周课表仍可填报，月历将在设置教学周并提交有效课表后可用。';
      el.teachingNote.append(title, text);
      if (info.space?.role === 'owner' && info.teachingState === 'pending') {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'ghost small';
        go.textContent = '去设置';
        go.addEventListener('click', () => { void shared.navigate(`/spaces/${spaceId}/settings`); });
        actions.append(go);
        el.teachingNote.append(actions);
      }
      el.teachingNote.hidden = false;
    }
  }

  function renderLegacy() {
    legacy = true;
    el.loading.hidden = true;
    el.state.textContent = '旧版空间';
    el.state.className = 'chip chip-idle';
    el.legacyNote.hidden = false;
    el.viewBar.hidden = true;
    el.grid.replaceChildren();
    el.actions.hidden = true;
    refreshControls();
  }

  function scheduleSourceEntries(document_) {
    if (Array.isArray(document_?.draftEntries)) return document_.draftEntries;
    if (Array.isArray(document_?.publishedEntries)) return document_.publishedEntries;
    return [];
  }

  function localEntries() {
    return slotsToEntries(state.slots, config.mode);
  }

  function recomputeDirty() {
    state.dirty = !entriesEqual(localEntries(), state.baseEntries);
    return state.dirty;
  }

  function markChanged(message) {
    state.pending = null;
    state.message = message;
    recomputeDirty();
  }

  function editorHasChanges() {
    if (!config || !state.edit || !state.editBaseline || !state.editing) return false;
    const key = scheduleKey(state.editing.day, state.editing.period);
    const currentEntries = slotsToEntries(new Map([[key, state.edit]]), config.mode);
    const original = slotsToEntries(new Map([[key, state.editBaseline]]), config.mode);
    return !entriesEqual(currentEntries, original);
  }

  function showEditorExitDialog(reason) {
    if (editorExitPromise) return editorExitPromise;
    el.editorExitText.textContent = `${reason}前，本格还有未应用的修改。应用后会留在课表中但尚未保存；放弃会丢弃本次编辑；留在当前则继续编辑。`;
    el.editorExitDialog.returnValue = 'stay';
    editorExitPromise = new Promise((resolve) => {
      const onClose = () => {
        el.editorExitDialog.removeEventListener('close', onClose);
        const value = el.editorExitDialog.returnValue;
        editorExitPromise = null;
        resolve(value === 'apply' || value === 'discard' ? value : 'stay');
      };
      el.editorExitDialog.addEventListener('close', onClose);
      el.editorExitDialog.showModal();
    });
    return editorExitPromise;
  }

  function findCellButton(day, period) {
    return el.grid.querySelector(`.week-cell[data-day="${day}"][data-period="${period}"]`);
  }

  function focusCell(day, period) {
    const cell = findCellButton(day, period);
    if (cell && typeof cell.focus === 'function') cell.focus({ preventScroll: true });
  }

  function collapsePopover() {
    if (!state.editing) return;
    state.popoverCollapsed = true;
    el.cellEditor.hidden = true;
    const slot = formatSlot(state.editing.day, state.editing.period);
    el.cellEditorRestore.textContent = '继续编辑';
    el.cellEditorRestore.setAttribute('aria-label', `继续编辑 ${slot}`);
    el.cellEditorRestore.title = `继续编辑 ${slot}`;
    el.cellEditorRestore.hidden = false;
  }

  function restorePopover() {
    if (!state.editing || state.narrow) return;
    const anchor = findCellButton(state.editing.day, state.editing.period);
    if (!anchor) return;
    anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    state.popoverCollapsed = false;
    el.cellEditorRestore.hidden = true;
    el.cellEditor.hidden = false;
    renderCellEditor();
    el.cellEditor.focus({ preventScroll: true });
    requestAnimationFrame(positionCellPopover);
  }

  function newRequestId() {
    return crypto.randomUUID().replace(/-/g, '');
  }

  function applyLoadedSchedule(body) {
    const source = scheduleSourceEntries(body.schedule);
    state.doc = body.schedule;
    configLocked = Boolean(body.configLocked);
    state.baseRevision = Number.isSafeInteger(body.schedule?.revision) ? body.schedule.revision : 0;
    state.baseEntries = canonicalEntries(source);
    state.slots = entriesToSlots(source, config.mode);
    state.dirty = false;
    state.pending = null;
    resetEditorState();
    state.conflictMessage = '';
  }

  async function loadSchedule(id, { checkToken = token, message = '', keep = false, revision = shared.dataRevision() } = {}) {
    if (!config || shared.currentSpaceId() !== id) return;
    if (!keep) {
      el.loading.hidden = false;
      el.error.hidden = true;
      el.errorText.textContent = '';
      el.state.textContent = '正在读取…';
      el.state.className = 'chip chip-idle';
      el.grid.replaceChildren();
      el.cellEditor.hidden = true;
    } else {
      el.status.textContent = '正在刷新课表…';
    }
    try {
      const body = await shared.api(`/api/spaces/${id}/schedule`);
      if (!current(checkToken, id)) return;
      applyLoadedSchedule(body);
      loadedRevision = revision;
      role = body.space?.role ?? role;
      state.message = message;
      el.loading.hidden = true;
      renderSchedule();
    } catch (error) {
      if (!current(checkToken, id)) return;
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      if (keep) {
        el.loading.hidden = true;
        el.status.textContent = `课表刷新失败：${error.message}；当前内容保留，可重试。`;
        return;
      }
      showError(`课表读取失败：${error.message}`);
    }
  }

  function scheduleChip() {
    if (state.dirty) return ['有修改待提交', 'chip-warn'];
    if ((state.doc?.publishedVersion ?? 0) > 0) return ['课表已提交', 'chip-ok'];
    if (state.doc?.draftEntries !== null) return ['草稿已保存', 'chip-idle'];
    return ['尚未提交', 'chip-warn'];
  }

  function weekRuleText() {
    if (!weekRuleResolved) return '周次规则待处理';
    return weekRule === 'odd' ? '单周' : weekRule === 'even' ? '双周' : '每周';
  }

  function cellAria(day, period, cell) {
    const parts = [];
    for (const rule of WEEK_RULES) {
      const value = cell[rule];
      if (!value?.hasClass) continue;
      parts.push(`${RULE_LABELS[rule]}有课${value.courseName ? `，${value.courseName}` : ''}`);
    }
    if (parts.length === 0) parts.push('无课');
    return `${DAY_LABELS[day]} 第 ${period} 节，${parts.join('；')}。点击编辑。`;
  }

  function buildCell(day, period) {
    const cell = state.slots.get(scheduleKey(day, period)) ?? emptyCell(day, period);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-cell';
    button.dataset.day = String(day);
    button.dataset.period = String(period);
    const hasContent = cellHasContent(cell);
    if (config?.mode === 'presence') {
      button.setAttribute('aria-pressed', String(hasContent));
      button.title = hasContent ? '点击取消本格有课' : '点击标记本格有课';
    } else {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.title = '点击编辑';
    }
    if (hasContent) button.classList.add('has-class');
    if (state.editing?.day === day && state.editing?.period === period) {
      button.classList.add('is-editing');
      if (config?.mode !== 'presence') button.setAttribute('aria-expanded', 'true');
    }
    button.setAttribute('aria-label', cellAria(day, period, cell));
    if (!cellHasContent(cell)) {
      const empty = document.createElement('span');
      empty.className = 'cell-empty';
      empty.textContent = '无课';
      button.append(empty);
    } else {
      for (const rule of WEEK_RULES) {
        const value = cell[rule];
        if (!value?.hasClass) continue;
        const line = document.createElement('span');
        line.className = `cell-line rule-${rule}`;
        if (rule !== 'every') {
          const tag = document.createElement('span');
          tag.className = 'cell-tag';
          tag.textContent = RULE_LABELS[rule];
          line.append(tag);
        }
        const text = document.createElement('span');
        text.className = 'cell-text';
        text.textContent = describeRuleValue(value, config.mode);
        line.append(text);
        button.append(line);
      }
    }
    button.addEventListener('click', (event) => {
      if (Date.now() < state.suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      void requestOpenCellEditor(day, period);
    });
    return button;
  }

  function renderDayTabs() {
    el.dayTabs.replaceChildren();
    for (let day = 1; day <= 7; day += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'day-tab';
      button.id = `day-tab-${day}`;
      button.dataset.day = String(day);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(day === state.viewDay));
      button.setAttribute('aria-controls', `day-page-${day}`);
      button.textContent = DAY_SHORT_LABELS[day];
      button.setAttribute('aria-label', DAY_LABELS[day]);
      button.addEventListener('click', () => { void selectScheduleDay(day, 'tab'); });
      el.dayTabs.append(button);
    }
  }

  function buildDayList(day) {
    const list = document.createElement('div');
    list.className = 'day-list';
    for (const period of config.periods) {
      const row = document.createElement('div');
      row.className = 'day-row';
      row.dataset.period = String(period.index);
      const slot = document.createElement('div');
      slot.className = 'day-slot';
      const number = document.createElement('strong');
      number.textContent = `第 ${period.index} 节`;
      const time = document.createElement('span');
      time.textContent = `${period.start}–${period.end}`;
      slot.append(number, time);
      row.append(slot, buildCell(day, period.index));
      list.append(row);
    }
    return list;
  }

  // 日期页内容高度随课表/字体/编辑态变化，高度必须跟随实际内容，否则页面会被纵向裁切。
  function disconnectDayObserver() {
    carousel.pageObserver?.disconnect();
    carousel.pageObserver = null;
  }

  function observeDayPages(pages) {
    disconnectDayObserver();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => syncDayHeight());
    for (const page of pages) observer.observe(page);
    carousel.pageObserver = observer;
  }

  function renderDayView() {
    renderDayTabs();
    const viewport = document.createElement('div');
    viewport.className = 'day-viewport';
    const track = document.createElement('div');
    track.className = 'day-track';
    const pages = [];
    for (let day = 1; day <= 7; day += 1) {
      const page = document.createElement('section');
      page.className = 'day-page';
      page.id = `day-page-${day}`;
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', `day-tab-${day}`);
      page.append(buildDayList(day));
      pages.push(page);
      track.append(page);
    }
    viewport.append(track);
    el.grid.replaceChildren(viewport);

    if (carousel.settleTimer) clearTimeout(carousel.settleTimer);
    carousel.viewport = viewport;
    carousel.track = track;
    carousel.pages = pages;
    carousel.settledDay = state.viewDay;
    carousel.targetDay = state.viewDay;
    carousel.settleTimer = 0;
    state.animating = false;
    track.style.transition = 'none';
    track.style.transform = `translate3d(${-(state.viewDay - 1) * viewport.clientWidth}px, 0, 0)`;
    setCarouselPages(state.viewDay, { during: false });
    syncDayHeight();
    observeDayPages(pages);
    document.fonts?.ready.then(() => {
      if (carousel.pages === pages) syncDayHeight();
    }).catch(() => {});
    requestAnimationFrame(() => {
      syncDayHeight();
      updateDayTabEdges();
      ensureDayTabVisible(state.viewDay, 'auto');
    });
  }

  function renderWeekGrid() {
    const table = document.createElement('table');
    table.className = 'week-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = '节次';
    headRow.append(corner);
    for (let day = 1; day <= 7; day += 1) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = DAY_LABELS[day];
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const period of config.periods) {
      const row = document.createElement('tr');
      const headCell = document.createElement('th');
      headCell.scope = 'row';
      const wrap = document.createElement('span');
      wrap.className = 'period-head';
      const number = document.createElement('strong');
      number.textContent = `第 ${period.index} 节`;
      const time = document.createElement('small');
      time.textContent = `${period.start}–${period.end}`;
      wrap.append(number, time);
      headCell.append(wrap);
      row.append(headCell);
      for (let day = 1; day <= 7; day += 1) {
        const td = document.createElement('td');
        td.append(buildCell(day, period.index));
        row.append(td);
      }
      body.append(row);
    }
    table.append(head, body);
    el.grid.replaceChildren(table);
  }

  function renderGrid() {
    if (state.narrow) {
      renderDayView();
    } else {
      disconnectDayObserver();
      el.dayTabs.replaceChildren();
      el.dayTabsWrap.classList.remove('can-left', 'can-right');
      renderWeekGrid();
    }
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setCarouselPages(day, { during }) {
    for (const [index, page] of carousel.pages.entries()) {
      const active = index + 1 === day;
      page.setAttribute('aria-hidden', String(!active));
      if (active && !during) page.removeAttribute('inert');
      else page.setAttribute('inert', '');
    }
  }

  function syncDayHeight({ during = false } = {}) {
    if (!state.narrow || !carousel.viewport) return;
    const currentPage = carousel.pages[state.viewDay - 1];
    const settled = carousel.pages[carousel.settledDay - 1];
    const targetHeight = currentPage?.offsetHeight ?? 0;
    const settledHeight = settled?.offsetHeight ?? 0;
    const height = during ? Math.max(targetHeight, settledHeight) : targetHeight;
    if (height > 0) carousel.viewport.style.height = `${height}px`;
  }

  function trackTranslateX() {
    if (!carousel.track) return 0;
    const transform = getComputedStyle(carousel.track).transform;
    if (!transform || transform === 'none') return 0;
    try {
      return new DOMMatrixReadOnly(transform).m41;
    } catch {
      return 0;
    }
  }

  function settleCarousel(day) {
    if (!carousel.track || day !== carousel.targetDay) return;
    if (carousel.settleTimer) clearTimeout(carousel.settleTimer);
    carousel.settleTimer = 0;
    const width = carousel.viewport?.clientWidth ?? 0;
    carousel.track.style.transition = 'none';
    carousel.track.style.transform = `translate3d(${-(day - 1) * width}px, 0, 0)`;
    carousel.settledDay = day;
    state.animating = false;
    setCarouselPages(day, { during: false });
    updateDayTabsSelection(day);
    syncDayHeight();
    ensureDayTabVisible(day);
  }

  function animateCarouselTo(day, { immediate = false } = {}) {
    if (!state.narrow || !carousel.track || !carousel.viewport) return;
    const width = carousel.viewport.clientWidth;
    if (!width) return;
    const targetX = -(day - 1) * width;
    const currentX = trackTranslateX();
    const distance = Math.abs(targetX - currentX) / width;
    carousel.targetDay = day;
    state.animating = true;
    setCarouselPages(day, { during: true });
    syncDayHeight({ during: true });
    const duration = immediate ? 0 : daySlideDuration(Math.max(1, distance), prefersReducedMotion());
    carousel.track.style.transition = duration > 0
      ? `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
      : 'none';
    void carousel.track.offsetWidth;
    carousel.track.style.transform = `translate3d(${targetX}px, 0, 0)`;
    if (carousel.settleTimer) clearTimeout(carousel.settleTimer);
    if (duration === 0) requestAnimationFrame(() => settleCarousel(day));
    else carousel.settleTimer = setTimeout(() => settleCarousel(day), duration + 80);
  }

  function updateDayTabsSelection(day) {
    for (const tab of el.dayTabs.querySelectorAll('.day-tab')) {
      tab.setAttribute('aria-selected', String(Number(tab.dataset.day) === day));
    }
  }

  function ensureDayTabVisible(day, behavior = 'smooth') {
    if (!state.narrow) return;
    const tab = el.dayTabs.querySelector(`.day-tab[data-day="${day}"]`);
    if (!tab) return;
    const box = el.dayTabs.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const edge = 10;
    if (rect.left < box.left + edge) {
      el.dayTabs.scrollBy({ left: rect.left - box.left - edge, behavior });
    } else if (rect.right > box.right - edge) {
      el.dayTabs.scrollBy({ left: rect.right - box.right + edge, behavior });
    }
  }

  function updateDayTabEdges() {
    if (!state.narrow) {
      el.dayTabsWrap.classList.remove('can-left', 'can-right');
      return;
    }
    const maxScroll = el.dayTabs.scrollWidth - el.dayTabs.clientWidth;
    el.dayTabsWrap.classList.toggle('can-left', el.dayTabs.scrollLeft > 2);
    el.dayTabsWrap.classList.toggle('can-right', maxScroll - el.dayTabs.scrollLeft > 2);
  }

  async function selectScheduleDay(day, source = 'tab') {
    if (!state.narrow || day < 1 || day > 7) return;
    if (source === 'swipe' && state.animating) return;
    if (day === state.viewDay) {
      updateDayTabsSelection(day);
      ensureDayTabVisible(day);
      return;
    }
    if (state.editing) {
      const proceed = await resolveEditorBeforeAction('切换星期');
      if (!proceed) return;
    }
    if (day === state.viewDay) return;
    state.viewDay = day;
    updateDayTabsSelection(day);
    ensureDayTabVisible(day);
    animateCarouselTo(day);
  }

  function updateCellHint() {
    if (!state.edit || !config) return;
    const validation = validateCell(state.edit, config.mode);
    if (config.mode !== 'courses') {
      el.cellHint.textContent = '保存后仍需保存草稿。';
      return;
    }
    const value = state.edit[weekRule ?? 'every'];
    if (!value?.hasClass) {
      el.cellHint.textContent = '清空课程名保存即为无课。';
      return;
    }
    el.cellHint.textContent = validation.ok
      ? '保存后仍需保存草稿。'
      : validation.message;
  }

  function previousSourceNote(previous) {
    const names = [];
    for (const rule of WEEK_RULES) {
      const value = previous.cell?.[rule];
      if (!value?.hasClass || typeof value.courseName !== 'string') continue;
      const name = value.courseName.trim();
      if (config.mode === 'courses' && name && !names.includes(name)) names.push(name);
    }
    return `来源：第 ${previous.period} 节${names.length ? ` · ${names.join(' / ')}` : ''}`;
  }

  function mountCellEditor(editing) {
    if (state.narrow) {
      el.cellEditor.className = 'cell-editor is-inline';
      const page = document.getElementById(`day-page-${editing.day}`);
      const row = page?.querySelector(`.day-row[data-period="${editing.period}"]`);
      if (row) {
        if (el.cellEditor.previousElementSibling !== row) {
          row.insertAdjacentElement('afterend', el.cellEditor);
        }
      } else if (page && el.cellEditor.parentElement !== page) {
        page.append(el.cellEditor);
      }
    } else {
      el.cellEditor.className = 'cell-editor is-popover';
      if (el.cellEditor.parentElement !== document.body) document.body.append(el.cellEditor);
    }
  }

  function revealInlineEditorIfNeeded() {
    if (!state.narrow || !state.editing || el.cellEditor.hidden) return;
    const rect = el.cellEditor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewTop = viewport?.offsetTop ?? 0;
    const viewHeight = viewport?.height ?? window.innerHeight;
    if (rect.bottom > viewTop + viewHeight - 12 || rect.top < viewTop) {
      el.cellEditor.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }

  function renderCellEditor() {
    const editing = state.editing;
    const edit = state.edit;
    if (!editing || !edit || !config) {
      el.cellEditor.hidden = true;
      el.cellEditorRestore.hidden = true;
      if (el.cellEditor.parentElement !== document.body) document.body.append(el.cellEditor);
      return;
    }
    mountCellEditor(editing);
    el.cellTitle.textContent = `${DAY_LABELS[editing.day]}·第${editing.period}节`;
    const rule = weekRule ?? 'every';
    const value = edit[rule];
    el.cellRuleNote.textContent = weekRuleResolved
      ? `本空间统一按${weekRuleText()}记录周次。`
      : '周次规则尚未确定，本格暂不可编辑。';
    el.cellEveryName.value = value?.courseName ?? '';
    el.cellEveryBlock.hidden = !weekRuleResolved;
    el.cellEveryCourse.hidden = config.mode !== 'courses';
    el.cellEveryName.disabled = false;

    updateCellHint();
    el.cellClear.hidden = !cellHasContent(state.editBaseline);
    const previous = previousCell(state.slots, editing.day, editing.period);
    const showPrevious = config.mode === 'courses' && Boolean(previous);
    el.cellPrevious.hidden = !showPrevious;
    el.cellPreviousNote.hidden = !showPrevious;
    if (previous) {
      el.cellPrevious.setAttribute('aria-label', `沿用第 ${previous.period} 节的内容`);
      el.cellPreviousNote.textContent = previousSourceNote(previous);
    } else {
      el.cellPreviousNote.textContent = '';
    }

    if (state.narrow) {
      el.cellEditor.hidden = false;
      el.cellEditorRestore.hidden = true;
      requestAnimationFrame(() => {
        syncDayHeight();
        revealInlineEditorIfNeeded();
      });
    } else {
      el.cellEditor.hidden = state.popoverCollapsed;
      el.cellEditorRestore.hidden = !state.popoverCollapsed;
      if (!state.popoverCollapsed) requestAnimationFrame(positionCellPopover);
    }
    refreshControls();
  }

  function positionCellPopover() {
    if (state.narrow || !state.editing || state.popoverCollapsed) return;
    const anchor = findCellButton(state.editing.day, state.editing.period);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const host = el.grid.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const visible = rect.bottom > 8 && rect.top < vh - 8 && rect.right > 8 && rect.left < vw - 8
      && rect.bottom > host.top + 4 && rect.top < host.bottom - 4
      && rect.right > host.left + 4 && rect.left < host.right - 4;
    if (!visible) {
      if (editorHasChanges()) collapsePopover();
      else {
        state.message = '目标格已滚出视野，已收起编辑；未修改本地内容。';
        resetEditorState();
        el.status.textContent = state.message;
      }
      return;
    }
    el.cellEditor.hidden = false;
    el.cellEditor.style.maxHeight = `${Math.max(120, vh - margin * 2)}px`;
    const box = el.cellEditor.getBoundingClientRect();
    let left;
    let top;
    if (rect.right + margin + box.width <= vw - margin) {
      left = rect.right + margin;
      top = rect.top;
    } else if (rect.left - margin - box.width >= margin) {
      left = rect.left - margin - box.width;
      top = rect.top;
    } else {
      left = Math.min(Math.max(margin, rect.left), vw - box.width - margin);
      top = rect.bottom + margin;
      if (top + box.height > vh - margin) top = rect.top - box.height - margin;
    }
    left = Math.max(margin, Math.min(left, vw - box.width - margin));
    top = Math.max(margin, Math.min(top, vh - box.height - margin));
    el.cellEditor.style.left = `${Math.floor(left)}px`;
    el.cellEditor.style.top = `${Math.floor(top)}px`;
  }

  function schedulePopoverPosition() {
    if (popoverFrame) return;
    popoverFrame = requestAnimationFrame(() => {
      popoverFrame = 0;
      positionCellPopover();
    });
  }

  function renderFeedbacks() {
    const [text, kind] = scheduleChip();
    el.state.textContent = text;
    el.state.className = `chip ${kind}`;
    el.status.textContent = state.message;
    el.conflict.hidden = !state.conflictMessage;
    el.conflictText.textContent = state.conflictMessage;
    el.discard.hidden = !state.dirty;
    if (!state.doc) {
      el.state.textContent = '读取失败';
      el.state.className = 'chip chip-warn';
    }
  }

  function renderSchedule() {
    if (!config || !state.doc) return;
    renderGrid();
    renderCellEditor();
    renderFeedbacks();
    refreshControls();
  }

  function blockUnresolvedRule() {
    if (weekRuleResolved) return false;
    state.message = '负责人尚未确定统一周次规则，本空间暂时只读；既有课表未被修改。';
    el.status.textContent = state.message;
    return true;
  }

  // 状态课表：点空格即有课、再点取消。只改本地草稿，不打开中间面板，也不自动提交整表。
  function togglePresenceCell(day, period) {
    if (busy || !config || blockUnresolvedRule()) return;
    const key = scheduleKey(day, period);
    const cell = state.slots.get(key) ?? emptyCell(day, period);
    const next = cloneCell(cell);
    const rule = weekRule ?? 'every';
    const hadClass = Boolean(next[rule]?.hasClass);
    next[rule] = hadClass ? null : { hasClass: true, courseName: null };
    const normalized = normalizeCell(next, config.mode);
    if (cellHasContent(normalized)) state.slots.set(key, normalized);
    else state.slots.delete(key);
    markChanged(hadClass ? '已取消本格有课标记；尚未保存。' : '已标记本格有课；尚未保存。');
    renderSchedule();
    focusCell(day, period);
  }

  async function requestOpenCellEditor(day, period) {
    if (busy || !config) return;
    if (config.mode === 'presence') {
      togglePresenceCell(day, period);
      return;
    }
    if (blockUnresolvedRule()) return;
    if (state.narrow && state.animating) return;
    if (state.editing?.day === day && state.editing?.period === period) {
      if (state.narrow) return;
      if (state.popoverCollapsed) restorePopover();
      else el.cellEveryName.focus({ preventScroll: true });
      return;
    }
    if (state.editing && !(await resolveEditorBeforeAction('编辑其他格子'))) return;
    if (busy || !config) return;
    const cell = state.slots.get(scheduleKey(day, period)) ?? emptyCell(day, period);
    state.editing = { day, period };
    state.edit = cloneCell(cell);
    state.editBaseline = cloneCell(cell);
    state.popoverCollapsed = false;
    state.message = '';
    renderSchedule();
    // 单次点击即进入课程名输入；同步聚焦以保留移动端键盘的用户手势资格。
    if (config.mode === 'courses') el.cellEveryName.focus({ preventScroll: true });
    else el.cellEditor.focus({ preventScroll: true });
    if (!state.narrow) {
      requestAnimationFrame(() => {
        if (state.narrow || state.popoverCollapsed) return;
        if (state.editing?.day !== day || state.editing?.period !== period) return;
        positionCellPopover();
        if (config.mode === 'courses' && !state.popoverCollapsed) {
          el.cellEveryName.focus({ preventScroll: true });
        }
      });
    }
  }

  async function settleEditorExit(reason) {
    if (!state.editing) return 'clean';
    if (!editorHasChanges()) {
      resetEditorState();
      refreshControls();
      return 'clean';
    }
    const choice = await showEditorExitDialog(reason);
    if (choice === 'apply') return applyCellEditor() ? 'applied' : 'stay';
    if (choice === 'discard') {
      resetEditorState();
      refreshControls();
      return 'discarded';
    }
    return 'stay';
  }

  async function resolveEditorBeforeAction(reason) {
    return (await settleEditorExit(reason)) !== 'stay';
  }

  async function requestCloseCellEditor(message = '') {
    if (!state.editing) return;
    const target = state.editing;
    const result = await settleEditorExit('关闭编辑器');
    if (result === 'stay') return;
    if (result === 'applied') return;
    if (message) {
      state.message = message;
      el.status.textContent = message;
    }
    if (!state.narrow) focusCell(target.day, target.period);
  }

  async function closeEditorForOutsideClick() {
    if (!state.editing) return;
    await settleEditorExit('关闭编辑器');
  }

  // 课程名本身就是“有课”的唯一开关：有名字即有课，清空并应用即为无课。
  function syncCourseName(input) {
    if (!state.edit || !weekRuleResolved) return;
    const rule = weekRule ?? 'every';
    const name = input.value;
    state.edit[rule] = name.trim() ? { hasClass: true, courseName: name } : null;
    updateCellHint();
    refreshControls();
  }

  function clearCellEditor() {
    if (!state.edit || !state.editing) return;
    state.edit = emptyCell(state.editing.day, state.editing.period);
    state.message = '已清空编辑内容；保存后才会修改本地内容。';
    renderSchedule();
  }

  function applyCellEditor() {
    if (!state.edit || !state.editing || !config) return false;
    const validation = validateCell(state.edit, config.mode);
    if (!validation.ok) {
      state.message = validation.message;
      updateCellHint();
      el.status.textContent = validation.message;
      return false;
    }
    const cell = normalizeCell(state.edit, config.mode);
    const key = scheduleKey(cell.day, cell.period);
    if (cellHasContent(cell)) state.slots.set(key, cell);
    else state.slots.delete(key);
    const target = state.editing;
    state.editing = null;
    state.edit = null;
    state.editBaseline = null;
    state.popoverCollapsed = false;
    markChanged('本格已保存，尚未提交到服务器。');
    renderSchedule();
    if (!state.narrow) focusCell(target.day, target.period);
    return true;
  }

  async function usePreviousPeriod() {
    if (!state.edit || !state.editing) return;
    const previous = previousCell(state.slots, state.editing.day, state.editing.period);
    if (!previous) return;
    if (cellHasContent(state.edit)) {
      const ok = await shared.confirmAction({
        title: '替换本格内容？',
        text: '本格已有正在编辑的内容，沿用上节将替换它（尚未保存）。',
        confirmText: '替换',
      });
      if (!ok) return;
    }
    const target = state.editing;
    state.edit = cloneCellInto(previous.cell, target.day, target.period);
    state.message = `已沿用第 ${previous.period} 节的内容；尚未保存本格。`;
    renderSchedule();
  }

  async function clearWholeWeek() {
    if (busy || !state.doc) return;
    if (state.editing && !(await resolveEditorBeforeAction('清空整周'))) return;
    const confirmed = await shared.confirmAction({
      title: '清空整周内容？',
      text: '将清空本地整周内容（全周无课），尚未保存。',
      confirmText: '清空',
      danger: true,
    });
    if (!confirmed) return;
    state.slots = new Map();
    resetEditorState();
    markChanged('已清空本地整周内容（全周无课），尚未保存到服务器。');
    renderSchedule();
  }

  async function discardLocalSchedule() {
    if (busy || !config) return;
    if (state.editing && !(await resolveEditorBeforeAction('放弃本地修改'))) return;
    if (!state.dirty) return;
    const confirmed = await shared.confirmAction({
      title: '放弃本地修改？',
      text: '放弃本地未保存修改，恢复到最近一次读取或保存的内容。',
      confirmText: '放弃修改',
      danger: true,
    });
    if (!confirmed) return;
    state.slots = entriesToSlots(state.baseEntries, config.mode);
    resetEditorState();
    state.pending = null;
    state.dirty = false;
    state.conflictMessage = '';
    state.message = '已放弃本地未保存修改。';
    renderSchedule();
  }

  async function reloadScheduleAction() {
    if (busy) return;
    if (state.editing && !(await resolveEditorBeforeAction('重新读取课表'))) return;
    if (state.dirty) {
      const confirmed = await shared.confirmAction({
        title: '重新读取课表？',
        text: '重新读取将丢弃本地未保存修改。',
        confirmText: '重新读取',
        danger: true,
      });
      if (!confirmed) return;
    }
    await loadSchedule(spaceId, { message: '已读取最新课表。' });
  }

  async function refreshLatestAfterConflict() {
    const id = spaceId;
    try {
      const body = await shared.api(`/api/spaces/${id}/schedule`);
      if (shared.currentSpaceId() !== id || !config) return;
      const local = slotsToEntries(state.slots, config.mode);
      state.doc = body.schedule;
      configLocked = Boolean(body.configLocked);
      if (body.weekRule) {
        weekRule = body.weekRule.resolved ? body.weekRule.rule : null;
        weekRuleResolved = Boolean(body.weekRule.resolved && weekRule);
      }
      state.baseRevision = body.schedule.revision;
      state.baseEntries = canonicalEntries(scheduleSourceEntries(body.schedule));
      state.slots = entriesToSlots(local, config.mode);
      state.dirty = !entriesEqual(local, state.baseEntries);
      state.conflictMessage = `版本冲突：本次未写入。已读取最新服务端版本（revision ${body.schedule.revision}）；你的本地输入已保留。核对后再次保存或提交会以最新版本为基准替换整表。`;
      state.message = '';
      renderSchedule();
    } catch (error) {
      if (shared.currentSpaceId() !== id) return;
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      state.conflictMessage = `版本冲突：本次未写入。读取最新版本失败：${error.message}；你的本地输入已保留。请点击“读取最新”重试。`;
      renderSchedule();
    }
  }

  async function handleWriteError(error, operation) {
    const code = error instanceof shared.ApiError ? error.code : 'request_failed';
    if (code === 'version_conflict') {
      state.pending = null;
      await refreshLatestAfterConflict();
      return;
    }
    if (code === 'request_reuse_conflict') {
      state.pending = null;
      state.message = '同一请求标识已用于不同内容，服务端拒绝写入；已生成新的请求标识，请再次操作。';
      renderSchedule();
      return;
    }
    if (!(error instanceof shared.ApiError) || error.status === 0 || error.status >= 500) {
      state.message = `结果未确认（${error.message.replace(/。$/, '')}）。本地输入已保留；请保持内容不变并再次点击“${operation === 'publish' ? '提交课表' : '保存草稿'}”，会复用同一请求标识安全重试。`;
      renderSchedule();
      return;
    }
    state.pending = null;
    state.message = error.message;
    renderSchedule();
  }

  function buildPublishPrompt() {
    const lines = [
      '整表提交会用当前编辑的整周内容替换你在此空间的有效课表。',
      '空白格表示无课；未填写的格子不会保留旧内容。',
    ];
    if (weekRuleResolved && weekRule !== 'every') {
      lines.push(`本空间统一按${weekRuleText()}记录周次；本次提交覆盖整周模板。`);
    }
    if (!((state.doc?.publishedVersion ?? 0) > 0)) {
      lines.push('这将是你的首次有效提交；提交后，本空间的节次、周次规则与收集模式将固定。');
    }
    return lines.join('\n');
  }

  async function submitScheduleOperation(operation) {
    if (busy || !config || !state.doc) return false;
    const id = spaceId;
    for (const cell of state.slots.values()) {
      const validation = validateCell(cell, config.mode);
      if (!validation.ok) {
        state.message = validation.message;
        renderSchedule();
        return false;
      }
    }
    const entries = slotsToEntries(state.slots, config.mode);
    if (operation === 'publish') {
      const confirmed = await shared.confirmAction({
        title: '提交有效课表？',
        text: buildPublishPrompt(),
        confirmText: '提交',
      });
      if (!confirmed) return false;
    }

    let requestId = newRequestId();
    const pending = state.pending;
    if (pending
      && pending.operation === operation
      && pending.baseRevision === state.baseRevision
      && entriesEqual(pending.entries, entries)) {
      requestId = pending.requestId;
    }
    const baseRevision = state.baseRevision;
    const collectionJoin = operation === 'publish' && role === 'owner' && pendingJoin;
    state.pending = { requestId, operation, baseRevision, entries };
    setBusy(true);
    state.message = operation === 'publish' ? '正在提交有效课表…' : '正在保存草稿…';
    el.status.textContent = state.message;
    let saved = false;
    try {
      const endpoint = operation === 'publish' ? 'schedule/publish' : 'schedule/draft';
      const body = await shared.api(`/api/spaces/${id}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({
          requestId, baseRevision, entries,
          ...(role === 'owner' && operation === 'publish' ? { collectionJoin } : {}),
        }),
      });
      if (shared.currentSpaceId() !== id) return false;
      state.doc = body.schedule;
      configLocked = Boolean(body.configLocked);
      state.baseRevision = body.schedule.revision;
      state.baseEntries = canonicalEntries(scheduleSourceEntries(body.schedule));
      state.pending = null;
      state.conflictMessage = '';
      state.dirty = !entriesEqual(slotsToEntries(state.slots, config.mode), state.baseEntries);
      const label = operation === 'publish'
        ? '课表已提交'
        : '草稿已保存';
      state.message = body.replayed
        ? `${label}（已确认上次请求，未重复写入）。`
        : `${label}。`;
      saved = true;
      if (collectionJoin) {
        pendingJoin = false;
        state.message = '课表已提交，并已纳入收集。';
      }
      renderSchedule();
    } catch (error) {
      if (shared.currentSpaceId() !== id) return false;
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return false;
      }
      await handleWriteError(error, operation);
    } finally {
      setBusy(false);
    }
    return saved && !state.dirty;
  }

  async function prepareLeave(reason) {
    if (state.editing) {
      const result = await settleEditorExit(reason);
      if (result === 'stay') return false;
    }
    if (!state.dirty) return true;
    const choice = await shared.showLeaveDialog({
      text: '本空间周课表还有未保存的修改。可以保存为草稿后离开；放弃会丢弃本地修改；留在当前则继续编辑。',
      canSave: true,
    });
    if (choice === 'stay') return false;
    if (choice === 'discard') {
      state.slots = entriesToSlots(state.baseEntries, config.mode);
      state.dirty = false;
      state.pending = null;
      resetEditorState();
      return true;
    }
    const saved = await submitScheduleOperation('draft');
    if (!saved) {
      state.message = state.message || '草稿未能保存，已留在当前页面。';
      el.status.textContent = state.message;
      return false;
    }
    return true;
  }

  function hasPending() {
    return Boolean(state.editing || state.dirty);
  }

  async function activate(id) {
    const revision = shared.dataRevision();
    if (spaceId === id && state.doc && !hasPending() && loadedRevision === revision) {
      el.loading.hidden = true;
      return;
    }
    const keep = spaceId === id && Boolean(state.doc) && !hasPending();
    const checkToken = ++token;
    spaceId = id;
    busy = false;
    if (!keep) {
      resetUi();
      el.loading.hidden = false;
      el.state.textContent = '正在读取…';
    } else {
      el.loading.hidden = true;
      el.error.hidden = true;
    }
    try {
      const info = await shared.api(`/api/spaces/${id}/config`);
      if (!current(checkToken, id)) return;
      detail = info;
      if (!info.config) {
        renderLegacy();
        return;
      }
      config = info.config;
      weekRule = info.weekRule?.resolved ? info.weekRule.rule : null;
      weekRuleResolved = Boolean(info.weekRule?.resolved && weekRule);
      configLocked = Boolean(info.configLocked);
      role = info.space?.role ?? null;
      if (!keep) {
        renderTeachingNote(info);
        el.loading.hidden = true;
      }
      await loadSchedule(id, { checkToken, keep, revision });
      if (role === 'owner' && pendingJoinSpaceId === id && canUse()) {
        pendingJoinSpaceId = null;
        pendingJoin = true;
        refreshControls();
        el.status.textContent = '提交有效课表后将计入收集。';
      }
    } catch (error) {
      if (!current(checkToken, id)) return;
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      if (keep) {
        el.loading.hidden = true;
        el.status.textContent = `配置刷新失败：${error.message}；当前内容保留。`;
        return;
      }
      showError(`空间配置读取失败：${error.message}`);
    }
  }

  function deactivate() {
    token += 1;
    if (el.editorExitDialog.open) el.editorExitDialog.close('stay');
    resetUi();
    spaceId = null;
    busy = false;
  }

  function requestPendingJoin(id) {
    pendingJoinSpaceId = id;
    pendingJoin = false;
  }

  // 事件绑定只在模块创建时执行一次；页面隐藏时由 hasPending/激活状态隔离。
  el.saveDraft.addEventListener('click', () => { void submitScheduleOperation('draft'); });
  el.publish.addEventListener('click', () => { void submitScheduleOperation('publish'); });
  el.reload.addEventListener('click', () => { void reloadScheduleAction(); });
  el.discard.addEventListener('click', () => { void discardLocalSchedule(); });
  el.clear.addEventListener('click', () => { void clearWholeWeek(); });
  el.conflictReload.addEventListener('click', () => { void refreshLatestAfterConflict(); });
  el.errorRetry.addEventListener('click', () => { void activate(spaceId); });
  el.legacyOpen.addEventListener('click', () => { void shared.navigate(`/spaces/${spaceId}/legacy`); });
  el.cellEditorRestore.addEventListener('click', restorePopover);
  el.cellCancel.addEventListener('click', () => { void requestCloseCellEditor('已取消本格编辑，未修改本地内容。'); });
  el.cellEveryName.addEventListener('input', () => syncCourseName(el.cellEveryName));
  el.cellPrevious.addEventListener('click', () => { void usePreviousPeriod(); });
  el.cellClear.addEventListener('click', clearCellEditor);
  el.cellApply.addEventListener('click', () => { applyCellEditor(); });

  document.addEventListener('pointerdown', (event) => {
    if (!state.editing || state.narrow) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#cell-editor') || target.closest('#editor-exit-dialog')) return;
    if (target.closest('#cell-editor-restore') || target.closest('.week-cell')) return;
    if (target.closest('button, input, select, textarea, label, a, summary, [role="tab"]')) return;
    void closeEditorForOutsideClick();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.editing || busy) return;
    if (el.editorExitDialog.open) return;
    event.preventDefault();
    void requestCloseCellEditor('已取消本格编辑，未修改本地内容。');
  });

  window.addEventListener('beforeunload', (event) => {
    if (!hasPending()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function onPointerDown(event) {
    if (!state.narrow || busy || state.animating || state.editing || !event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#cell-editor')) return;
    if (target.closest('a, input, select, textarea, label, [role="tab"]')) return;
    // 课程卡本身是编辑按钮，但也是内容区跟手切日的有效起点；
    // 其他按钮（如恢复编辑器）不接管手势。
    if (target.closest('button') && !target.closest('.week-cell')) return;
    if (swipeGesture) return;
    const width = carousel.viewport?.clientWidth ?? 0;
    if (width < 1) return;
    swipeGesture = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      deltaX: 0,
      width,
      baseX: -(carousel.settledDay - 1) * width,
      samples: [{ x: event.clientX, t: performance.now() }],
    };
  }

  function gestureVelocity(samples) {
    if (samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    const cutoff = last.t - 100;
    const first = samples.find((sample) => sample.t >= cutoff) ?? samples[0];
    const span = last.t - first.t;
    return span >= 8 ? (last.x - first.x) / span : 0;
  }

  // 跟手位移只写 transform；越界用阻尼，不读取布局，也不锁页面纵向滚动。
  function followFinger(gesture, dx) {
    const min = -6 * gesture.width;
    let x = gesture.baseX + dx;
    if (x > 0) x *= 0.32;
    else if (x < min) x = min + (x - min) * 0.32;
    carousel.track.style.transition = 'none';
    carousel.track.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  function onPointerMove(event) {
    const gesture = swipeGesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      gesture.axis = Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (gesture.axis === 'x') {
        state.suppressClickUntil = Date.now() + 400;
        carousel.track.style.transition = 'none';
      }
    }
    if (gesture.axis !== 'x') return;
    gesture.deltaX = dx;
    gesture.samples.push({ x: event.clientX, t: performance.now() });
    if (gesture.samples.length > 12) gesture.samples.shift();
    followFinger(gesture, dx);
  }

  function finishSwipe(cancel) {
    const gesture = swipeGesture;
    swipeGesture = null;
    if (!gesture || gesture.axis !== 'x' || state.animating) return;
    state.suppressClickUntil = Date.now() + 400;
    const velocity = cancel ? 0 : gestureVelocity(gesture.samples);
    const target = cancel
      ? carousel.settledDay
      : swipeDestination(carousel.settledDay, gesture.deltaX, gesture.width, velocity);
    state.viewDay = target;
    updateDayTabsSelection(target);
    ensureDayTabVisible(target);
    animateCarouselTo(target);
  }

  function onPointerEnd(event) {
    const gesture = swipeGesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    finishSwipe(false);
  }

  el.grid.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerEnd, { passive: true });
  document.addEventListener('pointercancel', () => { finishSwipe(true); }, { passive: true });
  el.dayTabs.addEventListener('scroll', updateDayTabEdges, { passive: true });
  el.grid.addEventListener('scroll', schedulePopoverPosition, { passive: true });
  window.addEventListener('scroll', schedulePopoverPosition, { passive: true });
  window.addEventListener('resize', () => {
    if (!state.doc) return;
    if (swipeGesture) {
      swipeGesture = null;
      if (carousel.track && carousel.viewport) {
        carousel.track.style.transition = 'none';
        carousel.track.style.transform = `translate3d(${-(carousel.settledDay - 1) * carousel.viewport.clientWidth}px, 0, 0)`;
      }
    }
    updateDayTabEdges();
    syncDayHeight();
    schedulePopoverPosition();
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (state.narrow && state.editing) revealInlineEditorIfNeeded();
      schedulePopoverPosition();
    });
  }

  if (typeof ResizeObserver === 'function') {
    const editorObserver = new ResizeObserver(() => {
      if (state.narrow && state.editing) syncDayHeight();
    });
    editorObserver.observe(el.cellEditor);
  }

  if (typeof window.matchMedia === 'function') {
    const narrowQuery = window.matchMedia('(max-width: 760px)');
    const onNarrowChange = (event) => {
      if (state.narrow === event.matches) return;
      state.narrow = event.matches;
      if (!config || !state.doc) return;
      if (state.narrow && state.editing) state.viewDay = state.editing.day;
      state.popoverCollapsed = false;
      renderSchedule();
      if (state.editing && !state.narrow) {
        requestAnimationFrame(() => {
          if (state.narrow || !state.editing || state.popoverCollapsed) return;
          positionCellPopover();
          el.cellEditor.focus({ preventScroll: true });
        });
      }
    };
    if (typeof narrowQuery.addEventListener === 'function') narrowQuery.addEventListener('change', onNarrowChange);
    else if (typeof narrowQuery.addListener === 'function') narrowQuery.addListener(onNarrowChange);
  }

  return { activate, deactivate, prepareLeave, hasPending, requestPendingJoin };
}

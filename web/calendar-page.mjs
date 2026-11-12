// 我的日历页面：按月读取服务端投影，日期例外即时保存；离开页面时清理本人数据与输入。
import {
  LEGEND, WEEKDAY_LABELS,
  conflictLabel, dayStateAria, daySummary, monthLabel, monthTermSummary, monthWeeks,
  shiftMonth, statusKind, statusText, teachingWeekNumber, todayInZone, validMonth,
  weekdayMon1,
} from './calendar-model.mjs';
import { bindMonthSwipe } from './month-swipe.mjs';

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createCalendarPage(shared) {
  const el = {
    state: document.getElementById('calendar-state'),
    teachingNote: document.getElementById('calendar-teaching-note'),
    assignments: document.getElementById('calendar-assignments'),
    assignmentCount: document.getElementById('calendar-assignment-count'),
    assignmentList: document.getElementById('calendar-assignment-list'),
    toolbar: document.getElementById('calendar-toolbar'),
    prev: document.getElementById('calendar-prev'),
    today: document.getElementById('calendar-today'),
    month: document.getElementById('calendar-month'),
    next: document.getElementById('calendar-next'),
    switchStatus: document.getElementById('calendar-switch-status'),
    preview: document.getElementById('calendar-preview'),
    previewNote: document.getElementById('calendar-preview-note'),
    term: document.getElementById('calendar-term'),
    legend: document.getElementById('calendar-legend'),
    loading: document.getElementById('calendar-loading'),
    skeleton: document.getElementById('calendar-skeleton'),
    skeletonGrid: document.querySelector('#calendar-skeleton .calendar-skeleton-grid'),
    error: document.getElementById('calendar-error'),
    errorText: document.getElementById('calendar-error-text'),
    retry: document.getElementById('calendar-retry'),
    empty: document.getElementById('calendar-empty'),
    table: document.getElementById('calendar-table'),
    viewport: document.getElementById('calendar-viewport'),
    track: document.getElementById('calendar-track'),
    pagePrev: document.getElementById('calendar-page-prev'),
    pageNext: document.getElementById('calendar-page-next'),
    grid: document.getElementById('calendar-grid'),
    detail: document.getElementById('calendar-detail'),
    detailTitle: document.getElementById('calendar-detail-title'),
    detailBody: document.getElementById('calendar-detail-body'),
    status: document.getElementById('calendar-status'),
  };

  let spaceId = null;
  let token = 0;
  let monthToken = 0;
  let home = null;
  let config = null;
  let teaching = null;
  let data = null;
  let month = null;
  // 独立于已显示月份的目标年月：连续点击在目标上累加，响应只允许落到最新目标。
  let targetMonth = null;
  let selectedDate = null;
  let consentAccepted = false;
  let busy = false;
  let pendingWrite = null;
  let assignmentWrite = null;
  let reduceMotion = false;
  let loadedRevision = -1;
  let previewMode = false;
  let previewOffer = false;
  let activeRequest = null;
  let prefetchTimer = 0;
  let retryTarget = null;
  let switching = false;
  // 写入后的自动刷新期间箭头仍可点：记录最后一次切月意图，刷新完成后再执行。
  let pendingNav = null;
  let swipe = null;
  const monthCache = new Map();
  const revalidating = new Map();
  let prefetchQueue = [];
  let prefetchRunning = false;
  let prefetchController = null;
  let preloadRequest = null;
  let cacheEpoch = 0;

  const current = (check, id) => check === token && shared.currentSpaceId() === id;
  const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  if (motionQuery) {
    reduceMotion = motionQuery.matches === true;
    motionQuery.addEventListener?.('change', (event) => { reduceMotion = event.matches === true; });
  }

  function setChip(text, kind = 'chip-idle') {
    el.state.textContent = text;
    el.state.className = `chip ${kind}`;
  }

  // 草稿预览只影响本人月历的只读投影；提交状态、负责人视图和收集口径不变。
  function syncPreviewControls() {
    if (!el.preview) return;
    const active = data?.preview === 'draft';
    el.preview.hidden = !active && !previewOffer;
    el.preview.setAttribute('aria-pressed', String(active));
    el.preview.disabled = switching || busy || !data;
    if (el.previewNote) el.previewNote.hidden = !active;
  }

  function buildLegend() {
    el.legend.replaceChildren();
    for (const item of LEGEND) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `legend-dot kind-${item.kind}`;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = item.label;
      li.append(dot, label);
      el.legend.append(li);
    }
  }

  function resetDetailPlaceholder() {
    el.detailTitle.textContent = '选择日期';
    el.detailBody.replaceChildren();
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = '点击日期查看当天节次。';
    el.detailBody.append(note);
  }

  function resetUi() {
    abortPreload();
    loadedRevision = -1;
    previewMode = false;
    previewOffer = false;
    retryTarget = null;
    home = null;
    config = null;
    teaching = null;
    data = null;
    month = null;
    targetMonth = null;
    selectedDate = null;
    consentAccepted = false;
    pendingWrite = null;
    assignmentWrite = null;
    if (el.switchStatus) {
      el.switchStatus.hidden = true;
      el.switchStatus.textContent = '';
      el.switchStatus.classList.remove('is-error');
    }
    el.table?.removeAttribute('aria-busy');
    el.teachingNote.replaceChildren();
    el.teachingNote.hidden = true;
    el.toolbar.hidden = false;
    el.assignments.hidden = true;
    el.assignmentCount.hidden = true;
    el.assignmentList.replaceChildren();
    el.month.textContent = '';
    el.term.textContent = '';
    el.legend.hidden = false;
    el.loading.hidden = true;
    el.skeleton.hidden = true;
    el.error.hidden = true;
    el.errorText.textContent = '';
    el.empty.hidden = true;
    el.empty.textContent = '';
    el.table.hidden = true;
    el.table.classList.remove('slide-next', 'slide-prev');
    el.grid.replaceChildren();
    el.pagePrev?.replaceChildren();
    el.pageNext?.replaceChildren();
    if (el.pagePrev) el.pagePrev.dataset.state = '';
    if (el.pageNext) el.pageNext.dataset.state = '';
    switching = false;
    pendingNav = null;
    el.status.textContent = '';
    setChip('正在读取…');
    syncPreviewControls();
    resetDetailPlaceholder();
  }

  function setTeachingNote(titleText, text, ownerAction) {
    el.teachingNote.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = titleText;
    const textNode = document.createElement('p');
    textNode.textContent = text;
    el.teachingNote.append(title, textNode);
    if (ownerAction) {
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

  function renderUnavailable(kind) {
    el.loading.hidden = true;
    el.skeleton.hidden = true;
    el.toolbar.hidden = true;
    el.legend.hidden = true;
    el.table.hidden = true;
    el.empty.hidden = false;
    resetDetailPlaceholder();
    if (kind === 'legacy') {
      setChip('旧版空间');
      el.empty.textContent = '该空间没有周课表与教学周设置，不提供月历。';
      setTeachingNote('旧版空间', '该空间使用旧版整表填报，不生成月历。');
    } else {
      setChip('设置无效', 'chip-warn');
      el.empty.textContent = '空间配置无效，暂时无法生成月历。';
      setTeachingNote('空间配置无效', '空间配置无法读取，请联系负责人检查。');
    }
  }

  function renderTeachingMissing(state) {
    el.loading.hidden = true;
    el.skeleton.hidden = true;
    el.toolbar.hidden = true;
    el.legend.hidden = true;
    el.table.hidden = true;
    el.empty.hidden = false;
    resetDetailPlaceholder();
    const owner = home?.space?.role === 'owner';
    if (state === 'invalid') {
      setChip('设置无效', 'chip-warn');
      el.empty.textContent = '教学周设置无效，暂时无法生成月历。';
      setTeachingNote('教学周设置无效', '教学周设置无法读取，请联系负责人检查；课表仍可使用。');
      return;
    }
    setChip('待教学设置');
    el.empty.textContent = '教学周设置完成后才能生成月历。';
    setTeachingNote(
      '尚未设置教学周',
      owner
        ? '周课表仍可正常使用；本人月历需要先一次性设置第一教学周的周一、学期开始、结束与时区。'
        : '负责人尚未设置教学周；周课表仍可使用，月历将在设置完成后可用。',
      owner,
    );
  }

  function renderFailure(message) {
    data = null;
    el.loading.hidden = true;
    el.skeleton.hidden = true;
    el.table.hidden = true;
    el.grid.replaceChildren();
    el.empty.hidden = true;
    el.errorText.textContent = message;
    el.error.hidden = false;
    setChip('读取失败', 'chip-warn');
    resetDetailPlaceholder();
  }

  function initialMonth() {
    const today = todayInZone(teaching.timezone);
    const candidate = today ? today.slice(0, 7) : teaching.termStart.slice(0, 7);
    return validMonth(candidate) ?? teaching.termStart.slice(0, 7);
  }

  function defaultSelection(body) {
    const days = body.days ?? [];
    return days.find((day) => day.isToday)?.date
      ?? days.find((day) => day.inTerm)?.date
      ?? days[0]?.date
      ?? null;
  }

  function eventTimeLabel(event) {
    if (event.allDay === true) return '全天';
    if (event.startTime && event.endTime) return `${event.startTime}–${event.endTime}`;
    if (event.startTime) return `${event.startTime} 起`;
    return '时间未指定';
  }

  function eventSpanLabel(event, date) {
    if (!event.endDate || event.endDate === event.startDate) return '单日';
    if (date > event.startDate && date < event.endDate) return '进行中';
    return event.startDate < date ? `至 ${event.endDate}` : `${event.startDate} 起`;
  }

  function eventsOnDate(date) {
    return (data?.events ?? []).filter((event) => event.startDate <= date && event.endDate >= date);
  }

  function cellTokens(day) {
    if (!day) return [];
    return daySummary(day).slice(0, 3);
  }

  function appendDayStats(container, day) {
    if (!day?.inTerm) return;
    const tokens = cellTokens(day);
    for (const token of tokens) {
      if (token.kind === 'term') continue;
      const stat = document.createElement('span');
      stat.className = `cal-stat kind-${token.kind}`;
      stat.title = token.label;
      const dot = document.createElement('span');
      dot.className = 'cal-stat-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = token.label;
      stat.append(dot, label);
      container.append(stat);
    }
    if (container.childElementCount === 0) {
      const empty = document.createElement('span');
      empty.className = 'cal-none';
      empty.textContent = '无记录';
      container.append(empty);
    }
  }

  function buildCell(day, displayWeek = null) {
    if (!day) {
      const filler = document.createElement('span');
      filler.className = 'cal-cell is-empty';
      filler.setAttribute('role', 'gridcell');
      filler.setAttribute('aria-hidden', 'true');
      return filler;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cal-cell';
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-selected', String(day.date === selectedDate));
    button.setAttribute('aria-label', dayStateAria(day));
    button.dataset.date = day.date;
    if (day.isToday) button.classList.add('is-today');
    if (day.date === selectedDate) button.classList.add('is-selected');
    if (!day.inTerm) button.classList.add('is-term-out');

    const head = document.createElement('span');
    head.className = 'cal-cell-head';
    const number = document.createElement('span');
    number.className = 'cal-day-num';
    number.textContent = String(Number(day.date.slice(8, 10)));
    head.append(number);
    if (day.isToday) {
      const badge = document.createElement('span');
      badge.className = 'cal-today-badge';
      badge.textContent = '今天';
      head.append(badge);
    }
    button.append(head);

    if (displayWeek !== null && displayWeek !== undefined) {
      const week = document.createElement('span');
      week.className = 'cal-week-num';
      week.textContent = `第 ${displayWeek} 周`;
      button.append(week);
    }

    const stats = document.createElement('span');
    stats.className = 'cal-stats';
    appendDayStats(stats, day);
    button.append(stats);

    const dayEvents = eventsOnDate(day.date);
    if (dayEvents.length > 0) {
      button.classList.add('has-events');
      button.setAttribute('aria-label', `${dayStateAria(day)}；${dayEvents.length} 个可见事件`);
      const badge = document.createElement('span');
      badge.className = 'cal-event-badge';
      badge.textContent = `事件 ${dayEvents.length}`;
      button.append(badge);
    }
    button.addEventListener('click', () => { selectDate(day.date); });
    return button;
  }

  // 邻月预览只放静态日期结构与已缓存摘要，不生成可交互控件、重复 id 或焦点站。
  function buildPreviewCell(date, day, body, displayWeek = null) {
    const cell = document.createElement('span');
    cell.className = 'cal-cell';
    cell.setAttribute('role', 'gridcell');
    if (!date) {
      cell.classList.add('is-empty');
      cell.setAttribute('aria-hidden', 'true');
      return cell;
    }
    cell.dataset.date = date;
    if (day?.isToday) cell.classList.add('is-today');
    if (day && day.inTerm === false) cell.classList.add('is-term-out');

    const head = document.createElement('span');
    head.className = 'cal-cell-head';
    const number = document.createElement('span');
    number.className = 'cal-day-num';
    number.textContent = String(Number(date.slice(8, 10)));
    head.append(number);
    if (day?.isToday) {
      const badge = document.createElement('span');
      badge.className = 'cal-today-badge';
      badge.textContent = '今天';
      head.append(badge);
    }
    cell.append(head);

    if (displayWeek !== null && displayWeek !== undefined) {
      const week = document.createElement('span');
      week.className = 'cal-week-num';
      week.textContent = `第 ${displayWeek} 周`;
      cell.append(week);
    }

    const stats = document.createElement('span');
    stats.className = 'cal-stats';
    if (day) appendDayStats(stats, day);
    cell.append(stats);

    const events = day ? (body?.events ?? []).filter((event) => event.startDate <= date && event.endDate >= date) : [];
    if (events.length > 0) {
      cell.classList.add('has-events');
      const badge = document.createElement('span');
      badge.className = 'cal-event-badge';
      badge.textContent = `事件 ${events.length}`;
      cell.append(badge);
    }
    return cell;
  }

  function renderNeighborPage(container, target) {
    if (!container) return;
    container.replaceChildren();
    container.dataset.state = '';
    container.removeAttribute('data-label');
    if (previewMode && target && validMonth(target)) {
      container.dataset.state = 'blocked';
      container.dataset.label = '草稿预览 · 切到该月查看';
      container.setAttribute('aria-label', `${monthLabel(target)}，草稿预览需切到该月`);
      return;
    }
    if (!target || !validMonth(target)) {
      container.dataset.state = 'blocked';
      container.dataset.label = '没有更多月份';
      container.setAttribute('aria-label', '没有更多月份');
      return;
    }
    container.setAttribute('aria-label', `${monthLabel(target)}，未激活页`);
    const body = readCache(target);
    const byDate = new Map((body?.days ?? []).map((day) => [day.date, day]));
    for (const week of monthWeeks(target)) {
      const row = document.createElement('div');
      row.className = 'cal-row';
      row.setAttribute('role', 'row');
      let weekShown = false;
      for (const date of week) {
        const day = date ? byDate.get(date) ?? null : null;
        const inTerm = day ? day.inTerm : Boolean(teaching && date && date >= teaching.termStart && date <= teaching.termEnd);
        let weekNumber = null;
        if (date && inTerm && !weekShown) {
          weekNumber = day?.weekNumber ?? (teaching ? teachingWeekNumber(teaching, date) : null);
          if (weekNumber !== null && weekNumber !== undefined) weekShown = true;
        }
        row.append(buildPreviewCell(date, day, body, weekNumber));
      }
      container.append(row);
    }
    if (body) {
      container.dataset.state = 'ready';
    } else {
      container.dataset.state = 'loading';
      container.dataset.label = `${monthLabel(target)} · 加载中`;
    }
  }

  function renderNeighborPages() {
    if (!teaching || !month) return;
    renderNeighborPage(el.pagePrev, shiftMonth(month, -1));
    renderNeighborPage(el.pageNext, shiftMonth(month, 1));
  }

  function refreshMonthControls() {
    const locked = switching || busy;
    for (const button of [el.prev, el.next, el.today, el.retry]) {
      if (button) button.disabled = locked;
    }
    if (el.preview) el.preview.disabled = locked || !data;
    el.viewport?.classList.toggle('is-switching', switching);
  }

  async function commitSwipe(delta) {
    if (!teaching || !month) return false;
    const target = shiftMonth(month, delta);
    if (!target || !validMonth(target)) return false;
    pausePrefetch();
    const cached = readCache(target);
    const previous = {
      term: el.term.textContent,
      chipText: el.state.textContent,
      chipClass: el.state.className,
    };
    switching = true;
    refreshMonthControls();
    // 数据到达前保持旧月标题与网格，避免“新标题配旧数据”；命中缓存时同步替换。
    if (!cached) {
      setChip('正在读取…');
    }
    let ok = false;
    try {
      ok = await loadMonth(target, {
        preferDate: null, silent: true, neighbors: false, preview: previewMode,
      });
    } finally {
      switching = false;
      refreshMonthControls();
      if (!ok && month) {
        el.month.textContent = monthLabel(month);
        el.term.textContent = previous.term;
        el.state.textContent = previous.chipText;
        el.state.className = previous.chipClass;
      }
    }
    return ok;
  }

  function renderCalendar() {
    if (!data) return;
    el.month.textContent = monthLabel(month);
    const summary = monthTermSummary(data.days);
    if (summary) el.term.textContent = summary;
    else el.term.textContent = data.state === 'unknown' ? '' : '本月不在学期范围内';
    if (data.preview === 'draft') setChip('草稿', 'chip-warn');
    else if (data.state === 'ready') setChip(consentAccepted ? '已就绪' : '待确认告知', consentAccepted ? 'chip-ok' : 'chip-warn');
    else if (data.state === 'unknown') setChip('未提交', 'chip-warn');
    else setChip('待教学设置');
    syncPreviewControls();

    const byDate = new Map((data.days ?? []).map((day) => [day.date, day]));
    const weeks = monthWeeks(month);
    el.grid.replaceChildren();
    for (const week of weeks) {
      const row = document.createElement('div');
      row.className = 'cal-row';
      row.setAttribute('role', 'row');
      let weekShown = false;
      for (const date of week) {
        const day = date ? byDate.get(date) ?? null : null;
        let weekNumber = null;
        if (day?.inTerm && !weekShown) {
          weekNumber = day.weekNumber;
          if (weekNumber !== null && weekNumber !== undefined) weekShown = true;
        }
        row.append(buildCell(day, weekNumber));
      }
      el.grid.append(row);
    }
    el.table.hidden = weeks.length === 0;
    el.empty.hidden = weeks.length > 0;
    if (weeks.length === 0) el.empty.textContent = '该月份没有可显示的日期。';
  }

  function selectDate(date) {    selectedDate = date;
    for (const cell of el.grid.querySelectorAll('button.cal-cell')) {
      const isSelected = cell.dataset.date === date;
      cell.classList.toggle('is-selected', isSelected);
      cell.setAttribute('aria-selected', String(isSelected));
    }
    renderDetail();
  }

  function periodTime(period) {
    const item = config?.periods?.find((entry) => entry.index === period);
    return item ? `${item.start}–${item.end}` : '';
  }

  function assignmentKindLabel(item) {
    if (item.kind === 'event') return '事件确认';
    if (item.kind === 'busy') return '负责人安排忙碌';
    return '负责人请求确认有空';
  }

  function assignmentStatusText(item) {
    if (item.requiresReconfirm) return '时间已变更 · 需重新确认';
    if (item.status === 'pending') return '待确认';
    if (item.status === 'accepted') return item.expired ? '已过期（只读）' : '已接受';
    return '';
  }

  function assignmentWhen(item) {
    if (item.kind === 'event' && item.event) {
      const span = item.event.startDate === item.event.endDate
        ? item.event.startDate
        : `${item.event.startDate} 至 ${item.event.endDate}`;
      const time = item.event.allDay
        ? '全天'
        : `${item.event.startTime ?? ''}–${item.event.endTime ?? ''}`;
      return `${span} · ${time}`;
    }
    return `${item.date ?? ''} · 第 ${item.period} 节 · ${periodTime(item.period)}`;
  }

  function conflictHint(item) {
    const items = item.conflict?.items;
    if (!Array.isArray(items) || items.length === 0) return '';
    const first = items.slice(0, 3).map((cell) => {
      const course = cell.courseName ? `《${cell.courseName}》` : '课程';
      return `${cell.date} 第 ${cell.period} 节${course}`;
    }).join('；');
    const more = items.length > 3 ? `；另有 ${items.length - 3} 处` : '';
    return `与课程冲突：${first}${more}。接受后课程仍保留，不会自动取消课程。`;
  }

  function setAssignmentButtonsDisabled(disabled) {
    for (const button of el.assignmentList.querySelectorAll('button')) button.disabled = disabled;
  }

  async function respondAssignmentAction(item, action) {
    if (busy || switching || !spaceId) return;
    if (action === 'reject' || action === 'withdraw') {
      const ok = typeof shared.confirmAction === 'function'
        ? await shared.confirmAction({
          title: action === 'reject' ? '拒绝这条安排？' : '撤回已接受的安排？',
          text: action === 'reject'
            ? '拒绝后不会占用你的节次；如需再次确认，需要负责人重新发起。'
            : '撤回后该事件或安排不再占用对应节次；周课表与个人日期记录不受影响。',
          confirmText: action === 'reject' ? '拒绝' : '撤回',
          danger: true,
        })
        : true;
      if (!ok) return;
    }
    const key = `${item.id}:${action}:${item.version}:${item.eventStamp ?? ''}`;
    let requestId = newRequestId();
    if (assignmentWrite && assignmentWrite.key === key) requestId = assignmentWrite.requestId;
    assignmentWrite = { key, requestId };
    busy = true;
    shared.setBusy(true);
    setAssignmentButtonsDisabled(true);
    setRowBusy(true);
    el.status.textContent = action === 'accept' ? '正在确认安排…' : '正在更新安排…';
    try {
      const body = await shared.api(`/api/spaces/${spaceId}/assignments/respond`, {
        method: 'POST',
        body: JSON.stringify({
          id: item.id,
          requestId,
          action,
          expectedVersion: item.version,
          ...(item.kind === 'event' && action === 'accept'
            ? { eventStamp: item.eventStamp }
            : {}),
        }),
      });
      if (shared.currentSpaceId() !== spaceId) return;
      assignmentWrite = null;
      const message = body.replayed
        ? '已确认上次操作，未重复写入。'
        : (action === 'accept' ? '已确认；占用已进入日历。' : '已更新安排状态。');
      await loadMonth(month, { preferDate: selectedDate, silent: true });
      if (shared.currentSpaceId() === spaceId) el.status.textContent = message;
    } catch (error) {
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      const code = error instanceof shared.ApiError ? error.code : 'request_failed';
      if (code === 'event_changed') {
        assignmentWrite = null;
        await loadMonth(month, { preferDate: selectedDate, silent: true });
        if (shared.currentSpaceId() === spaceId) {
          el.status.textContent = '事件时间已变更；已重新读取，请核对后重新确认。';
        }
        return;
      }
      if (code === 'assignment_conflict' || code === 'assignment_not_pending'
        || code === 'assignment_not_accepted') {
        assignmentWrite = null;
        await loadMonth(month, { preferDate: selectedDate, silent: true });
        if (shared.currentSpaceId() === spaceId) {
          el.status.textContent = '该安排已在其他页面更新；已重新读取。';
        }
        return;
      }
      if (!(error instanceof shared.ApiError) || error.status === 0 || error.status >= 500) {
        el.status.textContent = '安排操作结果未确认；可重试，同一操作不会重复写入。';
        return;
      }
      assignmentWrite = null;
      await loadMonth(month, { preferDate: selectedDate, silent: true });
      if (shared.currentSpaceId() === spaceId) el.status.textContent = error.message;
    } finally {
      busy = false;
      shared.setBusy(false);
      setAssignmentButtonsDisabled(false);
      setRowBusy(false);
      flushPendingNav();
    }
  }

  // 站内事件/安排只在这里确认；确认后才进入日历投影，拒绝与撤回不改动周课表。
  function renderAssignments() {
    const list = Array.isArray(data?.assignments) ? data.assignments : [];
    const visible = list.filter((item) => item.status === 'pending'
      || item.requiresReconfirm || item.status === 'accepted');
    el.assignments.hidden = visible.length === 0;
    el.assignmentList.replaceChildren();
    const pendingCount = Number.isSafeInteger(data?.pendingCount) ? data.pendingCount : 0;
    el.assignmentCount.hidden = pendingCount === 0;
    el.assignmentCount.textContent = pendingCount > 0 ? `待确认 ${pendingCount}` : '';
    if (visible.length === 0) return;

    for (const item of visible) {
      const card = document.createElement('article');
      card.className = `assignment-card${item.status === 'pending' || item.requiresReconfirm ? ' is-pending' : ''}`;
      card.dataset.assignmentId = item.id;

      const head = document.createElement('div');
      head.className = 'assignment-card-head';
      const title = document.createElement('strong');
      title.textContent = item.event?.title ?? assignmentKindLabel(item);
      const status = document.createElement('span');
      status.className = `state-tag kind-${item.requiresReconfirm || item.status === 'pending' ? 'conflict' : 'busy'}`;
      status.textContent = assignmentStatusText(item);
      head.append(title, status);

      const meta = document.createElement('p');
      meta.className = 'note';
      meta.textContent = `${assignmentKindLabel(item)} · ${assignmentWhen(item)}`;
      card.append(head, meta);

      const conflict = conflictHint(item);
      if (conflict) {
        const conflictText = document.createElement('p');
        conflictText.className = 'detail-hint';
        conflictText.textContent = conflict;
        card.append(conflictText);
      }
      if (item.requiresReconfirm) {
        const changed = document.createElement('p');
        changed.className = 'detail-hint';
        changed.textContent = '事件时间已变更，旧确认不再占用节次；请核对后重新确认。';
        card.append(changed);
      }
      if (item.expired) {
        const expired = document.createElement('p');
        expired.className = 'note';
        expired.textContent = '该日期已结束，只读保留记录。';
        card.append(expired);
      }

      const actions = document.createElement('div');
      actions.className = 'actions compact';
      if (item.status === 'pending') {
        actions.append(
          assignmentButton('接受', actionAria(item, '接受'), () => { void respondAssignmentAction(item, 'accept'); }, 'small'),
          assignmentButton('拒绝', actionAria(item, '拒绝'), () => { void respondAssignmentAction(item, 'reject'); }),
        );
      } else if (item.status === 'accepted' && item.requiresReconfirm) {
        actions.append(
          assignmentButton('重新确认', actionAria(item, '重新确认'), () => { void respondAssignmentAction(item, 'accept'); }, 'small'),
          assignmentButton('撤回', actionAria(item, '撤回'), () => { void respondAssignmentAction(item, 'withdraw'); }),
        );
      } else if (item.status === 'accepted' && !item.expired) {
        actions.append(
          assignmentButton('撤回', actionAria(item, '撤回'), () => { void respondAssignmentAction(item, 'withdraw'); }),
        );
      }
      if (actions.childElementCount > 0) card.append(actions);
      el.assignmentList.append(card);
    }
  }

  function actionAria(item, verb) {
    return `${verb}${assignmentKindLabel(item)}：${item.event?.title ?? assignmentWhen(item)}`;
  }

  function assignmentButton(label, aria, onClick, cls = 'ghost') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.textContent = label;
    button.setAttribute('aria-label', aria);
    button.disabled = busy;
    button.addEventListener('click', onClick);
    return button;
  }

  function rowHint(item) {
    const externalBusy = item.eventBusy === true || item.requestBusy === true;
    if (externalBusy && item.status === 'class_occupied') return '与已接受占用冲突';
    if (externalBusy && item.status === 'busy') {
      return item.eventBusy ? '已被已接受事件占用' : '已被负责人安排占用';
    }
    if (externalBusy && item.status === 'conflict') return '占用与课程冲突';
    if (item.requestAvailable === true && item.status === 'available') return '来自负责人确认';
    if (item.status === 'conflict') return conflictLabel(item.conflict?.type);
    return '';
  }

  // 每个节次只给一个“下一步”按钮；A 类在同一个日期例外里原子写入停课与有空。
  function periodAction(item, day) {
    const externalBusy = item.eventBusy === true || item.requestBusy === true;
    if (externalBusy && item.status === 'busy') {
      return {
        label: '安排',
        focusAssignments: true,
        aria: `查看 ${day.date} 第 ${item.period} 节已接受的事件或负责人安排`,
      };
    }
    if (item.requestAvailable === true && item.status === 'available') {
      return {
        label: '安排',
        focusAssignments: true,
        aria: `查看 ${day.date} 第 ${item.period} 节的负责人安排`,
      };
    }
    if (!consentAccepted || item.editable !== true) return null;
    if (item.status === 'class_occupied') {
      return {
        label: '有空',
        aria: `将 ${day.date} 第 ${item.period} 节改为有空`,
        write: { action: 'save', cancelClass: true, personalState: 'available' },
      };
    }
    if (item.status === 'available') {
      return {
        label: item.cancelled ? '有课' : '恢复',
        aria: item.cancelled
          ? `恢复 ${day.date} 第 ${item.period} 节的课程占用`
          : `清除 ${day.date} 第 ${item.period} 节的个人声明`,
        write: { action: 'reset', cancelClass: false, personalState: 'none' },
      };
    }
    if (item.status === 'busy') {
      return {
        label: item.cancelled ? '有课' : '有空',
        aria: item.cancelled
          ? `恢复 ${day.date} 第 ${item.period} 节的课程占用`
          : `清除 ${day.date} 第 ${item.period} 节的忙碌声明，回到无课默认`,
        write: { action: 'reset', cancelClass: false, personalState: 'none' },
      };
    }
    if (item.status === 'no_class') {
      return item.cancelled
        ? {
          label: '有课',
          aria: `恢复 ${day.date} 第 ${item.period} 节的课程占用`,
          write: { action: 'reset', cancelClass: false, personalState: 'none' },
        }
        : {
          label: '忙碌',
          aria: `声明 ${day.date} 第 ${item.period} 节忙碌`,
          write: { action: 'save', cancelClass: false, personalState: 'busy' },
        };
    }
    if (item.status === 'conflict') {
      return {
        label: '恢复',
        aria: `清除 ${day.date} 第 ${item.period} 节的冲突记录并恢复当前课表`,
        write: { action: 'reset', cancelClass: false, personalState: 'none' },
      };
    }
    return null;
  }

  function renderDetail() {
    if (!data) return;
    const day = (data.days ?? []).find((entry) => entry.date === selectedDate);
    if (!day) {
      resetDetailPlaceholder();
      return;
    }
    const weekday = WEEKDAY_LABELS[(weekdayMon1(day.date) ?? 1) - 1];
    const weekText = day.inTerm && day.weekNumber !== null
      ? `第 ${day.weekNumber} 教学周`
      : (day.inTerm ? '教学周外' : '学期外');
    el.detailTitle.textContent = `${day.date} · ${weekday} · ${weekText}`;
    el.detailBody.replaceChildren();

    const list = document.createElement('div');
    list.className = 'detail-periods';
    for (const periodMeta of config.periods) {
      const item = day.periods.find((entry) => entry.period === periodMeta.index);
      if (!item) continue;
      const row = document.createElement('div');
      row.className = 'detail-period';
      row.dataset.date = day.date;
      row.dataset.period = String(item.period);
      row.dataset.status = item.status;

      const slot = document.createElement('span');
      slot.className = 'detail-slot';
      const slotTitle = document.createElement('strong');
      slotTitle.textContent = `第 ${item.period} 节`;
      const slotTime = document.createElement('small');
      slotTime.textContent = periodTime(item.period);
      slot.append(slotTitle, slotTime);

      const main = document.createElement('div');
      main.className = 'detail-main';
      if (data.state === 'ready') {
        const state = document.createElement('span');
        state.className = `detail-state kind-${statusKind(item)}`;
        const dot = document.createElement('span');
        dot.className = 'detail-dot';
        dot.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'detail-state-text';
        text.textContent = item.status === 'class_occupied'
          ? (item.courseName || '有课')
          : statusText(item);
        state.append(dot, text);
        main.append(state);
      }
      const hint = rowHint(item);
      if (hint) {
        const hintText = document.createElement('p');
        hintText.className = 'detail-hint';
        hintText.textContent = hint;
        main.append(hintText);
      }

      row.append(slot, main);
      const action = data.preview === 'draft' ? null : periodAction(item, day);
      if (action) {
        const adjust = document.createElement('button');
        adjust.type = 'button';
        adjust.className = 'detail-action small ghost';
        adjust.textContent = action.label;
        adjust.setAttribute('aria-label', action.aria);
        adjust.dataset.action = action.focusAssignments
          ? 'assignments'
          : action.focusEvents ? 'events' : action.write.action;
        adjust.disabled = busy || switching;
        adjust.addEventListener('click', () => {
          if (action.focusAssignments) {
            el.assignments.scrollIntoView({
              block: 'nearest',
              behavior: reduceMotion ? 'auto' : 'smooth',
            });
            el.assignmentList.querySelector('button')?.focus();
            return;
          }
          if (action.focusEvents) {
            el.detailBody.querySelector('.detail-events')?.scrollIntoView({
              block: 'nearest',
              behavior: reduceMotion ? 'auto' : 'smooth',
            });
            return;
          }
          void runPeriodAction(item, day, action.write);
        });
        row.append(adjust);
      }
      list.append(row);
    }
    el.detailBody.append(list);

    const dayEvents = eventsOnDate(day.date);
    if (dayEvents.length > 0) {
      const eventList = document.createElement('div');
      eventList.className = 'detail-events';
      const heading = document.createElement('h4');
      heading.textContent = '当天事件';
      eventList.append(heading);
      for (const event of dayEvents) {
        const card = document.createElement('div');
        card.className = 'event-card';
        const title = document.createElement('strong');
        title.textContent = event.title;
        const meta = document.createElement('p');
        meta.className = 'note';
        const visibility = event.visibility === 'space'
          ? '全空间'
          : event.visibility === 'invitees' ? '受邀成员' : '仅自己';
        meta.textContent = `${eventTimeLabel(event)} · ${eventSpanLabel(event, day.date)} · ${visibility}`;
        card.append(title, meta);
        if (event.description) {
          const text = document.createElement('p');
          text.className = 'note';
          text.textContent = event.description;
          card.append(text);
        }
        eventList.append(card);
      }
      el.detailBody.append(eventList);
    }

    let noteText = '';
    if (!day.inTerm) noteText = '学期外日期只读。';
    else if (data.state !== 'ready') noteText = '尚未提交周课表；提交后显示课次并可调整日期。';
    else if (!consentAccepted) noteText = '需先确认日历告知。';
    else if (!day.periods.some((entry) => entry.editable === true)) noteText = '该日已无可调整节次。';
    if (noteText) {
      const note = document.createElement('p');
      note.className = 'note detail-note';
      note.textContent = noteText;
      el.detailBody.append(note);
    }
  }

  function renderAll() {
    el.loading.hidden = true;
    el.error.hidden = true;
    el.skeleton.hidden = true;
    renderCalendar();
    renderAssignments();
    renderDetail();
  }

  function buildSkeleton() {
    if (!el.skeletonGrid || el.skeletonGrid.childElementCount > 0) return;
    for (let row = 0; row < 5; row += 1) {
      const line = document.createElement('div');
      line.className = 'calendar-skeleton-row';
      for (let cell = 0; cell < 7; cell += 1) {
        const block = document.createElement('span');
        block.className = 'calendar-skeleton-cell';
        line.append(block);
      }
      el.skeletonGrid.append(line);
    }
  }

  function monthIndex(value) {
    const [year, monthNumber] = String(value ?? '').split('-').map(Number);
    return Number.isFinite(year) && Number.isFinite(monthNumber) ? year * 12 + monthNumber : null;
  }

  function monthDirection(target) {
    const from = monthIndex(month);
    const to = monthIndex(target);
    if (from === null || to === null || from === to) return null;
    return to > from ? 'next' : 'prev';
  }

  function showSkeleton(target, direction) {
    el.loading.hidden = true;
    el.error.hidden = true;
    el.empty.hidden = true;
    el.table.hidden = true;
    el.table.classList.remove('slide-next', 'slide-prev');
    el.month.textContent = monthLabel(target);
    el.skeleton.hidden = false;
    el.skeleton.classList.remove('skeleton-next', 'skeleton-prev');
    if (!reduceMotion && direction) {
      el.skeleton.classList.add(`skeleton-${direction}`);
    }
    el.status.textContent = '正在读取目标月份…';
  }

  function setSwitchStatus(text, isError = false) {
    if (!el.switchStatus) return;
    el.switchStatus.textContent = text;
    el.switchStatus.classList.toggle('is-error', isError);
    el.switchStatus.hidden = !text;
  }

  function cancelActiveRequest() {
    if (!activeRequest) return;
    activeRequest.controller.abort();
    activeRequest = null;
  }

  const CACHE_LIMIT = 18;
  const CACHE_FRESH_MS = 45_000;

  function cacheKey(value) {
    return `${spaceId}:${value}`;
  }

  function readCacheEntry(value) {
    const key = cacheKey(value);
    const hit = monthCache.get(key);
    if (!hit || hit.revision !== shared.dataRevision()) return null;
    monthCache.delete(key);
    monthCache.set(key, hit);
    return hit;
  }

  function readCache(value) {
    return readCacheEntry(value)?.body ?? null;
  }

  function writeCache(value, body, revision) {
    monthCache.set(cacheKey(value), { body, revision, at: Date.now() });
    while (monthCache.size > CACHE_LIMIT) {
      const oldest = monthCache.keys().next().value;
      monthCache.delete(oldest);
    }
  }

  function pausePrefetch() {
    prefetchQueue = [];
    if (prefetchController) {
      prefetchController.abort();
      prefetchController = null;
    }
  }

  function abortPreload(exceptTarget = null) {
    if (!preloadRequest || preloadRequest.target === exceptTarget) return;
    preloadRequest.controller.abort();
    preloadRequest = null;
  }

  // 手势目标确定后先取数、不渲染：吸附动画与网络并行，内容仍只在该月数据到达后替换。
  function preloadMonth(target) {
    if (previewMode) return;
    if (!teaching || !validMonth(target)) return;
    if (readCache(target) || activeRequest?.target === target) return;
    if (preloadRequest?.target === target) return;
    abortPreload(target);
    const id = spaceId;
    const revision = shared.dataRevision();
    const epoch = cacheEpoch;
    const controller = new AbortController();
    const entry = { target, controller, promise: null };
    entry.promise = (async () => {
      try {
        const body = await shared.api(`/api/spaces/${id}/calendar?month=${encodeURIComponent(target)}`, {
          signal: controller.signal,
        });
        if (epoch !== cacheEpoch || spaceId !== id || shared.currentSpaceId() !== id
          || shared.dataRevision() !== revision || controller.signal.aborted) return null;
        writeCache(target, body, revision);
        return body;
      } catch {
        return null;
      } finally {
        if (preloadRequest === entry) preloadRequest = null;
      }
    })();
    preloadRequest = entry;
  }

  // 只对仍在目标月附近的响应落到邻页；旧手势的迟到响应不能改动当前画面。
  function nearDisplayedMonth(value) {
    return value === shiftMonth(month, -1) || value === shiftMonth(month, 1);
  }

  // 当前页缓存命中后，超过新鲜期再静默核对一次；成功才替换，失败保留现有内容。
  async function revalidateMonth(target, { preferDate = null, revision }) {
    if (previewMode) return;
    const key = cacheKey(target);
    if (revalidating.has(key)) return;
    const id = spaceId;
    const epoch = cacheEpoch;
    const controller = new AbortController();
    revalidating.set(key, controller);
    try {
      const body = await shared.api(`/api/spaces/${id}/calendar?month=${encodeURIComponent(target)}`, {
        signal: controller.signal,
      });
      if (epoch !== cacheEpoch || spaceId !== id || shared.currentSpaceId() !== id
        || shared.dataRevision() !== revision) return;
      writeCache(target, body, revision);
      if (month === target && !switching && !busy && !swipe?.isBusy()
        && JSON.stringify(body) !== JSON.stringify(data)) {
        applyMonthBody(body, { preferDate: preferDate ?? selectedDate, silent: true, neighbors: false });
      }
    } catch {
      // 静默核对失败不覆盖已显示内容；下次进入或切月再试。
    } finally {
      if (revalidating.get(key) === controller) revalidating.delete(key);
    }
  }

  function applyMonthBody(body, { preferDate = null, direction = null, silent = false, neighbors = true } = {}) {
    data = body;
    month = body.month;
    targetMonth = body.month;
    retryTarget = null;
    previewMode = body.preview === 'draft';
    previewOffer = Boolean(body.draft?.exists && (body.draft.changed || !body.submitted));
    consentAccepted = body.consent?.accepted === true;
    const days = body.days ?? [];
    const kept = preferDate && days.some((day) => day.date === preferDate) ? preferDate : null;
    selectedDate = kept ?? defaultSelection(body);
    el.skeleton.hidden = true;
    el.error.hidden = true;
    el.table.removeAttribute('aria-busy');
    setSwitchStatus('');
    renderAll();
    el.table.classList.remove('slide-next', 'slide-prev');
    if (!silent && !reduceMotion && direction) {
      void el.table.offsetWidth;
      el.table.classList.add(direction === 'next' ? 'slide-next' : 'slide-prev');
      window.setTimeout(() => el.table.classList.remove('slide-next', 'slide-prev'), 520);
    }
    el.status.textContent = '';
    if (neighbors) {
      renderNeighborPages();
      swipe?.center();
    }
    if (!previewMode) schedulePrefetch();
  }

  function buildPrefetchQueue() {
    if (previewMode) return;
    if (!teaching || !month) return;
    if (switching || busy || swipe?.isDragging() || swipe?.isBusy()) return;
    const wanted = [];
    for (const distance of [1, 2]) {
      for (const dir of [-1, 1]) {
        const target = shiftMonth(month, dir * distance);
        if (!validMonth(target) || wanted.includes(target)) continue;
        if (readCache(target)) continue;
        wanted.push(target);
      }
    }
    prefetchQueue = wanted;
    void runPrefetchQueue();
  }

  // 预取串行执行：先 ±1，空闲后再 ±2；与当前读取争用时由 pausePrefetch 直接让路。
  async function runPrefetchQueue() {
    if (prefetchRunning || !teaching || !month) return;
    if (switching || busy || swipe?.isDragging() || swipe?.isBusy()) return;
    const target = prefetchQueue.shift();
    if (!target) return;
    if (readCache(target)) {
      void runPrefetchQueue();
      return;
    }
    const id = spaceId;
    const revision = shared.dataRevision();
    const epoch = cacheEpoch;
    const controller = new AbortController();
    prefetchRunning = true;
    prefetchController = controller;
    try {
      const body = await shared.api(`/api/spaces/${id}/calendar?month=${encodeURIComponent(target)}`, {
        signal: controller.signal,
      });
      if (epoch !== cacheEpoch || spaceId !== id || shared.currentSpaceId() !== id
        || shared.dataRevision() !== revision) return;
      writeCache(target, body, revision);
      if (!swipe?.isDragging() && !swipe?.isBusy() && nearDisplayedMonth(target)) {
        renderNeighborPages();
      }
    } catch {
      // 预取失败保持静默；当前目标月读取仍会给出真实错误。
    } finally {
      if (prefetchController === controller) prefetchController = null;
      prefetchRunning = false;
      if (prefetchQueue.length && !switching && !busy) schedulePrefetch(160);
    }
  }

  function schedulePrefetch(timeout = 600) {
    if (prefetchTimer) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(prefetchTimer);
      else window.clearTimeout(prefetchTimer);
    }
    const run = () => {
      prefetchTimer = 0;
      buildPrefetchQueue();
    };
    prefetchTimer = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(run, { timeout })
      : window.setTimeout(run, Math.min(timeout, 200));
  }

  // 连续点击只更新 targetMonth；同一目标合并请求，旧响应晚到也不能覆盖最新目标。
  // 返回值只表示“目标月已成为当前有效月”，供轨道手势决定吸附还是回弹。
  async function loadMonth(target, {
    check = token, preferDate = null, direction = null, silent = false, force = false, neighbors = true,
    preview = false,
  } = {}) {
    if (!teaching || !validMonth(target)) return false;
    if (activeRequest && activeRequest.target === target && !force && !preview) {
      targetMonth = target;
      return activeRequest.outcome;
    }
    targetMonth = target;
    const request = ++monthToken;
    const slide = direction ?? monthDirection(target);
    if (!force && !preview) {
      const cached = readCacheEntry(target);
      if (cached) {
        applyMonthBody(cached.body, { preferDate, direction: slide, silent, neighbors });
        // 有界新鲜度：命中即显示，超过 45 秒再静默核对，不回到骨架/加载态。
        if (Date.now() - cached.at > CACHE_FRESH_MS) {
          void revalidateMonth(target, { preferDate, revision: shared.dataRevision() });
        }
        return true;
      }
    }
    abortPreload(target);
    let preloadEntry = null;
    if (!force && !preview && preloadRequest?.target === target) {
      preloadEntry = preloadRequest;
    } else if (!force && !preview) {
      // 预读可能刚在缓存检查与这里之间完成，再读一次避免重复请求。
      const late = readCacheEntry(target);
      if (late) {
        applyMonthBody(late.body, { preferDate, direction: slide, silent, neighbors });
        if (Date.now() - late.at > CACHE_FRESH_MS) {
          void revalidateMonth(target, { preferDate, revision: shared.dataRevision() });
        }
        return true;
      }
    }
    const hasData = Boolean(data && month);
    if (!hasData) {
      showSkeleton(target, slide);
    } else {
      el.table.setAttribute('aria-busy', 'true');
      setSwitchStatus(`正在切换至 ${monthLabel(target)}…`);
    }
    pausePrefetch();
    cancelActiveRequest();
    const revision = shared.dataRevision();
    const controller = new AbortController();
    const entry = { target, controller, revision, promise: null, outcome: null };
    const fetchMonth = () => shared.api(`/api/spaces/${spaceId}/calendar?month=${encodeURIComponent(target)}`
      + (preview ? '&preview=draft' : ''), {
      signal: controller.signal,
    });
    // 手势预读与吸附动画并行；预读失败或已被替换时退回普通请求。
    entry.promise = preloadEntry
      ? preloadEntry.promise.then((body) => body ?? fetchMonth())
      : fetchMonth();
    activeRequest = entry;
    entry.outcome = (async () => {
      try {
        const body = await entry.promise;
        if (activeRequest === entry) activeRequest = null;
        if (!current(check, spaceId) || request !== monthToken || targetMonth !== target) return false;
        if (!preview) writeCache(target, body, revision);
        applyMonthBody(body, { preferDate, direction: slide, silent, neighbors });
        if (loadedRevision === -1 || revision === shared.dataRevision()) loadedRevision = revision;
        return true;
      } catch (error) {
        if (activeRequest === entry) activeRequest = null;
        if (controller.signal.aborted) return false;
        if (!current(check, spaceId) || request !== monthToken || targetMonth !== target) return false;
        el.skeleton.hidden = true;
        el.table.removeAttribute('aria-busy');
        if (error instanceof shared.ApiError && error.status === 401) {
          shared.onUnauthorized();
          return false;
        }
        if (hasData) {
          retryTarget = target;
          targetMonth = month;
          setSwitchStatus(`切换至 ${monthLabel(target)} 失败：${error.message}；仍显示 ${monthLabel(month)}。`, true);
          el.errorText.textContent = `月历读取失败：${error.message}`;
          el.error.hidden = false;
          return false;
        }
        renderFailure(`月历读取失败：${error.message}`);
        return false;
      }
    })();
    return entry.outcome;
  }

  async function reload() {
    if (!teaching) return;
    const target = targetMonth ?? month;
    if (target) await loadMonth(target, { preferDate: selectedDate, preview: previewMode });
  }

  function setRowBusy(on) {
    for (const button of el.detailBody.querySelectorAll('.detail-action')) {
      button.disabled = on;
    }
  }

  async function runPeriodAction(item, day, write) {
    if (busy || switching || !data) return;
    if (data.preview === 'draft') {
      el.status.textContent = '草稿预览仅供查看；提交课表后才能调整日期。';
      return;
    }
    const baseVersion = item.exceptionVersion ?? 0;
    const key = JSON.stringify({
      date: day.date, period: item.period, baseVersion, ...write,
    });
    let requestId = newRequestId();
    if (pendingWrite && pendingWrite.key === key) requestId = pendingWrite.requestId;
    pendingWrite = { key, requestId };

    busy = true;
    shared.setBusy(true);
    el.status.textContent = '正在保存本次状态…';
    setRowBusy(true);
    try {
      const body = await shared.api(`/api/spaces/${spaceId}/exceptions`, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          baseVersion,
          action: write.action,
          date: day.date,
          period: item.period,
          cancelClass: write.cancelClass === true,
          personalState: write.personalState,
          acknowledgeCourseChange: false,
          noticeAccepted: true,
          noticeVersion: data?.consent?.version,
        }),
      });
      if (shared.currentSpaceId() !== spaceId) return;
      pendingWrite = null;
      el.status.textContent = body.replayed
        ? '已确认上次调整，未重复写入。'
        : '已更新本次状态。';
      await loadMonth(month, { preferDate: day.date });
    } catch (error) {
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      const code = error instanceof shared.ApiError ? error.code : 'request_failed';
      if (code === 'version_conflict') {
        pendingWrite = null;
        el.status.textContent = '该次记录已在其他页面更新；已重新读取，请核对后再操作。';
        await loadMonth(month, { preferDate: day.date });
        return;
      }
      if (code === 'calendar_notice_required') {
        pendingWrite = null;
        consentAccepted = false;
        renderDetail();
        el.status.textContent = '请先在“我的空间”的“隐私设置”确认日历告知后再调整。';
        return;
      }
      if (code === 'date_not_editable' || code === 'date_out_of_term' || code === 'schedule_not_published') {
        pendingWrite = null;
        el.status.textContent = error.message;
        await loadMonth(month, { preferDate: day.date });
        return;
      }
      if (!(error instanceof shared.ApiError) || error.status === 0 || error.status >= 500) {
        el.status.textContent = '保存结果未确认；可重试，同一操作不会重复写入。';
        return;
      }
      pendingWrite = null;
      el.status.textContent = error.message;
      await loadMonth(month, { preferDate: day.date });
    } finally {
      busy = false;
      shared.setBusy(false);
      setRowBusy(false);
      flushPendingNav();
    }
  }

  async function activate(id) {
    const revision = shared.dataRevision();
    if (spaceId === id && data && loadedRevision === revision) {
      el.loading.hidden = true;
      el.error.hidden = true;
      renderNeighborPages();
      swipe?.center();
      const cached = month ? readCacheEntry(month) : null;
      if (cached && Date.now() - cached.at > CACHE_FRESH_MS) {
        void revalidateMonth(month, { preferDate: selectedDate, revision });
      }
      return;
    }
    const same = spaceId === id && Boolean(data);
    const check = ++token;
    spaceId = id;
    busy = false;
    if (!same) {
      resetUi();
      el.loading.hidden = false;
    } else {
      el.loading.hidden = true;
      el.error.hidden = true;
      setSwitchStatus(`正在刷新 ${monthLabel(month)}…`);
    }
    try {
      const info = await shared.api(`/api/spaces/${id}/home`);
      if (!current(check, id)) return;
      home = info;
      if (info.kind !== 's1') {
        if (!same) renderUnavailable('legacy');
        return;
      }
      if (!info.config) {
        if (!same) renderUnavailable('invalid');
        return;
      }
      config = info.config;
      teaching = info.teaching;
      if (!teaching) {
        if (!same) renderTeachingMissing(info.teachingState);
        return;
      }
      el.loading.hidden = true;
      const target = same && month ? month : initialMonth();
      targetMonth = target;
      await loadMonth(target, { check, preferDate: selectedDate, silent: same });
      loadedRevision = revision;
    } catch (error) {
      if (!current(check, id)) return;
      if (error instanceof shared.ApiError && error.status === 401) {
        shared.onUnauthorized();
        return;
      }
      if (same) {
        setSwitchStatus(`刷新失败：${error.message}；当前内容保留。`, true);
        return;
      }
      renderFailure(`空间配置读取失败：${error.message}`);
    }
  }

  function deactivate() {
    token += 1;
    monthToken += 1;
    cancelActiveRequest();
    if (prefetchTimer) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(prefetchTimer);
      else window.clearTimeout(prefetchTimer);
      prefetchTimer = 0;
    }
    cacheEpoch += 1;
    pausePrefetch();
    for (const controller of revalidating.values()) controller.abort();
    revalidating.clear();
    monthCache.clear();
    loadedRevision = -1;
    spaceId = null;
    busy = false;
    switching = false;
    targetMonth = null;
    resetUi();
    swipe?.reset();
  }

  buildLegend();
  buildSkeleton();
  resetDetailPlaceholder();

  swipe = bindMonthSwipe({
    viewport: el.viewport,
    track: el.track,
    canStart: () => Boolean(data && month && teaching && !busy && !switching && !pendingWrite && !assignmentWrite),
    onStart: () => pausePrefetch(),
    onTarget: (delta) => {
      const target = shiftMonth(month, delta);
      if (target) preloadMonth(target);
    },
    onCommit: (delta) => commitSwipe(delta),
    onSettled: () => {
      el.table.removeAttribute('aria-busy');
      renderNeighborPages();
      swipe?.center();
      schedulePrefetch(300);
    },
    onCancel: () => {
      el.table.removeAttribute('aria-busy');
      renderNeighborPages();
      schedulePrefetch(300);
    },
  });

  function applyNavIntent(intent) {
    if (!intent) return;
    if (intent.kind === 'today') {
      const target = intent.date.slice(0, 7);
      if (target === month && data) {
        selectDate(intent.date);
        return;
      }
      void loadMonth(target, { preferDate: intent.date, preview: previewMode });
      return;
    }
    const target = shiftMonth(targetMonth ?? month, intent.delta);
    if (target) void loadMonth(target, { preview: previewMode });
  }

  // 写入后的刷新会把 busy 保持到重新读取完成；此间点击仍记下最后一次意图。
  function navigationIntent(intent) {
    if (busy) {
      if (intent.kind === 'delta' && pendingNav?.kind === 'delta') {
        pendingNav = { kind: 'delta', delta: pendingNav.delta + intent.delta };
      } else {
        pendingNav = intent;
      }
      return;
    }
    applyNavIntent(intent);
  }

  function flushPendingNav() {
    if (!pendingNav || busy || switching) return;
    const intent = pendingNav;
    pendingNav = null;
    applyNavIntent(intent);
  }

  el.prev.addEventListener('click', () => {
    if (switching) return;
    navigationIntent({ kind: 'delta', delta: -1 });
  });
  el.next.addEventListener('click', () => {
    if (switching) return;
    navigationIntent({ kind: 'delta', delta: 1 });
  });
  el.today.addEventListener('click', () => {
    if (!teaching || switching) return;
    const today = todayInZone(teaching.timezone);
    if (!today) {
      el.status.textContent = '暂时无法确定今天，请稍后重试。';
      return;
    }
    navigationIntent({ kind: 'today', date: today });
  });
  el.retry.addEventListener('click', () => {
    if (switching) return;
    const target = retryTarget ?? targetMonth ?? month;
    if (target) void loadMonth(target, { preferDate: selectedDate, force: true, preview: previewMode });
  });

  async function togglePreview() {
    if (switching || busy || !data || !teaching) return;
    const target = month ?? targetMonth;
    if (!target) return;
    const next = data.preview !== 'draft';
    switching = true;
    refreshMonthControls();
    el.table.setAttribute('aria-busy', 'true');
    setSwitchStatus(next ? '正在读取草稿…' : '正在读取已提交版本…');
    let ok = false;
    try {
      ok = await loadMonth(target, { preferDate: selectedDate, force: next, preview: next });
    } finally {
      switching = false;
      refreshMonthControls();
      el.table.removeAttribute('aria-busy');
    }
    if (!ok) {
      setSwitchStatus(next ? '草稿读取失败，仍显示已提交版本。' : '读取失败，仍显示草稿预览。', true);
    } else {
      setSwitchStatus('');
    }
  }

  el.preview?.addEventListener('click', () => { void togglePreview(); });
  return { activate, deactivate, reload };
}

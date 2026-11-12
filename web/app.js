// 应用外壳：账号、路由、空间列表、创建/加入、空间首页、收集、设置与旧版页面。
// 周课表与月历分别由独立模块挂载；路由切换先处理离页保护，再按当前页面按需读取数据。
import { PAGE_LABELS, collectVisible, parentRoute, parseRoute, resolveLoginTarget, routePath } from './routes.mjs';
import {
  LEGEND, WEEKDAY_LABELS, addDays, mondayOf, monthLabel, monthTermSummary, monthWeeks, shiftMonth,
  teachingWeekCount, teachingWeekNumber, timezoneLabel, timezoneOptions, todayInZone, validMonth, validateTeachingInput, weekdayMon1,
} from './calendar-model.mjs';
import { bindMonthSwipe } from './month-swipe.mjs';
import { createSchedulePage } from './schedule-page.mjs';
import { createCalendarPage } from './calendar-page.mjs';
import { createDateField, createDatePicker, createTimezoneField } from './pickers.mjs';

const API = '/functions/v1/app';
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 256;

const passwordChars = (value) => [...value].length;
const passwordBytes = (value) => new TextEncoder().encode(value).length;

const MESSAGES = {
  invalid_username: '账号格式不正确：请使用 3–32 位小写字母、数字、下划线或连字符，并以字母或数字开头。',
  invalid_password: '密码不符合要求：至少 8 个字符，且不超过 256 字节。',
  invalid_credentials: '账号或密码不正确。',
  invalid_input: '请求内容不合法，请检查填写内容。',
  notice_required: '请先阅读并确认加入告知。',
  username_taken: '该账号已被注册，请换一个账号。',
  rate_limited: '尝试次数过多，请稍后再试。',
  login_required: '登录状态已失效，请重新登录。',
  origin_forbidden: '请求来源校验未通过。',
  forbidden: '你没有访问该空间的权限。',
  not_found: '请求的页面或接口不存在。',
  invite_unavailable: '邀请码无效、已撤销或已过期。',
  invite_full: '该邀请码的可用名额已满。',
  invite_exists: '该空间已存在邀请码；如需更换请使用轮换。',
  invite_not_found: '该空间尚未生成邀请码。',
  invite_conflict: '邀请码状态已变化，请重新读取后再试。',
  invite_slots_unconfirmed: '邀请名额初始化未确认，请重新读取邀请信息后再试。',
  join_unconfirmed: '加入结果未确认，请重新读取空间列表后再试。',
  space_unconfirmed: '空间创建结果未确认，请重新读取空间列表后再试。',
  registration_unconfirmed: '注册结果未确认，请重新登录后再试。',
  logout_unconfirmed: '退出未确认，请重新读取会话后再试。',
  version_conflict: '版本冲突：记录已被其他请求更新。',
  request_reuse_conflict: '同一请求标识已用于不同内容，本次未写入。',
  invalid_request_id: '请求标识不合法，请重新操作。',
  invalid_period: '节次不在本空间配置中，请重新读取空间配置。',
  invalid_date: '日期不合法，请重新选择。',
  invalid_month: '月份不合法，请重新选择。',
  invalid_personal_state: '个人声明不合法。',
  invalid_week_rule: '周次规则不合法，请重新读取空间配置。',
  duplicate_cell: '同一日同一节次不能重复填写。',
  week_rule_mismatch: '本空间统一周次规则已变化，请重新读取后再填写。',
  space_week_rule_unresolved: '本空间仍有旧版单双周数据，周次规则尚未统一；当前只读，请联系负责人处理。',
  invalid_course_name: '课程名不能为空，最多 100 个字符。',
  space_config_invalid: '空间配置无效，暂时不能填报课表。',
  space_kind_mismatch: '该接口不适用于此空间类型。',
  legacy_capability_unavailable: '旧版填报不适用于该空间。',
  method_not_allowed: '请求方法不受支持。',
  payload_too_large: '请求内容过大。',
  database_unavailable: '数据服务暂时不可用。',
  service_unavailable: '服务暂时不可用。',
  network_error: '网络请求未完成，请检查连接后重试。',
  invalid_response: '服务返回了非预期响应。',
  request_failed: '请求失败。',
  invalid_teaching: '教学周设置不完整。',
  invalid_teaching_timezone: '教学时区不受支持。',
  invalid_teaching_anchor: '第一教学周周一不是真实日期。',
  invalid_teaching_range: '学期开始或结束不是真实日期。',
  teaching_anchor_not_monday: '第一教学周的起点必须是周一。',
  teaching_start_before_anchor: '学期开始不能早于第一教学周周一。',
  teaching_start_outside_first_week: '学期开始须在第一教学周（周一至周日）内。',
  teaching_end_before_start: '学期结束不能早于学期开始。',
  teaching_term_too_long: '学期范围过长，当前上限为 366 天。',
  teaching_required: '该空间尚未设置教学周。',
  teaching_already_set: '教学周已经设置，不能再次修改。',
  date_not_editable: '只能调整该空间时区下未来日期的课次。',
  date_out_of_term: '该日期不在学期范围内。',
  schedule_not_published: '尚未提交有效课表，不能调整日期例外。',
  calendar_notice_required: '请先阅读并确认日历告知。',
  consent_unconfirmed: '告知确认未写入，请重试。',
  cancel_requires_class: '该次课表已无课，不能取消占用。',
  cancel_required_for_statement: '该次仍有课，请先明确取消本次占用再声明忙/有空。',
  cancel_clear_requires_reset: '该记录包含停课或旧冲突，请使用“恢复默认”。',
  course_change_confirmation_required: '课程已更换，需明确确认后才能按当前课程停课。',
  share_notice_required: '请先阅读并确认日期状态共享范围。',
  invalid_event_title: '事件标题不能为空，且最多 100 个字符。',
  invalid_event_description: '事件说明过长，最多 500 个字符。',
  invalid_event_date: '事件日期不合法，请重新选择。',
  invalid_event_time: '事件时间不合法：请填写 HH:MM，且结束时间晚于开始时间。',
  invalid_event_visibility: '事件可见性不合法。',
  invalid_event_id: '事件标识不合法，请刷新后重试。',
  event_end_before_start: '事件结束日期不能早于开始日期。',
  event_range_too_long: '事件范围最长 31 天。',
  event_not_found: '事件不存在或已删除。',
  event_conflict: '事件已被更新，请重新读取后再操作。',
  event_reuse_conflict: '事件标识已被使用，请刷新后重试。',
  invalid_version: '记录版本不合法，请刷新后重试。',
  collection_too_large: '日期数据过多，暂时无法生成收集日历。',
  invalid_export_date: '导出日期不合法。',
  invalid_export_week: '导出周必须从周一开始。',
  export_failed: '导出未完成，请稍后重试。',
};

class ApiError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  let response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(MESSAGES.network_error, 'network_error');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', response.status);
  }
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'request_failed';
    throw new ApiError(MESSAGES[code] ?? MESSAGES.request_failed, code, response.status);
  }
  const method = String(init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') state.dataRevision += 1;
  return data;
}

const TEMPLATE = [
  ['08:00', '08:45'], ['08:55', '09:40'], ['10:00', '10:45'], ['10:55', '11:40'],
  ['11:50', '12:35'], ['14:00', '14:45'], ['14:55', '15:40'], ['16:00', '16:45'],
  ['16:55', '17:40'], ['19:00', '19:45'], ['19:55', '20:40'], ['20:50', '21:35'],
];
const PERIODS_MAX = 20;

const ui = {
  brandLink: document.getElementById('brand-link'),
  chip: document.getElementById('session-chip'),
  accountWrap: document.getElementById('account-wrap'),
  accountButton: document.getElementById('account-button'),
  accountName: document.getElementById('account-name'),
  accountPanel: document.getElementById('account-panel'),
  logout: document.getElementById('logout'),
  authPanel: document.getElementById('auth-panel'),
  authTabLogin: document.getElementById('auth-tab-login'),
  authTabRegister: document.getElementById('auth-tab-register'),
  loginForm: document.getElementById('login-form'),
  loginUsername: document.getElementById('login-username'),
  loginPassword: document.getElementById('login-password'),
  loginTerms: document.getElementById('login-terms'),
  loginSubmit: document.getElementById('login-submit'),
  registerForm: document.getElementById('register-form'),
  registerUsername: document.getElementById('register-username'),
  registerNickname: document.getElementById('register-nickname'),
  registerPassword: document.getElementById('register-password'),
  registerConfirm: document.getElementById('register-confirm'),
  registerUsernameError: document.getElementById('register-username-error'),
  registerPasswordError: document.getElementById('register-password-error'),
  registerConfirmError: document.getElementById('register-confirm-error'),
  registerNotice: document.getElementById('register-notice'),
  registerSubmit: document.getElementById('register-submit'),
  appPanel: document.getElementById('app-panel'),
  sideSpacesLink: document.getElementById('side-spaces-link'),
  sideSpace: document.getElementById('side-space'),
  sideSpaceName: document.getElementById('side-space-name'),
  sideSpaceRole: document.getElementById('side-space-role'),
  sideSpaceLinks: document.getElementById('side-space-links'),
  mobileHead: document.getElementById('mobile-head'),
  mobileBack: document.getElementById('mobile-back'),
  mobileTitle: document.getElementById('mobile-title'),
  mobileNav: document.getElementById('mobile-nav'),
  flash: document.getElementById('flash'),
  spaceHead: document.getElementById('space-head'),
  spaceTitle: document.getElementById('space-title'),
  spaceRole: document.getElementById('space-role'),
  spaceStatus: document.getElementById('space-status'),
  pages: {
    spaces: document.getElementById('page-spaces'),
    create: document.getElementById('page-create'),
    join: document.getElementById('page-join'),
    home: document.getElementById('page-home'),
    schedule: document.getElementById('page-schedule'),
    calendar: document.getElementById('page-calendar'),
    collect: document.getElementById('page-collect'),
    settings: document.getElementById('page-settings'),
    legacy: document.getElementById('page-legacy'),
    notfound: document.getElementById('page-notfound'),
    error: document.getElementById('page-error'),
  },
  spacesSummary: document.getElementById('spaces-summary'),
  openPrivacy: document.getElementById('open-privacy'),
  consentDialog: document.getElementById('consent-dialog'),
  consentVersion: document.getElementById('consent-version'),
  consentHint: document.getElementById('consent-hint'),
  consentBody: document.getElementById('consent-body'),
  consentMessage: document.getElementById('consent-message'),
  consentNecessary: document.getElementById('consent-necessary'),
  consentContinue: document.getElementById('consent-continue'),
  reload: document.getElementById('reload'),
  openCreate: document.getElementById('open-create'),
  openJoin: document.getElementById('open-join'),
  spacesLoading: document.getElementById('spaces-loading'),
  spacesError: document.getElementById('spaces-error'),
  spacesErrorText: document.getElementById('spaces-error-text'),
  spacesRetry: document.getElementById('spaces-retry'),
  spacesEmpty: document.getElementById('spaces-empty'),
  spaceList: document.getElementById('space-list'),
  createForm: document.getElementById('create-form'),
  createName: document.getElementById('create-name'),
  createOwnerName: document.getElementById('create-owner-name'),
  createTimezone: document.getElementById('create-timezone'),
  createAnchor: document.getElementById('create-anchor'),
  createTermStart: document.getElementById('create-term-start'),
  createTermEnd: document.getElementById('create-term-end'),
  createPreview: document.getElementById('create-teaching-preview'),
  periodsEditor: document.getElementById('periods-editor'),
  addPeriod: document.getElementById('add-period'),
  resetPeriods: document.getElementById('reset-periods'),
  createSubmit: document.getElementById('create-submit'),
  createStatus: document.getElementById('create-status'),
  joinForm: document.getElementById('join-form'),
  joinCode: document.getElementById('join-code'),
  joinName: document.getElementById('join-name'),
  joinNoticeText: document.getElementById('join-notice-text'),
  joinNotice: document.getElementById('join-notice'),
  joinShare: document.getElementById('join-share'),
  joinSubmit: document.getElementById('join-submit'),
  joinStatus: document.getElementById('join-status'),
  homeLoading: document.getElementById('home-loading'),
  homeError: document.getElementById('home-error'),
  homeErrorText: document.getElementById('home-error-text'),
  homeRetry: document.getElementById('home-retry'),
  homeContent: document.getElementById('home-content'),
  homeStatusGrid: document.getElementById('home-status-grid'),
  homeTeachingNote: document.getElementById('home-teaching-note'),
  homeLegacy: document.getElementById('home-legacy'),
  homeLegacyText: document.getElementById('home-legacy-text'),
  homeOpenLegacy: document.getElementById('home-open-legacy'),
  collectDenied: document.getElementById('collect-denied'),
  collectContent: document.getElementById('collect-content'),
  collectLegacy: document.getElementById('collect-legacy'),
  collectOpenLegacy: document.getElementById('collect-open-legacy'),
  collectSummaryText: document.getElementById('collect-summary-text'),
  collectRefresh: document.getElementById('collect-refresh'),
  collectSummary: document.getElementById('collect-summary'),
  collectMembersCard: document.getElementById('collect-members-card'),
  collectMembersLoading: document.getElementById('collect-members-loading'),
  collectMembersError: document.getElementById('collect-members-error'),
  collectMembersErrorText: document.getElementById('collect-members-error-text'),
  collectMembersRetry: document.getElementById('collect-members-retry'),
  collectMembersBody: document.getElementById('collect-members-body'),
  collectMembersStatus: document.getElementById('collect-members-status'),
  collectInviteCard: document.getElementById('collect-invite-card'),
  collectTabs: document.getElementById('collect-tabs'),
  collectTabOverview: document.getElementById('collect-tab-overview'),
  collectTabCalendar: document.getElementById('collect-tab-calendar'),
  collectOverview: document.getElementById('collect-overview'),
  collectCalendar: document.getElementById('collect-calendar'),
  collectPrev: document.getElementById('collect-prev'),
  collectToday: document.getElementById('collect-today'),
  collectMonth: document.getElementById('collect-month'),
  collectNext: document.getElementById('collect-next'),
  collectTerm: document.getElementById('collect-term'),
  collectLegend: document.getElementById('collect-legend'),
  collectCalendarLoading: document.getElementById('collect-calendar-loading'),
  collectCalendarError: document.getElementById('collect-calendar-error'),
  collectCalendarErrorText: document.getElementById('collect-calendar-error-text'),
  collectCalendarRetry: document.getElementById('collect-calendar-retry'),
  collectCalendarEmpty: document.getElementById('collect-calendar-empty'),
  collectCalendarTable: document.getElementById('collect-calendar-table'),
  collectCalendarViewport: document.getElementById('collect-calendar-viewport'),
  collectCalendarTrack: document.getElementById('collect-calendar-track'),
  collectCalendarPagePrev: document.getElementById('collect-calendar-page-prev'),
  collectCalendarPageNext: document.getElementById('collect-calendar-page-next'),
  collectCalendarGrid: document.getElementById('collect-calendar-grid'),
  collectCalendarStatus: document.getElementById('collect-calendar-status'),
  collectDetailTitle: document.getElementById('collect-detail-title'),
  collectDetailSub: document.getElementById('collect-detail-sub'),
  collectFilters: document.getElementById('collect-filters'),
  collectDetailBody: document.getElementById('collect-detail-body'),
  collectEventsPanel: document.getElementById('collect-events-panel'),
  collectEventNew: document.getElementById('collect-event-new'),
  collectEventsEmpty: document.getElementById('collect-events-empty'),
  collectEventsList: document.getElementById('collect-events-list'),
  collectEventsStatus: document.getElementById('collect-events-status'),
  collectExport: document.getElementById('collect-export'),
  collectExportRange: document.getElementById('collect-export-range'),
  inviteMeta: document.getElementById('invite-meta'),
  inviteGenerate: document.getElementById('invite-generate'),
  inviteRotate: document.getElementById('invite-rotate'),
  inviteRevoke: document.getElementById('invite-revoke'),
  inviteCodeBox: document.getElementById('invite-code-box'),
  inviteCode: document.getElementById('invite-code'),
  inviteCopy: document.getElementById('invite-copy'),
  inviteStatus: document.getElementById('invite-status'),
  settingsLoading: document.getElementById('settings-loading'),
  settingsDenied: document.getElementById('settings-denied'),
  settingsError: document.getElementById('settings-error'),
  settingsErrorText: document.getElementById('settings-error-text'),
  settingsRetry: document.getElementById('settings-retry'),
  settingsContent: document.getElementById('settings-content'),
  settingsTeaching: document.getElementById('settings-teaching'),
  settingsTeachingNote: document.getElementById('settings-teaching-note'),
  settingsForm: document.getElementById('settings-form'),
  settingsTimezone: document.getElementById('settings-timezone'),
  settingsAnchor: document.getElementById('settings-anchor'),
  settingsTermStart: document.getElementById('settings-term-start'),
  settingsTermEnd: document.getElementById('settings-term-end'),
  settingsPreview: document.getElementById('settings-preview'),
  settingsSubmit: document.getElementById('settings-submit'),
  settingsStatus: document.getElementById('settings-status'),
  settingsConfig: document.getElementById('settings-config'),
  settingsLockNote: document.getElementById('settings-lock-note'),
  settingsParticipationCheck: document.getElementById('settings-participation-check'),
  settingsParticipationStatus: document.getElementById('settings-participation-status'),
  settingsParticipationChoice: document.getElementById('settings-participation-choice'),
  settingsParticipationKeep: document.getElementById('settings-participation-keep'),
  settingsParticipationEdit: document.getElementById('settings-participation-edit'),
  legacyLoading: document.getElementById('legacy-loading'),
  legacyError: document.getElementById('legacy-error'),
  legacyErrorText: document.getElementById('legacy-error-text'),
  legacyRetry: document.getElementById('legacy-retry'),
  legacyPanel: document.getElementById('legacy-panel'),
  legacyMismatch: document.getElementById('legacy-mismatch'),
  overviewNote: document.getElementById('overview-note'),
  overviewHead: document.getElementById('overview-head'),
  overviewBody: document.getElementById('overview-body'),
  overviewEmpty: document.getElementById('overview-empty'),
  editorNote: document.getElementById('editor-note'),
  versionNote: document.getElementById('version-note'),
  entriesEditor: document.getElementById('entries-editor'),
  submitSchedule: document.getElementById('submit-schedule'),
  editorStatus: document.getElementById('editor-status'),
  routeErrorText: document.getElementById('route-error-text'),
  routeErrorBack: document.getElementById('route-error-back'),
  error: document.getElementById('error'),
  leaveDialog: document.getElementById('leave-dialog'),
  leaveText: document.getElementById('leave-text'),
  leaveSave: document.getElementById('leave-save'),
  leaveDiscard: document.getElementById('leave-discard'),
  leaveStay: document.getElementById('leave-stay'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmText: document.getElementById('confirm-text'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel'),
  eventDialog: document.getElementById('event-dialog'),
  eventTitle: document.getElementById('event-dialog-title'),
  eventRule: document.getElementById('event-dialog-rule'),
  eventName: document.getElementById('event-title'),
  eventStartButton: document.getElementById('event-start-button'),
  eventStart: document.getElementById('event-start'),
  eventSingleDay: document.getElementById('event-single-day'),
  eventEndField: document.getElementById('event-end-field'),
  eventEndButton: document.getElementById('event-end-button'),
  eventEnd: document.getElementById('event-end'),
  eventAllDay: document.getElementById('event-all-day'),
  eventTimeRow: document.getElementById('event-time-row'),
  eventStartTime: document.getElementById('event-start-time'),
  eventEndTime: document.getElementById('event-end-time'),
  eventDescription: document.getElementById('event-description'),
  eventVisibilityNote: document.getElementById('event-visibility-note'),
  eventStatus: document.getElementById('event-status'),
  eventSave: document.getElementById('event-save'),
  eventClose: document.getElementById('event-close'),
  eventRecipients: document.getElementById('event-recipients'),
  eventRecipientNote: document.getElementById('event-recipient-note'),
  arrangementDialog: document.getElementById('arrangement-dialog'),
  arrangementTarget: document.getElementById('arrangement-target'),
  arrangementWhen: document.getElementById('arrangement-when'),
  arrangementStatus: document.getElementById('arrangement-status'),
  arrangementSend: document.getElementById('arrangement-send'),
  arrangementClose: document.getElementById('arrangement-close'),
};

const state = {
  user: null,
  spaces: [],
  spacesLoaded: false,
  spacesToken: 0,
  notice: null,
  noticePromise: null,
  consents: null,
  consentGate: false,
  consentFocusSpaceId: null,
  consentManageAll: false,
  consentBusy: false,
  busy: false,
  route: null,
  routeToken: 0,
  activePage: null,
  historyIndex: 0,
  routing: false,
  suppressPop: false,
  dataRevision: 0,
  home: null,
  homeSpaceId: null,
  homeRevision: -1,
  members: null,
  invite: null,
  inviteCode: null,
  legacy: { overview: null, schedule: null, draft: [] },
  settingsInfo: null,
};

let createPeriods = makeTemplate(12);
let createReady = false;
let leaveResolve = null;
let pageEnterTimer = null;
let pageSpaceId = null;
let flashTimer = 0;
let consentResolve = null;
let consentChoices = new Map();
let consentReturnFocus = null;
const touchedAuth = { username: false, password: false, confirm: false };

const datePicker = createDatePicker();
const createTimezone = createTimezoneField('create');
const settingsTimezone = createTimezoneField('settings');
const createFields = {
  anchor: createDateField('create-anchor', datePicker, { mondayOnly: true }),
  termStart: createDateField('create-term-start', datePicker),
  termEnd: createDateField('create-term-end', datePicker),
};
const settingsFields = {
  anchor: createDateField('settings-anchor', datePicker, { mondayOnly: true }),
  termStart: createDateField('settings-term-start', datePicker),
  termEnd: createDateField('settings-term-end', datePicker),
};
const eventFields = {
  start: createDateField('event-start', datePicker, { title: '选择开始日期' }),
  end: createDateField('event-end', datePicker, { title: '选择结束日期' }),
};
const sharedPage = {
  dataRevision: () => state.dataRevision,
  setBusy,
  currentSpaceId: () => state.route?.spaceId ?? null,
  onUnauthorized: handleUnauthorized,
  showLeaveDialog,
  navigate: (path) => navigate(path),
  confirmAction,
};

const schedulePage = createSchedulePage({ ...sharedPage, api, ApiError });

const calendarPage = createCalendarPage({
  ...sharedPage,
  api,
  ApiError,
  openConsent: (spaceId) => openConsentDialog({ spaceId, manage: true }),
});

function makeTemplate(count) {
  return Array.from({ length: count }, (_, index) => {
    const pair = TEMPLATE[index % TEMPLATE.length];
    return { start: pair[0], end: pair[1] };
  });
}

function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesToTime(total) {
  const bounded = Math.max(0, Math.min(total, 23 * 60 + 59));
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString('zh-CN', {
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function roleLabel(role) {
  return role === 'owner' ? '负责人' : '普通成员';
}

function modeLabel(mode) {
  if (mode === 'courses') return '具体课程';
  if (mode === 'presence') return '仅有课状态';
  return '—';
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = !message;
}

function clearError() {
  showError('');
}

function flash(message) {
  if (!message) {
    ui.flash.hidden = true;
    return;
  }
  if (flashTimer) clearTimeout(flashTimer);
  ui.flash.textContent = message;
  ui.flash.hidden = false;
  flashTimer = setTimeout(() => { ui.flash.hidden = true; }, 6000);
}

function setChip(text, kind = 'chip-idle') {
  ui.chip.textContent = text;
  ui.chip.className = `chip ${kind}`;
}

function setSpaceStatus(text, kind = 'chip-idle') {
  ui.spaceStatus.textContent = text ?? '';
  ui.spaceStatus.className = `chip ${kind}`;
  ui.spaceStatus.hidden = !text;
}

function setBusy(value) {
  state.busy = Boolean(value);
  document.body.classList.toggle('is-busy', state.busy);
  refreshGlobalControls();
  refreshPageControls();
}

function refreshGlobalControls() {
  ui.logout.disabled = state.busy;
  ui.reload.disabled = state.busy;
  ui.openCreate.disabled = state.busy;
  ui.openJoin.disabled = state.busy;
}

function refreshPageControls() {
  if (state.activePage === 'create') refreshCreateControls();
  else if (state.activePage === 'join') refreshJoinControls();
  else if (state.activePage === 'collect') refreshCollectControls();
  else if (state.activePage === 'settings') refreshSettingsControls();
  else if (state.activePage === 'legacy') refreshLegacyControls();
  else if (state.activePage === 'home') refreshHomeControls();
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const LOGIN_DRAFT_KEY = 's0-login-draft-v1';

function readLoginDraft() {
  try { return JSON.parse(sessionStorage.getItem(LOGIN_DRAFT_KEY) || 'null'); } catch { return null; }
}

function writeLoginDraft() {
  try {
    sessionStorage.setItem(LOGIN_DRAFT_KEY, JSON.stringify({
      username: ui.loginUsername.value,
      terms: ui.loginTerms.checked,
    }));
  } catch { /* 本地草稿不可用时不影响登录 */ }
}

function clearLoginDraft() {
  try { sessionStorage.removeItem(LOGIN_DRAFT_KEY); } catch { /* 同上 */ }
}

function restoreLoginDraft() {
  const draft = readLoginDraft();
  if (!draft || typeof draft !== 'object') return;
  ui.loginUsername.value = typeof draft.username === 'string' ? draft.username : '';
  ui.loginTerms.checked = draft.terms === true;
  // 密码从不写入 URL、本地或会话存储；返回登录页后需重新输入。
}

function setFieldError(target, message) {
  target.textContent = message;
  target.hidden = !message;
}

function refreshAuthValidation() {
  const username = ui.registerUsername.value;
  const password = ui.registerPassword.value;
  const confirm = ui.registerConfirm.value;
  let usernameError = '';
  if (touchedAuth.username) {
    if (!username.trim()) usernameError = '请输入登录账号。';
    else if (!USERNAME_PATTERN.test(username.trim())) {
      usernameError = '账号需为 3–32 位小写字母、数字、下划线或连字符，并以字母或数字开头。';
    }
  }
  setFieldError(ui.registerUsernameError, usernameError);

  let passwordError = '';
  if (touchedAuth.password && password) {
    if (passwordChars(password) < PASSWORD_MIN_CHARS) passwordError = '密码至少需要 8 个字符。';
    else if (passwordBytes(password) > PASSWORD_MAX_BYTES) passwordError = '密码过长，请缩短后重试。';
  }
  setFieldError(ui.registerPasswordError, passwordError);

  let confirmError = '';
  if ((touchedAuth.confirm || password) && confirm && confirm !== password) {
    confirmError = '两次输入的密码不一致。';
  } else if (touchedAuth.confirm && !confirm && password) {
    confirmError = '请再次输入同一密码。';
  }
  setFieldError(ui.registerConfirmError, confirmError);
}

function refreshAuthControls() {
  ui.loginSubmit.disabled = state.busy
    || !ui.loginUsername.value.trim()
    || !ui.loginPassword.value
    || !ui.loginTerms.checked;
  ui.registerSubmit.disabled = state.busy
    || !ui.registerUsername.value.trim()
    || passwordChars(ui.registerPassword.value) < PASSWORD_MIN_CHARS
    || passwordBytes(ui.registerPassword.value) > PASSWORD_MAX_BYTES
    || ui.registerPassword.value !== ui.registerConfirm.value
    || !ui.registerNotice.checked;
  refreshAuthValidation();
}

function switchAuthTab(tab) {
  clearError();
  const login = tab === 'login';
  ui.authTabLogin.setAttribute('aria-selected', String(login));
  ui.authTabRegister.setAttribute('aria-selected', String(!login));
  ui.loginForm.hidden = !login;
  ui.registerForm.hidden = login;
  refreshAuthControls();
}

function setAccountMenu(open, focusButton = false) {
  if (!ui.accountPanel) return;
  ui.accountPanel.hidden = !open;
  ui.accountButton.setAttribute('aria-expanded', String(open));
  if (open) ui.accountPanel.querySelector('[role="menuitem"]')?.focus();
  else if (focusButton) ui.accountButton.focus();
}

function showAuth() {
  document.body.classList.remove('has-space');
  ui.authPanel.hidden = false;
  ui.appPanel.hidden = true;
  ui.accountWrap.hidden = true;
  setAccountMenu(false);
  ui.chip.hidden = false;
  restoreLoginDraft();
  setChip('未登录');
  document.title = '登录 · 社团协同课表';
  clearError();
  refreshAuthControls();
}

function showApp() {
  ui.authPanel.hidden = true;
  ui.appPanel.hidden = false;
  const username = state.user?.username ?? '';
  const nickname = state.user?.nickname || username;
  ui.accountWrap.hidden = false;
  ui.accountName.textContent = nickname || '账号';
  ui.accountButton.setAttribute('aria-label', `${nickname || '账号'} · 账号与退出`);
  ui.chip.hidden = true;
  setAccountMenu(false);
}

function findSpace(spaceId) {
  return state.spaces.find((space) => space.id === spaceId) ?? null;
}

function ensureHistoryState() {
  const route = parseRoute(location.hash);
  state.historyIndex = 0;
  history.replaceState({ idx: 0 }, '', `#${route.path}`);
}

function commitPath(path, replace) {
  const hash = `#${path}`;
  if (replace || location.hash === hash) {
    history.replaceState({ idx: state.historyIndex }, '', hash);
    return;
  }
  state.historyIndex += 1;
  history.pushState({ idx: state.historyIndex }, '', hash);
}

function updateDocumentTitle(route, space) {
  if (!state.user) {
    document.title = '登录 · 社团协同课表';
    return;
  }
  if (route.name === 'spaces') document.title = '我的空间 · 社团协同课表';
  else if (route.name === 'home' && space) document.title = `${space.name} · 社团协同课表`;
  else if (route.spaceId && space) document.title = `${PAGE_LABELS[route.name] ?? '空间'} · ${space.name} · 社团协同课表`;
  else document.title = `${PAGE_LABELS[route.name] ?? '页面'} · 社团协同课表`;
}

function focusCurrentPage(route, space) {
  requestAnimationFrame(() => {
    let heading = null;
    if (route.name === 'home' && space) heading = ui.spaceTitle;
    else {
      const section = ui.pages[route.name];
      heading = section?.querySelector('h2, h3') ?? null;
    }
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  });
}

function orderedSpacePages(space) {
  if (!space) return [];
  const items = ['home', 'schedule', 'calendar'];
  if (collectVisible(space.role)) items.push('collect');
  if (space.role === 'owner') items.push('settings');
  return items;
}

// 切换只重排同一套已渲染区域；入场动画作用于真实节点，不复制页面、不推迟交互。
function playPageEnter(section) {
  if (!section) return;
  if (pageEnterTimer !== null) window.clearTimeout(pageEnterTimer);
  section.classList.remove('page-enter');
  void section.offsetWidth;
  section.classList.add('page-enter');
  pageEnterTimer = window.setTimeout(() => {
    section.classList.remove('page-enter');
    pageEnterTimer = null;
  }, 220);
}

function showPage(name) {
  const previous = state.activePage;
  const targetSpace = state.route?.spaceId ? findSpace(state.route.spaceId) : null;
  const sameSpace = Boolean(targetSpace && pageSpaceId && targetSpace.id === pageSpaceId);
  for (const [key, section] of Object.entries(ui.pages)) {
    if (!section) continue;
    if (key !== name && section.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    section.hidden = key !== name;
  }
  const target = ui.pages[name];
  if (target) {
    if (sameSpace && previous && previous !== name) playPageEnter(target);
    else target.classList.remove('page-enter');
  }
  state.activePage = name;
  pageSpaceId = targetSpace?.id ?? null;
}

function buildSideLink(route, space, name, label) {
  const path = name === 'home' ? routePath('home', space.id) : routePath(name, space.id);
  const link = document.createElement('a');
  link.className = 'side-link';
  link.href = `#${path}`;
  link.textContent = label;
  if (route.name === name) link.setAttribute('aria-current', 'page');
  return link;
}

// 手机导航等分五列宽度有限，标签保持简短；完整名称放进 aria-label，桌面保持原文。
const MOBILE_NAV_LABELS = {
  home: '首页', schedule: '课表', calendar: '日历', collect: '收集', settings: '设置', legacy: '旧版',
};

function spaceNavItems(route, space) {
  const items = [
    ['home', '首页'],
    ['schedule', '我的课表'],
    ['calendar', '我的日历'],
  ];
  if (collectVisible(space.role)) items.push(['collect', '课表收集']);
  if (space.role === 'owner') items.push(['settings', '空间设置']);
  if (route.name === 'legacy') items.push(['legacy', '旧版填报']);
  return items;
}

function renderSpaceNavigation(route, space) {
  ui.sideSpaceLinks.replaceChildren();
  ui.mobileNav.replaceChildren();
  if (!space) {
    ui.sideSpace.hidden = true;
    ui.sideSpaceName.textContent = '';
    ui.sideSpaceRole.textContent = '';
    ui.mobileNav.hidden = true;
    return;
  }
  ui.sideSpace.hidden = false;
  ui.sideSpaceName.textContent = space.name;
  ui.sideSpaceRole.textContent = `${roleLabel(space.role)} · ${modeLabel(space.mode)}`;
  for (const [name, label] of spaceNavItems(route, space)) {
    ui.sideSpaceLinks.append(buildSideLink(route, space, name, label));
    const mobile = buildSideLink(route, space, name, label);
    mobile.className = 'mobile-link';
    mobile.textContent = MOBILE_NAV_LABELS[name] ?? label;
    mobile.setAttribute('aria-label', label);
    ui.mobileNav.append(mobile);
  }
  ui.mobileNav.hidden = false;
}

function renderShell(route, space) {
  document.body.classList.toggle('has-space', Boolean(space));
  ui.sideSpacesLink.toggleAttribute('aria-current', route.name === 'spaces');
  if (route.name === 'spaces') ui.sideSpacesLink.setAttribute('aria-current', 'page');
  renderSpaceNavigation(route, space);
  ui.spaceHead.hidden = !space;
  if (space) {
    ui.spaceTitle.textContent = space.name;
    ui.spaceRole.textContent = `${roleLabel(space.role)} · ${modeLabel(space.mode)}`;
  }
  const isSpaces = route.name === 'spaces';
  ui.mobileHead.hidden = isSpaces || route.name === 'notfound' || route.name === 'error';
  ui.mobileBack.hidden = !space && route.name !== 'create' && route.name !== 'join';
  ui.mobileTitle.textContent = space ? space.name : (PAGE_LABELS[route.name] ?? '页面');
  updateDocumentTitle(route, space);
}

function showRouteError(message) {
  ui.routeErrorText.textContent = message;
  setSpaceStatus('');
  showPage('error');
  document.title = '无法打开 · 社团协同课表';
  focusCurrentPage({ name: 'error' }, null);
}

function deactivateSpacePages() {
  schedulePage.deactivate();
  calendarPage.deactivate();
  deactivateHome();
  deactivateCollect();
  deactivateSettings();
  deactivateLegacy();
}

async function applyRoute() {
  if (!state.user) {
    showAuth();
    return;
  }
  const route = parseRoute(location.hash);
  const previous = state.route;
  const sameSpaceRoute = Boolean(previous?.spaceId && previous.spaceId === route.spaceId);
  state.routeToken += 1;
  const routeToken = state.routeToken;
  if (!sameSpaceRoute) deactivateSpacePages();
  state.route = route;
  flash('');

  if (route.name === 'notfound') {
    renderShell(route, null);
    setSpaceStatus('');
    showPage('notfound');
    focusCurrentPage(route, null);
    return;
  }

  if (route.name === 'spaces' || route.name === 'create' || route.name === 'join') {
    renderShell(route, null);
    setSpaceStatus('');
    showPage(route.name);
    if (route.name === 'spaces') {
      renderSpaces();
      if (!state.spacesLoaded) void loadSpaces();
    } else if (route.name === 'create') {
      activateCreate();
    } else {
      activateJoin();
    }
    focusCurrentPage(route, null);
    return;
  }

  const space = findSpace(route.spaceId);
  if (!space) {
    renderShell(route, null);
    showRouteError(state.spacesLoaded
      ? '找不到该空间，可能已被移除，或你没有访问权限。'
      : '空间列表尚未读取成功，请返回“我的空间”重试。');
    return;
  }

  renderShell(route, space);
  setSpaceStatus('');
  showPage(route.name);
  if (route.name === 'home') void activateHome(space, routeToken);
  else if (route.name === 'schedule') void schedulePage.activate(space.id);
  else if (route.name === 'calendar') void calendarPage.activate(space.id);
  else if (route.name === 'collect') void activateCollect(space, routeToken);
  else if (route.name === 'settings') void activateSettings(space, routeToken);
  else if (route.name === 'legacy') void activateLegacy(space, routeToken);
  focusCurrentPage(route, space);
}

async function canLeave(reason) {
  if (state.activePage !== 'schedule') return true;
  return schedulePage.prepareLeave(reason);
}

let pendingNavigation = null;
let routingIntent = null;

function drainPendingNavigation() {
  const next = pendingNavigation;
  pendingNavigation = null;
  if (next && state.user) {
    const nextTarget = parseRoute(next.path);
    if (nextTarget.path !== state.route?.path) void runNavigation(next);
  }
}

// 快速连续导航时只保留最新目标；离页保护先于路径写入与页面数据读取。
// 原生 hash 变化会同时触发 popstate 与 hashchange，同一目标的重复意图直接忽略。
async function runNavigation({ path, replace = false, skipLeave = false, fromHash = false }) {
  const target = parseRoute(path);
  if (state.routing) {
    // 离页保护关闭后紧接着的同目标点击不能丢；来自 hash 的重复事件仍忽略。
    if (target.path !== routingIntent || !fromHash) {
      pendingNavigation = { path, replace, skipLeave, fromHash };
    }
    return false;
  }
  if (state.user && state.route?.path === target.path) return true;
  state.routing = true;
  routingIntent = target.path;
  try {
    if (state.user && !skipLeave && !(await canLeave('离开当前页面'))) {
      if (fromHash) commitPath(state.route?.path ?? '/spaces', true);
      return false;
    }
    if (fromHash) {
      state.historyIndex += 1;
      history.replaceState({ idx: state.historyIndex }, '', `#${target.path}`);
    } else {
      commitPath(target.path, replace);
    }
    if (state.user) await applyRoute();
    return true;
  } finally {
    state.routing = false;
    routingIntent = null;
    drainPendingNavigation();
  }
}

async function navigate(path, { replace = false, skipLeave = false } = {}) {
  return runNavigation({ path, replace, skipLeave });
}

function revertPop(delta) {
  state.suppressPop = true;
  history.go(-delta);
  setTimeout(() => { state.suppressPop = false; }, 700);
}

function onPopState(event) {
  if (state.suppressPop) {
    state.suppressPop = false;
    return;
  }
  // 无应用历史索引的条目来自直接修改 hash（含首次书签进入），交给 hashchange 统一处理。
  if (!Number.isSafeInteger(event.state?.idx)) {
    onHashChange();
    return;
  }
  const targetIndex = event.state.idx;
  const delta = targetIndex - state.historyIndex;
  if (delta === 0) return;
  if (!state.user) {
    state.historyIndex = targetIndex;
    return;
  }
  if (state.routing) {
    revertPop(delta);
    return;
  }
  pendingNavigation = null;
  state.routing = true;
  routingIntent = parseRoute(location.hash).path;
  void (async () => {
    try {
      const ok = await canLeave('返回上一页');
      if (!ok) {
        revertPop(delta);
        return;
      }
      state.historyIndex = targetIndex;
      await applyRoute();
    } finally {
      state.routing = false;
      routingIntent = null;
      drainPendingNavigation();
    }
  })();
}

function onHashChange() {
  if (!state.user) return;
  const target = parseRoute(location.hash);
  if (target.path === state.route?.path && !state.routing) return;
  void runNavigation({
    path: location.hash.replace(/^#/, ''),
    fromHash: true,
  });
}

function showLeaveDialog({ text, canSave = true }) {
  if (leaveResolve) return Promise.resolve('stay');
  ui.leaveText.textContent = text;
  ui.leaveSave.hidden = !canSave;
  ui.leaveDialog.returnValue = 'stay';
  return new Promise((resolve) => {
    leaveResolve = resolve;
    const onClose = () => {
      ui.leaveDialog.removeEventListener('close', onClose);
      const value = ui.leaveDialog.returnValue;
      leaveResolve = null;
      resolve(value === 'save' || value === 'discard' ? value : 'stay');
    };
    ui.leaveDialog.addEventListener('close', onClose);
    ui.leaveDialog.showModal();
    (canSave ? ui.leaveSave : ui.leaveStay).focus();
  });
}

let confirmActionPending = false;

function confirmAction({
  title = '请确认', text, confirmText = '确认', danger = false,
} = {}) {
  // 原生 dialog 的 close 事件是排队派发的，可能晚于下一次打开；
  // 若此时直接复用对话框，旧事件会把新确认误判为取消。先等旧事件结算再打开。
  if (confirmActionPending || ui.confirmDialog.open) {
    if (ui.confirmDialog.open) ui.confirmDialog.close('cancel');
    return new Promise((resolve) => {
      setTimeout(() => {
        confirmAction({ title, text, confirmText, danger }).then(resolve);
      }, 0);
    });
  }
  ui.confirmTitle.textContent = title;
  ui.confirmText.textContent = text ?? '';
  ui.confirmOk.textContent = confirmText;
  ui.confirmOk.classList.toggle('danger', danger);
  ui.confirmDialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    const onClose = () => {
      ui.confirmDialog.removeEventListener('close', onClose);
      confirmActionPending = false;
      resolve(ui.confirmDialog.returnValue === 'ok');
    };
    confirmActionPending = true;
    ui.confirmDialog.addEventListener('close', onClose);
    ui.confirmDialog.showModal();
    ui.confirmOk.focus();
  });
}

function handleUnauthorized() {
  resetSessionState();
  state.user = null;
  showAuth();
  ui.loginPassword.value = '';
  showError('登录状态已失效，请重新登录。');
  refreshAuthControls();
}

async function performLogout() {
  if (state.busy || state.routing) return;
  if (!(await canLeave('退出登录'))) return;
  setBusy(true);
  clearError();
  try {
    await api('/api/logout', { method: 'POST' });
    resetSessionState();
    state.user = null;
    commitPath('/spaces', true);
    showAuth();
    ui.loginUsername.value = '';
    ui.loginPassword.value = '';
    flash('');
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
    refreshAuthControls();
  }
}

function resetSessionState() {
  if (pageEnterTimer !== null) {
    window.clearTimeout(pageEnterTimer);
    pageEnterTimer = null;
  }
  pageSpaceId = null;
  schedulePage.deactivate();
  calendarPage.deactivate();
  state.spaces = [];
  state.spacesLoaded = false;
  state.spacesToken += 1;
  state.routeToken += 1;
  state.route = null;
  state.activePage = null;
  state.home = null;
  state.members = null;
  state.invite = null;
  state.inviteCode = null;
  state.settingsInfo = null;
  state.legacy = { overview: null, schedule: null, draft: [] };
  state.notice = null;
  state.noticePromise = null;
  state.consents = null;
  state.consentGate = false;
  state.consentFocusSpaceId = null;
  state.consentManageAll = false;
  state.consentBusy = false;
  if (ui.consentDialog.open) ui.consentDialog.close('reset');
  consentChoices = new Map();
  consentReturnFocus = null;
  ui.consentBody.replaceChildren();
  ui.consentVersion.textContent = '';
  ui.consentMessage.hidden = true;
  ui.spaceList.replaceChildren();
  ui.spacesLoading.hidden = true;
  ui.spacesError.hidden = true;
  ui.spacesEmpty.hidden = true;
  ui.sideSpace.hidden = true;
  ui.sideSpaceLinks.replaceChildren();
  ui.mobileNav.replaceChildren();
  ui.mobileNav.hidden = true;
  ui.spaceHead.hidden = true;
  ui.spaceTitle.textContent = '';
  ui.spaceRole.textContent = '';
  ui.sideSpaceName.textContent = '';
  ui.sideSpaceRole.textContent = '';
  ui.mobileTitle.textContent = '';
  setSpaceStatus('');
  ui.flash.textContent = '';
  ui.flash.hidden = true;
  ui.spacesSummary.textContent = '';
  resetHomePage();
  resetCollectPage();
  resetSettingsPage();
  resetLegacyPage();
  resetCreateForm();
  resetJoinForm();
}

// ---- 集中告知与同意 ----

function consentParagraphs(text, container) {
  const sentences = String(text ?? '').match(/[^。]+。?/g) ?? [];
  let count = 0;
  for (const sentence of sentences) {
    const value = sentence.trim();
    if (!value) continue;
    const p = document.createElement('p');
    p.textContent = value;
    container.append(p);
    count += 1;
  }
  if (count === 0 && text) {
    const p = document.createElement('p');
    p.textContent = text;
    container.append(p);
  }
}

function consentActionButton(label, ariaLabel, onClick, cls = 'small') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = cls;
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function consentKey(item, kind) {
  return `${item.spaceId}:${kind}`;
}

function consentEntry(item, kind) {
  return kind === 'calendar' ? item.calendar : item.share;
}

function consentVersionOf(item, kind) {
  return item.notices?.[kind]?.version ?? consentEntry(item, kind)?.version ?? '';
}

function consentProtected(consent) {
  return consent?.status === 'declined' || consent?.status === 'revoked';
}

function stagedConsent(item, kind) {
  return consentChoices.get(consentKey(item, kind)) ?? null;
}

function stageConsent(item, kind, action) {
  if (state.consentBusy) return;
  const key = consentKey(item, kind);
  if (consentChoices.get(key) === action) consentChoices.delete(key);
  else consentChoices.set(key, action);
  renderConsentBody();
}

function setStagedConsent(item, kind, action) {
  if (state.consentBusy) return;
  const key = consentKey(item, kind);
  if (action) consentChoices.set(key, action);
  else consentChoices.delete(key);
  renderConsentBody();
}

function consentTimeText(consent) {
  if (consent?.accepted) return `同意于 ${formatDateTime(consent.acceptedAt)}`;
  if (consent?.status === 'revoked') return `撤回于 ${formatDateTime(consent.revokedAt ?? consent.updatedAt)}`;
  if (consent?.status === 'declined') return `拒绝于 ${formatDateTime(consent.declinedAt ?? consent.updatedAt)}`;
  return '尚未决定';
}

function buildConsentRow(item) {
  const calendar = item.calendar;
  const share = item.share;
  const calChosen = stagedConsent(item, 'calendar');
  const shareChosen = stagedConsent(item, 'share');
  const shareOn = shareChosen ? shareChosen === 'accept' : share.accepted;

  const section = document.createElement('section');
  section.className = 'consent-space';
  section.dataset.space = item.spaceId;

  const head = document.createElement('div');
  head.className = 'consent-space-head';
  const name = document.createElement('strong');
  name.textContent = item.spaceName;
  const role = document.createElement('span');
  role.className = 'chip chip-idle';
  role.textContent = roleLabel(item.role);
  head.append(name, role);
  section.append(head);

  const calLine = document.createElement('div');
  calLine.className = 'consent-line';
  calLine.dataset.kind = 'calendar';
  const calText = document.createElement('div');
  calText.className = 'consent-line-text';
  const calTitle = document.createElement('strong');
  calTitle.textContent = '日历告知';
  const calState = document.createElement('span');
  calState.className = 'consent-state';
  calState.textContent = calendar.accepted ? '已同意'
    : calendar.status === 'declined' ? '已拒绝' : '待确认';
  calText.append(calTitle, calState);
  calLine.append(calText);

  if (calendar.pending || !state.consentGate) {
    const actions = document.createElement('div');
    actions.className = 'actions compact';
    if (!calendar.accepted) {
      const accept = consentActionButton('同意', '同意当前日历告知', () => {
        setStagedConsent(item, 'calendar', calChosen === 'accept' ? null : 'accept');
      }, 'ghost small consent-pick');
      accept.setAttribute('aria-pressed', calChosen === 'accept' ? 'true' : 'false');
      actions.append(accept);
    }
    const decline = consentActionButton(calendar.accepted ? '改为拒绝' : '拒绝',
      calendar.accepted ? '改为拒绝日历告知，日期例外变为只读' : '拒绝日历告知，日期例外保持只读',
      () => { setStagedConsent(item, 'calendar', calChosen === 'decline' ? null : 'decline'); },
      'ghost small consent-pick');
    decline.setAttribute('aria-pressed', calChosen === 'decline' ? 'true' : 'false');
    actions.append(decline);
    calLine.append(actions);
  }
  section.append(calLine);

  const shareRow = document.createElement('div');
  shareRow.className = 'consent-line consent-share';
  shareRow.dataset.kind = 'share';
  const switchLabel = document.createElement('label');
  switchLabel.className = 'consent-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = shareOn;
  input.disabled = state.consentBusy;
  input.setAttribute('aria-label', '向负责人共享日期状态');
  input.addEventListener('change', () => {
    if (input.checked) setStagedConsent(item, 'share', 'accept');
    else if (share.status === 'accepted') setStagedConsent(item, 'share', 'revoke');
    else if (share.status === 'declined' || share.status === 'revoked') setStagedConsent(item, 'share', null);
    else setStagedConsent(item, 'share', 'decline');
  });
  const switchText = document.createElement('span');
  switchText.textContent = '向负责人共享日期状态';
  switchLabel.append(input, switchText);
  const shareState = document.createElement('span');
  shareState.className = 'consent-state';
  shareState.textContent = shareChosen === 'accept' ? '提交后共享'
    : shareChosen === 'revoke' ? '提交后撤回'
      : shareChosen === 'decline' ? '提交后关闭'
        : share.accepted ? '已共享'
          : share.status === 'revoked' ? '已撤回'
            : share.status === 'declined' ? '已拒绝' : '未共享';
  shareRow.append(switchLabel, shareState);
  section.append(shareRow);

  if ((calendar.pending && consentProtected(calendar)) || (share.pending && consentProtected(share))) {
    const kept = document.createElement('p');
    kept.className = 'hint consent-protected';
    kept.textContent = '此前版本的选择会保留，只有主动改动才会覆盖。';
    section.append(kept);
  }

  const details = document.createElement('details');
  details.className = 'consent-details';
  const summary = document.createElement('summary');
  summary.textContent = '详情';
  details.append(summary);
  const calMeta = document.createElement('p');
  calMeta.className = 'consent-version-note';
  calMeta.textContent = `日历告知 v${item.notices?.calendar?.version ?? calendar.version ?? '—'} · ${consentTimeText(calendar)}`;
  const shareMeta = document.createElement('p');
  shareMeta.className = 'consent-version-note';
  shareMeta.textContent = `日期共享 v${item.notices?.share?.version ?? share.version ?? '—'} · ${consentTimeText(share)}`;
  details.append(calMeta, shareMeta);

  const calHead = document.createElement('strong');
  calHead.className = 'consent-notice-head';
  calHead.textContent = '日历告知原文';
  const calNotice = document.createElement('div');
  consentParagraphs(item.notices?.calendar?.text, calNotice);
  const shareHead = document.createElement('strong');
  shareHead.className = 'consent-notice-head';
  shareHead.textContent = '日期共享说明';
  const shareNotice = document.createElement('div');
  consentParagraphs(item.notices?.share?.text, shareNotice);
  details.append(calHead, calNotice, shareHead, shareNotice);
  section.append(details);
  return section;
}

function visibleConsentItems() {
  const items = state.consents?.items ?? [];
  const focused = state.consentFocusSpaceId
    ? items.filter((item) => item.spaceId === state.consentFocusSpaceId)
    : items;
  return state.consentGate
    ? focused.filter((item) => item.calendar.pending
      || consentChoices.has(consentKey(item, 'calendar'))
      || consentChoices.has(consentKey(item, 'share')))
    : focused;
}

function pendingConsentEntries() {
  const entries = [];
  for (const item of visibleConsentItems()) {
    for (const kind of ['calendar', 'share']) {
      const consent = consentEntry(item, kind);
      if (consent.pending) entries.push({ item, kind, consent });
    }
  }
  return entries;
}

function unresolvedRequiredConsent() {
  return pendingConsentEntries().filter(({ item, kind, consent }) => kind === 'calendar'
    && !stagedConsent(item, kind)
    && (consentChoices.size > 0 || consentProtected(consent)));
}

function renderConsentBody() {
  ui.consentBody.replaceChildren();
  ui.consentVersion.textContent = '';
  if (!state.consents) {
    const error = document.createElement('p');
    error.className = 'inline-error';
    error.textContent = '未能读取待确认告知。请检查网络后重试。';
    const retry = consentActionButton('重试', '重新读取待确认告知', () => {
      void openConsentDialog({
        spaceId: state.consentFocusSpaceId,
        gate: state.consentGate,
        manage: state.consentManageAll,
      });
    }, 'ghost small');
    ui.consentBody.append(error, retry);
    ui.consentNecessary.hidden = true;
    ui.consentContinue.textContent = '读取失败';
    ui.consentContinue.disabled = true;
    return;
  }

  ui.consentVersion.hidden = true;
  const visible = visibleConsentItems();
  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '当前没有需要确认的事项。';
    ui.consentBody.append(empty);
  } else {
    for (const item of visible) ui.consentBody.append(buildConsentRow(item));
  }

  const pending = pendingConsentEntries();
  const bulkEligible = pending.filter(({ consent }) => !consentProtected(consent));
  const unresolved = unresolvedRequiredConsent();
  ui.consentNecessary.hidden = bulkEligible.length === 0 || state.consentBusy;
  if (consentChoices.size > 0 || unresolved.length > 0) ui.consentContinue.textContent = '按当前选择继续';
  else if (bulkEligible.length > 0) ui.consentContinue.textContent = '全部同意';
  else ui.consentContinue.textContent = state.consentGate ? '进入应用' : '完成';
  ui.consentContinue.disabled = state.consentBusy || (state.consentGate && unresolved.length > 0);
}

function chooseNecessaryConsent() {
  if (state.consentBusy) return;
  for (const item of visibleConsentItems()) {
    for (const kind of ['calendar', 'share']) {
      const consent = consentEntry(item, kind);
      if (!consent.pending || consentProtected(consent)) continue;
      consentChoices.set(consentKey(item, kind), kind === 'calendar' ? 'accept' : 'decline');
    }
  }
  void submitConsentChoices();
}

function setConsentMessage(text, kind = 'error') {
  ui.consentMessage.textContent = text;
  ui.consentMessage.className = kind === 'ok' ? 'status' : 'inline-error';
  ui.consentMessage.hidden = !text;
  ui.consentMessage.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
}

async function loadConsents() {
  try {
    state.consents = await api('/api/consents');
    return state.consents;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) handleUnauthorized();
    else setConsentMessage(`读取同意状态失败：${error.message}`);
    state.consents = null;
    return null;
  }
}

function consentPrimaryActions() {
  const actions = [];
  const explicit = consentChoices.size > 0;
  for (const item of visibleConsentItems()) {
    for (const kind of ['calendar', 'share']) {
      const consent = consentEntry(item, kind);
      const chosen = stagedConsent(item, kind);
      if (chosen) actions.push({ item, kind, action: chosen });
      else if (!explicit && kind === 'calendar' && consent.pending && !consentProtected(consent)) {
        actions.push({ item, kind, action: 'accept' });
      }
    }
  }
  return actions;
}

function consentActionSettled(item, kind, action) {
  const consent = consentEntry(item, kind);
  if (consent.pending) return false;
  if (action === 'accept') return consent.accepted === true;
  if (action === 'decline') return consent.status === 'declined';
  return consent.status === 'revoked';
}

async function submitConsentChoices() {
  if (state.consentBusy) return;
  if (state.consentGate && unresolvedRequiredConsent().length > 0) {
    setConsentMessage('请先为必选日历告知选择“同意”或“拒绝”。');
    return;
  }
  const actions = consentPrimaryActions();
  if (actions.length === 0) {
    ui.consentDialog.close('done');
    return;
  }
  state.consentBusy = true;
  setConsentMessage('');
  renderConsentBody();
  const failed = [];
  let closeAfter = false;
  try {
    for (const action of actions) {
      try {
        const version = consentVersionOf(action.item, action.kind);
        const path = action.kind === 'calendar'
          ? `/api/spaces/${action.item.spaceId}/calendar/consent`
          : `/api/spaces/${action.item.spaceId}/calendar/share`;
        const payload = action.action === 'revoke'
          ? { action: action.action }
          : { action: action.action, noticeVersion: version };
        if (action.action === 'accept') payload.noticeAccepted = true;
        await api(path, { method: 'POST', body: JSON.stringify(payload) });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized();
          return;
        }
        failed.push(action);
      }
    }
    if (!state.user) return;
    await loadConsents();
    if (!state.consents) {
      setConsentMessage('决定已尝试提交，但状态刷新失败；请重试读取后再确认。');
      return;
    }
    // 网络中断时响应可能丢失：以服务端最新状态判断，已落地的不重复写入。
    const stillFailed = failed.filter(({ item, kind, action }) => {
      const fresh = (state.consents.items ?? []).find((entry) => entry.spaceId === item.spaceId);
      return !fresh || !consentActionSettled(fresh, kind, action);
    });
    const successCount = actions.length - stillFailed.length;
    consentChoices = new Map();
    for (const { item, kind, action } of stillFailed) {
      consentChoices.set(consentKey(item, kind), action);
    }
    if (stillFailed.length > 0) {
      const spaces = [...new Set(stillFailed.map(({ item }) => item.spaceName))];
      setConsentMessage(`已记录 ${successCount} 项；${stillFailed.length} 项未完成（${spaces.join('、')}）。`
        + '选择已保留，可再次点击重试。');
      return;
    }
    setConsentMessage(`已记录 ${successCount} 项决定。`, 'ok');
    const pendingRequired = (state.consents.items ?? []).some((entry) => entry.calendar.pending);
    closeAfter = state.consentGate && !pendingRequired;
    for (const spaceId of new Set(actions.map(({ item }) => item.spaceId))) {
      if (state.activePage === 'calendar' && state.route?.spaceId === spaceId) {
        void calendarPage.reload();
      }
    }
  } finally {
    state.consentBusy = false;
    if (ui.consentDialog.open) {
      if (closeAfter) ui.consentDialog.close('done');
      else renderConsentBody();
    }
  }
}

async function openConsentDialog({ spaceId = null, gate = false, manage = false, returnFocus = null } = {}) {
  if (state.consentBusy) return;
  const alreadyOpen = ui.consentDialog.open;
  state.consentGate = gate;
  state.consentFocusSpaceId = spaceId;
  state.consentManageAll = manage;
  if (!alreadyOpen) {
    consentReturnFocus = returnFocus instanceof HTMLElement
      ? returnFocus
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    consentChoices = new Map();
  }
  setConsentMessage('');
  const data = await loadConsents();
  if (!state.user) return;
  if (!data && gate) {
    flash('未能读取待确认告知；可稍后在“我的空间”的“隐私设置”处理。');
    return Promise.resolve();
  }
  if (!alreadyOpen) {
    const promise = new Promise((resolve) => { consentResolve = resolve; });
    ui.consentDialog.showModal();
    renderConsentBody();
    const target = ui.consentBody.querySelector('.consent-pick')
      ?? ui.consentBody.querySelector('.consent-switch input')
      ?? ui.consentContinue;
    target.focus();
    return promise;
  }
  renderConsentBody();
  return Promise.resolve();
}

async function runConsentGate() {
  const data = await loadConsents();
  if (!state.user) return;
  if (!data) {
    flash('未能读取待确认告知；可稍后在“我的空间”的“隐私设置”处理。');
    return;
  }
  const pending = data.items.some((item) => item.calendar.pending);
  if (!pending) return;
  await openConsentDialog({ gate: true });
}

async function enterAfterAuth({ restoreTarget }) {
  const ok = await loadSpaces();
  if (!state.user) return;
  await runConsentGate();
  if (!state.user) return;
  showApp();
  let target = parseRoute(location.hash);
  if (restoreTarget) target = parseRoute(resolveLoginTarget(location.hash, state.spaces));
  if (!ok && restoreTarget) target = parseRoute('/spaces');
  commitPath(target.path, true);
  await applyRoute();
}

async function loadSpaces() {
  const token = ++state.spacesToken;
  if (state.activePage === 'spaces') {
    ui.spacesLoading.hidden = false;
    ui.spacesError.hidden = true;
    ui.spacesEmpty.hidden = true;
  }
  try {
    const list = await api('/api/spaces');
    if (token !== state.spacesToken) return false;
    state.spaces = Array.isArray(list) ? list : [];
    state.spacesLoaded = true;
    renderSpaces();
    return true;
  } catch (error) {
    if (token !== state.spacesToken) return false;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (state.activePage === 'spaces') {
      ui.spacesErrorText.textContent = error.message;
      ui.spacesError.hidden = false;
    }
    return false;
  } finally {
    if (token === state.spacesToken && state.activePage === 'spaces') {
      ui.spacesLoading.hidden = true;
      ui.spacesEmpty.hidden = !state.spacesLoaded || state.spaces.length > 0;
    }
  }
}

function renderSpaces() {
  ui.spaceList.replaceChildren();
  const count = state.spaces.length;
  ui.spacesSummary.textContent = count > 0 ? `${count} 个空间` : '';
  for (const space of state.spaces) {
    const item = document.createElement('div');
    item.className = 'space-item';
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'space-button';
    button.addEventListener('click', () => { void navigate(routePath('home', space.id)); });
    const name = document.createElement('span');
    name.className = 'space-name';
    name.textContent = space.name;
    const meta = document.createElement('small');
    const ownName = space.inSpaceName ? ` · ${space.inSpaceName}` : '';
    meta.textContent = `${roleLabel(space.role)} · ${modeLabel(space.mode)}${ownName}`;
    button.append(name, meta);
    item.append(button);
    ui.spaceList.append(item);
  }
  ui.spacesEmpty.hidden = !state.spacesLoaded || count > 0;
}

async function submitLogin(event) {
  event.preventDefault();
  if (state.busy) return;
  const username = ui.loginUsername.value.trim();
  const password = ui.loginPassword.value;
  if (!username || !password) return;
  if (!ui.loginTerms.checked) {
    showError('请先阅读并勾选条款确认。');
    return;
  }
  ui.loginPassword.value = '';
  setBusy(true);
  clearError();
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.user = body.user;
    ui.loginUsername.value = '';
    clearLoginDraft();
    await enterAfterAuth({ restoreTarget: true });
  } catch (error) {
    showError(error.message);
    refreshAuthControls();
  } finally {
    setBusy(false);
    refreshAuthControls();
  }
}

async function submitRegister(event) {
  event.preventDefault();
  if (state.busy) return;
  const username = ui.registerUsername.value.trim();
  const nickname = ui.registerNickname.value.trim();
  const password = ui.registerPassword.value;
  const confirm = ui.registerConfirm.value;
  if (!ui.registerNotice.checked) {
    showError('请先勾选“我已了解忘记密码可能无法恢复”。');
    return;
  }
  touchedAuth.username = true;
  touchedAuth.password = true;
  touchedAuth.confirm = true;
  refreshAuthValidation();
  if (!USERNAME_PATTERN.test(username)) {
    showError('请检查标记的账号格式。');
    return;
  }
  if (passwordChars(password) < PASSWORD_MIN_CHARS || passwordBytes(password) > PASSWORD_MAX_BYTES) {
    showError(MESSAGES.invalid_password);
    return;
  }
  if (password !== confirm) {
    showError('两次输入的密码不一致。');
    return;
  }
  setBusy(true);
  clearError();
  try {
    const body = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, nickname, password, noticeAccepted: true }),
    });
    state.user = body.user;
    ui.registerUsername.value = '';
    ui.registerNickname.value = '';
    ui.registerPassword.value = '';
    ui.registerConfirm.value = '';
    ui.registerNotice.checked = false;
    await enterAfterAuth({ restoreTarget: true });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
    refreshAuthControls();
  }
}

// ---- 创建空间 ----

function teachingInput(prefix) {
  const map = prefix === 'create'
    ? [ui.createTimezone, ui.createAnchor, ui.createTermStart, ui.createTermEnd]
    : [ui.settingsTimezone, ui.settingsAnchor, ui.settingsTermStart, ui.settingsTermEnd];
  return {
    timezone: map[0].value,
    firstWeekMonday: map[1].value,
    termStart: map[2].value,
    termEnd: map[3].value,
  };
}

function teachingPreviewText(input, target) {
  const result = validateTeachingInput(input);
  if (!result.ok) {
    target.textContent = result.message;
    return { ok: false, result };
  }
  const termDate = new Date(`${result.teaching.termStart}T12:00:00Z`);
  target.textContent = `第 1–${result.weekCount} 教学周 · ${monthLabel(result.teaching.termStart.slice(0, 7))} 起 · 学期 ${result.teaching.termStart} 至 ${result.teaching.termEnd}（含首尾） · 时区 ${timezoneLabel(result.teaching.timezone, termDate)}`;
  return { ok: true, result };
}

function activateCreate() {
  ui.createStatus.textContent = '';
  refreshCreateControls();
  if (!ui.createName.value) ui.createName.focus();
}

function resetCreateForm() {
  ui.createName.value = '';
  ui.createOwnerName.value = '';
  const everyRule = document.querySelector('input[name="create-week-rule"][value="every"]');
  if (everyRule) everyRule.checked = true;
  const presence = document.querySelector('input[name="create-mode"][value="presence"]');
  if (presence) presence.checked = true;
  const stats = document.querySelector('input[name="create-visibility"][value="stats"]');
  if (stats) stats.checked = true;
  createTimezone.setValue('');
  createFields.anchor.setValue('');
  createFields.termStart.setValue('');
  createFields.termEnd.setValue('');
  ui.createPreview.textContent = '请填写完整的教学周设置。';
  ui.createStatus.textContent = '';
  createPeriods = makeTemplate(12);
  renderPeriods();
}

function periodsValid(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  let previousEnd = null;
  for (const period of list) {
    if (!period.start || !period.end || period.start >= period.end) return false;
    if (previousEnd !== null && period.start < previousEnd) return false;
    previousEnd = period.end;
  }
  return true;
}

function refreshCreateControls() {
  const preview = teachingPreviewText(teachingInput('create'), ui.createPreview);
  createReady = preview.ok
    && Boolean(ui.createName.value.trim())
    && Boolean(ui.createOwnerName.value.trim())
    && periodsValid(createPeriods);
  ui.createSubmit.disabled = state.busy || !createReady;
  ui.addPeriod.disabled = state.busy || createPeriods.length >= PERIODS_MAX;
  ui.resetPeriods.disabled = state.busy;
  for (const remove of ui.periodsEditor.querySelectorAll('button[data-remove]')) {
    remove.disabled = state.busy || createPeriods.length <= 1;
  }
}

function renderPeriods() {
  ui.periodsEditor.replaceChildren();
  createPeriods.forEach((period, index) => {
    const row = document.createElement('div');
    row.className = 'period-row';

    const number = document.createElement('span');
    number.className = 'period-index';
    number.textContent = `第 ${index + 1} 节`;

    const startLabel = document.createElement('label');
    startLabel.className = 'period-field';
    const startText = document.createElement('span');
    startText.textContent = '开始';
    const start = document.createElement('input');
    start.type = 'time';
    start.value = period.start;
    start.addEventListener('input', () => {
      period.start = start.value;
      refreshCreateControls();
    });
    startLabel.append(startText, start);

    const endLabel = document.createElement('label');
    endLabel.className = 'period-field';
    const endText = document.createElement('span');
    endText.textContent = '结束';
    const end = document.createElement('input');
    end.type = 'time';
    end.value = period.end;
    end.addEventListener('input', () => {
      period.end = end.value;
      refreshCreateControls();
    });
    endLabel.append(endText, end);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost small';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除第 ${index + 1} 节`);
    remove.dataset.remove = '1';
    remove.disabled = createPeriods.length <= 1 || state.busy;
    remove.addEventListener('click', () => {
      if (createPeriods.length <= 1) return;
      createPeriods.splice(index, 1);
      renderPeriods();
      refreshCreateControls();
    });

    row.append(number, startLabel, endLabel, remove);
    ui.periodsEditor.append(row);
  });
  refreshCreateControls();
}

function addPeriod() {
  if (createPeriods.length >= PERIODS_MAX) {
    ui.createStatus.textContent = `最多 ${PERIODS_MAX} 节；可增删。`;
    return;
  }
  const last = createPeriods[createPeriods.length - 1];
  const lastEnd = last ? timeToMinutes(last.end) : null;
  const startMinutes = lastEnd === null ? 8 * 60 : Math.min(lastEnd, 23 * 60 + 14);
  createPeriods.push({
    start: minutesToTime(startMinutes),
    end: minutesToTime(startMinutes + 45),
  });
  renderPeriods();
}

function resetPeriodTemplate() {
  createPeriods = makeTemplate(12);
  ui.createStatus.textContent = '已恢复 12 节模板；可继续增删。';
  renderPeriods();
}

async function submitCreate(event) {
  event.preventDefault();
  if (state.busy || !createReady) return;
  const teaching = teachingInput('create');
  const teachingResult = validateTeachingInput(teaching);
  if (!teachingResult.ok) {
    ui.createStatus.textContent = teachingResult.message;
    return;
  }
  if (!periodsValid(createPeriods)) {
    ui.createStatus.textContent = '节次时间需要完整、递增且不重叠。';
    return;
  }
  const payload = {
    name: ui.createName.value.trim(),
    ownerName: ui.createOwnerName.value.trim(),
    mode: document.querySelector('input[name="create-mode"]:checked')?.value ?? 'presence',
    weekRule: document.querySelector('input[name="create-week-rule"]:checked')?.value ?? 'every',
    periods: createPeriods.map((period, index) => ({
      index: index + 1, start: period.start, end: period.end,
    })),
    visibility: document.querySelector('input[name="create-visibility"]:checked')?.value ?? 'stats',
    teaching: teachingResult.teaching,
  };
  setBusy(true);
  clearError();
  ui.createStatus.textContent = '';
  try {
    const body = await api('/api/spaces', { method: 'POST', body: JSON.stringify(payload) });
    ui.createStatus.textContent = '空间已创建，正在进入…';
    resetCreateForm();
    state.consents = null;
    const ok = await loadSpaces();
    if (!ok || !state.spaces.some((space) => space.id === body.space.id)) {
      state.spaces.push({
        id: body.space.id,
        name: body.space.name,
        mode: body.space.mode,
        role: 'owner',
        inSpaceName: body.space.inSpaceName ?? null,
      });
      state.spacesLoaded = true;
      renderSpaces();
    }
    // 新建空间也走一次集中确认：在进入空间前处理该空间的待确认告知，无需退出重登。
    await runConsentGate();
    if (!state.user) return;
    await navigate(`/spaces/${body.space.id}`, { replace: true, skipLeave: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.createStatus.textContent = error.message;
  } finally {
    setBusy(false);
    refreshCreateControls();
  }
}

// ---- 邀请加入 ----

function activateJoin() {
  ui.joinStatus.textContent = '';
  refreshJoinControls();
  void ensureNotice().then(renderJoinNotice).catch((error) => {
    ui.joinStatus.textContent = `加入告知读取失败：${error.message} 请重试。`;
    refreshJoinControls();
  });
  if (!ui.joinCode.value) ui.joinCode.focus();
}

function resetJoinForm() {
  ui.joinCode.value = '';
  ui.joinName.value = '';
  ui.joinNotice.checked = false;
  ui.joinShare.checked = false;
  ui.joinStatus.textContent = '';
}

async function ensureNotice() {
  if (state.notice?.version) return true;
  if (!state.noticePromise) {
    state.noticePromise = api('/api/notice').then((body) => {
      if (typeof body?.version !== 'string' || typeof body?.text !== 'string') {
        throw new ApiError(MESSAGES.invalid_response, 'invalid_response');
      }
      state.notice = {
        version: body.version,
        text: body.text,
        share: body.share && typeof body.share.version === 'string'
          ? { version: body.share.version, text: String(body.share.text ?? '') }
          : null,
      };
      return true;
    }).catch((error) => {
      state.noticePromise = null;
      throw error;
    });
  }
  return state.noticePromise;
}

function renderJoinNotice() {
  ui.joinNoticeText.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = '加入前告知';
  ui.joinNoticeText.append(title);
  const text = state.notice?.text ?? '';
  const sentences = text.match(/[^。]+。?/g) ?? [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const p = document.createElement('p');
    p.textContent = trimmed;
    ui.joinNoticeText.append(p);
  }
  if (sentences.length === 0) {
    const p = document.createElement('p');
    p.textContent = '正在读取加入告知，读取完成后才能加入。';
    ui.joinNoticeText.append(p);
  }
  const shareText = document.getElementById('join-share-text');
  if (shareText) {
    shareText.textContent = state.notice?.share?.text
      || '确认后，负责人可看到你在具体日期和节次的忙/有空声明；不确认时，只按已提交课程显示有课/没课，不显示日期例外。';
  }
  ui.joinShare.disabled = !state.notice?.share?.version;
  refreshJoinControls();
}

function refreshJoinControls() {
  ui.joinSubmit.disabled = state.busy
    || !ui.joinCode.value.trim()
    || !ui.joinName.value.trim()
    || !ui.joinNotice.checked
    || !state.notice?.version;
}

async function submitJoin(event) {
  event.preventDefault();
  if (state.busy) return;
  if (!state.notice?.version && !(await ensureNotice())) return;
  const code = ui.joinCode.value.trim();
  const inSpaceName = ui.joinName.value.trim();
  if (!code || !inSpaceName) return;
  setBusy(true);
  clearError();
  ui.joinStatus.textContent = '';
  try {
    const body = await api('/api/join', {
      method: 'POST',
      body: JSON.stringify({
        code,
        inSpaceName,
        noticeAccepted: true,
        noticeVersion: state.notice.version,
        shareNoticeAccepted: ui.joinShare.checked === true,
        shareNoticeVersion: state.notice.share?.version ?? null,
      }),
    });
    ui.joinStatus.textContent = body.alreadyMember ? '你已在该空间中，无需重复加入。' : '已加入空间。';
    resetJoinForm();
    state.consents = null;
    const ok = await loadSpaces();
    if (!ok || !state.spaces.some((space) => space.id === body.space.id)) {
      state.spaces.push({
        id: body.space.id,
        name: body.space.name,
        mode: null,
        role: body.space.role ?? 'member',
        inSpaceName: body.inSpaceName ?? null,
      });
      state.spacesLoaded = true;
      renderSpaces();
    }
    await navigate(`/spaces/${body.space.id}`, { replace: true, skipLeave: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.joinStatus.textContent = error.message;
  } finally {
    setBusy(false);
    refreshJoinControls();
  }
}

// ---- 空间首页 ----

function resetHomePage() {
  state.home = null;
  state.homeSpaceId = null;
  state.homeRevision = -1;
  ui.homeLoading.hidden = true;
  ui.homeError.hidden = true;
  ui.homeErrorText.textContent = '';
  ui.homeContent.hidden = true;
  ui.homeStatusGrid.replaceChildren();
  ui.homeTeachingNote.replaceChildren();
  ui.homeTeachingNote.hidden = true;
  ui.homeLegacy.hidden = true;
  ui.homeLegacyText.textContent = '';
}

function deactivateHome() {
  resetHomePage();
}

function statCard(label, value, tone = '') {
  const cell = document.createElement('div');
  cell.className = `stat${tone ? ` is-${tone}` : ''}`;
  const key = document.createElement('span');
  key.className = 'stat-label';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = 'stat-value';
  val.textContent = value;
  cell.append(key, val);
  return cell;
}

function actionButton(label, onClick, cls = 'ghost') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = cls;
  button.textContent = label;
  button.addEventListener('click', () => { void onClick(); });
  return button;
}

function renderHome(body, space) {
  const legacy = body.kind === 'legacy';
  ui.homeContent.hidden = false;
  ui.homeStatusGrid.replaceChildren();
  ui.homeTeachingNote.replaceChildren();
  ui.homeTeachingNote.hidden = true;
  ui.homeLegacy.hidden = true;

  if (legacy) {
    ui.homeStatusGrid.append(statCard('空间类型', '旧版空间'));
    ui.homeStatusGrid.append(statCard(
      '我的整表',
      body.legacySchedule ? `已提交 v${body.legacySchedule.version ?? 1}` : '未提交',
    ));
    ui.homeLegacy.hidden = false;
    ui.homeLegacyText.textContent = '该空间使用旧版整表填报；周课表与月历不适用。';
    return;
  }

  const submitted = body.schedule?.submitted === true;
  const version = body.schedule?.publishedVersion ?? 0;
  const hasDraft = body.schedule?.hasDraft === true;
  const teachingState = body.teachingState;
  const weeks = body.teaching
    ? teachingWeekCount(body.teaching.firstWeekMonday, body.teaching.termEnd)
    : null;
  const calendarReady = body.calendar?.ready === true;
  const consentAccepted = body.calendar?.consentAccepted === true;

  ui.homeStatusGrid.append(statCard(
    '教学周',
    teachingState === 'set' ? `${weeks ?? '—'} 周` : (teachingState === 'invalid' ? '设置无效' : '待设置'),
    teachingState === 'set' ? 'ok' : 'warn',
  ));
  ui.homeStatusGrid.append(statCard(
    '我的课表',
    submitted ? '课表已提交' : (hasDraft ? '草稿已保存' : '尚未提交'),
    submitted ? 'ok' : 'warn',
  ));
  ui.homeStatusGrid.append(statCard(
    '我的日历',
    !body.teaching ? '待教学设置' : (!submitted ? '待提交课表' : (consentAccepted ? '可用' : '待确认告知')),
    calendarReady && consentAccepted ? 'ok' : 'warn',
  ));
  const assignmentPending = body.assignments?.pendingCount ?? 0;
  if (assignmentPending > 0) {
    ui.homeStatusGrid.append(statCard('待我确认', `${assignmentPending} 项`, 'warn'));
  }
  if (collectVisible(body.space.role) && body.collection) {
    const { total, submitted: submittedCount } = body.collection;
    ui.homeStatusGrid.append(statCard('收集进度', `${submittedCount} / ${total} 位成员`, 'ok'));
  }

  if (teachingState === 'pending') {
    const title = document.createElement('strong');
    title.textContent = '尚未设置教学周';
    const text = document.createElement('p');
    text.textContent = body.space.role === 'owner'
      ? '设置教学周后可用月历。'
      : '负责人尚未设置教学周。';
    ui.homeTeachingNote.append(title, text);
    if (body.space.role === 'owner') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(actionButton('去设置', () => navigate(`/spaces/${space.id}/settings`), 'small'));
      ui.homeTeachingNote.append(actions);
    }
    ui.homeTeachingNote.hidden = false;
  } else if (teachingState === 'invalid') {
    const title = document.createElement('strong');
    title.textContent = '教学周设置无效';
    const text = document.createElement('p');
    text.textContent = '教学周设置无效，请联系负责人。';
    ui.homeTeachingNote.append(title, text);
    ui.homeTeachingNote.hidden = false;
  }

}

async function activateHome(space, token) {
  const revision = state.dataRevision;
  const same = state.homeSpaceId === space.id && Boolean(state.home);
  if (same && state.homeRevision === revision) {
    ui.homeLoading.hidden = true;
    return;
  }
  if (!same) resetHomePage();
  ui.homeLoading.hidden = same;
  try {
    const body = await api(`/api/spaces/${space.id}/home`);
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    state.home = body;
    state.homeSpaceId = space.id;
    state.homeRevision = revision;
    if (body.space?.name) space.name = body.space.name;
    if (body.space?.role) space.role = body.space.role;
    if (body.space?.mode) space.mode = body.space.mode;
    ui.homeLoading.hidden = true;
    ui.homeError.hidden = true;
    renderHome(body, space);
    refreshHomeControls();
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.homeLoading.hidden = true;
    ui.homeErrorText.textContent = error.message;
    ui.homeError.hidden = false;
    setSpaceStatus('读取失败', 'chip-warn');
  }
}

function refreshHomeControls() {
  ui.homeRetry.disabled = state.busy;
}

async function retryHome() {
  if (state.busy) return;
  const space = findSpace(state.route?.spaceId);
  if (!space) return;
  await activateHome(space, state.routeToken);
}

// ---- 课表收集 ----

let collectHome = null;
let collectHomeSpaceId = null;
let collectRevision = -1;
let collectTab = 'overview';
let collectMonth = null;
let collectMonthData = null;
let collectMonthToken = 0;
let collectSelectedDate = null;
let collectTargetMonth = null;
let collectRetryTarget = null;
let collectSwitching = false;
let collectActiveRequest = null;
let collectPrefetchTimer = 0;
let collectSwipe = null;
const collectMonthCache = new Map();
const collectRevalidating = new Map();
let collectPrefetchQueue = [];
let collectPrefetchRunning = false;
let collectPrefetchController = null;
let collectPreloadRequest = null;
let collectCacheEpoch = 0;
const COLLECT_CACHE_LIMIT = 12;
const COLLECT_CACHE_FRESH_MS = 45_000;
let collectFilter = 'all';
let collectEventsStatus = '';
let eventEditing = null;
let arrangementTarget = null;
let collectExporting = false;

function collectInitialMonth() {
  if (!collectHome?.teaching) return null;
  const today = todayInZone(collectHome.teaching.timezone);
  return validMonth(today?.slice(0, 7)) ?? validMonth(collectHome.teaching.termStart.slice(0, 7));
}

function setCollectTab(tab, { focus = false } = {}) {
  collectTab = tab === 'calendar' ? 'calendar' : 'overview';
  const calendar = collectTab === 'calendar';
  ui.collectTabOverview.setAttribute('aria-selected', String(!calendar));
  ui.collectTabCalendar.setAttribute('aria-selected', String(calendar));
  ui.collectOverview.hidden = calendar;
  ui.collectCalendar.hidden = !calendar;
  if (focus) (calendar ? ui.collectTabCalendar : ui.collectTabOverview).focus();
  if (calendar && !collectMonthData) {
    const initial = collectInitialMonth();
    if (initial) void loadCollectCalendar(initial);
    else {
      ui.collectCalendarTable.hidden = true;
      ui.collectCalendarEmpty.hidden = false;
      ui.collectCalendarEmpty.textContent = '负责人尚未设置教学周，收集日历暂不可用。';
    }
  } else if (calendar) {
    renderCollectNeighborPages();
    collectSwipe?.center();
    // 重新进入日历标签时先显示缓存，过期再静默核对其他设备/负责人侧的改动。
    if (collectMonth) void loadCollectCalendar(collectMonth, { preferDate: collectSelectedDate, silent: true });
  }
}

function resetCollectPage() {
  abortCollectPreload();
  state.members = null;
  state.invite = null;
  state.inviteCode = null;
  collectHome = null;
  collectHomeSpaceId = null;
  collectRevision = -1;
  collectTab = 'overview';
  collectMonth = null;
  collectMonthData = null;
  collectMonthToken += 1;
  collectSelectedDate = null;
  collectTargetMonth = null;
  collectRetryTarget = null;
  collectSwitching = false;
  collectActiveRequest?.controller.abort();
  collectActiveRequest = null;
  if (collectPrefetchTimer) {
    window.clearTimeout(collectPrefetchTimer);
    collectPrefetchTimer = 0;
  }
  collectMonthCache.clear();
  collectExporting = false;
  collectCacheEpoch += 1;
  collectPrefetchQueue = [];
  collectPrefetchRunning = false;
  collectPrefetchController?.abort();
  collectPrefetchController = null;
  for (const controller of collectRevalidating.values()) controller.abort();
  collectRevalidating.clear();
  ui.collectExportRange.textContent = '';
  collectFilter = 'all';
  collectEventsStatus = '';
  eventEditing = null;
  arrangementTarget = null;
  if (ui.eventDialog.open) ui.eventDialog.close('reset');
  if (ui.arrangementDialog.open) ui.arrangementDialog.close('reset');
  ui.collectDenied.hidden = true;
  ui.collectContent.hidden = true;
  ui.collectLegacy.hidden = true;
  ui.collectSummaryText.textContent = '';
  ui.collectSummary.replaceChildren();
  ui.collectSummary.hidden = false;
  ui.collectMembersLoading.hidden = true;
  ui.collectMembersError.hidden = true;
  ui.collectMembersErrorText.textContent = '';
  ui.collectMembersBody.replaceChildren();
  ui.collectMembersStatus.textContent = '';
  ui.collectMembersCard.hidden = false;
  ui.collectInviteCard.hidden = false;
  ui.collectTabOverview.setAttribute('aria-selected', 'true');
  ui.collectTabCalendar.setAttribute('aria-selected', 'false');
  ui.collectOverview.hidden = false;
  ui.collectCalendar.hidden = true;
  ui.collectMonth.textContent = '';
  ui.collectTerm.textContent = '';
  ui.collectLegend.replaceChildren();
  ui.collectCalendarLoading.hidden = true;
  ui.collectCalendarError.hidden = true;
  ui.collectCalendarErrorText.textContent = '';
  ui.collectCalendarEmpty.hidden = true;
  ui.collectCalendarEmpty.textContent = '';
  ui.collectCalendarTable.hidden = true;
  ui.collectCalendarGrid.replaceChildren();
  ui.collectCalendarPagePrev.replaceChildren();
  ui.collectCalendarPageNext.replaceChildren();
  ui.collectCalendarPagePrev.dataset.state = '';
  ui.collectCalendarPageNext.dataset.state = '';
  ui.collectCalendarStatus.textContent = '';
  ui.collectDetailTitle.textContent = '选择日期';
  ui.collectDetailSub.textContent = '';
  ui.collectDetailBody.replaceChildren();
  const placeholder = document.createElement('p');
  placeholder.className = 'muted';
  placeholder.textContent = '点击上方日期查看每个节次的人数与名单。';
  ui.collectDetailBody.append(placeholder);
  ui.collectEventsEmpty.hidden = true;
  ui.collectEventsList.replaceChildren();
  ui.collectEventsStatus.textContent = '';
  for (const button of ui.collectFilters.querySelectorAll('button[data-filter]')) {
    const active = button.dataset.filter === 'all';
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-active', active);
  }
  ui.inviteMeta.textContent = '';
  ui.inviteGenerate.hidden = false;
  ui.inviteCodeBox.hidden = true;
  ui.inviteCode.textContent = '';
  ui.inviteStatus.textContent = '';
  collectSwipe?.reset();
}

function deactivateCollect() {
  resetCollectPage();
}

function collectExportBaseDate() {
  const teaching = collectHome?.teaching;
  if (!teaching) return null;
  return collectSelectedDate ?? todayInZone(teaching.timezone) ?? teaching.termStart ?? null;
}

function collectExportMonday() {
  const base = collectExportBaseDate();
  return base ? mondayOf(base) : null;
}

function renderCollectExportRange() {
  const teaching = collectHome?.teaching;
  if (!teaching) {
    ui.collectExportRange.textContent = '尚未设置教学周';
    ui.collectExport.setAttribute('aria-label', '尚未设置教学周，暂时无法导出课程表');
    return;
  }
  const monday = collectExportMonday();
  if (!monday) {
    ui.collectExportRange.textContent = '选择日期后可导出';
    ui.collectExport.setAttribute('aria-label', '选择日期后可导出课程表 Excel 文件');
    return;
  }
  const end = addDays(monday, 6);
  const range = monday.slice(0, 4) === end.slice(0, 4)
    ? `${monday.slice(5)} 至 ${end.slice(5)}`
    : `${monday} 至 ${end}`;
  ui.collectExportRange.textContent = `本周 ${range}`;
  ui.collectExport.setAttribute('aria-label', `导出 ${monday} 至 ${end} 的课程表 Excel 文件`);
}

function refreshCollectControls() {
  renderCollectExportRange();
  const busy = state.busy;
  const owner = state.route?.spaceId
    && collectVisible(findSpace(state.route.spaceId)?.role);
  const exportMonday = collectExportMonday();
  ui.collectRefresh.disabled = busy;
  ui.collectMembersRetry.disabled = busy;
  ui.collectExport.disabled = busy || !owner || collectExporting || !exportMonday;
  ui.collectPrev.disabled = busy || collectSwitching || !(collectTargetMonth ?? collectMonth);
  ui.collectToday.disabled = busy || collectSwitching || !collectHome?.teaching;
  ui.collectNext.disabled = busy || collectSwitching || !(collectTargetMonth ?? collectMonth);
  ui.collectCalendarRetry.disabled = busy || collectSwitching;
  ui.collectEventNew.disabled = busy || !collectSelectedDate;
  const invite = state.invite;
  ui.inviteGenerate.disabled = busy || !owner || !invite || invite.exists === true;
  ui.inviteRotate.disabled = busy || !owner || !invite?.exists || invite.revoked === true;
  ui.inviteRevoke.disabled = busy || !owner || !invite?.exists || invite.revoked === true;
  ui.inviteCopy.disabled = busy;
}

async function activateCollect(space, token) {
  const revision = state.dataRevision;
  const same = collectHomeSpaceId === space.id && Boolean(collectHome);
  if (same && collectRevision === revision && !ui.collectContent.hidden) return;
  if (!same) resetCollectPage();
  if (!collectVisible(space.role)) {
    ui.collectDenied.hidden = false;
    ui.collectContent.hidden = true;
    return;
  }
  ui.collectContent.hidden = false;
  ui.collectSummaryText.textContent = '正在读取收集进度…';
  refreshCollectControls();
  try {
    const home = await api(`/api/spaces/${space.id}/home`);
    if (state.routeToken !== token || state.route?.spaceId !== space.id || state.activePage !== 'collect') return;
    if (home.space?.role && !collectVisible(home.space.role)) {
      ui.collectContent.hidden = true;
      ui.collectDenied.hidden = false;
      return;
    }
    if (home.kind === 'legacy') {
      ui.collectLegacy.hidden = false;
      ui.collectMembersCard.hidden = true;
      ui.collectInviteCard.hidden = true;
      ui.collectSummary.hidden = true;
      ui.collectSummaryText.textContent = '该空间使用旧版整表提交，不提供收集进度。';
      return;
    }
    ui.collectSummary.hidden = false;
    const collection = home.collection ?? { total: 0, submitted: 0, unsubmitted: 0 };
    ui.collectSummaryText.textContent = '';
    collectHome = home;
    collectHomeSpaceId = space.id;
    collectRevision = revision;
    setCollectTab('overview');
    renderCollectionSummary(collection);
    void loadMembers(space.id, token);
    void loadInvite(space.id, token);
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== space.id || state.activePage !== 'collect') return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.collectSummaryText.textContent = `收集进度读取失败：${error.message}`;
    ui.collectMembersCard.hidden = true;
    ui.collectInviteCard.hidden = true;
  }
}

function renderCollectionSummary(summary) {
  ui.collectSummary.replaceChildren();
  ui.collectSummary.append(
    statCard('成员总数', String(summary.total ?? 0)),
    statCard('已提交', String(summary.submitted ?? 0), 'ok'),
    statCard('未提交', String(summary.unsubmitted ?? 0), 'warn'),
  );
}

function renderMembers() {
  ui.collectMembersBody.replaceChildren();
  const members = state.members?.members;
  if (!Array.isArray(members) || members.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = '暂无成员记录。';
    row.append(cell);
    ui.collectMembersBody.append(row);
    return;
  }
  for (const member of members) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = member.inSpaceName ?? '—';
    const role = document.createElement('td');
    role.textContent = roleLabel(member.role);
    const counts = document.createElement('td');
    counts.textContent = member.role === 'owner'
      ? (member.countsInCollection ? '已参与' : '未参与')
      : '计入';
    const status = document.createElement('td');
    status.textContent = member.hasSubmission ? '已提交' : '未提交';
    const share = document.createElement('td');
    share.textContent = member.share?.accepted === true
      ? '已确认'
      : member.share?.status === 'revoked' ? '已撤回' : '未确认';
    const joined = document.createElement('td');
    joined.textContent = formatDateTime(member.joinedAt);
    row.append(name, status, counts, share, role, joined);
    ui.collectMembersBody.append(row);
  }
}

function renderMembersError(message) {
  ui.collectMembersBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.textContent = `成员列表读取失败：${message} 可点击“重试”重新读取。`;
  row.append(cell);
  ui.collectMembersBody.append(row);
}

async function loadMembers(spaceId, token) {
  ui.collectMembersLoading.hidden = false;
  ui.collectMembersError.hidden = true;
  ui.collectMembersCard.hidden = false;
  try {
    const body = await api(`/api/spaces/${spaceId}/members`);
    if (state.routeToken !== token || state.route?.spaceId !== spaceId || state.activePage !== 'collect') return;
    state.members = body;
    renderMembers();
    if (body.summary) {
      renderCollectionSummary(body.summary);
      ui.collectSummaryText.textContent = '';
    }
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== spaceId || state.activePage !== 'collect') return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    state.members = null;
    renderMembersError(error.message);
  } finally {
    if (state.routeToken === token && state.activePage === 'collect') {
      ui.collectMembersLoading.hidden = true;
    }
  }
}

// ---- 收集日历、导出与空间事件 ----

const COLLECT_GROUPS = [
  { key: 'class', label: '有课', kind: 'class' },
  { key: 'busy', label: '忙碌', kind: 'busy' },
  { key: 'free', label: '没课/有空', kind: 'available' },
];
const COLLECT_PENDING = { key: 'pending', label: '待确认', kind: 'unknown' };
const PENDING_REASONS = { unsubmitted: '未提交', conflict: '冲突' };

function renderCollectLegend() {
  ui.collectLegend.replaceChildren();
  for (const item of [...COLLECT_GROUPS, COLLECT_PENDING]) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `legend-dot kind-${item.kind}`;
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    li.append(dot, label);
    ui.collectLegend.append(li);
  }
}

function collectDayTotals(day) {
  const totals = { class: 0, busy: 0, free: 0, pending: 0 };
  for (const period of day.periods ?? []) {
    for (const key of Object.keys(totals)) totals[key] += period.groups?.[key]?.count ?? 0;
  }
  return totals;
}

function collectStatsLabel(day) {
  const totals = collectDayTotals(day);
  const parts = COLLECT_GROUPS
    .filter((item) => totals[item.key] > 0)
    .map((item) => `${item.label} ${totals[item.key]} 人次`);
  if (totals.pending > 0) parts.push(`待确认 ${totals.pending} 人次`);
  return parts.join('，');
}

function collectCellLabel(day, weekNumber = null) {
  if (!day.inTerm) return `${day.date}，学期外`;
  const week = weekNumber === null || weekNumber === undefined ? '' : `，第 ${weekNumber} 周`;
  const stats = collectStatsLabel(day);
  return `${day.date}${week}，${stats || '无有效记录'}`;
}

function appendCollectStats(container, day) {
  if (!day?.inTerm) return;
  const totals = collectDayTotals(day);
  let shown = 0;
  for (const item of [...COLLECT_GROUPS, COLLECT_PENDING]) {
    if (totals[item.key] <= 0) continue;
    const stat = document.createElement('span');
    stat.className = `cal-stat kind-${item.kind}`;
    stat.title = `${item.label} ${totals[item.key]} 人次`;
    const dot = document.createElement('span');
    dot.className = 'cal-stat-dot';
    dot.setAttribute('aria-hidden', 'true');
    const num = document.createElement('span');
    num.className = 'cal-stat-num';
    num.textContent = String(totals[item.key]);
    stat.append(dot, num);
    container.append(stat);
    shown += 1;
  }
  if (shown === 0) {
    const empty = document.createElement('span');
    empty.className = 'cal-none';
    empty.textContent = '无记录';
    container.append(empty);
  }
}

function buildCollectCell(day, displayWeek = null) {
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
  button.setAttribute('aria-selected', String(day.date === collectSelectedDate));
  button.setAttribute('aria-label', collectCellLabel(day, displayWeek));
  button.dataset.date = day.date;
  if (day.isToday) button.classList.add('is-today');
  if (day.date === collectSelectedDate) button.classList.add('is-selected');
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
  appendCollectStats(stats, day);
  button.append(stats);

  const dayEvents = collectEventsOnDate(day.date);
  if (dayEvents.length > 0) {
    button.classList.add('has-events');
    button.setAttribute('aria-label', `${collectCellLabel(day, displayWeek)}；${dayEvents.length} 个可见事件`);
    const badge = document.createElement('span');
    badge.className = 'cal-event-badge';
    badge.textContent = `事件 ${dayEvents.length}`;
    button.append(badge);
  }
  button.addEventListener('click', () => { selectCollectDate(day.date); });
  return button;
}

function selectCollectDate(date) {
  collectSelectedDate = date;
  for (const cell of ui.collectCalendarGrid.querySelectorAll('button.cal-cell')) {
    const isSelected = cell.dataset.date === date;
    cell.classList.toggle('is-selected', isSelected);
    cell.setAttribute('aria-selected', String(isSelected));
  }
  renderCollectDetail();
  renderCollectEvents();
  refreshCollectControls();
}

function collectDayByDate(date) {
  return (collectMonthData?.days ?? []).find((day) => day.date === date) ?? null;
}

function collectWeekday(date) {
  return WEEKDAY_LABELS[(weekdayMon1(date) ?? 1) - 1];
}

function renderCollectCalendar() {
  if (!collectMonthData) return;
  ui.collectMonth.textContent = monthLabel(collectMonth);
  const summary = monthTermSummary(collectMonthData.days);
  ui.collectTerm.textContent = summary || '本月不在学期范围内';
  renderCollectLegend();
  const byDate = new Map((collectMonthData.days ?? []).map((day) => [day.date, day]));
  const weeks = monthWeeks(collectMonth);
  ui.collectCalendarGrid.replaceChildren();
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
      row.append(buildCollectCell(day, weekNumber));
    }
    ui.collectCalendarGrid.append(row);
  }
  ui.collectCalendarTable.hidden = weeks.length === 0;
  ui.collectCalendarEmpty.hidden = weeks.length > 0;
  if (weeks.length === 0) ui.collectCalendarEmpty.textContent = '该月份没有可显示的日期。';
  ui.collectCalendarStatus.textContent = `本月 ${collectMonthData.days?.length ?? 0} 天。`;
}

function monthDirectionBetween(from, to) {
  if (!validMonth(from) || !validMonth(to) || from === to) return null;
  return to > from ? 'next' : 'prev';
}

function collectCacheKey(monthValue) {
  return `${state.route?.spaceId ?? ''}:${monthValue}`;
}

function readCollectCacheEntry(monthValue) {
  const key = collectCacheKey(monthValue);
  const hit = collectMonthCache.get(key);
  if (!hit || hit.revision !== state.dataRevision) return null;
  collectMonthCache.delete(key);
  collectMonthCache.set(key, hit);
  return hit;
}

function readCollectCache(monthValue) {
  return readCollectCacheEntry(monthValue)?.body ?? null;
}

function writeCollectCache(monthValue, body, revision) {
  collectMonthCache.set(collectCacheKey(monthValue), { body, revision, at: Date.now() });
  while (collectMonthCache.size > COLLECT_CACHE_LIMIT) {
    const oldest = collectMonthCache.keys().next().value;
    collectMonthCache.delete(oldest);
  }
}

function pauseCollectPrefetch() {
  collectPrefetchQueue = [];
  if (collectPrefetchController) {
    collectPrefetchController.abort();
    collectPrefetchController = null;
  }
}

function abortCollectPreload(exceptTarget = null) {
  if (!collectPreloadRequest || collectPreloadRequest.target === exceptTarget) return;
  collectPreloadRequest.controller.abort();
  collectPreloadRequest = null;
}

// 手势目标确定后立即取收集月数据，与吸附动画并行；只写缓存，不提前替换当前月。
function preloadCollectMonth(target) {
  const spaceId = state.route?.spaceId;
  if (!spaceId || !collectHome?.teaching || !validMonth(target)) return;
  if (readCollectCache(target) || collectActiveRequest?.target === target) return;
  if (collectPreloadRequest?.target === target) return;
  abortCollectPreload(target);
  const routeToken = state.routeToken;
  const revision = state.dataRevision;
  const epoch = collectCacheEpoch;
  const controller = new AbortController();
  const entry = { target, controller, promise: null };
  entry.promise = (async () => {
    try {
      const body = await api(`/api/spaces/${spaceId}/collection?month=${encodeURIComponent(target)}`, {
        signal: controller.signal,
      });
      if (epoch !== collectCacheEpoch || state.routeToken !== routeToken || state.route?.spaceId !== spaceId
        || state.activePage !== 'collect' || state.dataRevision !== revision || controller.signal.aborted) return null;
      writeCollectCache(target, body, revision);
      return body;
    } catch {
      return null;
    } finally {
      if (collectPreloadRequest === entry) collectPreloadRequest = null;
    }
  })();
  collectPreloadRequest = entry;
}

// 过期缓存先显示，再静默核对；只有仍在当前月且内容变化时才重绘。
async function revalidateCollectMonth(target, { preferDate = null, revision } = {}) {
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const key = collectCacheKey(target);
  if (collectRevalidating.has(key)) return;
  const routeToken = state.routeToken;
  const epoch = collectCacheEpoch;
  const controller = new AbortController();
  collectRevalidating.set(key, controller);
  try {
    const body = await api(`/api/spaces/${spaceId}/collection?month=${encodeURIComponent(target)}`, {
      signal: controller.signal,
    });
    if (epoch !== collectCacheEpoch || state.routeToken !== routeToken || state.route?.spaceId !== spaceId
      || state.activePage !== 'collect' || state.dataRevision !== revision) return;
    writeCollectCache(target, body, revision);
    if (collectMonth === target && !collectSwitching && !state.busy && !collectSwipe?.isBusy()
      && JSON.stringify(body) !== JSON.stringify(collectMonthData)) {
      applyCollectMonthBody(body, {
        preferDate: preferDate ?? collectSelectedDate, silent: true, neighbors: false,
      });
    }
  } catch {
    // 静默核对失败保留现有内容；刷新按钮与重新进入仍会真实报错。
  } finally {
    if (collectRevalidating.get(key) === controller) collectRevalidating.delete(key);
  }
}

function pickCollectDate(body, preferDate) {
  const days = body.days ?? [];
  const preferred = preferDate && days.some((day) => day.date === preferDate) ? preferDate : null;
  const current = collectSelectedDate && days.some((day) => day.date === collectSelectedDate)
    ? collectSelectedDate
    : null;
  return preferred ?? current
    ?? days.find((day) => day.isToday)?.date
    ?? days.find((day) => day.inTerm)?.date
    ?? days[0]?.date
    ?? null;
}

function buildCollectPreviewCell(date, day, body, displayWeek = null) {
  const cell = document.createElement('span');
  cell.className = 'cal-cell';
  cell.setAttribute('role', 'gridcell');
  if (!date) {
    cell.classList.add('is-empty');
    cell.setAttribute('aria-hidden', 'true');
    return cell;
  }
  const teaching = collectHome?.teaching;
  const inTerm = day ? day.inTerm : Boolean(teaching && date >= teaching.termStart && date <= teaching.termEnd);
  const today = todayInZone(teaching?.timezone);
  const isToday = day ? Boolean(day.isToday) : date === today;
  cell.dataset.date = date;
  if (isToday) cell.classList.add('is-today');
  if (!inTerm) cell.classList.add('is-term-out');

  const head = document.createElement('span');
  head.className = 'cal-cell-head';
  const number = document.createElement('span');
  number.className = 'cal-day-num';
  number.textContent = String(Number(date.slice(8, 10)));
  head.append(number);
  if (isToday) {
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
  appendCollectStats(stats, day);
  cell.append(stats);

  const events = day ? collectEventsOn(body, date) : [];
  if (events.length > 0) {
    cell.classList.add('has-events');
    const badge = document.createElement('span');
    badge.className = 'cal-event-badge';
    badge.textContent = `事件 ${events.length}`;
    cell.append(badge);
  }
  return cell;
}

function renderCollectNeighborPage(container, target) {
  if (!container) return;
  container.replaceChildren();
  container.dataset.state = '';
  container.removeAttribute('data-label');
  if (!target || !validMonth(target)) {
    container.dataset.state = 'blocked';
    container.dataset.label = '没有更多月份';
    container.setAttribute('aria-label', '没有更多月份');
    return;
  }
  container.setAttribute('aria-label', `${monthLabel(target)}，未激活页`);
  const body = readCollectCache(target);
  const byDate = new Map((body?.days ?? []).map((day) => [day.date, day]));
  const teaching = collectHome?.teaching;
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
      row.append(buildCollectPreviewCell(date, day, body, weekNumber));
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

function renderCollectNeighborPages() {
  if (!collectMonth || !collectHome?.teaching) return;
  renderCollectNeighborPage(ui.collectCalendarPagePrev, shiftMonth(collectMonth, -1));
  renderCollectNeighborPage(ui.collectCalendarPageNext, shiftMonth(collectMonth, 1));
}

function applyCollectMonthBody(body, {
  preferDate = null, silent = false, neighbors = true, direction = null,
} = {}) {
  collectMonthData = body;
  collectMonth = body.month;
  collectTargetMonth = body.month;
  collectRetryTarget = null;
  collectHome = { ...collectHome, config: body.config, teaching: body.teaching };
  collectSelectedDate = pickCollectDate(body, preferDate);
  collectEventsStatus = '';
  ui.collectCalendarTable.removeAttribute('aria-busy');
  ui.collectCalendarLoading.hidden = true;
  ui.collectCalendarError.hidden = true;
  ui.collectCalendarEmpty.hidden = true;
  renderCollectCalendar();
  renderCollectDetail();
  renderCollectEvents();
  refreshCollectControls();
  if (!silent && direction) animateCollectMonth(direction);
  if (neighbors) {
    renderCollectNeighborPages();
    collectSwipe?.center();
  }
  scheduleCollectPrefetch();
}

function buildCollectPrefetchQueue() {
  const teaching = collectHome?.teaching;
  if (!state.route?.spaceId || !collectMonth || !teaching) return;
  if (collectSwitching || state.busy || state.activePage !== 'collect'
    || collectSwipe?.isDragging() || collectSwipe?.isBusy()) return;
  const wanted = [];
  for (const distance of [1, 2]) {
    for (const dir of [-1, 1]) {
      const target = shiftMonth(collectMonth, dir * distance);
      if (!validMonth(target) || wanted.includes(target)) continue;
      if (readCollectCache(target)) continue;
      wanted.push(target);
    }
  }
  collectPrefetchQueue = wanted;
  void runCollectPrefetchQueue();
}

// 单并发预取：先 ±1，空闲后 ±2；切月/手势开始时暂停，避免和当前请求抢资源。
async function runCollectPrefetchQueue() {
  if (collectPrefetchRunning || !collectMonth) return;
  if (collectSwitching || state.busy || state.activePage !== 'collect'
    || collectSwipe?.isDragging() || collectSwipe?.isBusy()) return;
  const target = collectPrefetchQueue.shift();
  if (!target) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  if (readCollectCache(target)) {
    void runCollectPrefetchQueue();
    return;
  }
  const routeToken = state.routeToken;
  const revision = state.dataRevision;
  const epoch = collectCacheEpoch;
  const controller = new AbortController();
  collectPrefetchRunning = true;
  collectPrefetchController = controller;
  try {
    const body = await api(`/api/spaces/${spaceId}/collection?month=${encodeURIComponent(target)}`, {
      signal: controller.signal,
    });
    if (epoch !== collectCacheEpoch || state.routeToken !== routeToken || state.route?.spaceId !== spaceId
      || state.activePage !== 'collect' || state.dataRevision !== revision) return;
    writeCollectCache(target, body, revision);
    if (!collectSwipe?.isDragging() && !collectSwipe?.isBusy()
      && (target === shiftMonth(collectMonth, -1) || target === shiftMonth(collectMonth, 1))) {
      renderCollectNeighborPages();
    }
  } catch {
    // 预取失败静默；目标月读取仍会报真实错误。
  } finally {
    if (collectPrefetchController === controller) collectPrefetchController = null;
    collectPrefetchRunning = false;
    if (collectPrefetchQueue.length && !collectSwitching && !state.busy) scheduleCollectPrefetch(160);
  }
}

function scheduleCollectPrefetch(timeout = 600) {
  if (collectPrefetchTimer) window.clearTimeout(collectPrefetchTimer);
  const run = () => {
    collectPrefetchTimer = 0;
    buildCollectPrefetchQueue();
  };
  collectPrefetchTimer = typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(run, { timeout })
    : window.setTimeout(run, Math.min(timeout, 200));
}

async function commitCollectSwipe(delta) {
  if (!collectHome?.teaching || !collectMonth) return false;
  const target = shiftMonth(collectMonth, delta);
  if (!target || !validMonth(target)) return false;
  pauseCollectPrefetch();
  const cached = readCollectCache(target);
  const previous = {
    term: ui.collectTerm.textContent,
    status: ui.collectCalendarStatus.textContent,
  };
  collectSwitching = true;
  refreshCollectControls();
  // 缓存命中直接替换内容；未命中时保留旧月标题与网格，只显示状态，避免新旧错配。
  if (!cached) {
    ui.collectCalendarStatus.textContent = '';
  }
  let ok = false;
  try {
    ok = await loadCollectCalendar(target, { preferDate: null, silent: true, neighbors: false });
  } finally {
    collectSwitching = false;
    refreshCollectControls();
    if (!ok && collectMonth) {
      ui.collectMonth.textContent = monthLabel(collectMonth);
      ui.collectTerm.textContent = previous.term;
      ui.collectCalendarStatus.textContent = previous.status;
    }
  }
  return ok;
}

function collectMemberNode(entry, variant, periodContext = null) {  if (typeof entry === 'string') return document.createTextNode(entry);
  const wrap = document.createElement('span');
  wrap.className = 'collect-member-wrap';
  const chip = document.createElement('span');
  chip.className = 'collect-member';
  let text = entry.name;
  if (entry.courseName) text += `（${entry.courseName}）`;
  if (variant === 'free') {
    if (entry.declared) {
      chip.classList.add('is-declared');
      text += '（主动）';
    } else {
      chip.classList.add('is-default');
    }
  } else if (variant === 'pending') {
    chip.classList.add('is-pending');
    text += `（${PENDING_REASONS[entry.reason] ?? '待确认'}）`;
  }
  if (Array.isArray(entry.sources) && entry.sources.length > 0) {
    text += `（${entry.sources.map((source) => source.label).join('、')}）`;
  }
  chip.textContent = text;
  wrap.append(chip);
  if (periodContext && entry.userId && entry.userId !== state.user?.id && variant !== 'pending') {
    const arrange = document.createElement('button');
    arrange.type = 'button';
    arrange.className = 'mini-action ghost';
    arrange.textContent = '安排';
    arrange.setAttribute('aria-label',
      `安排 ${entry.name} ${periodContext.date} 第 ${periodContext.period} 节的时间`);
    arrange.disabled = state.busy;
    arrange.addEventListener('click', (event) => {
      event.stopPropagation();
      openArrangementDialog({
        targetUserId: entry.userId,
        name: entry.name,
        date: periodContext.date,
        period: periodContext.period,
        start: periodContext.start,
        end: periodContext.end,
      });
    });
    wrap.append(arrange);
  }
  return wrap;
}

function collectGroup(label, entries, variant, periodContext = null) {
  const p = document.createElement('p');
  p.className = 'collect-group';
  const strong = document.createElement('strong');
  strong.textContent = `${label}：`;
  const list = document.createElement('span');
  entries.forEach((entry, index) => {
    if (index > 0) list.append('、');
    list.append(collectMemberNode(entry, variant, periodContext));
  });
  p.append(strong, list);
  return p;
}

function collectPendingDetails(pending) {
  const details = document.createElement('details');
  details.className = 'collect-pending';
  const summary = document.createElement('summary');
  const reasons = Object.entries(PENDING_REASONS)
    .map(([key, label]) => [label, pending.members.filter((member) => member.reason === key).length])
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join('、');
  summary.textContent = `${COLLECT_PENDING.label} ${pending.count}${reasons ? `（${reasons}）` : ''}`;
  details.append(summary);
  if (pending.members.length > 0) details.append(collectGroup('待确认名单', pending.members, 'pending'));
  return details;
}

function renderCollectDetail() {
  const day = collectDayByDate(collectSelectedDate);
  if (!day) {
    ui.collectDetailTitle.textContent = '选择日期';
    ui.collectDetailSub.textContent = '';
    ui.collectDetailBody.replaceChildren();
    const placeholder = document.createElement('p');
    placeholder.className = 'muted';
    placeholder.textContent = '点击上方日期查看每个节次的三个主分组与待确认入口。';
    ui.collectDetailBody.append(placeholder);
    return;
  }
  const weekText = !day.inTerm
    ? '学期外'
    : (day.weekNumber === null ? '教学周外' : `第 ${day.weekNumber} 教学周`);
  ui.collectDetailTitle.textContent = `${day.date} · ${collectWeekday(day.date)} · ${weekText}`;
  ui.collectDetailSub.textContent = '浅色是没课，深色是主动有空；未提交与冲突见待确认。';
  ui.collectDetailBody.replaceChildren();

  if (!day.inTerm || day.periods.length === 0) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = '学期外日期没有课次统计。';
    ui.collectDetailBody.append(note);
    return;
  }

  const list = document.createElement('div');
  list.className = 'detail-periods collect-detail-periods';
  for (const period of day.periods) {
    const groups = period.groups ?? {};
    const pending = groups.pending ?? { count: 0, members: [] };
    const row = document.createElement('div');
    row.className = 'detail-period collect-detail-period';
    const slot = document.createElement('span');
    slot.className = 'detail-slot';
    const title = document.createElement('strong');
    title.textContent = `第 ${period.period} 节`;
    const time = document.createElement('small');
    time.textContent = `${period.time.start}–${period.time.end}`;
    slot.append(title, time);

    const main = document.createElement('div');
    main.className = 'detail-main collect-detail-main';
    const counts = document.createElement('div');
    counts.className = 'collect-counts';
    for (const item of COLLECT_GROUPS) {
      const tag = document.createElement('span');
      tag.className = `cal-token kind-${item.kind}`;
      tag.textContent = `${item.label} ${groups[item.key]?.count ?? 0}`;
      counts.append(tag);
    }
    if (pending.count > 0) {
      const tag = document.createElement('span');
      tag.className = `cal-token kind-${COLLECT_PENDING.kind}`;
      tag.textContent = `${COLLECT_PENDING.label} ${pending.count}`;
      counts.append(tag);
    }
    main.append(counts);

    const visible = collectFilter === 'all'
      ? COLLECT_GROUPS
      : COLLECT_GROUPS.filter((item) => item.key === collectFilter);
    for (const item of visible) {
      const group = groups[item.key];
      if (!group || group.count === 0) continue;
      let label = item.label;
      if (item.key === 'free') {
        const noClassCount = group.count - group.declaredCount;
        label = group.declaredCount > 0
          ? `没课 ${noClassCount} · 有空 ${group.declaredCount}`
          : `没课 ${noClassCount}`;
      }
      main.append(collectGroup(label, group.members, item.key, {
        date: day.date,
        period: period.period,
        start: period.time.start,
        end: period.time.end,
      }));
    }
    if (pending.count > 0) main.append(collectPendingDetails(pending));
    row.append(slot, main);
    list.append(row);
  }
  ui.collectDetailBody.append(list);
}

function collectEventsOn(body, date) {
  if (!date) return [];
  return (body?.events ?? [])
    .filter((event) => event.startDate <= date && event.endDate >= date);
}

function collectEventsOnDate(date) {
  return collectEventsOn(collectMonthData, date);
}

function eventMetaText(event) {
  const time = event.allDay === true
    ? '全天'
    : `${event.startTime ?? '—'}–${event.endTime ?? '—'}`;
  const span = event.endDate && event.endDate !== event.startDate
    ? `${event.startDate} 至 ${event.endDate}`
    : event.startDate;
  const visibility = event.visibility === 'space'
    ? '全空间'
    : event.visibility === 'invitees' ? '受邀成员' : '仅自己';
  const recipient = event.recipientScope === 'none'
    ? '不通知'
    : `接收人 ${event.recipientCount ?? 0} 位`;
  return `${span} · ${time} · ${visibility} · ${recipient}`;
}

function renderCollectEvents() {
  ui.collectEventsList.replaceChildren();
  const events = collectEventsOnDate(collectSelectedDate);
  ui.collectEventsEmpty.hidden = events.length > 0;
  ui.collectEventsEmpty.textContent = collectSelectedDate ? '所选日期没有事件。' : '请先选择日期。';
  for (const event of events) {
    const card = document.createElement('div');
    card.className = 'event-card';
    const head = document.createElement('div');
    head.className = 'event-card-head';
    const title = document.createElement('strong');
    title.textContent = event.title;
    head.append(title);
    if (event.editable === true) {
      const actions = document.createElement('div');
      actions.className = 'actions compact';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost small';
      edit.textContent = '编辑';
      edit.setAttribute('aria-label', `编辑事件 ${event.title}`);
      edit.addEventListener('click', () => { openEventDialog(event); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger small';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除事件 ${event.title}`);
      remove.addEventListener('click', () => { void deleteEventAction(event); });
      actions.append(edit, remove);
      head.append(actions);
    }
    const meta = document.createElement('p');
    meta.className = 'note';
    meta.textContent = eventMetaText(event);
    card.append(head, meta);
    if (event.assignmentSummary && event.createdByViewer === true) {
      const s = event.assignmentSummary;
      const summary = document.createElement('p');
      summary.className = 'note';
      summary.textContent = `确认进度：待确认 ${s.pending} · 已接受 ${s.accepted} · 已拒绝 ${s.rejected} · 已撤回 ${s.withdrawn}`
        + (s.requiresReconfirm > 0 ? ` · 改期待重新确认 ${s.requiresReconfirm}` : '');
      card.append(summary);
    }
    if (event.description) {
      const text = document.createElement('p');
      text.className = 'event-description';
      text.textContent = event.description;
      card.append(text);
    }
    ui.collectEventsList.append(card);
  }
  ui.collectEventsStatus.textContent = collectEventsStatus;
}

function animateCollectMonth(direction) {
  if (!direction) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
  ui.collectCalendarTable.classList.remove('slide-next', 'slide-prev');
  void ui.collectCalendarTable.offsetWidth;
  ui.collectCalendarTable.classList.add(direction === 'next' ? 'slide-next' : 'slide-prev');
  window.setTimeout(() => {
    ui.collectCalendarTable.classList.remove('slide-next', 'slide-prev');
  }, 700);
}

async function loadCollectCalendar(target, {
  preferDate = null, silent = false, neighbors = true, force = false,
} = {}) {
  const spaceId = state.route?.spaceId;
  if (!spaceId || !validMonth(target)) return false;
  if (collectActiveRequest && collectActiveRequest.target === target && !force) {
    collectTargetMonth = target;
    return collectActiveRequest.outcome;
  }
  const routeToken = state.routeToken;
  const request = ++collectMonthToken;
  const previousMonth = collectMonth;
  collectTargetMonth = target;
  collectEventsStatus = '';
  if (!force) {
    const cached = readCollectCacheEntry(target);
    if (cached) {
      const direction = previousMonth && previousMonth !== cached.body.month
        ? monthDirectionBetween(previousMonth, cached.body.month)
        : null;
      applyCollectMonthBody(cached.body, { preferDate, silent, neighbors, direction });
      if (Date.now() - cached.at > COLLECT_CACHE_FRESH_MS) {
        void revalidateCollectMonth(target, { preferDate, revision: state.dataRevision });
      }
      return true;
    }
  }
  abortCollectPreload(target);
  let preloadEntry = null;
  if (!force && collectPreloadRequest?.target === target) {
    preloadEntry = collectPreloadRequest;
  } else if (!force) {
    const late = readCollectCacheEntry(target);
    if (late) {
      const direction = previousMonth && previousMonth !== late.body.month
        ? monthDirectionBetween(previousMonth, late.body.month)
        : null;
      applyCollectMonthBody(late.body, { preferDate, silent, neighbors, direction });
      if (Date.now() - late.at > COLLECT_CACHE_FRESH_MS) {
        void revalidateCollectMonth(target, { preferDate, revision: state.dataRevision });
      }
      return true;
    }
  }
  const hasData = Boolean(collectMonthData && collectMonth);
  if (!hasData) {
    ui.collectCalendarLoading.hidden = false;
    ui.collectCalendarError.hidden = true;
    ui.collectCalendarEmpty.hidden = true;
    ui.collectCalendarTable.hidden = true;
  } else {
    ui.collectCalendarTable.setAttribute('aria-busy', 'true');
    ui.collectCalendarStatus.textContent = `正在切换至 ${monthLabel(target)}…`;
  }
  pauseCollectPrefetch();
  collectActiveRequest?.controller.abort();
  const controller = new AbortController();
  const entry = { target, controller, outcome: null };
  collectActiveRequest = entry;
  const revision = state.dataRevision;
  const fetchMonth = () => api(`/api/spaces/${spaceId}/collection?month=${encodeURIComponent(target)}`, {
    signal: controller.signal,
  });
  entry.outcome = (async () => {
    try {
      const body = preloadEntry
        ? await preloadEntry.promise.then((value) => value ?? fetchMonth())
        : await fetchMonth();
      if (collectActiveRequest === entry) collectActiveRequest = null;
      if (state.routeToken !== routeToken || state.route?.spaceId !== spaceId
        || state.activePage !== 'collect' || request !== collectMonthToken || collectTargetMonth !== target) return false;
      writeCollectCache(target, body, revision);
      const direction = previousMonth && previousMonth !== body.month
        ? monthDirectionBetween(previousMonth, body.month)
        : null;
      applyCollectMonthBody(body, { preferDate, silent, neighbors, direction });
      return true;
    } catch (error) {
      if (collectActiveRequest === entry) collectActiveRequest = null;
      if (controller.signal.aborted) return false;
      if (state.routeToken !== routeToken || state.route?.spaceId !== spaceId
        || state.activePage !== 'collect' || request !== collectMonthToken || collectTargetMonth !== target) return false;
      ui.collectCalendarTable.removeAttribute('aria-busy');
      ui.collectCalendarLoading.hidden = true;
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized();
        return false;
      }
      if (hasData) {
        collectRetryTarget = target;
        collectTargetMonth = collectMonth;
        ui.collectCalendarErrorText.textContent = `收集日历读取失败：${error.message}`;
        ui.collectCalendarError.hidden = false;
        ui.collectCalendarStatus.textContent = `切换至 ${monthLabel(target)} 失败：${error.message}；仍显示 ${monthLabel(collectMonth)}。`;
        refreshCollectControls();
        return false;
      }
      collectMonthData = null;
      ui.collectCalendarTable.hidden = true;
      ui.collectCalendarErrorText.textContent = `收集日历读取失败：${error.message}`;
      ui.collectCalendarError.hidden = false;
      ui.collectCalendarStatus.textContent = '';
      refreshCollectControls();
      return false;
    }
  })();
  return entry.outcome;
}

function exportFilenameFrom(disposition, fallback) {
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (extended) {
    try { return decodeURIComponent(extended[1]); } catch { /* 使用 ASCII 降级文件名 */ }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition) ?? /filename=([^;]+)/i.exec(disposition);
  return plain ? plain[1].trim() : fallback;
}

async function exportCollectWeek() {
  if (state.busy || collectExporting || !state.route?.spaceId) return;
  if (!collectHome?.teaching) {
    ui.collectSummaryText.textContent = '负责人尚未设置教学周，暂时无法导出。';
    return;
  }
  const spaceId = state.route.spaceId;
  const monday = collectExportMonday();
  if (!monday) {
    ui.collectSummaryText.textContent = '无法确定导出周，请先选择有效日期。';
    return;
  }
  const spaceAtStart = spaceId;
  collectExporting = true;
  setBusy(true);
  refreshCollectControls();
  const target = collectTab === 'calendar' ? ui.collectCalendarStatus : ui.collectMembersStatus;
  target.textContent = '正在生成并下载课程表…';
  try {
    const response = await fetch(`${API}/api/spaces/${spaceAtStart}/collection/export?week=${encodeURIComponent(monday)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    });
    if (!response.ok) {
      let code = 'export_failed';
      try {
        const body = await response.json();
        if (typeof body?.error === 'string') code = body.error;
      } catch {
        code = 'export_failed';
      }
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      throw new ApiError(MESSAGES[code] ?? MESSAGES.export_failed, code, response.status);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const spaceName = String(collectHome?.space?.name ?? '空间').replace(/[\\/:*?"<>|]/g, '_');
    const filename = exportFilenameFrom(disposition,
      `${spaceName}_课程表_${monday}至${addDays(monday, 6)}.xlsx`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
    target.textContent = `已下载 ${filename}（7 张工作表：周一至周日；没课不代表有空参加活动）。`;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    target.textContent = `导出失败：${error.message}`;
  } finally {
    collectExporting = false;
    setBusy(false);
    refreshCollectControls();
  }
}

function setEventStatus(message) {
  ui.eventStatus.textContent = message;
  ui.eventStatus.hidden = !message;
}

function eventVisibilityValue() {
  return ui.eventDialog.querySelector('input[name="event-visibility"]:checked')?.value ?? 'private';
}

function eventScopeValue() {
  return ui.eventDialog.querySelector('input[name="event-recipient-scope"]:checked')?.value ?? 'none';
}

function setEventScope(scope) {
  for (const radio of ui.eventDialog.querySelectorAll('input[name="event-recipient-scope"]')) {
    radio.checked = radio.value === scope;
  }
}

function renderEventRecipientOptions() {
  ui.eventRecipients.replaceChildren();
  const roster = Array.isArray(collectMonthData?.roster) ? collectMonthData.roster : [];
  const candidates = roster.filter((person) => person.userId !== state.user?.id);
  if (candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = '暂无可选成员；请先在收集日历读取成员名单。';
    ui.eventRecipients.append(empty);
    return;
  }
  for (const person of candidates) {
    const label = document.createElement('label');
    label.className = 'check-line';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = person.userId;
    input.name = 'event-recipient';
    const text = document.createElement('span');
    text.textContent = person.role === 'owner' ? `${person.name}（负责人）` : person.name;
    label.append(input, text);
    ui.eventRecipients.append(label);
  }
}

function syncEventDialog() {
  const singleDay = ui.eventSingleDay.checked;
  ui.eventEndField.hidden = singleDay;
  ui.eventTimeRow.hidden = ui.eventAllDay.checked;
  const visibility = eventVisibilityValue();
  const editing = Boolean(eventEditing);
  const hasRecipients = (eventEditing?.recipientCount ?? 0) > 0;
  const scope = editing ? (eventEditing?.recipientScope ?? 'none') : eventScopeValue();
  if (!editing && visibility === 'private' && scope !== 'none') {
    setEventScope('none');
  }
  if (!editing && visibility === 'invitees' && eventScopeValue() === 'none') {
    setEventScope('selected');
  }
  const currentScope = editing ? scope : eventScopeValue();

  for (const radio of ui.eventDialog.querySelectorAll('input[name="event-visibility"]')) {
    const lockedPrivate = editing && radio.value === 'private' && hasRecipients;
    const lockedInvitees = editing && radio.value === 'invitees' && !hasRecipients;
    radio.disabled = lockedPrivate || lockedInvitees;
  }
  for (const radio of ui.eventDialog.querySelectorAll('input[name="event-recipient-scope"]')) {
    radio.disabled = editing || visibility === 'private';
    if (!editing && visibility === 'private') radio.checked = radio.value === 'none';
  }
  ui.eventRecipients.hidden = currentScope !== 'selected' || editing;
  if (!editing && currentScope === 'selected' && ui.eventRecipients.childElementCount === 0) {
    renderEventRecipientOptions();
  }
  const selectedCount = ui.eventRecipients.querySelectorAll('input[name="event-recipient"]:checked').length;

  ui.eventVisibilityNote.textContent = visibility === 'space'
    ? '全空间成员可见标题、日期与说明；切回仅自己后不再返回。'
    : visibility === 'invitees'
      ? '仅接收人可见；拒绝或撤回后不再返回。'
      : '仅自己可见；不计入其他成员的日历、统计或导出。';
  let recipientNote = '';
  if (editing) {
    recipientNote = hasRecipients
      ? `已有接收人 ${eventEditing.recipientCount} 位；编辑时不能更改接收范围，可新建事件重新通知。`
      : '该事件没有接收人；编辑时不能新增接收范围，可新建事件重新通知。';
  } else if (visibility === 'private') {
    recipientNote = '仅自己可见的事件不发送通知；如需通知，请改为“全空间”或“受邀成员”。';
  } else if (currentScope === 'none') {
    recipientNote = '不通知：事件按可见性展示，但不会生成待确认安排。';
  } else if (currentScope === 'all') {
    recipientNote = '发给当前全体成员（不含你本人）；之后加入的成员不会自动收到。';
  } else {
    recipientNote = `已选择 ${selectedCount} 位成员；请至少选择一位，成员确认后才会占用节次。`;
  }
  ui.eventRecipientNote.textContent = recipientNote;
}

function syncEventSingleDay() {
  if (ui.eventSingleDay.checked) {
    eventFields.end.setValue(eventFields.start.value());
  }
  syncEventDialog();
}

function openEventDialog(event = null) {
  if (state.busy || collectSwitching || state.activePage !== 'collect') return;
  eventEditing = event;
  const baseDate = collectSelectedDate
    ?? todayInZone(collectHome?.teaching?.timezone ?? 'Asia/Shanghai')
    ?? null;
  const startDate = event?.startDate ?? baseDate;
  const endDate = event?.endDate ?? startDate;
  ui.eventTitle.textContent = event ? '编辑事件' : '新建事件';
  ui.eventRule.textContent = event
    ? '修改会立即生效。'
    : `默认仅自己可见；开始日期取自当前选择${baseDate ? ` ${baseDate}` : ''}。`;
  ui.eventName.value = event?.title ?? '';
  eventFields.start.setValue(startDate ?? '');
  eventFields.end.setValue(endDate ?? '');
  ui.eventSingleDay.checked = !event || event.startDate === event.endDate;
  ui.eventAllDay.checked = event ? event.allDay === true : true;
  ui.eventStartTime.value = event?.startTime ?? '';
  ui.eventEndTime.value = event?.endTime ?? '';
  ui.eventDescription.value = event?.description ?? '';
  const visibility = event?.visibility ?? 'private';
  for (const radio of ui.eventDialog.querySelectorAll('input[name="event-visibility"]')) {
    radio.checked = radio.value === visibility;
  }
  setEventScope(event?.recipientScope ?? 'none');
  renderEventRecipientOptions();
  setEventStatus('');
  syncEventDialog();
  ui.eventDialog.showModal();
  ui.eventName.focus();
}

function closeEventDialog() {
  if (ui.eventDialog.open) ui.eventDialog.close('cancel');
  eventEditing = null;
}

function readEventForm() {
  const title = ui.eventName.value.trim();
  if (!title) return { ok: false, message: '请填写事件标题。' };
  if ([...title].length > 100) return { ok: false, message: '事件标题最多 100 个字符。' };
  const description = ui.eventDescription.value.trim();
  if ([...description].length > 500) return { ok: false, message: '事件说明最多 500 个字符。' };
  const startDate = eventFields.start.value();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { ok: false, message: '请选择开始日期。' };
  const singleDay = ui.eventSingleDay.checked;
  const endDate = singleDay ? startDate : eventFields.end.value();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { ok: false, message: '请选择结束日期。' };
  if (endDate < startDate) return { ok: false, message: '结束日期不能早于开始日期。' };
  const allDay = ui.eventAllDay.checked;
  const startTime = allDay ? null : ui.eventStartTime.value.trim();
  const endTime = allDay ? null : ui.eventEndTime.value.trim();
  if (!allDay) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      return { ok: false, message: '请填写 HH:MM 格式的开始与结束时间。' };
    }
    if (endTime <= startTime) return { ok: false, message: '结束时间须晚于开始时间。' };
  }
  const visibility = eventVisibilityValue();
  const recipientScope = eventEditing
    ? (eventEditing.recipientScope ?? 'none')
    : eventScopeValue();
  const recipients = recipientScope === 'selected'
    ? [...ui.eventRecipients.querySelectorAll('input[name="event-recipient"]:checked')]
      .map((input) => input.value)
    : [];
  if (!eventEditing && visibility === 'private' && recipientScope !== 'none') {
    return { ok: false, message: '仅自己可见的事件不能发送通知；请改为全空间或受邀成员。' };
  }
  if (!eventEditing && visibility === 'invitees' && recipientScope === 'none') {
    return { ok: false, message: '“受邀成员”需要至少一位接收人。' };
  }
  if (eventEditing && visibility === 'invitees' && (eventEditing.recipientCount ?? 0) === 0) {
    return { ok: false, message: '该事件没有接收人，不能设为“受邀成员”。' };
  }
  if (!eventEditing && recipientScope === 'selected' && recipients.length === 0) {
    return { ok: false, message: '请至少选择一位接收人。' };
  }
  return {
    ok: true,
    value: {
      title, description, startDate, endDate, allDay, startTime, endTime, visibility,
      recipientScope, recipients,
    },
  };
}

async function saveEventAction() {
  if (state.busy || state.activePage !== 'collect') return;
  const parsed = readEventForm();
  if (!parsed.ok) {
    setEventStatus(parsed.message);
    return;
  }
  const value = parsed.value;
  if (value.visibility === 'space' && eventEditing?.visibility !== 'space') {
    const confirmed = await confirmAction({
      title: '公开此事件？',
      text: '公开后全空间成员可见标题、日期与说明；已查看或截图无法撤回。',
      confirmText: '公开',
    });
    if (!confirmed) return;
  }
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const routeToken = state.routeToken;
  const editing = eventEditing;
  setBusy(true);
  refreshCollectControls();
  setEventStatus('正在保存事件…');
  ui.eventSave.disabled = true;
  try {
    let message;
    if (editing) {
      const body = await api(`/api/spaces/${spaceId}/events/update`, {
        method: 'POST',
        body: JSON.stringify({ ...value, id: editing.id, version: editing.version }),
      });
      if (state.routeToken !== routeToken || state.activePage !== 'collect') return;
      message = body.replayed ? '已确认上次修改，未重复写入。' : '事件已更新。';
    } else {
      const id = crypto.randomUUID();
      const body = await api(`/api/spaces/${spaceId}/events`, {
        method: 'POST',
        body: JSON.stringify({ ...value, id }),
      });
      if (state.routeToken !== routeToken || state.activePage !== 'collect') return;
      const count = body.event?.recipientCount ?? 0;
      message = body.replayed
        ? '已确认上次创建，未重复写入。'
        : (count > 0 ? `事件已创建，已向 ${count} 位成员发送站内待确认。` : '事件已创建。');
    }
    closeEventDialog();
    await loadCollectCalendar(collectMonth ?? collectInitialMonth(), { preferDate: collectSelectedDate });
    if (state.routeToken === routeToken && state.activePage === 'collect') {
      collectEventsStatus = message;
      renderCollectEvents();
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error instanceof ApiError && error.code === 'event_conflict') {
      closeEventDialog();
      collectEventsStatus = '事件已被其他页面更新，已重新读取。';
      await loadCollectCalendar(collectMonth ?? collectInitialMonth(), { preferDate: collectSelectedDate });
      return;
    }
    setEventStatus(error.message);
  } finally {
    setBusy(false);
    refreshCollectControls();
    ui.eventSave.disabled = false;
  }
}

async function deleteEventAction(event) {
  if (state.busy || collectSwitching || state.activePage !== 'collect') return;
  const confirmed = await confirmAction({
    title: '删除此事件？',
    text: `删除事件“${event.title}”？已查看或截图的内容无法撤回；已接受的占用会随事件删除释放。`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const routeToken = state.routeToken;
  setBusy(true);
  refreshCollectControls();
  collectEventsStatus = '正在删除事件…';
  renderCollectEvents();
  try {
    await api(`/api/spaces/${spaceId}/events/delete`, {
      method: 'POST',
      body: JSON.stringify({ id: event.id, version: event.version }),
    });
    if (state.routeToken !== routeToken || state.activePage !== 'collect') return;
    await loadCollectCalendar(collectMonth ?? collectInitialMonth(), { preferDate: collectSelectedDate });
    if (state.routeToken === routeToken && state.activePage === 'collect') {
      collectEventsStatus = '事件已删除。';
      renderCollectEvents();
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    collectEventsStatus = `删除失败：${error.message}`;
    renderCollectEvents();
  } finally {
    setBusy(false);
    refreshCollectControls();
  }
}


function openArrangementDialog({
  targetUserId, name, date, period, start, end,
}) {
  if (state.busy || collectSwitching || state.activePage !== 'collect') return;
  if (!targetUserId || targetUserId === state.user?.id) return;
  arrangementTarget = {
    targetUserId, name, date, period,
  };
  ui.arrangementTarget.textContent = `对象：${name}`;
  ui.arrangementWhen.textContent = `${date} · 第 ${period} 节 · ${start}–${end}`;
  ui.arrangementStatus.hidden = true;
  ui.arrangementStatus.textContent = '';
  ui.arrangementDialog.querySelector('input[name="arrangement-kind"][value="busy"]').checked = true;
  ui.arrangementDialog.showModal();
}

function closeArrangementDialog() {
  if (ui.arrangementDialog.open) ui.arrangementDialog.close('cancel');
  arrangementTarget = null;
}

async function sendArrangementAction() {
  if (state.busy || !arrangementTarget) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const kind = ui.arrangementDialog.querySelector('input[name="arrangement-kind"]:checked')?.value ?? 'busy';
  const target = arrangementTarget;
  const routeToken = state.routeToken;
  const id = crypto.randomUUID();
  setBusy(true);
  refreshCollectControls();
  ui.arrangementSend.disabled = true;
  ui.arrangementStatus.hidden = false;
  ui.arrangementStatus.textContent = '正在发送站内请求…';
  try {
    const body = await api(`/api/spaces/${spaceId}/arrangements`, {
      method: 'POST',
      body: JSON.stringify({
        id, kind, targetUserId: target.targetUserId, date: target.date, period: target.period,
      }),
    });
    if (state.routeToken !== routeToken || state.activePage !== 'collect') return;
    const conflict = body.conflict;
    const message = conflict
      ? `请求已发送；提示：${target.name} 在该节次已有课程${conflict.courseName ? `《${conflict.courseName}》` : ''}，不会自动取消课程。`
      : `请求已发送；${target.name} 在本人的“我的日历”确认后才会生效。`;
    collectEventsStatus = message;
    closeArrangementDialog();
    await loadCollectCalendar(collectMonth ?? collectInitialMonth(), { preferDate: collectSelectedDate });
    if (state.routeToken === routeToken && state.activePage === 'collect') {
      collectEventsStatus = message;
      renderCollectEvents();
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.arrangementStatus.hidden = false;
    ui.arrangementStatus.textContent = `发送失败：${error.message}`;
  } finally {
    setBusy(false);
    refreshCollectControls();
    ui.arrangementSend.disabled = false;
  }
}

function renderInviteMeta() {
  const invite = state.invite;
  ui.inviteGenerate.hidden = Boolean(invite?.exists);
  if (!invite || !invite.exists) {
    ui.inviteMeta.textContent = '尚未生成邀请码。生成后只显示一次，请及时保存。';
    refreshCollectControls();
    return;
  }
  const expired = !Number.isFinite(Date.parse(invite.expiresAt)) || Date.parse(invite.expiresAt) <= Date.now();
  const status = invite.revoked ? '已撤销' : expired ? '已过期' : '有效';
  ui.inviteMeta.textContent = `状态：${status} · 已用 ${invite.used}/${invite.maxUses} · 剩余 ${invite.remaining} · 到期 ${formatDateTime(invite.expiresAt)}`;
  refreshCollectControls();
}

async function loadInvite(spaceId, token) {
  try {
    const body = await api(`/api/spaces/${spaceId}/invite`);
    if (state.routeToken !== token || state.route?.spaceId !== spaceId || state.activePage !== 'collect') return;
    state.invite = body;
    renderInviteMeta();
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== spaceId || state.activePage !== 'collect') return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    state.invite = null;
    ui.inviteStatus.textContent = `邀请信息读取失败：${error.message}`;
    refreshCollectControls();
  }
}

function showInviteCode(code) {
  state.inviteCode = code;
  ui.inviteCode.textContent = code;
  ui.inviteCodeBox.hidden = false;
}

async function generateInviteAction() {
  if (state.busy || state.activePage !== 'collect') return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.inviteStatus.textContent = '';
  try {
    const body = await api(`/api/spaces/${spaceId}/invite`, { method: 'POST' });
    if (state.routeToken !== token || state.activePage !== 'collect') return;
    showInviteCode(body.code);
    ui.inviteStatus.textContent = '邀请码已生成，只显示这一次。请通过可信渠道发送。';
    await loadInvite(spaceId, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.inviteStatus.textContent = error.message;
    if (error instanceof ApiError && error.code === 'invite_exists') {
      await loadInvite(spaceId, token);
    }
  } finally {
    setBusy(false);
  }
}

async function rotateInviteAction() {
  if (state.busy || state.activePage !== 'collect') return;
  const confirmed = await confirmAction({
    title: '轮换邀请码？',
    text: '轮换会立即使旧邀请码失效，已加入成员不受影响。',
    confirmText: '轮换',
    danger: true,
  });
  if (!confirmed) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.inviteStatus.textContent = '';
  try {
    const body = await api(`/api/spaces/${spaceId}/invite/rotate`, { method: 'POST' });
    if (state.routeToken !== token || state.activePage !== 'collect') return;
    showInviteCode(body.code);
    ui.inviteStatus.textContent = '已轮换：旧码失效，已加入成员保留。新码只显示这一次。';
    await loadInvite(spaceId, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.inviteStatus.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function revokeInviteAction() {
  if (state.busy || state.activePage !== 'collect') return;
  const confirmed = await confirmAction({
    title: '撤销邀请码？',
    text: '撤销后当前邀请码立即失效，已加入成员不受影响。',
    confirmText: '撤销',
    danger: true,
  });
  if (!confirmed) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.inviteStatus.textContent = '';
  try {
    await api(`/api/spaces/${spaceId}/invite/revoke`, { method: 'POST' });
    if (state.routeToken !== token || state.activePage !== 'collect') return;
    state.inviteCode = null;
    ui.inviteCode.textContent = '';
    ui.inviteCodeBox.hidden = true;
    ui.inviteStatus.textContent = '邀请码已撤销，当前不再接受新成员。';
    await loadInvite(spaceId, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.inviteStatus.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function copyInviteCode() {
  const code = state.inviteCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    ui.inviteStatus.textContent = '已复制到剪贴板。';
  } catch {
    ui.inviteStatus.textContent = '复制失败，请手动选择邀请码复制。';
  }
}

// ---- 空间设置 ----

let settingsJoinChoice = false;

function resetSettingsPage() {
  state.settingsInfo = null;
  settingsJoinChoice = false;
  ui.settingsLoading.hidden = true;
  ui.settingsError.hidden = true;
  ui.settingsErrorText.textContent = '';
  ui.settingsContent.hidden = true;
  ui.settingsTeaching.replaceChildren();
  ui.settingsTeachingNote.replaceChildren();
  ui.settingsTeachingNote.hidden = true;
  ui.settingsForm.hidden = true;
  settingsTimezone.setValue('');
  settingsFields.anchor.setValue('');
  settingsFields.termStart.setValue('');
  settingsFields.termEnd.setValue('');
  ui.settingsPreview.textContent = '';
  ui.settingsStatus.textContent = '';
  ui.settingsConfig.replaceChildren();
  ui.settingsLockNote.hidden = true;
  ui.settingsParticipationCheck.checked = false;
  ui.settingsParticipationCheck.disabled = true;
  ui.settingsParticipationStatus.textContent = '';
  ui.settingsParticipationChoice.hidden = true;
}

function deactivateSettings() {
  resetSettingsPage();
}

function refreshSettingsControls() {
  const info = state.settingsInfo;
  const pending = info?.teachingState === 'pending' && info?.space?.role === 'owner';
  const preview = pending ? teachingPreviewText(teachingInput('settings'), ui.settingsPreview) : { ok: false };
  ui.settingsSubmit.disabled = state.busy || !pending || !preview.ok;
  ui.settingsRetry.disabled = state.busy;
  ui.settingsParticipationCheck.disabled = state.busy || info?.space?.role !== 'owner';
  ui.settingsParticipationKeep.disabled = state.busy;
  ui.settingsParticipationEdit.disabled = state.busy;
}

async function activateSettings(space, token) {
  resetSettingsPage();
  if (space.role !== 'owner') {
    ui.settingsDenied.hidden = false;
    ui.settingsContent.hidden = true;
    return;
  }
  ui.settingsDenied.hidden = true;
  ui.settingsLoading.hidden = false;
  try {
    const body = await api(`/api/spaces/${space.id}/settings`);
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    state.settingsInfo = body;
    ui.settingsLoading.hidden = true;
    ui.settingsContent.hidden = false;
    renderSettings(body);
    refreshSettingsControls();
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error instanceof ApiError && error.status === 403) {
      ui.settingsLoading.hidden = true;
      ui.settingsDenied.hidden = false;
      ui.settingsContent.hidden = true;
      return;
    }
    ui.settingsLoading.hidden = true;
    ui.settingsErrorText.textContent = error.message;
    ui.settingsError.hidden = false;
  }
}

function configGrid(target, items) {
  target.replaceChildren();
  for (const [label, value] of items) {
    const cell = document.createElement('div');
    const key = document.createElement('span');
    key.className = 'config-label';
    key.textContent = label;
    const text = document.createElement('span');
    text.textContent = value;
    cell.append(key, text);
    target.append(cell);
  }
}

function renderSettingsParticipation(body) {
  const status = body.ownerParticipation?.status;
  const owner = body.space?.role === 'owner';
  ui.settingsParticipationCheck.checked = status === 'joined';
  ui.settingsParticipationCheck.disabled = state.busy || !owner;
  ui.settingsParticipationChoice.hidden = !settingsJoinChoice;
  ui.settingsParticipationStatus.textContent = settingsJoinChoice
    ? '已提交过课表：请选择“沿用已交”，或去课表重新提交。'
    : status === 'joined'
      ? '已参与：计入收集人数与名单。'
      : status === 'declined'
        ? '未参与：不计入收集，课表保留。'
        : '尚未选择：当前不计入收集。';
}

async function writeSettingsParticipation(action, extra = {}) {
  const spaceId = state.route?.spaceId;
  if (!spaceId || state.busy) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.settingsParticipationStatus.textContent = action === 'join' ? '正在加入收集…' : '正在退出收集…';
  try {
    const body = await api(`/api/spaces/${spaceId}/participation`, {
      method: 'POST',
      body: JSON.stringify({ action, ...extra }),
    });
    if (state.routeToken !== token || state.route?.spaceId !== spaceId) return;
    if (state.settingsInfo) {
      state.settingsInfo.ownerParticipation = body.participation ?? null;
      settingsJoinChoice = false;
      renderSettingsParticipation(state.settingsInfo);
    } else {
      ui.settingsParticipationStatus.textContent = action === 'join' ? '已参与。' : '未参与。';
    }
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== spaceId) return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error instanceof ApiError && error.code === 'rejoin_choice_required') {
      settingsJoinChoice = true;
      if (state.settingsInfo) renderSettingsParticipation(state.settingsInfo);
      return;
    }
    ui.settingsParticipationStatus.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function renderSettings(body) {
  const { config, teaching, teachingState } = body;
  const owner = body.space.role === 'owner';
  ui.settingsTeaching.replaceChildren();
  ui.settingsTeachingNote.replaceChildren();
  ui.settingsTeachingNote.hidden = true;
  ui.settingsForm.hidden = true;

  if (teachingState === 'legacy') {
    configGrid(ui.settingsTeaching, [['空间类型', '旧版空间'], ['教学周', '不适用']]);
    const note = document.createElement('p');
    note.textContent = '旧版空间不提供教学周设置。';
    ui.settingsTeachingNote.append(note);
    ui.settingsTeachingNote.hidden = false;
  } else if (teachingState === 'set' && teaching) {
    configGrid(ui.settingsTeaching, [
      ['时区', timezoneLabel(teaching.timezone, new Date(`${teaching.termStart}T12:00:00Z`))],
      ['第一教学周周一', teaching.firstWeekMonday],
      ['学期开始', teaching.termStart],
      ['学期结束', teaching.termEnd],
      ['教学周数', `${teachingWeekCount(teaching.firstWeekMonday, teaching.termEnd) ?? '—'} 周`],
    ]);
    const note = document.createElement('p');
    note.textContent = '设置后不可更改。';
    ui.settingsTeachingNote.append(note);
    ui.settingsTeachingNote.hidden = false;
  } else if (teachingState === 'invalid') {
    configGrid(ui.settingsTeaching, [['教学周', '设置无效']]);
    const note = document.createElement('p');
    note.textContent = '教学周设置无效，请联系负责人。';
    ui.settingsTeachingNote.append(note);
    ui.settingsTeachingNote.hidden = false;
  } else {
    const pending = teachingState === 'pending';
    configGrid(ui.settingsTeaching, [['教学周', '尚未设置']]);
    const note = document.createElement('p');
    note.textContent = owner
      ? '请设置第一教学周周一、学期开始、结束与时区。'
      : '负责人尚未设置教学周。';
    ui.settingsTeachingNote.append(note);
    ui.settingsTeachingNote.hidden = false;
    if (pending && owner) {
      ui.settingsForm.hidden = false;
      settingsTimezone.setValue('');
      settingsFields.anchor.setValue('');
      settingsFields.termStart.setValue('');
      settingsFields.termEnd.setValue('');
      teachingPreviewText(teachingInput('settings'), ui.settingsPreview);
    }
  }

  if (config) {
    const rule = body.weekRule ?? { resolved: Boolean(config.weekRule), rule: config.weekRule };
    const ruleLabel = rule.resolved
      ? (rule.rule === 'odd' ? '单周' : rule.rule === 'even' ? '双周' : '每周')
      : '待处理';
    configGrid(ui.settingsConfig, [
      ['收集模式', modeLabel(config.mode)],
      ['周次规则', rule.resolved ? ruleLabel : '待处理（旧数据含单/双周）'],
      ['成员可见范围', config.visibility === 'masked_list' ? '脱敏名单' : '仅统计'],
      ['节次数量', `${config.periods.length} 节`],
    ]);
    ui.settingsLockNote.hidden = false;
    ui.settingsLockNote.textContent = body.configLocked
      ? '已有提交，配置已固定。'
      : '首次提交后固定。';
  } else {
    ui.settingsConfig.replaceChildren();
    ui.settingsLockNote.hidden = true;
  }

  renderSettingsParticipation(body);
}

async function submitSettings(event) {
  event.preventDefault();
  if (state.busy) return;
  const info = state.settingsInfo;
  if (!info || info.teachingState !== 'pending' || info.space.role !== 'owner') return;
  const teaching = teachingInput('settings');
  const result = validateTeachingInput(teaching);
  if (!result.ok) {
    ui.settingsStatus.textContent = result.message;
    return;
  }
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.settingsStatus.textContent = '';
  try {
    const body = await api(`/api/spaces/${spaceId}/teaching`, {
      method: 'POST',
      body: JSON.stringify({ teaching: result.teaching }),
    });
    if (state.routeToken !== token || state.route?.spaceId !== spaceId) return;
    if (state.settingsInfo) {
      state.settingsInfo.teaching = body.teaching;
      state.settingsInfo.teachingState = 'set';
      renderSettings(state.settingsInfo);
      refreshSettingsControls();
    }
    ui.settingsStatus.textContent = '已保存。';
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error instanceof ApiError && error.code === 'teaching_already_set') {
      ui.settingsStatus.textContent = error.message;
      const space = findSpace(spaceId);
      if (space) await activateSettings(space, state.routeToken);
      return;
    }
    ui.settingsStatus.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

// ---- 旧版空间 ----

function resetLegacyPage() {
  state.legacy = { overview: null, schedule: null, draft: [] };
  ui.legacyLoading.hidden = true;
  ui.legacyError.hidden = true;
  ui.legacyErrorText.textContent = '';
  ui.legacyPanel.hidden = true;
  ui.legacyMismatch.hidden = true;
  ui.overviewHead.replaceChildren();
  ui.overviewBody.replaceChildren();
  ui.overviewEmpty.hidden = true;
  ui.entriesEditor.replaceChildren();
  ui.editorStatus.textContent = '';
  ui.overviewNote.textContent = '';
  ui.editorNote.textContent = '';
  ui.versionNote.textContent = '';
}

function deactivateLegacy() {
  resetLegacyPage();
}

function refreshLegacyControls() {
  ui.submitSchedule.disabled = state.busy || !state.legacy.overview;
  ui.legacyRetry.disabled = state.busy;
}

function buildLegacyDraft(mode, schedule) {
  if (Array.isArray(schedule?.entries) && schedule.entries.length > 0) {
    return schedule.entries.map((entry) => ({
      day: entry.day,
      period: entry.period,
      hasClass: Boolean(entry.hasClass),
      courseName: mode === 'courses' ? (entry.courseName ?? null) : null,
    }));
  }
  return [
    { day: 1, period: 1, hasClass: false, courseName: null },
    { day: 1, period: 2, hasClass: false, courseName: null },
  ];
}

function formatSlot(day, period) {
  const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return `${days[day] ?? `第 ${day} 天`} · 第 ${period} 节`;
}

function renderLegacyOverview() {
  ui.overviewHead.replaceChildren();
  ui.overviewBody.replaceChildren();
  const overview = state.legacy.overview;
  if (!overview) {
    ui.overviewNote.textContent = '';
    ui.overviewEmpty.hidden = false;
    return;
  }
  const owner = overview.space.role === 'owner';
  ui.overviewNote.textContent = owner
    ? '负责人视图：返回本空间成员姓名与课程名；你仍不能改写成员记录。'
    : '普通成员视图：仅显示脱敏姓名与有课／无课状态，看不到他人课程名。';
  const header = document.createElement('tr');
  const columns = owner ? ['成员', '时间', '状态', '课程'] : ['成员', '时间', '状态'];
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    header.append(th);
  }
  ui.overviewHead.append(header);
  const entries = overview.entries ?? [];
  for (const entry of entries) {
    const row = document.createElement('tr');
    const member = document.createElement('td');
    member.textContent = owner ? entry.memberName : entry.maskedName;
    const slot = document.createElement('td');
    slot.textContent = formatSlot(entry.day, entry.period);
    const status = document.createElement('td');
    status.textContent = entry.hasClass ? '有课' : '无课';
    row.append(member, slot, status);
    if (owner) {
      const course = document.createElement('td');
      course.textContent = entry.courseName ?? '—';
      row.append(course);
    }
    ui.overviewBody.append(row);
  }
  ui.overviewEmpty.hidden = entries.length > 0;
}

function renderLegacyEditor() {
  ui.entriesEditor.replaceChildren();
  const space = state.legacy.overview?.space;
  if (!space) {
    ui.editorNote.textContent = '';
    ui.versionNote.textContent = '';
    return;
  }
  const mode = space.mode;
  ui.editorNote.textContent = '空白格表示无课；提交会替换你在该空间的整表。';
  ui.versionNote.textContent = state.legacy.schedule
    ? `当前整表版本：${state.legacy.schedule.version}`
    : '尚无整表记录；首次提交为版本 0。';

  for (const entry of state.legacy.draft) {
    const row = document.createElement('div');
    row.className = 'entry-row';
    const slot = document.createElement('span');
    slot.textContent = formatSlot(entry.day, entry.period);
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = entry.hasClass;
    const text = document.createElement('span');
    text.textContent = '有课';
    label.append(checkbox, text);
    let courseInput = null;
    if (mode === 'courses') {
      courseInput = document.createElement('input');
      courseInput.type = 'text';
      courseInput.maxLength = 100;
      courseInput.placeholder = '课程名（可留空）';
      courseInput.value = entry.courseName ?? '';
      courseInput.disabled = !entry.hasClass;
      courseInput.addEventListener('input', () => {
        entry.courseName = courseInput.value.trim() || null;
      });
    }
    checkbox.addEventListener('change', () => {
      entry.hasClass = checkbox.checked;
      if (!entry.hasClass) entry.courseName = null;
      if (courseInput) {
        courseInput.disabled = !entry.hasClass;
        if (!entry.hasClass) courseInput.value = '';
      }
    });
    row.append(slot, label);
    if (courseInput) row.append(courseInput);
    else {
      const spacer = document.createElement('span');
      spacer.className = 'muted';
      spacer.textContent = '仅有课状态模式不采集课程名';
      row.append(spacer);
    }
    ui.entriesEditor.append(row);
  }
}

async function loadLegacyData(spaceId, token) {
  const [overview, own] = await Promise.all([
    api(`/api/spaces/${spaceId}/overview`),
    api(`/api/spaces/${spaceId}/my-schedule`),
  ]);
  if (state.routeToken !== token || state.route?.spaceId !== spaceId || state.activePage !== 'legacy') return false;
  state.legacy.overview = overview;
  state.legacy.schedule = own.schedule;
  state.legacy.draft = buildLegacyDraft(overview.space.mode, own.schedule);
  renderLegacyOverview();
  renderLegacyEditor();
  refreshLegacyControls();
  return true;
}

async function activateLegacy(space, token) {
  resetLegacyPage();
  ui.legacyLoading.hidden = false;
  try {
    const info = await api(`/api/spaces/${space.id}/config`);
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    if (info.config) {
      ui.legacyLoading.hidden = true;
      ui.legacyMismatch.hidden = false;
      return;
    }
    ui.legacyLoading.hidden = true;
    ui.legacyPanel.hidden = false;
    const loaded = await loadLegacyData(space.id, token);
    if (!loaded) return;
  } catch (error) {
    if (state.routeToken !== token || state.route?.spaceId !== space.id) return;
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    ui.legacyLoading.hidden = true;
    ui.legacyErrorText.textContent = error.message;
    ui.legacyError.hidden = false;
  }
}

async function submitLegacySchedule() {
  if (state.busy || !state.legacy.overview) return;
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  const token = state.routeToken;
  setBusy(true);
  clearError();
  ui.editorStatus.textContent = '';
  try {
    const result = await api(`/api/spaces/${spaceId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({
        version: state.legacy.schedule?.version ?? 0,
        entries: state.legacy.draft,
      }),
    });
    if (state.routeToken !== token || state.route?.spaceId !== spaceId) return;
    ui.editorStatus.textContent = `提交成功，整表版本 ${result.version}。`;
    await loadLegacyData(spaceId, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    if (error instanceof ApiError && error.code === 'version_conflict') {
      ui.editorStatus.textContent = '版本冲突：本次未写入。已重新读取最新整表，请核对后再次提交。';
      await loadLegacyData(spaceId, token);
    } else {
      showError(error.message);
    }
  } finally {
    setBusy(false);
  }
}

// ---- 事件绑定 ----

ui.authTabLogin.addEventListener('click', () => switchAuthTab('login'));
ui.authTabRegister.addEventListener('click', () => switchAuthTab('register'));
ui.consentContinue.addEventListener('click', () => { void submitConsentChoices(); });
ui.consentNecessary.addEventListener('click', chooseNecessaryConsent);
ui.openPrivacy.addEventListener('click', () => {
  const opener = ui.openPrivacy;
  setAccountMenu(false);
  void openConsentDialog({ manage: true, returnFocus: opener });
});
ui.consentDialog.addEventListener('cancel', (event) => {
  if (state.consentGate && (state.consents?.items ?? []).some((item) => item.calendar.pending)) {
    event.preventDefault();
  }
});
ui.consentDialog.addEventListener('close', () => {
  state.consentGate = false;
  state.consentFocusSpaceId = null;
  state.consentManageAll = false;
  state.consentBusy = false;
  consentChoices = new Map();
  setConsentMessage('');
  // 管理列表在提交后会重建按钮，原触发节点可能已脱离文档，回退到隐私设置入口。
  const target = consentReturnFocus && document.contains(consentReturnFocus)
    ? consentReturnFocus
    : (document.querySelector('#open-privacy') ?? null);
  consentReturnFocus = null;
  // 原生 dialog 会在 close 事件后恢复旧焦点，延后一拍再落回当前触发按钮。
  // 隐私入口位于账号菜单内，菜单已收起时需重新展开才能落焦到该入口。
  if (target) {
    setTimeout(() => {
      if (target === ui.openPrivacy) setAccountMenu(true);
      if (!target.hidden) target.focus({ preventScroll: true });
    }, 60);
  }
  const resolve = consentResolve;
  consentResolve = null;
  resolve?.();
});

ui.loginForm.addEventListener('submit', (event) => { void submitLogin(event); });
ui.registerForm.addEventListener('submit', (event) => { void submitRegister(event); });
for (const [input, key] of [
  [ui.registerUsername, 'username'],
  [ui.registerPassword, 'password'],
  [ui.registerConfirm, 'confirm'],
]) {
  input.addEventListener('input', () => {
    touchedAuth[key] = true;
    refreshAuthControls();
  });
  input.addEventListener('change', () => {
    touchedAuth[key] = true;
    refreshAuthControls();
  });
}
for (const input of [ui.loginUsername, ui.loginPassword, ui.loginTerms, ui.registerNickname, ui.registerNotice]) {
  input.addEventListener('input', refreshAuthControls);
  input.addEventListener('change', refreshAuthControls);
}
for (const input of [ui.loginUsername, ui.loginTerms]) {
  input.addEventListener('input', writeLoginDraft);
  input.addEventListener('change', writeLoginDraft);
}
ui.reload.addEventListener('click', () => { if (!state.busy) void loadSpaces(); });
ui.openCreate.addEventListener('click', () => { void navigate('/spaces/new'); });
ui.openJoin.addEventListener('click', () => { void navigate('/spaces/join'); });
ui.spacesRetry.addEventListener('click', () => { if (!state.busy) void loadSpaces(); });
ui.accountButton.addEventListener('click', () => { setAccountMenu(ui.accountPanel.hidden); });
ui.accountPanel.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('button')) setAccountMenu(false);
});
document.addEventListener('click', (event) => {
  if (ui.accountPanel.hidden) return;
  if (!(event.target instanceof Element) || !event.target.closest('#account-wrap')) setAccountMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || ui.accountPanel.hidden) return;
  setAccountMenu(false, true);
});
ui.logout.addEventListener('click', () => { void performLogout(); });

ui.createForm.addEventListener('submit', (event) => { void submitCreate(event); });
for (const input of [ui.createName, ui.createOwnerName, ui.createTimezone, ui.createAnchor,
  ui.createTermStart, ui.createTermEnd]) {
  input.addEventListener('input', refreshCreateControls);
  input.addEventListener('change', refreshCreateControls);
}
for (const radio of document.querySelectorAll('input[name="create-mode"], input[name="create-visibility"], input[name="create-week-rule"]')) {
  radio.addEventListener('change', refreshCreateControls);
}
ui.addPeriod.addEventListener('click', addPeriod);
ui.resetPeriods.addEventListener('click', resetPeriodTemplate);

ui.joinForm.addEventListener('submit', (event) => { void submitJoin(event); });
for (const input of [ui.joinCode, ui.joinName, ui.joinNotice]) {
  input.addEventListener('input', refreshJoinControls);
  input.addEventListener('change', refreshJoinControls);
}

ui.homeRetry.addEventListener('click', () => { void retryHome(); });
ui.homeOpenLegacy.addEventListener('click', () => {
  if (state.route?.spaceId) void navigate(`/spaces/${state.route.spaceId}/legacy`);
});

ui.collectRefresh.addEventListener('click', () => {
  const spaceId = state.route?.spaceId;
  if (!spaceId || state.busy) return;
  if (collectTab === 'calendar' && collectMonth) void loadCollectCalendar(collectMonth);
  void loadMembers(spaceId, state.routeToken);
  void loadInvite(spaceId, state.routeToken);
});
ui.collectMembersRetry.addEventListener('click', () => {
  const spaceId = state.route?.spaceId;
  if (spaceId && !state.busy) void loadMembers(spaceId, state.routeToken);
});
collectSwipe = bindMonthSwipe({
  viewport: ui.collectCalendarViewport,
  track: ui.collectCalendarTrack,
  canStart: () => Boolean(collectMonthData && collectMonth && collectHome?.teaching
    && state.activePage === 'collect' && !state.busy && !collectSwitching),
  onStart: () => pauseCollectPrefetch(),
  onTarget: (delta) => {
    const target = shiftMonth(collectMonth, delta);
    if (target) preloadCollectMonth(target);
  },
  onCommit: (delta) => commitCollectSwipe(delta),
  onSettled: () => {
    ui.collectCalendarTable.removeAttribute('aria-busy');
    renderCollectNeighborPages();
    collectSwipe?.center();
    scheduleCollectPrefetch(300);
  },
  onCancel: () => {
    ui.collectCalendarTable.removeAttribute('aria-busy');
    renderCollectNeighborPages();
    scheduleCollectPrefetch(300);
  },
});

ui.collectTabOverview.addEventListener('click', () => { setCollectTab('overview', { focus: true }); });
ui.collectTabCalendar.addEventListener('click', () => { setCollectTab('calendar', { focus: true }); });
ui.collectPrev.addEventListener('click', () => {
  if (collectSwitching || state.busy) return;
  const target = shiftMonth(collectTargetMonth ?? collectMonth, -1);
  if (target && !state.busy) void loadCollectCalendar(target);
});
ui.collectNext.addEventListener('click', () => {
  if (collectSwitching || state.busy) return;
  const target = shiftMonth(collectTargetMonth ?? collectMonth, 1);
  if (target && !state.busy) void loadCollectCalendar(target);
});
ui.collectToday.addEventListener('click', () => {
  if (state.busy || collectSwitching || !collectHome?.teaching) return;
  const today = todayInZone(collectHome.teaching.timezone);
  if (!today) {
    ui.collectCalendarStatus.textContent = '无法按空间时区确定今天，请稍后重试。';
    return;
  }
  const target = today.slice(0, 7);
  if (target === collectMonth) {
    selectCollectDate(today);
    return;
  }
  void loadCollectCalendar(target, { preferDate: today });
});
ui.collectCalendarRetry.addEventListener('click', () => {
  if (collectSwitching || state.busy) return;
  const target = collectRetryTarget ?? collectMonth;
  if (target) void loadCollectCalendar(target, { preferDate: collectSelectedDate, force: true });
});
for (const button of ui.collectFilters.querySelectorAll('button[data-filter]')) {
  button.addEventListener('click', () => {
    collectFilter = ['class', 'busy', 'free'].includes(button.dataset.filter)
      ? button.dataset.filter
      : 'all';
    for (const item of ui.collectFilters.querySelectorAll('button[data-filter]')) {
      const active = item.dataset.filter === collectFilter;
      item.setAttribute('aria-pressed', String(active));
      item.classList.toggle('is-active', active);
    }
    renderCollectDetail();
  });
}
ui.collectExport.addEventListener('click', () => { void exportCollectWeek(); });
ui.collectEventNew.addEventListener('click', () => { openEventDialog(); });
ui.eventSingleDay.addEventListener('change', syncEventSingleDay);
ui.eventAllDay.addEventListener('change', syncEventDialog);
for (const radio of ui.eventDialog.querySelectorAll('input[name="event-visibility"]')) {
  radio.addEventListener('change', syncEventDialog);
}
for (const radio of ui.eventDialog.querySelectorAll('input[name="event-recipient-scope"]')) {
  radio.addEventListener('change', syncEventDialog);
}
ui.eventRecipients.addEventListener('change', syncEventDialog);
ui.eventSave.addEventListener('click', () => { void saveEventAction(); });
ui.eventClose.addEventListener('click', closeEventDialog);
ui.arrangementSend.addEventListener('click', () => { void sendArrangementAction(); });
ui.arrangementClose.addEventListener('click', closeArrangementDialog);
ui.arrangementDialog.addEventListener('cancel', (event) => {
  if (state.busy) {
    event.preventDefault();
    return;
  }
  arrangementTarget = null;
});
ui.arrangementDialog.addEventListener('close', () => { arrangementTarget = null; });
ui.eventDialog.addEventListener('cancel', (event) => {
  if (state.busy) {
    event.preventDefault();
    return;
  }
  eventEditing = null;
});
ui.eventDialog.addEventListener('close', () => { eventEditing = null; });
ui.collectOpenLegacy.addEventListener('click', () => {
  if (state.route?.spaceId) void navigate(`/spaces/${state.route.spaceId}/legacy`);
});
ui.inviteGenerate.addEventListener('click', () => { void generateInviteAction(); });
ui.inviteRotate.addEventListener('click', () => { void rotateInviteAction(); });
ui.inviteRevoke.addEventListener('click', () => { void revokeInviteAction(); });
ui.inviteCopy.addEventListener('click', () => { void copyInviteCode(); });

ui.settingsForm.addEventListener('submit', (event) => { void submitSettings(event); });
for (const input of [ui.settingsTimezone, ui.settingsAnchor, ui.settingsTermStart, ui.settingsTermEnd]) {
  input.addEventListener('input', refreshSettingsControls);
  input.addEventListener('change', refreshSettingsControls);
}
ui.settingsRetry.addEventListener('click', () => {
  const space = findSpace(state.route?.spaceId);
  if (space && !state.busy) void activateSettings(space, state.routeToken);
});
ui.settingsParticipationCheck.addEventListener('change', () => {
  if (state.busy) {
    if (state.settingsInfo) renderSettingsParticipation(state.settingsInfo);
    return;
  }
  void writeSettingsParticipation(ui.settingsParticipationCheck.checked ? 'join' : 'decline');
});
ui.settingsParticipationKeep.addEventListener('click', () => {
  void writeSettingsParticipation('join', { source: 'published' });
});
ui.settingsParticipationEdit.addEventListener('click', () => {
  const spaceId = state.route?.spaceId;
  if (!spaceId) return;
  settingsJoinChoice = false;
  schedulePage.requestPendingJoin(spaceId, 'participation');
  void navigate(`/spaces/${spaceId}/schedule`);
});

ui.legacyRetry.addEventListener('click', () => {
  const space = findSpace(state.route?.spaceId);
  if (space && !state.busy) void activateLegacy(space, state.routeToken);
});
ui.submitSchedule.addEventListener('click', () => { void submitLegacySchedule(); });

ui.routeErrorBack.addEventListener('click', () => { void navigate('/spaces'); });
ui.mobileBack.addEventListener('click', () => {
  const route = state.route;
  if (!route) return;
  const parent = parentRoute(route);
  void navigate(parent.path);
});
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a[href^="#/"]');
  if (!anchor) return;
  event.preventDefault();
  void navigate(anchor.getAttribute('href').slice(1));
});

window.addEventListener('popstate', onPopState);
window.addEventListener('hashchange', onHashChange);

function bootstrap() {
  ensureHistoryState();
  renderPeriods();
  refreshAuthControls();
  refreshGlobalControls();
  void (async () => {
    setBusy(true);
    try {
      const me = await api('/api/me');
      state.user = me.user;
      await enterAfterAuth({ restoreTarget: false });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error.message);
      showAuth();
    } finally {
      setBusy(false);
      refreshAuthControls();
    }
  })();
}

bootstrap();

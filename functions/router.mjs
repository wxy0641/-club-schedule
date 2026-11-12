// S1 应用路由：自建账号、空间配置、邀请码加入、成员关系与服务端授权。
// 身份只来自本应用会话；请求体/请求头里的账号、角色、成员 ID 不参与授权判断。
import {
  AppError, applicationPath, binary, errorJson, json, readJson, requireTrustedOrigin, rows,
} from './http.mjs';
import {
  canonicalUsername, isUuid, validateEntries, validateNickname, validatePassword, validateVersion,
} from './validate.mjs';
import { hashPassword, verifyPassword, verifyPasswordAgainstDummy } from './passwords.mjs';
import {
  SESSION_TTL_MS, clearSessionCookie, createSession, revokeSession, sessionCookie, sha256Hex, validateSession,
} from './sessions.mjs';
import { consume } from './limiter.mjs';
import { publicConfig, validateSpaceConfig } from './config.mjs';
import {
  CALENDAR_NOTICE_VERSION, NOTICE_TEXT, NOTICE_VERSION, SHARE_NOTICE_VERSION,
} from './notices.mjs';
import {
  calendarConsentView, calendarNotice, calendarVersionAccepted,
  declineCalendarConsent, ensureCalendarConsent, GENERAL_TERMS, readCalendarConsent, shareNotice,
} from './consents.mjs';
import {
  declineParticipation, declineShareConsent, ensureShareConsent, joinParticipation,
  loadCollectionSubjects, loadShareConsents, participationView, projectCollectionMonth,
  readParticipation, readShareConsent, revokeShareConsent, shareView,
} from './collection.mjs';
import {
  createEvent, deleteEvent, loadVisibleEventsForMonth, updateEvent,
} from './events.mjs';
import {
  createStandaloneAssignment, incomingAssignments, loadOccupancy, pendingAssignmentCount,
  respondAssignment,
} from './assignments.mjs';
import { buildCollectionWorkbook, exportFilename, normalizeExportWeek } from './export.mjs';
import {
  INVITE_MAX_USES, INVITE_TTL_MS, MAX_SLOT_ATTEMPTS,
  emptyInviteSummary, ensureInviteSlots, formatInviteCode, generateInviteCode,
  hashInviteCode, invalidateUnclaimedSlots, inviteSummary, normalizeInviteCode, readInvite,
  validateInSpaceName,
} from './invites.mjs';
import {
  findAccessibleSpaceIds, isLegacySpace, isS1Space, loadMemberNames, loadRoster, resolveAccess,
} from './membership.mjs';
import {
  SCHEDULE_BODY_LIMIT_BYTES, SCHEDULE_DOCUMENT_COLUMNS, isPublishedDocument,
  scheduleDocumentView, scheduleRequestDigest, validateRequestId, validateWeekEntries,
} from './week-schedule.mjs';
import {
  addDays, buildWeeklyMap, courseSignature, exceptionView, isValidDate, localMinuteOfDay,
  localToday, monthDates, periodEditable, projectMonth, publicTeaching, teachingWeekCount,
  teachingWeekNumber, validateMonth, validatePersonalState, validateTeaching, weeklyValueFromMap,
} from './calendar.mjs';

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const encoder = new TextEncoder();
const EXCEPTION_COLUMNS = [
  'space_id', 'member_id', 'local_date', 'period', 'cancel_class', 'personal_state',
  'course_signature', 'version', 'last_request_id', 'last_request_op',
  'last_request_digest', 'updated_at',
].join(',');

class SessionRequired extends Error {
  constructor(state) {
    super('login_required');
    this.state = state;
  }
}

const retryAfter = (result) => ({ 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });

function unauthorized(state) {
  return state === 'invalid'
    ? errorJson('login_required', 401, { 'set-cookie': clearSessionCookie() })
    : errorJson('login_required', 401);
}

async function requireSession(db, request) {
  const result = await validateSession(db, request);
  if (result.state !== 'valid') throw new SessionRequired(result.state);
  return result.session;
}

// 账号资料只有 UID、登录名与本人展示昵称；空间内姓名保存在空间成员/邀请槽位中，二者互不替代。
async function loadUser(db, userId) {
  const found = rows(await db.from('users').select('id,username,nickname').eq('id', userId).limit(1));
  if (found.length !== 1 || typeof found[0]?.username !== 'string') {
    throw new SessionRequired('invalid');
  }
  const nickname = typeof found[0].nickname === 'string' ? found[0].nickname : null;
  return { id: found[0].id, username: found[0].username, nickname };
}

async function loadSpace(db, spaceId) {
  const found = rows(await db.from('spaces')
    .select('id,name,mode,owner_id,owner_name,config,created_at')
    .eq('id', spaceId).limit(1));
  if (found.length !== 1 || typeof found[0]?.name !== 'string' || typeof found[0]?.owner_id !== 'string') return null;
  return found[0];
}

async function requireAccess(db, spaceId, userId) {
  const space = await loadSpace(db, spaceId);
  if (!space) throw new AppError('forbidden', 403);
  const access = await resolveAccess(db, space, userId);
  if (!access) throw new AppError('forbidden', 403);
  return { space, access };
}

async function requireOwner(db, spaceId, userId) {
  const result = await requireAccess(db, spaceId, userId);
  if (result.access.role !== 'owner') throw new AppError('forbidden', 403);
  return result;
}

// 旧探针接口只服务 config 为 null 的旧空间；S1 空间明确拒绝，不返回空结果假装统计成功。
function requireLegacySpace(space) {
  if (isS1Space(space)) throw new AppError('legacy_capability_unavailable', 409);
}

// 邀请码生命周期属于 S1 空间；旧空间不得通过新接口混入槽位成员。
function requireS1Space(space) {
  if (isLegacySpace(space)) throw new AppError('space_kind_mismatch', 409);
}

function requireS1Config(space) {
  const config = publicConfig(space.config);
  if (!config) throw new AppError('space_config_invalid', 409);
  return config;
}

// 统一周次规则的兼容解析：
// - 新配置直接使用 weekRule；
// - 旧配置 oddEvenEnabled=false 映射为 every；
// - 旧配置 oddEvenEnabled=true 只有在校验全部草稿/已发布数据均为 every 或空时才映射为 every；
//   一旦出现 odd/even，规则保持未决，保留原数据与原投影，新写入被拒绝直到负责人处理。
async function resolveSpaceWeekRule(db, space, config) {
  if (config.weekRule) return { rule: config.weekRule, resolved: true, source: 'config' };
  if (config.oddEvenEnabled === false) return { rule: 'every', resolved: true, source: 'legacy_flag' };
  const documents = rows(await db.from('schedule_documents')
    .select('draft_entries,published_entries').eq('space_id', space.id));
  for (const document of documents) {
    for (const entries of [document.draft_entries, document.published_entries]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry?.weekRule === 'odd' || entry?.weekRule === 'even') {
          return { rule: null, resolved: false, source: 'legacy_data' };
        }
      }
    }
  }
  return { rule: 'every', resolved: true, source: 'legacy_data' };
}

function configWithWeekRule(config, resolved) {
  return config ? {
    ...config,
    weekRule: resolved.resolved ? resolved.rule : null,
    weekRuleResolved: resolved.resolved,
    weekRuleSource: resolved.source,
  } : null;
}

async function readScheduleDocument(db, spaceId, memberId) {
  const found = rows(await db.from('schedule_documents')
    .select(SCHEDULE_DOCUMENT_COLUMNS)
    .eq('space_id', spaceId).eq('member_id', memberId).limit(1));
  return found.length === 1 ? found[0] : null;
}

// 配置锁由“空间内存在任一有效提交”推导：零条目提交也计入，草稿不计入。
// 当前没有配置编辑入口；未来若增加成员移除，删除路径不得抹掉这些已发布文档，
// 否则锁判据会被破坏。
async function isConfigLocked(db, spaceId) {
  const documents = rows(await db.from('schedule_documents')
    .select('member_id,published_version').eq('space_id', spaceId));
  return documents.some((row) => isPublishedDocument(row));
}

// 新空间的 teaching 嵌在同一行 config 中，创建是一次原子写入；
// 旧 S2a 空间通过 space_teaching 单行 insert-if-absent 一次性补设，不重写任何锁定配置。
async function loadTeaching(db, space) {
  if (isLegacySpace(space)) return { teaching: null, state: 'legacy' };
  const embedded = space.config?.teaching;
  if (embedded !== undefined && embedded !== null) {
    const teaching = publicTeaching(embedded);
    return { teaching, state: teaching ? 'set' : 'invalid' };
  }
  const found = rows(await db.from('space_teaching')
    .select('timezone,first_week_monday,term_start,term_end')
    .eq('space_id', space.id).limit(1));
  if (found.length !== 1) return { teaching: null, state: 'pending' };
  const teaching = publicTeaching({
    timezone: found[0].timezone,
    firstWeekMonday: found[0].first_week_monday,
    termStart: found[0].term_start,
    termEnd: found[0].term_end,
  });
  return { teaching, state: teaching ? 'set' : 'invalid' };
}

async function readExceptionRow(db, spaceId, memberId, date, period) {
  const found = rows(await db.from('date_exceptions')
    .select(EXCEPTION_COLUMNS)
    .eq('space_id', spaceId).eq('member_id', memberId)
    .eq('local_date', date).eq('period', period).limit(1));
  return found.length === 1 ? found[0] : null;
}

function maskName(name) {
  const chars = [...name];
  if (chars.length <= 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function flattenSchedules(schedules, names, viewerId, isOwner) {
  const entries = [];
  for (const schedule of schedules) {
    if (!Array.isArray(schedule.entries)) throw new AppError('database_unavailable', 503);
    const name = names.get(schedule.member_id) ?? '成员';
    for (const entry of schedule.entries) {
      if (isOwner) {
        entries.push({
          scheduleId: schedule.id,
          memberId: schedule.member_id,
          memberName: name,
          maskedName: maskName(name),
          day: entry.day,
          period: entry.period,
          hasClass: entry.hasClass,
          courseName: entry.hasClass ? entry.courseName : null,
          version: schedule.version,
        });
      } else {
        entries.push({
          maskedName: maskName(name),
          isSelf: schedule.member_id === viewerId,
          day: entry.day,
          period: entry.period,
          hasClass: entry.hasClass,
          version: schedule.version,
        });
      }
    }
  }
  entries.sort((a, b) => (a.day - b.day) || (a.period - b.period)
    || String(a.maskedName).localeCompare(String(b.maskedName)));
  return entries;
}

function boundedPassword(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || encoder.encode(raw).length > 256) {
    throw new AppError('invalid_input', 400);
  }
  return raw;
}

async function register(db, request) {
  const body = await readJson(request);
  if (body?.noticeAccepted !== true) throw new AppError('notice_required', 400);
  const username = canonicalUsername(body?.username);
  const password = validatePassword(body?.password);
  const nickname = validateNickname(body?.nickname);
  const limit = await consume(db, 'register', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const existing = rows(await db.from('users').select('id').eq('username', username).limit(1));
  if (existing.length > 0) return errorJson('username_taken', 409);

  const derived = await hashPassword(password);
  const id = crypto.randomUUID();
  const created = rows(await db.from('users').insertIfAbsent({
    id,
    username,
    nickname,
    // 兼容旧表 NOT NULL 列；昵称单独存储，不写入该列。
    full_name: '',
    password_salt: derived.salt,
    password_hash: derived.hash,
    password_iterations: derived.iterations,
    created_at: new Date().toISOString(),
  }, { onConflict: 'username' }).select('id,username'));

  // 只接受自己写入的那一行；若 Provider 在冲突时回显既有账号，不得为其签发会话。
  if (created.length !== 1 || created[0]?.id !== id || created[0]?.username !== username) {
    const winner = rows(await db.from('users').select('id').eq('username', username).limit(1));
    if (winner.length === 1) return errorJson('username_taken', 409);
    return errorJson('registration_unconfirmed', 503);
  }

  const { token } = await createSession(db, id);
  return json({ user: { id, username, nickname } }, 201, { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS) });
}

async function login(db, request) {
  const body = await readJson(request);
  const username = canonicalUsername(body?.username);
  const limit = await consume(db, 'login', username);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const password = boundedPassword(body?.password);
  const found = rows(await db.from('users')
    .select('id,username,nickname,password_salt,password_hash,password_iterations')
    .eq('username', username).limit(1));

  if (found.length !== 1) {
    await verifyPasswordAgainstDummy(password);
    return errorJson('invalid_credentials', 401);
  }

  const user = found[0];
  const ok = await verifyPassword(password, {
    salt: user.password_salt, hash: user.password_hash, iterations: user.password_iterations,
  });
  if (!ok) return errorJson('invalid_credentials', 401);

  const { token } = await createSession(db, user.id);
  const nickname = typeof user.nickname === 'string' ? user.nickname : null;
  return json({
    user: { id: user.id, username: user.username, nickname },
  }, 200, { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS) });
}

async function logout(db, request) {
  const result = await validateSession(db, request);
  if (result.state === 'valid' && result.session) {
    try {
      await revokeSession(db, result.session.digest);
    } catch {
      return errorJson('logout_unconfirmed', 503);
    }
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

async function listSpaces(db, request) {
  const session = await requireSession(db, request);
  const ids = await findAccessibleSpaceIds(db, session.userId);
  const result = [];
  for (const id of ids) {
    const space = await loadSpace(db, id);
    if (!space) continue;
    const access = await resolveAccess(db, space, session.userId);
    if (!access) continue;
    result.push({
      id: space.id,
      name: space.name,
      mode: space.mode,
      role: access.role,
      inSpaceName: access.inSpaceName ?? null,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return json(result);
}

// 登录后的集中待办：只返回当前账号已加入空间里“尚未决定或版本已变化”的告知与共享。
// 未变更的决定不再重复询问；空间细节只对仍有访问权限的成员返回。
async function listConsents(db, request) {
  const session = await requireSession(db, request);
  const ids = await findAccessibleSpaceIds(db, session.userId);
  const items = [];
  for (const id of ids) {
    const space = await loadSpace(db, id);
    if (!space || !isS1Space(space)) continue;
    const access = await resolveAccess(db, space, session.userId);
    if (!access) continue;
    const calendar = calendarConsentView(await readCalendarConsent(db, space.id, session.userId));
    const share = shareView(await readShareConsent(db, space.id, session.userId));
    items.push({
      spaceId: space.id,
      spaceName: space.name,
      role: access.role,
      calendar,
      share,
      notices: { calendar: calendarNotice(), share: shareNotice() },
      pending: calendar.pending || share.pending,
    });
  }
  items.sort((a, b) => String(a.spaceName).localeCompare(String(b.spaceName)));
  return json({
    items,
    pendingCount: items.filter((item) => item.pending).length,
    general: GENERAL_TERMS,
    termsPath: '/terms.html',
  });
}

async function getSpaceTerms(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  const calendar = isS1Space(space)
    ? calendarConsentView(await readCalendarConsent(db, spaceId, session.userId))
    : null;
  const share = isS1Space(space)
    ? shareView(await readShareConsent(db, spaceId, session.userId))
    : null;
  return json({
    space: {
      id: space.id,
      name: space.name,
      mode: space.mode,
      role: access.role,
      inSpaceName: access.inSpaceName ?? null,
      kind: isLegacySpace(space) ? 'legacy' : 's1',
    },
    notices: {
      join: { version: NOTICE_VERSION, text: NOTICE_TEXT },
      calendar: calendarNotice(),
      share: shareNotice(),
    },
    decisions: { calendar, share },
    general: GENERAL_TERMS,
  });
}

// 创建空间是单行写入：owner_id、名称、配置、教学周设置和所有者在空间内姓名一起提交，
// 所有者身份由该行直接确定，不需要再写成员关系，也不会留下无所有者或半配置空间。
async function createSpace(db, request) {
  const session = await requireSession(db, request);
  const body = await readJson(request);
  const parsed = validateSpaceConfig(body);
  const teaching = validateTeaching(body?.teaching);
  const id = crypto.randomUUID();
  const inserted = rows(await db.from('spaces').insertIfAbsent({
    id,
    owner_id: session.userId,
    name: parsed.name,
    mode: parsed.mode,
    owner_name: parsed.ownerName,
    config: { ...parsed.config, teaching },
    created_at: new Date().toISOString(),
  }, { onConflict: 'id' }).select('id,name,mode'));
  if (inserted.length !== 1) return errorJson('space_unconfirmed', 503);
  return json({
    space: { id, name: parsed.name, mode: parsed.mode, role: 'owner', inSpaceName: parsed.ownerName },
    config: parsed.config,
    teaching: publicTeaching(teaching),
  }, 201);
}

async function getConfig(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  const { teaching, state } = await loadTeaching(db, space);
  const rawConfig = publicConfig(space.config);
  const weekRule = rawConfig ? await resolveSpaceWeekRule(db, space, rawConfig) : null;
  return json({
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    config: configWithWeekRule(rawConfig, weekRule),
    weekRule,
    configLocked: isS1Space(space) ? await isConfigLocked(db, spaceId) : false,
    teaching,
    teachingState: state,
    noticeVersion: NOTICE_VERSION,
  });
}

// 空间设置是负责人专属入口；成员仍可用只读的 /config 获取节次与时区摘要。
async function getSettings(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const { teaching, state: teachingState } = await loadTeaching(db, space);
  const collection = await loadCollectionSubjects(db, space);
  const participation = participationView(
    await readParticipation(db, spaceId, session.userId),
  );
  const rawConfig = publicConfig(space.config);
  const weekRule = rawConfig ? await resolveSpaceWeekRule(db, space, rawConfig) : null;
  return json({
    kind: 's1',
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    config: configWithWeekRule(rawConfig, weekRule),
    weekRule,
    configLocked: await isConfigLocked(db, spaceId),
    teaching,
    teachingState,
    collection: {
      total: collection.total,
      submitted: collection.submitted,
      unsubmitted: collection.unsubmitted,
    },
    ownerParticipation: participation,
    noticeVersion: NOTICE_VERSION,
    shareNotice: shareNotice(),
  });
}

async function getParticipation(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const document = await readScheduleDocument(db, spaceId, session.userId);
  const participation = participationView(
    await readParticipation(db, spaceId, session.userId),
  );
  return json({
    participation,
    schedule: {
      submitted: isPublishedDocument(document),
      publishedAt: document?.published_at ?? null,
      hasDraft: Boolean(document && Array.isArray(document.draft_entries)),
    },
  });
}

// 负责人参与/退出只影响收集名单：不改变 owner_id、邀请权或任何成员权限。
// 已有有效提交时重新加入必须显式选择“沿用已提交课表”或去编辑后重新提交，
// 服务端拒绝含糊的静默重新加入。
async function writeParticipation(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  const action = body?.action;
  if (action !== 'join' && action !== 'decline') throw new AppError('invalid_input', 400);
  const document = await readScheduleDocument(db, spaceId, session.userId);
  const current = participationView(await readParticipation(db, spaceId, session.userId));

  let row;
  if (action === 'decline') {
    row = await declineParticipation(db, spaceId, session.userId);
  } else {
    if (body?.source === 'published') {
      if (!isPublishedDocument(document)) throw new AppError('published_schedule_required', 409);
      row = await joinParticipation(db, spaceId, session.userId);
    } else {
      if (isPublishedDocument(document) && current.status !== 'joined') {
        throw new AppError('rejoin_choice_required', 409);
      }
      row = await joinParticipation(db, spaceId, session.userId);
    }
  }

  const collection = await loadCollectionSubjects(db, space);
  return json({
    participation: participationView(row),
    collection: {
      total: collection.total,
      submitted: collection.submitted,
      unsubmitted: collection.unsubmitted,
    },
    schedule: {
      submitted: isPublishedDocument(document),
      publishedAt: document?.published_at ?? null,
    },
  });
}

// 教学周设置只允许负责人一次性写入：旧空间用唯一 space_id 的 insert-if-absent 竞争，
// 并发下最多一个请求成功；新空间在创建时已随 config 单行写入，不再提供修改入口。
async function setTeaching(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const current = await loadTeaching(db, space);
  if (current.state !== 'pending') throw new AppError('teaching_already_set', 409);

  const body = await readJson(request);
  const teaching = validateTeaching(body?.teaching);
  const inserted = rows(await db.from('space_teaching').insertIfAbsent({
    space_id: spaceId,
    timezone: teaching.timezone,
    first_week_monday: teaching.firstWeekMonday,
    term_start: teaching.termStart,
    term_end: teaching.termEnd,
    set_at: new Date().toISOString(),
  }, { onConflict: 'space_id' }).select('space_id'));
  if (inserted.length !== 1) throw new AppError('teaching_already_set', 409);
  return json({ teaching: publicTeaching(teaching) });
}

// 空间首页只返回少量状态：教学周是否就绪、本人周课表提交状态、负责人收集进度。
async function getHome(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  const base = {
    kind: isS1Space(space) ? 's1' : 'legacy',
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    config: publicConfig(space.config),
    configLocked: isS1Space(space) ? await isConfigLocked(db, spaceId) : false,
  };
  if (isLegacySpace(space)) {
    const found = rows(await db.from('schedules')
      .select('version,updated_at').eq('space_id', spaceId).eq('member_id', session.userId).limit(1));
    return json({
      ...base,
      legacySchedule: found.length === 1
        ? { version: found[0].version ?? 0, updatedAt: found[0].updated_at ?? null }
        : null,
    });
  }

  const { teaching, state: teachingState } = await loadTeaching(db, space);
  const document = await readScheduleDocument(db, spaceId, session.userId);
  const submitted = isPublishedDocument(document);
  const consent = await readCalendarConsent(db, spaceId, session.userId);
  const shareConsent = await readShareConsent(db, spaceId, session.userId);
  const response = {
    ...base,
    teaching,
    teachingState,
    schedule: {
      submitted,
      publishedVersion: document?.published_version ?? 0,
      hasDraft: Boolean(document && Array.isArray(document.draft_entries)),
      publishedAt: document?.published_at ?? null,
    },
    calendar: {
      ready: Boolean(teaching && submitted),
      consentAccepted: calendarConsentView(consent).accepted,
      consent: calendarConsentView(consent),
      share: shareView(shareConsent),
    },
    assignments: {
      pendingCount: await pendingAssignmentCount(db, { space, userId: session.userId }),
    },
  };

  if (access.role === 'owner') {
    const collection = await loadCollectionSubjects(db, space);
    const participation = participationView(
      await readParticipation(db, spaceId, session.userId),
    );
    response.ownerParticipation = participation;
    response.collection = {
      total: collection.total,
      submitted: collection.submitted,
      unsubmitted: collection.unsubmitted,
    };
    response.participation = participation;
  }
  return json(response);
}

// 负责人只读取本空间必要的成员信息：空间内姓名、加入时间、是否已提交；不返回账号标识。
async function getMembers(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  const roster = await loadRoster(db, space);
  if (isS1Space(space)) {
    // 名单只暴露“是否有有效提交”和共享状态；草稿与日期例外都不进入负责人响应。
    const collection = await loadCollectionSubjects(db, space);
    const shareConsents = await loadShareConsents(db, spaceId);
    const participation = participationView(
      await readParticipation(db, spaceId, space.owner_id),
    );
    const subjects = new Map(collection.subjects.map((subject) => [subject.userId, subject]));
    const memberRow = (member) => {
      const subject = subjects.get(member.userId);
      return {
        role: member.role,
        inSpaceName: member.inSpaceName,
        joinedAt: member.joinedAt,
        noticeVersion: member.noticeVersion,
        noticeAckAt: member.noticeAckAt,
        hasSubmission: Boolean(subject?.submitted),
        countsInCollection: Boolean(subject),
        share: shareView(shareConsents.get(member.userId)),
      };
    };
    const members = roster.members
      .map(memberRow)
      .sort((a, b) => String(a.inSpaceName ?? '').localeCompare(String(b.inSpaceName ?? '')));
    const ownerRow = {
      ...memberRow(roster.owner),
      participation,
      countsInCollection: participation.status === 'joined',
      hasSubmission: isPublishedDocument(collection.documents.get(roster.owner.userId)),
    };
    return json({
      members: [ownerRow, ...members],
      // 收集进度只数有效提交：零条目提交也算，草稿永远不计入。
      summary: {
        total: collection.total,
        submitted: collection.submitted,
        unsubmitted: collection.unsubmitted,
      },
      ownerParticipation: participation,
      shareNotice: shareNotice(),
    });
  }

  const schedules = rows(await db.from('schedules').select('member_id').eq('space_id', spaceId));
  const submitted = new Set(schedules.map((row) => row.member_id));
  const withSubmission = (member) => ({
    role: member.role,
    inSpaceName: member.inSpaceName,
    joinedAt: member.joinedAt,
    noticeVersion: member.noticeVersion,
    noticeAckAt: member.noticeAckAt,
    hasSubmission: submitted.has(member.userId),
  });
  const members = roster.members
    .map((member) => withSubmission(member))
    .sort((a, b) => String(a.inSpaceName ?? '').localeCompare(String(b.inSpaceName ?? '')));
  const submittedCount = roster.members
    .filter((member) => submitted.has(member.userId)).length;
  return json({
    members: [withSubmission(roster.owner), ...members],
    summary: {
      total: roster.members.length,
      submitted: submittedCount,
      unsubmitted: roster.members.length - submittedCount,
    },
  });
}

async function getInvite(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const invite = await readInvite(db, spaceId);
  if (!invite) return json(emptyInviteSummary());
  return json(await inviteSummary(db, invite));
}

async function generateInvite(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  if (await readInvite(db, spaceId)) return errorJson('invite_exists', 409);

  const generation = 1;
  await ensureInviteSlots(db, spaceId, generation, INVITE_MAX_USES);
  const code = generateInviteCode();
  const hash = await hashInviteCode(code);
  const now = Date.now();
  const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
  const inserted = rows(await db.from('space_invites').insertIfAbsent({
    space_id: spaceId,
    code_hash: hash,
    generation,
    max_uses: INVITE_MAX_USES,
    expires_at: expiresAt,
    revoked: false,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  }, { onConflict: 'space_id' }).select('space_id'));
  if (inserted.length !== 1) return errorJson('invite_exists', 409);

  return json({
    code: formatInviteCode(code),
    generation,
    maxUses: INVITE_MAX_USES,
    expiresAt,
    notice: '邀请码只显示这一次；请通过可信渠道发送，不要在公开位置张贴。',
  }, 201);
}

// 轮换先为新代次建好槽位，再条件更新邀请行；旧成员仍保留在旧代次槽位中。
async function rotateInvite(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const current = await readInvite(db, spaceId);
  if (!current) return errorJson('invite_not_found', 404);

  const generation = current.generation + 1;
  await ensureInviteSlots(db, spaceId, generation, INVITE_MAX_USES);
  // 新代次槽位就绪后先让旧代次未认领槽位失效；邀请行更新失败时保持 fail-closed。
  await invalidateUnclaimedSlots(db, spaceId, current.generation);
  const code = generateInviteCode();
  const hash = await hashInviteCode(code);
  const now = Date.now();
  const expiresAt = new Date(now + INVITE_TTL_MS).toISOString();
  const updated = rows(await db.from('space_invites').update({
    code_hash: hash,
    generation,
    max_uses: INVITE_MAX_USES,
    expires_at: expiresAt,
    revoked: false,
    updated_at: new Date(now).toISOString(),
  }).eq('space_id', spaceId).eq('generation', current.generation).select('space_id'));
  if (updated.length !== 1) return errorJson('invite_conflict', 409);

  return json({
    code: formatInviteCode(code),
    generation,
    maxUses: INVITE_MAX_USES,
    expiresAt,
    notice: '已轮换：旧邀请码立即失效，已加入成员不受影响。新码只显示这一次。',
  });
}

async function revokeInvite(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const current = await readInvite(db, spaceId);
  if (!current) return errorJson('invite_not_found', 404);

  // 先让旧代次的未认领槽位失效，再标记邀请行；两步之间到达的认领会因代次条件失败。
  await invalidateUnclaimedSlots(db, spaceId, current.generation);
  const updated = rows(await db.from('space_invites').update({
    revoked: true,
    updated_at: new Date().toISOString(),
  }).eq('space_id', spaceId).eq('generation', current.generation).select('space_id'));
  if (updated.length !== 1) return errorJson('invite_conflict', 409);
  const invite = await readInvite(db, spaceId);
  return json({ ok: true, invite: invite ? await inviteSummary(db, invite) : emptyInviteSummary() });
}

function memberResponse(space, access, status = 200) {
  return json({
    ok: true,
    alreadyMember: true,
    space: { id: space.id, name: space.name, role: access.role },
    inSpaceName: access.inSpaceName ?? null,
  }, status);
}

async function redeemInvite(db, request) {
  const session = await requireSession(db, request);
  const body = await readJson(request);
  const code = normalizeInviteCode(body?.code);
  const inSpaceName = validateInSpaceName(body?.inSpaceName);
  if (body?.noticeAccepted !== true || body?.noticeVersion !== NOTICE_VERSION) {
    throw new AppError('notice_required', 400);
  }
  // 日期状态共享是可选的新用途；勾选时必须在认领名额前完成版本校验，
  // 写入失败不会回滚成员资格，但响应会明确 shareAccepted=false。
  const wantsShare = body?.shareNoticeAccepted === true;
  if (wantsShare && body?.shareNoticeVersion !== SHARE_NOTICE_VERSION) {
    throw new AppError('share_notice_required', 400);
  }
  const limit = await consume(db, 'join', session.userId);
  if (!limit.allowed) return errorJson('rate_limited', 429, retryAfter(limit));

  const hash = await hashInviteCode(code);
  const invites = rows(await db.from('space_invites').select('space_id,generation,expires_at,revoked')
    .eq('code_hash', hash).limit(1));
  if (invites.length !== 1) return errorJson('invite_unavailable', 410);
  const invite = invites[0];
  const expiresAt = Date.parse(invite.expires_at);
  if (invite.revoked !== false || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return errorJson('invite_unavailable', 410);
  }

  const space = await loadSpace(db, invite.space_id);
  if (!space || isLegacySpace(space)) return errorJson('invite_unavailable', 410);

  const existing = await resolveAccess(db, space, session.userId);
  if (existing) return memberResponse(space, existing);

  const stillCurrent = async () => {
    const latest = await readInvite(db, space.id);
    const latestExpiry = latest ? Date.parse(latest.expires_at) : NaN;
    return Boolean(latest
      && latest.revoked === false
      && Number.isFinite(latestExpiry)
      && latestExpiry > Date.now()
      && latest.generation === invite.generation);
  };
  const expiredNow = async () => {
    if (Date.now() < expiresAt) return false;
    // 过期后先让旧代次未认领槽位失效，避免并发中的认领继续写入。
    await invalidateUnclaimedSlots(db, space.id, invite.generation);
    return true;
  };

  const nowIso = new Date().toISOString();
  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt += 1) {
    if (await expiredNow()) return errorJson('invite_unavailable', 410);
    const slots = rows(await db.from('invite_slots').select('id,slot_no')
      .eq('space_id', space.id).eq('generation', invite.generation).eq('claimed', false)
      .order('slot_no', { ascending: true }).limit(1));
    if (slots.length === 0) {
      const again = await resolveAccess(db, space, session.userId);
      if (again) return memberResponse(space, again);
      const current = await stillCurrent();
      return errorJson(current ? 'invite_full' : 'invite_unavailable', current ? 409 : 410);
    }

    if (await expiredNow()) return errorJson('invite_unavailable', 410);
    const slot = slots[0];
    let updated;
    try {
      updated = rows(await db.from('invite_slots').update({
        claimed: true,
        claimed_by: session.userId,
        in_space_name: inSpaceName,
        notice_version: NOTICE_VERSION,
        notice_ack_at: nowIso,
        claimed_at: nowIso,
      }).eq('id', slot.id).eq('space_id', space.id)
        .eq('generation', invite.generation).eq('claimed', false).select('id,slot_no'));
    } catch (error) {
      const again = await resolveAccess(db, space, session.userId);
      if (again) return memberResponse(space, again);
      if (attempt === MAX_SLOT_ATTEMPTS - 1) throw new AppError('join_unconfirmed', 503);
      continue;
    }

    if (updated.length === 1) {
      let shareAccepted = false;
      if (wantsShare) {
        try {
          await ensureShareConsent(db, space.id, session.userId);
          shareAccepted = true;
        } catch {
          shareAccepted = false;
        }
      }
      return json({
        ok: true,
        alreadyMember: false,
        space: { id: space.id, name: space.name, role: 'member' },
        inSpaceName,
        noticeVersion: NOTICE_VERSION,
        noticeAckAt: nowIso,
        shareAccepted,
        shareNoticeVersion: SHARE_NOTICE_VERSION,
      }, 201);
    }

    const again = await resolveAccess(db, space, session.userId);
    if (again) return memberResponse(space, again);
  }

  const again = await resolveAccess(db, space, session.userId);
  if (again) return memberResponse(space, again);
  return errorJson('join_unconfirmed', 503);
}

async function overview(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  requireLegacySpace(space);

  const schedules = rows(await db.from('schedules')
    .select('id,member_id,entries,version,updated_at').eq('space_id', spaceId));
  const names = await loadMemberNames(db, space, schedules.map((schedule) => schedule.member_id));
  const isOwner = access.role === 'owner';
  return json({
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    entries: flattenSchedules(schedules, names, session.userId, isOwner),
  });
}

async function mySchedule(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  requireLegacySpace(space);

  const found = rows(await db.from('schedules')
    .select('id,entries,version,updated_at')
    .eq('space_id', spaceId).eq('member_id', session.userId).limit(1));
  const schedule = found.length === 1
    ? { id: found[0].id, entries: found[0].entries, version: found[0].version, updatedAt: found[0].updated_at }
    : null;
  return json({
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    schedule,
  });
}

async function submit(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireLegacySpace(space);

  const body = await readJson(request);
  const target = body?.memberId;
  if (target !== undefined) {
    if (!isUuid(target)) throw new AppError('invalid_input', 400);
    if (target !== session.userId) throw new AppError('forbidden', 403);
  }
  const version = validateVersion(body?.version);
  const entries = validateEntries(body?.entries, space.mode);
  const now = new Date().toISOString();

  if (version === 0) {
    const created = rows(await db.from('schedules').insertIfAbsent({
      id: crypto.randomUUID(),
      space_id: spaceId,
      member_id: session.userId,
      entries,
      version: 1,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' }).select('id,version'));
    if (created.length !== 1) return errorJson('version_conflict', 409);
    return json({ ok: true, version: 1, entries }, 201);
  }

  const updated = rows(await db.from('schedules').update({
    entries,
    version: version + 1,
    updated_at: now,
  }).eq('space_id', spaceId).eq('member_id', session.userId).eq('version', version)
    .select('id,version'));
  if (updated.length !== 1) return errorJson('version_conflict', 409);
  return json({ ok: true, version: version + 1, entries });
}

async function getWeekSchedule(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const weekRule = await resolveSpaceWeekRule(db, space, config);
  const document = await readScheduleDocument(db, spaceId, session.userId);
  const { teaching, state: teachingState } = await loadTeaching(db, space);

  // 我的课表只保存抽象每周模板；具体日期、事件与周视图只出现在个人日历和收集日历中。
  return json({
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    schedule: scheduleDocumentView(document),
    config: configWithWeekRule(config, weekRule),
    weekRule,
    configLocked: await isConfigLocked(db, spaceId),
    teaching,
    teachingState,
  });
}

function weekScheduleResponse(document, configLocked, replayed, status = 200, extra = {}) {
  return json({
    ok: true,
    replayed,
    schedule: scheduleDocumentView(document),
    configLocked,
    ...extra,
  }, status);
}

function isReplay(document, requestId, operation, digest) {
  return document?.last_request_id === requestId
    && document?.last_request_op === operation
    && document?.last_request_digest === digest;
}

// 单行文档是草稿、有效提交、revision 和最后请求标识的唯一原子边界。
// 条件更新失败后只重读一次：如果最后请求标识与内容都相同，视为并发重试成功；
// 否则返回版本冲突。只保留最后一个 requestId，因此更旧的重试不会无限期重放。
async function writeWeekSchedule(db, request, spaceId, operation) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const weekRule = await resolveSpaceWeekRule(db, space, config);

  const body = await readJson(request, SCHEDULE_BODY_LIMIT_BYTES);
  if (body?.memberId !== undefined && body.memberId !== session.userId) {
    throw new AppError('forbidden', 403);
  }
  const requestId = validateRequestId(body?.requestId);
  const baseRevision = validateVersion(body?.baseRevision);
  const entries = validateWeekEntries(body?.entries, { ...config, weekRule: weekRule.rule });
  // 只有负责人在发布时可显式把本人纳入收集；草稿永远不触发参与。
  const collectionJoin = access.role === 'owner'
    && operation === 'publish'
    && body?.collectionJoin === true;
  const digest = await scheduleRequestDigest(operation, baseRevision, entries, collectionJoin);
  const current = await readScheduleDocument(db, spaceId, session.userId);
  const finish = async (document, replayed, status = 200) => {
    if (collectionJoin) await joinParticipation(db, spaceId, session.userId);
    return weekScheduleResponse(
      document, await isConfigLocked(db, spaceId), replayed, status,
      collectionJoin ? { collectionJoin: true } : {},
    );
  };

  if (current?.last_request_id === requestId) {
    if (isReplay(current, requestId, operation, digest)) {
      return finish(current, true);
    }
    throw new AppError('request_reuse_conflict', 409);
  }

  const now = new Date().toISOString();
  if (current) {
    if (current.revision !== baseRevision) throw new AppError('version_conflict', 409);
    const patch = {
      revision: baseRevision + 1,
      draft_entries: entries,
      draft_updated_at: now,
      last_request_id: requestId,
      last_request_op: operation,
      last_request_digest: digest,
      updated_at: now,
    };
    if (operation === 'publish') {
      patch.published_entries = entries;
      patch.published_version = (Number.isSafeInteger(current.published_version)
        ? current.published_version : 0) + 1;
      patch.published_at = now;
    }
    const updated = rows(await db.from('schedule_documents').update(patch)
      .eq('space_id', spaceId).eq('member_id', session.userId).eq('revision', baseRevision)
      .select(SCHEDULE_DOCUMENT_COLUMNS));
    if (updated.length === 1) {
      return finish(updated[0], false);
    }
    const latest = await readScheduleDocument(db, spaceId, session.userId);
    if (isReplay(latest, requestId, operation, digest)) {
      return finish(latest, true);
    }
    if (latest?.last_request_id === requestId) throw new AppError('request_reuse_conflict', 409);
    throw new AppError('version_conflict', 409);
  }

  if (baseRevision !== 0) throw new AppError('version_conflict', 409);
  const created = rows(await db.from('schedule_documents').insertIfAbsent({
    id: crypto.randomUUID(),
    space_id: spaceId,
    member_id: session.userId,
    revision: 1,
    draft_entries: entries,
    published_entries: operation === 'publish' ? entries : null,
    published_version: operation === 'publish' ? 1 : 0,
    draft_updated_at: now,
    published_at: operation === 'publish' ? now : null,
    last_request_id: requestId,
    last_request_op: operation,
    last_request_digest: digest,
    updated_at: now,
  }, { onConflict: 'space_id,member_id' }).select(SCHEDULE_DOCUMENT_COLUMNS));
  if (created.length === 1) {
    return finish(created[0], false, 201);
  }
  const latest = await readScheduleDocument(db, spaceId, session.userId);
  if (isReplay(latest, requestId, operation, digest)) {
    return finish(latest, true);
  }
  if (latest?.last_request_id === requestId) throw new AppError('request_reuse_conflict', 409);
  throw new AppError('version_conflict', 409);
}

// 本人月历只读取自己的分布：服务端按月投影，不落库、不返回其他人的例外或课程名。
async function getCalendar(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);

  const url = new URL(request.url);
  const requestedMember = url.searchParams.get('memberId');
  if (requestedMember !== null && requestedMember !== session.userId) throw new AppError('forbidden', 403);
  const month = validateMonth(url.searchParams.get('month'));
  // 草稿预览只读本人且不改变提交状态：用草稿内容做投影，响应显式标记 preview，
  // 收集、导出与负责人视图仍只读已发布快照。
  const preview = url.searchParams.get('preview') === 'draft';

  const document = await readScheduleDocument(db, spaceId, session.userId);
  if (preview && !Array.isArray(document?.draft_entries)) throw new AppError('draft_not_found', 404);
  const storedExceptions = rows(await db.from('date_exceptions')
    .select(EXCEPTION_COLUMNS)
    .eq('space_id', spaceId).eq('member_id', session.userId));
  const exceptions = storedExceptions.filter((row) => typeof row.local_date === 'string'
    && row.local_date.startsWith(`${month}-`));
  const consent = await readCalendarConsent(db, spaceId, session.userId);
  const shareConsent = await readShareConsent(db, spaceId, session.userId);
  const { teaching, state: teachingState } = await loadTeaching(db, space);
  const occupancy = await loadOccupancy(db, {
    spaceId, config, dates: monthDates(month), viewerId: session.userId,
  });
  const projection = await projectMonth({
    teaching,
    config,
    document: preview
      ? { ...document, published_entries: document.draft_entries, published_version: 1 }
      : document,
    exceptions,
    month,
    externalOccupancy: occupancy.get(session.userId) ?? null,
  });
  const events = await loadVisibleEventsForMonth(db, {
    spaceId, viewerId: session.userId, month,
  });
  const incoming = await incomingAssignments(db, {
    space, config, teaching, userId: session.userId,
  });
  const draftEntries = Array.isArray(document?.draft_entries) ? document.draft_entries : null;
  const publishedEntries = Number(document?.published_version) > 0
    && Array.isArray(document?.published_entries) ? document.published_entries : [];
  return json({
    kind: 's1',
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    config,
    teaching,
    teachingState,
    month: projection.month,
    state: projection.state,
    preview: preview ? 'draft' : null,
    submitted: Number(document?.published_version) > 0,
    publishedVersion: Number(document?.published_version) || 0,
    draft: {
      exists: Boolean(draftEntries),
      updatedAt: document?.draft_updated_at ?? null,
      changed: Boolean(draftEntries)
        && JSON.stringify(draftEntries) !== JSON.stringify(publishedEntries),
    },
    today: projection.today,
    days: projection.days,
    events,
    assignments: incoming.assignments,
    pendingCount: incoming.pendingCount,
    consent: calendarConsentView(consent),
    notice: calendarNotice(),
    share: {
      consent: shareView(shareConsent),
      notice: shareNotice(),
    },
  });
}

// 告知确认或拒绝都记录版本与时间；拒绝不阻止进入应用，但日期例外写入保持关闭。
async function writeCalendarConsent(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  const action = body?.action ?? 'accept';
  if (body?.noticeVersion !== CALENDAR_NOTICE_VERSION
    && !calendarVersionAccepted(body?.noticeVersion)) {
    throw new AppError('calendar_notice_required', 403);
  }
  if (action === 'accept') {
    if (body?.noticeAccepted !== true) throw new AppError('calendar_notice_required', 403);
    await ensureCalendarConsent(db, spaceId, session.userId);
  } else if (action === 'decline') {
    await declineCalendarConsent(db, spaceId, session.userId);
  } else {
    throw new AppError('invalid_input', 400);
  }
  const consent = await readCalendarConsent(db, spaceId, session.userId);
  return json({ consent: calendarConsentView(consent) });
}

// 日期状态共享：确认、拒绝与撤回都落服务端；都不触碰日期例外、课表、收集参与或账号权限。
async function writeShareConsent(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  const action = body?.action;
  if (action === 'revoke') {
    const row = await revokeShareConsent(db, spaceId, session.userId);
    return json({ consent: shareView(row), notice: shareNotice() });
  }
  if (body?.noticeVersion !== SHARE_NOTICE_VERSION) {
    throw new AppError('share_notice_required', 403);
  }
  if (action === 'accept') {
    if (body?.noticeAccepted !== true) throw new AppError('share_notice_required', 403);
    const row = await ensureShareConsent(db, spaceId, session.userId);
    return json({ consent: shareView(row), notice: shareNotice() });
  }
  if (action === 'decline') {
    const row = await declineShareConsent(db, spaceId, session.userId);
    return json({ consent: shareView(row), notice: shareNotice() });
  }
  throw new AppError('invalid_input', 400);
}

// 收集日历只给负责人：按教学周与空间时区实时投影，不落第二份月历，也不返回草稿。
async function getCollection(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space, access } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const { teaching, state: teachingState } = await loadTeaching(db, space);
  if (!teaching) throw new AppError('teaching_required', 409);
  const url = new URL(request.url);
  const month = validateMonth(url.searchParams.get('month'));

  const collection = await loadCollectionSubjects(db, space);
  const shareConsents = await loadShareConsents(db, spaceId);
  const storedExceptions = rows(await db.from('date_exceptions')
    .select(EXCEPTION_COLUMNS).eq('space_id', spaceId));
  const occupancy = await loadOccupancy(db, {
    spaceId, config, dates: monthDates(month), viewerId: session.userId,
  });
  const projection = await projectCollectionMonth({
    teaching, config, month, collection, shareConsents,
    exceptions: storedExceptions, viewerId: session.userId, occupancy,
  });
  const events = await loadVisibleEventsForMonth(db, {
    spaceId, viewerId: session.userId, month,
  });
  return json({
    kind: 's1',
    space: { id: space.id, name: space.name, mode: space.mode, role: access.role },
    viewer: { inSpaceName: access.inSpaceName ?? null },
    config,
    teaching,
    teachingState,
    month: projection.month,
    today: projection.today,
    participation: collection.ownerParticipation,
    summary: {
      total: collection.total,
      submitted: collection.submitted,
      unsubmitted: collection.unsubmitted,
    },
    members: collection.subjects.map((subject) => ({
      name: subject.inSpaceName ?? '成员',
      role: subject.role,
      source: subject.source,
      submitted: subject.submitted,
      share: subject.userId === session.userId
        ? { ...shareView(shareConsents.get(subject.userId)), status: 'accepted', accepted: true, self: true }
        : shareView(shareConsents.get(subject.userId)),
    })),
    // 负责人发起事件通知/站内安排时选择接收人；只返回空间内 UUID 与姓名，不含账号或联系方式。
    roster: collection.subjects.map((subject) => ({
      userId: subject.userId,
      name: subject.inSpaceName ?? '成员',
      role: subject.role,
      source: subject.source,
      submitted: subject.submitted,
    })),
    days: projection.days,
    events,
    shareNotice: shareNotice(),
  });
}

async function getCollectionExport(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const { teaching } = await loadTeaching(db, space);
  if (!teaching) throw new AppError('teaching_required', 409);
  const url = new URL(request.url);
  const requestedWeek = url.searchParams.get('week') ?? url.searchParams.get('date');
  const { weekStart, weekEnd } = normalizeExportWeek(requestedWeek ?? localToday(teaching.timezone));

  const collection = await loadCollectionSubjects(db, space);
  const shareConsents = await loadShareConsents(db, spaceId);
  const storedExceptions = rows(await db.from('date_exceptions')
    .select(EXCEPTION_COLUMNS).eq('space_id', spaceId));
  const bytes = await buildCollectionWorkbook({
    space, config, teaching, collection, shareConsents, exceptions: storedExceptions,
    viewerId: session.userId, weekStart,
  });
  return binary(bytes, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: exportFilename(space.name, weekStart, weekEnd),
  });
}

async function getEvents(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const url = new URL(request.url);
  const month = validateMonth(url.searchParams.get('month'));
  const events = await loadVisibleEventsForMonth(db, {
    spaceId, viewerId: session.userId, month,
  });
  return json({ month, events });
}

async function createSpaceEvent(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  const result = await createEvent(db, { space, userId: session.userId, body });
  return json(result, result.replayed ? 200 : 201);
}

async function updateSpaceEvent(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  return json(await updateEvent(db, { spaceId, userId: session.userId, body }));
}

async function deleteSpaceEvent(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const body = await readJson(request);
  return json(await deleteEvent(db, { spaceId, userId: session.userId, body }));
}

// 负责人只发起“安排忙碌/请求确认有空”，不直接改写成员的日期例外；成员接受后才进入投影。
async function createArrangement(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireOwner(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const { teaching } = await loadTeaching(db, space);
  if (!teaching) throw new AppError('teaching_required', 409);
  const body = await readJson(request);
  const result = await createStandaloneAssignment(db, {
    space, config, teaching, creatorId: session.userId, body,
  });
  return json({
    assignment: result.assignment,
    conflict: result.conflict,
    replayed: result.replayed,
  }, result.replayed ? 200 : 201);
}

async function respondToAssignment(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);
  const { teaching } = await loadTeaching(db, space);
  const body = await readJson(request);
  return json(await respondAssignment(db, {
    space, config, teaching, userId: session.userId, body,
  }));
}

function isExceptionReplay(row, requestId, action, digest) {
  return row?.last_request_id === requestId
    && row.last_request_op === action
    && row.last_request_digest === digest;
}

function exceptionResponse(row, action, replayed, status = 200) {
  return json({ ok: true, replayed, exception: exceptionView(row) }, status);
}

// 具体日期例外是两个独立维度：取消当日占用、个人忙/可用声明。
// 单行覆盖以版本 CAS + 最后请求标识保证重试安全；空覆盖保留版本，避免恢复默认后的 ABA。
async function writeException(db, request, spaceId) {
  const session = await requireSession(db, request);
  const { space } = await requireAccess(db, spaceId, session.userId);
  requireS1Space(space);
  const config = requireS1Config(space);

  const body = await readJson(request);
  if (body?.memberId !== undefined && body.memberId !== session.userId) {
    throw new AppError('forbidden', 403);
  }
  const consent = await readCalendarConsent(db, spaceId, session.userId);
  if (!calendarConsentView(consent).accepted) throw new AppError('calendar_notice_required', 403);
  if (body?.noticeAccepted !== true) throw new AppError('calendar_notice_required', 403);
  if (!calendarVersionAccepted(body?.noticeVersion)) {
    throw new AppError('calendar_notice_required', 403);
  }
  const requestId = validateRequestId(body?.requestId);
  const baseVersion = validateVersion(body?.baseVersion);
  const action = body?.action;
  if (action !== 'save' && action !== 'reset') throw new AppError('invalid_input', 400);
  if (!isValidDate(body?.date)) throw new AppError('invalid_date', 400);
  const date = body.date;
  const period = body?.period;
  if (!Number.isSafeInteger(period) || !config.periods.some((item) => item.index === period)) {
    throw new AppError('invalid_period', 400);
  }
  const cancelClass = action === 'save' && body?.cancelClass === true;
  const personalState = action === 'save' ? validatePersonalState(body?.personalState) : 'none';
  const acknowledgeCourseChange = body?.acknowledgeCourseChange === true;

  const { teaching } = await loadTeaching(db, space);
  if (!teaching) throw new AppError('teaching_required', 409);
  const today = localToday(teaching.timezone);
  if (date < today) throw new AppError('date_not_editable', 409);
  if (date === today) {
    const periodMeta = config.periods.find((item) => item.index === period);
    const editable = periodEditable({
      date,
      today,
      nowMinutes: localMinuteOfDay(teaching.timezone),
      periodMeta,
      submitted: true,
      inTerm: true,
    });
    if (!editable) throw new AppError('date_not_editable', 409);
  }
  if (date < teaching.termStart || date > teaching.termEnd) throw new AppError('date_out_of_term', 409);

  const document = await readScheduleDocument(db, spaceId, session.userId);
  if (!isPublishedDocument(document)) throw new AppError('schedule_not_published', 409);
  const weekNumber = teachingWeekNumber(teaching, date);
  const value = weeklyValueFromMap(
    buildWeeklyMap(document.published_entries, config), date, period, weekNumber,
  );

  if (action === 'save') {
    if (cancelClass && !value) throw new AppError('cancel_requires_class', 409);
    if (!cancelClass && personalState !== 'none' && value) {
      throw new AppError('cancel_required_for_statement', 409);
    }
  }

  const digest = await sha256Hex(JSON.stringify({
    action, date, period, baseVersion, cancelClass, personalState, acknowledgeCourseChange,
  }));
  const current = await readExceptionRow(db, spaceId, session.userId, date, period);
  if (current?.last_request_id === requestId) {
    if (isExceptionReplay(current, requestId, action, digest)) {
      return exceptionResponse(current, action, true);
    }
    throw new AppError('request_reuse_conflict', 409);
  }

  // 清除个人声明不得顺手清掉停课；只有确认无课的过期停课才能这样解除。
  if (current?.cancel_class === true && action === 'save' && !cancelClass) {
    if (value || !acknowledgeCourseChange) throw new AppError('cancel_clear_requires_reset', 409);
  }

  let signature = null;
  if (cancelClass) {
    signature = await courseSignature(value, config);
    if (current?.cancel_class === true
      && current.course_signature !== signature
      && !acknowledgeCourseChange) {
      throw new AppError('course_change_confirmation_required', 409);
    }
  }

  const now = new Date().toISOString();
  await ensureCalendarConsent(db, spaceId, session.userId);

  if (!current) {
    if (baseVersion !== 0) throw new AppError('version_conflict', 409);
    if (action === 'reset') {
      return exceptionResponse({ local_date: date, period, version: 0 }, action, false);
    }
    const inserted = rows(await db.from('date_exceptions').insertIfAbsent({
      id: crypto.randomUUID(),
      space_id: spaceId,
      member_id: session.userId,
      local_date: date,
      period,
      cancel_class: cancelClass,
      personal_state: personalState,
      course_signature: signature,
      version: 1,
      last_request_id: requestId,
      last_request_op: action,
      last_request_digest: digest,
      created_at: now,
      updated_at: now,
    }, { onConflict: 'space_id,member_id,local_date,period' }).select(EXCEPTION_COLUMNS));
    if (inserted.length === 1) return exceptionResponse(inserted[0], action, false, 201);

    const latest = await readExceptionRow(db, spaceId, session.userId, date, period);
    if (isExceptionReplay(latest, requestId, action, digest)) {
      return exceptionResponse(latest, action, true);
    }
    if (latest?.last_request_id === requestId) throw new AppError('request_reuse_conflict', 409);
    throw new AppError('version_conflict', 409);
  }

  if (current.version !== baseVersion) throw new AppError('version_conflict', 409);
  if (action === 'reset' && current.cancel_class !== true
    && (!current.personal_state || current.personal_state === 'none')) {
    return exceptionResponse(current, action, false);
  }

  const updated = rows(await db.from('date_exceptions').update({
    cancel_class: cancelClass,
    personal_state: personalState,
    course_signature: signature,
    version: baseVersion + 1,
    last_request_id: requestId,
    last_request_op: action,
    last_request_digest: digest,
    updated_at: now,
  }).eq('space_id', spaceId).eq('member_id', session.userId)
    .eq('local_date', date).eq('period', period).eq('version', baseVersion)
    .select(EXCEPTION_COLUMNS));
  if (updated.length === 1) return exceptionResponse(updated[0], action, false);

  const latest = await readExceptionRow(db, spaceId, session.userId, date, period);
  if (isExceptionReplay(latest, requestId, action, digest)) {
    return exceptionResponse(latest, action, true);
  }
  if (latest?.last_request_id === requestId) throw new AppError('request_reuse_conflict', 409);
  throw new AppError('version_conflict', 409);
}

async function route(db, request, origin) {
  requireTrustedOrigin(request, origin);
  const path = applicationPath(request);

  if (path === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (path === '/api/notice' && request.method === 'GET') {
    return json({
      version: NOTICE_VERSION,
      text: NOTICE_TEXT,
      share: shareNotice(),
      calendar: calendarNotice(),
      general: GENERAL_TERMS,
      termsPath: '/terms.html',
    });
  }
  if (path === '/api/consents' && request.method === 'GET') return listConsents(db, request);
  if (path === '/api/register' && request.method === 'POST') return register(db, request);
  if (path === '/api/login' && request.method === 'POST') return login(db, request);
  if (path === '/api/logout' && request.method === 'POST') return logout(db, request);
  if (path === '/api/join' && request.method === 'POST') return redeemInvite(db, request);

  if (path === '/api/me' && request.method === 'GET') {
    const session = await requireSession(db, request);
    return json({ user: await loadUser(db, session.userId) });
  }
  if (path === '/api/spaces') {
    if (request.method === 'GET') return listSpaces(db, request);
    if (request.method === 'POST') return createSpace(db, request);
    throw new AppError('method_not_allowed', 405);
  }

  const matched = path.match(/^\/api\/spaces\/([^/]+)\/(overview|my-schedule|submissions|config|settings|participation|members|invite|invite\/rotate|invite\/revoke|schedule|schedule\/draft|schedule\/publish|home|teaching|calendar|calendar\/consent|calendar\/share|exceptions|collection|collection\/export|events|events\/update|events\/delete|arrangements|assignments\/respond|terms)$/);
  if (matched) {
    if (!isUuid(matched[1])) throw new AppError('invalid_input', 400);
    const spaceId = matched[1];
    const action = matched[2];
    if (action === 'home') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getHome(db, request, spaceId);
    }
    if (action === 'settings') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getSettings(db, request, spaceId);
    }
    if (action === 'terms') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getSpaceTerms(db, request, spaceId);
    }
    if (action === 'participation') {
      if (request.method === 'GET') return getParticipation(db, request, spaceId);
      if (request.method === 'POST') return writeParticipation(db, request, spaceId);
      throw new AppError('method_not_allowed', 405);
    }
    if (action === 'collection') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getCollection(db, request, spaceId);
    }
    if (action === 'collection/export') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getCollectionExport(db, request, spaceId);
    }
    if (action === 'events') {
      if (request.method === 'GET') return getEvents(db, request, spaceId);
      if (request.method === 'POST') return createSpaceEvent(db, request, spaceId);
      throw new AppError('method_not_allowed', 405);
    }
    if (action === 'events/update') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return updateSpaceEvent(db, request, spaceId);
    }
    if (action === 'events/delete') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return deleteSpaceEvent(db, request, spaceId);
    }
    if (action === 'arrangements') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return createArrangement(db, request, spaceId);
    }
    if (action === 'assignments/respond') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return respondToAssignment(db, request, spaceId);
    }
    if (action === 'teaching') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return setTeaching(db, request, spaceId);
    }
    if (action === 'calendar') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getCalendar(db, request, spaceId);
    }
    if (action === 'calendar/consent') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return writeCalendarConsent(db, request, spaceId);
    }
    if (action === 'calendar/share') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return writeShareConsent(db, request, spaceId);
    }
    if (action === 'exceptions') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return writeException(db, request, spaceId);
    }
    if (action === 'overview') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return overview(db, request, spaceId);
    }
    if (action === 'my-schedule') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return mySchedule(db, request, spaceId);
    }
    if (action === 'config') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getConfig(db, request, spaceId);
    }
    if (action === 'members') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getMembers(db, request, spaceId);
    }
    if (action === 'invite') {
      if (request.method === 'GET') return getInvite(db, request, spaceId);
      if (request.method === 'POST') return generateInvite(db, request, spaceId);
      throw new AppError('method_not_allowed', 405);
    }
    if (action === 'invite/rotate') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return rotateInvite(db, request, spaceId);
    }
    if (action === 'invite/revoke') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return revokeInvite(db, request, spaceId);
    }
    if (action === 'schedule') {
      if (request.method !== 'GET') throw new AppError('method_not_allowed', 405);
      return getWeekSchedule(db, request, spaceId);
    }
    if (action === 'schedule/draft') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return writeWeekSchedule(db, request, spaceId, 'draft');
    }
    if (action === 'schedule/publish') {
      if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
      return writeWeekSchedule(db, request, spaceId, 'publish');
    }
    if (request.method !== 'POST') throw new AppError('method_not_allowed', 405);
    return submit(db, request, spaceId);
  }

  if (['/api/health', '/api/notice', '/api/register', '/api/login', '/api/logout',
    '/api/join', '/api/me', '/api/spaces'].includes(path)) {
    throw new AppError('method_not_allowed', 405);
  }
  throw new AppError('not_found', 404);
}

export function createApplication({ db, origin }) {
  return async function handle(ctx) {
    try {
      return await route(db, ctx.request, typeof origin === 'function' ? origin() : origin);
    } catch (error) {
      if (error instanceof SessionRequired) return unauthorized(error.state);
      if (error instanceof AppError) return errorJson(error.code, error.status);
      return errorJson('service_unavailable', 503);
    }
  };
}

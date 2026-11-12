// 站内安排与事件接受：负责人发起，成员本人确认后才会进入投影。
// 事件时间不写入 personal date_exceptions；接受记录以 event_stamp 绑定当前时间版本，
// 改期后旧确认自动失效，取消/删除事件只释放该事件的占用。
import { AppError, rows } from './http.mjs';
import { isUuid } from './validate.mjs';
import { loadRoster } from './membership.mjs';
import { SCHEDULE_DOCUMENT_COLUMNS, isPublishedDocument } from './week-schedule.mjs';
import {
  addDays, buildWeeklyMap, courseSignature, daysBetween, isValidDate, localMinuteOfDay,
  localToday, timeToMinutes, weekdayMon1, weeklyValueFromMap,
} from './calendar.mjs';

export const ASSIGNMENT_KINDS = ['event', 'busy', 'available'];
export const ASSIGNMENT_STATUSES = ['pending', 'accepted', 'rejected', 'withdrawn'];
export const EVENT_RECIPIENT_MAX = 200;
export const ASSIGNMENT_COLUMNS = [
  'id', 'space_id', 'event_id', 'kind', 'request_id', 'created_by', 'target_user_id',
  'request_date', 'request_period', 'event_stamp', 'status', 'version',
  'last_request_id', 'last_request_op', 'last_request_digest',
  'created_at', 'responded_at', 'updated_at',
].join(',');
const EXCEPTION_COLUMNS = [
  'space_id', 'member_id', 'local_date', 'period', 'cancel_class', 'personal_state',
  'course_signature', 'version', 'updated_at',
].join(',');

export function buildEventStamp(event) {
  return [
    event?.start_date ?? '',
    event?.end_date ?? '',
    event?.all_day === true ? '1' : '0',
    event?.start_time ?? '',
    event?.end_time ?? '',
  ].join('|');
}

export function eventRecipientIds(row) {
  if (!row || typeof row.recipient_ids !== 'string' || !row.recipient_ids) return [];
  try {
    const parsed = JSON.parse(row.recipient_ids);
    return Array.isArray(parsed) ? parsed.filter((id) => isUuid(id)) : [];
  } catch {
    return [];
  }
}

export function resolveRecipientIds(roster, creatorId, scope, rawRecipients) {
  if (scope === 'none') return [];
  if (scope === 'all') {
    return [...new Set(roster.members.map((member) => member.userId))]
      .filter((id) => id !== creatorId)
      .sort();
  }
  if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
    throw new AppError('event_recipients_required', 400);
  }
  if (rawRecipients.length > EVENT_RECIPIENT_MAX) {
    throw new AppError('event_recipients_too_many', 400);
  }
  const allowed = new Set([
    roster.owner.userId,
    ...roster.members.map((member) => member.userId),
  ]);
  const ids = [...new Set(rawRecipients)];
  for (const id of ids) {
    if (!isUuid(id)) throw new AppError('invalid_event_recipients', 400);
    if (id === creatorId) throw new AppError('event_recipient_self', 400);
    if (!allowed.has(id)) throw new AppError('event_recipient_not_member', 400);
  }
  return ids.sort();
}

function eventDates(event) {
  if (!isValidDate(event?.start_date) || !isValidDate(event?.end_date)) return [];
  const span = daysBetween(event.end_date, event.start_date);
  if (span < 0) return [];
  return Array.from({ length: span + 1 }, (_, index) => addDays(event.start_date, index));
}

function eventPeriodIndexes(event, config) {
  const periods = [...(config?.periods ?? [])].sort((a, b) => a.index - b.index);
  if (event?.all_day === true) return periods.map((period) => period.index);
  const start = timeToMinutes(event?.start_time);
  const end = timeToMinutes(event?.end_time);
  if (start === null || end === null || end <= start) return [];
  return periods
    .filter((period) => {
      const periodStart = timeToMinutes(period.start);
      const periodEnd = timeToMinutes(period.end);
      if (periodStart === null || periodEnd === null) return false;
      return start < periodEnd && end > periodStart;
    })
    .map((period) => period.index);
}

export function eventCoverage(event, config) {
  const periods = eventPeriodIndexes(event, config);
  if (periods.length === 0) return [];
  const output = [];
  for (const date of eventDates(event)) {
    for (const period of periods) output.push({ date, period });
  }
  return output;
}

function occupancyEntry(map, userId, date, period) {
  let byDate = map.get(userId);
  if (!byDate) {
    byDate = new Map();
    map.set(userId, byDate);
  }
  const key = `${date}:${period}`;
  let entry = byDate.get(key);
  if (!entry) {
    entry = { busy: [], available: [] };
    byDate.set(key, entry);
  }
  return entry;
}

function eventSourceVisible(event, viewerId) {
  if (event.visibility === 'space') return true;
  if (viewerId === null || viewerId === undefined) return false;
  if (event.created_by === viewerId) return true;
  return eventRecipientIds(event).includes(viewerId);
}

// 只有“已接受且事件时间版本仍匹配”的占用才进入投影；删除事件和改期旧确认都会自动释放。
// 仅受邀事件对非受邀查看者只显示“事件占用”，不返回标题或事件 ID。
export function occupancyFromAssignments({
  assignments, events, config, dates = null, viewerId = null,
}) {
  const eventMap = new Map((events ?? []).map((event) => [event.id, event]));
  const allowedDates = dates ? new Set(dates) : null;
  const map = new Map();
  for (const row of assignments ?? []) {
    if (row.status !== 'accepted') continue;
    if (row.kind === 'event') {
      const event = eventMap.get(row.event_id);
      if (!event || event.deleted === true) continue;
      if (row.event_stamp !== buildEventStamp(event)) continue;
      const visible = eventSourceVisible(event, viewerId);
      for (const cell of eventCoverage(event, config)) {
        if (allowedDates && !allowedDates.has(cell.date)) continue;
        occupancyEntry(map, row.target_user_id, cell.date, cell.period).busy.push(
          visible
            ? {
              type: 'event',
              label: `事件：${event.title}`,
              eventId: event.id,
              assignmentId: row.id,
            }
            : { type: 'event', label: '事件占用', assignmentId: row.id, hidden: true },
        );
      }
    } else if (allowedDates && !allowedDates.has(row.request_date)) {
      continue;
    } else if (row.kind === 'busy') {
      occupancyEntry(map, row.target_user_id, row.request_date, row.request_period).busy.push({
        type: 'request',
        label: '负责人安排',
        assignmentId: row.id,
      });
    } else if (row.kind === 'available') {
      occupancyEntry(map, row.target_user_id, row.request_date, row.request_period).available.push({
        type: 'request',
        label: '负责人确认有空',
        assignmentId: row.id,
      });
    }
  }
  return map;
}

export async function loadAssignments(db, spaceId) {
  return rows(await db.from('event_assignments').select(ASSIGNMENT_COLUMNS).eq('space_id', spaceId));
}

export async function loadEventRows(db, spaceId, eventIds = null) {
  const found = rows(await db.from('space_events')
    .select('id,space_id,created_by,title,description,start_date,end_date,all_day,start_time,end_time,visibility,recipient_scope,recipient_ids,deleted,version,created_at,updated_at')
    .eq('space_id', spaceId));
  if (!eventIds) return found;
  const allowed = new Set(eventIds);
  return found.filter((row) => allowed.has(row.id));
}

export async function loadOccupancy(db, {
  spaceId, config, dates = null, viewerId = null,
}) {
  const assignments = await loadAssignments(db, spaceId);
  const eventIds = [...new Set(assignments.filter((row) => row.kind === 'event').map((row) => row.event_id))];
  const events = eventIds.length > 0 ? await loadEventRows(db, spaceId, eventIds) : [];
  return occupancyFromAssignments({ assignments, events, config, dates, viewerId });
}

export async function createEventAssignments(db, { event, creatorId, recipientIds }) {
  const now = new Date().toISOString();
  const stamp = buildEventStamp(event);
  const created = [];
  for (const targetUserId of recipientIds) {
    const inserted = rows(await db.from('event_assignments').insertIfAbsent({
      id: crypto.randomUUID(),
      space_id: event.space_id,
      event_id: event.id,
      kind: 'event',
      request_id: event.id,
      created_by: creatorId,
      target_user_id: targetUserId,
      request_date: null,
      request_period: null,
      event_stamp: stamp,
      status: 'pending',
      version: 1,
      last_request_id: null,
      last_request_op: null,
      last_request_digest: null,
      created_at: now,
      responded_at: null,
      updated_at: now,
    }, { onConflict: 'space_id,request_id,target_user_id' }).select(ASSIGNMENT_COLUMNS));
    if (inserted.length === 1) created.push(inserted[0]);
  }
  return created;
}

export async function createStandaloneAssignment(db, {
  space, config, teaching, creatorId, body, now = new Date(),
}) {
  if (!isUuid(body?.id)) throw new AppError('invalid_assignment_id', 400);
  const kind = body?.kind;
  if (kind !== 'busy' && kind !== 'available') throw new AppError('invalid_assignment_kind', 400);
  const targetUserId = body?.targetUserId;
  if (!isUuid(targetUserId)) throw new AppError('invalid_assignment_target', 400);
  if (targetUserId === creatorId) throw new AppError('assignment_target_self', 400);
  const roster = await loadRoster(db, space);
  const allowed = new Set([
    roster.owner.userId,
    ...roster.members.map((member) => member.userId),
  ]);
  if (!allowed.has(targetUserId)) throw new AppError('assignment_target_not_member', 404);
  if (!isValidDate(body?.date)) throw new AppError('invalid_assignment_date', 400);
  const period = body?.period;
  if (!Number.isSafeInteger(period)
    || !config.periods.some((item) => item.index === period)) {
    throw new AppError('invalid_assignment_period', 400);
  }
  const term = teaching && typeof teaching === 'object' ? teaching : null;
  if (!term) throw new AppError('teaching_required', 409);
  const today = localToday(term.timezone, now);
  if (!today || body.date < today || body.date < term.termStart || body.date > term.termEnd) {
    throw new AppError('assignment_date_closed', 409);
  }
  const periodMeta = config.periods.find((item) => item.index === period);
  if (body.date === today) {
    const minutes = localMinuteOfDay(term.timezone, now);
    const end = timeToMinutes(periodMeta.end);
    if (minutes !== null && end !== null && end <= minutes) {
      throw new AppError('assignment_date_closed', 409);
    }
  }

  const nowText = new Date().toISOString();
  const inserted = rows(await db.from('event_assignments').insertIfAbsent({
    id: body.id,
    space_id: space.id,
    event_id: null,
    kind,
    request_id: body.id,
    created_by: creatorId,
    target_user_id: targetUserId,
    request_date: body.date,
    request_period: period,
    event_stamp: null,
    status: 'pending',
    version: 1,
    last_request_id: null,
    last_request_op: null,
    last_request_digest: null,
    created_at: nowText,
    responded_at: null,
    updated_at: nowText,
  }, { onConflict: 'id' }).select(ASSIGNMENT_COLUMNS));
  if (inserted.length === 1) {
    return {
      assignment: inserted[0],
      conflict: await conflictForCell(db, {
        space, config, teaching: term, targetUserId, date: body.date, period,
      }),
      replayed: false,
    };
  }
  const existing = await readAssignment(db, space.id, body.id);
  if (existing && existing.target_user_id === targetUserId && existing.created_by === creatorId
    && existing.kind === kind && existing.request_date === body.date
    && existing.request_period === period && existing.status === 'pending') {
    return { assignment: existing, conflict: null, replayed: true };
  }
  throw new AppError('assignment_reuse_conflict', 409);
}

export async function readAssignment(db, spaceId, id) {
  const found = rows(await db.from('event_assignments').select(ASSIGNMENT_COLUMNS)
    .eq('space_id', spaceId).eq('id', id).limit(1));
  return found.length === 1 ? found[0] : null;
}

async function conflictForCell(db, {
  space, config, teaching, targetUserId, date, period,
}) {
  const documents = rows(await db.from('schedule_documents')
    .select(SCHEDULE_DOCUMENT_COLUMNS)
    .eq('space_id', space.id).eq('member_id', targetUserId).limit(1));
  const document = documents.length === 1 ? documents[0] : null;
  if (!isPublishedDocument(document)) return null;
  const weekNumber = teachingWeekNumberSafe(teaching, date);
  if (weekNumber === null) return null;
  const weekly = buildWeeklyMap(document.published_entries, config);
  const value = weeklyValueFromMap(weekly, date, period, weekNumber);
  if (!value) return null;
  const exceptions = rows(await db.from('date_exceptions')
    .select(EXCEPTION_COLUMNS)
    .eq('space_id', space.id).eq('member_id', targetUserId)
    .eq('local_date', date).eq('period', period).limit(1));
  const row = exceptions.length === 1 ? exceptions[0] : null;
  if (row?.cancel_class === true) {
    const signature = await courseSignature(value, config);
    if (row.course_signature === signature) return null;
  }
  return {
    date,
    period,
    courseName: config.mode === 'courses' ? (value.courseName || null) : null,
  };
}

function teachingWeekNumberSafe(teaching, date) {
  if (!teaching) return null;
  const anchor = typeof teaching.firstWeekMonday === 'string' ? teaching.firstWeekMonday : null;
  if (!isValidDate(anchor) || !isValidDate(date) || date < anchor) return null;
  return Math.floor(daysBetween(date, anchor) / 7) + 1;
}

export async function computeAssignmentConflicts(db, {
  space, config, teaching, targetUserId, event, limit = 8,
}) {
  const conflicts = [];
  for (const cell of eventCoverage(event, config)) {
    const conflict = await conflictForCell(db, {
      space, config, teaching, targetUserId, date: cell.date, period: cell.period,
    });
    if (!conflict) continue;
    conflicts.push(conflict);
    if (conflicts.length >= limit) break;
  }
  return conflicts;
}

function eventBrief(event) {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    description: event.description ?? null,
    startDate: event.start_date,
    endDate: event.end_date,
    allDay: event.all_day === true,
    startTime: event.start_time ?? null,
    endTime: event.end_time ?? null,
    visibility: ['private', 'space', 'invitees'].includes(event.visibility)
      ? event.visibility
      : 'private',
  };
}

export function assignmentView(row, event = null, conflict = null) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    eventId: row.event_id ?? null,
    date: row.request_date ?? null,
    period: row.request_period ?? null,
    eventStamp: event ? buildEventStamp(event) : (row.event_stamp ?? null),
    eventChanged: Boolean(event) && row.kind === 'event'
      && row.event_stamp !== buildEventStamp(event),
    requiresReconfirm: row.kind === 'event' && row.status === 'accepted'
      && event && row.event_stamp !== buildEventStamp(event),
    createdAt: row.created_at ?? null,
    respondedAt: row.responded_at ?? null,
    updatedAt: row.updated_at ?? null,
    event: eventBrief(event),
    conflict,
  };
}

export async function pendingAssignmentCount(db, { space, userId }) {
  const found = rows(await db.from('event_assignments').select(ASSIGNMENT_COLUMNS)
    .eq('space_id', space.id).eq('target_user_id', userId));
  const eventIds = [...new Set(found.filter((row) => row.kind === 'event').map((row) => row.event_id))];
  const events = eventIds.length > 0 ? await loadEventRows(db, space.id, eventIds) : [];
  const eventMap = new Map(events.filter((event) => event.deleted !== true).map((event) => [event.id, event]));
  let count = 0;
  for (const row of found) {
    if (row.status === 'pending') {
      if (row.kind !== 'event' || eventMap.has(row.event_id)) count += 1;
    } else if (row.status === 'accepted' && row.kind === 'event') {
      const event = eventMap.get(row.event_id);
      if (event && row.event_stamp !== buildEventStamp(event)) count += 1;
    }
  }
  return count;
}

export async function incomingAssignments(db, {
  space, config, teaching, userId, now = new Date(),
}) {
  const found = rows(await db.from('event_assignments').select(ASSIGNMENT_COLUMNS)
    .eq('space_id', space.id).eq('target_user_id', userId));
  const eventIds = [...new Set(found.filter((row) => row.kind === 'event').map((row) => row.event_id))];
  const events = eventIds.length > 0 ? await loadEventRows(db, space.id, eventIds) : [];
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const today = teaching ? localToday(teaching.timezone, now) : null;
  const output = [];
  for (const row of found) {
    if (row.status === 'rejected' || row.status === 'withdrawn') continue;
    if (row.kind === 'event') {
      const event = eventMap.get(row.event_id);
      if (!event || event.deleted === true) continue;
      const conflicts = row.status === 'pending'
        ? await computeAssignmentConflicts(db, {
          space, config, teaching, targetUserId: userId, event,
        })
        : [];
      output.push(assignmentView(row, event, conflicts.length > 0 ? { type: 'course', items: conflicts } : null));
    } else {
      if (!isValidDate(row.request_date) || !Number.isSafeInteger(row.request_period)) continue;
      const expired = row.status === 'accepted' && today !== null && row.request_date < today;
      output.push({ ...assignmentView(row), expired });
    }
  }
  output.sort((a, b) => {
    const priority = (item) => (item.status === 'pending' || item.requiresReconfirm ? 0 : 1);
    return priority(a) - priority(b)
      || String(a.event?.startDate ?? a.date ?? '').localeCompare(String(b.event?.startDate ?? b.date ?? ''))
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  });
  const pendingCount = output.filter((item) => item.status === 'pending' || item.requiresReconfirm).length;
  return { assignments: output, pendingCount };
}

export async function assignmentSummaryForEvent(db, spaceId, event) {
  const found = rows(await db.from('event_assignments').select(ASSIGNMENT_COLUMNS)
    .eq('space_id', spaceId).eq('event_id', event.id));
  const currentStamp = buildEventStamp(event);
  const summary = {
    total: found.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    withdrawn: 0,
    requiresReconfirm: 0,
  };
  for (const row of found) {
    if (row.status === 'accepted' && row.event_stamp !== currentStamp) {
      summary.requiresReconfirm += 1;
      continue;
    }
    if (summaryKey(row.status)) summary[row.status] += 1;
  }
  return summary;
}

function summaryKey(status) {
  return status === 'pending' || status === 'accepted'
    || status === 'rejected' || status === 'withdrawn'
    ? status
    : null;
}

export async function respondAssignment(db, {
  space, config, teaching, userId, body, now = new Date(),
}) {
  if (!isUuid(body?.id)) throw new AppError('invalid_assignment_id', 400);
  if (!isUuid(body?.requestId)) throw new AppError('invalid_request_id', 400);
  const action = body?.action;
  if (!['accept', 'reject', 'withdraw'].includes(action)) {
    throw new AppError('invalid_assignment_action', 400);
  }
  const expectedVersion = body?.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppError('invalid_version', 400);
  }
  const current = await readAssignment(db, space.id, body.id);
  if (!current) throw new AppError('assignment_not_found', 404);
  if (current.target_user_id !== userId) throw new AppError('forbidden', 403);

  const targetStatus = action === 'accept'
    ? 'accepted'
    : action === 'reject' ? 'rejected' : 'withdrawn';
  const replay = (row) => ({ assignment: assignmentView(row), replayed: true });

  if (current.status === targetStatus && action !== 'accept') return replay(current);
  if (action === 'reject' && current.status !== 'pending') {
    throw new AppError('assignment_not_pending', 409);
  }
  if (action === 'withdraw' && current.status !== 'accepted') {
    throw new AppError('assignment_not_accepted', 409);
  }

  let event = null;
  if (current.kind === 'event') {
    const events = await loadEventRows(db, space.id, [current.event_id]);
    event = events.find((row) => row.id === current.event_id && row.deleted !== true) ?? null;
    if (!event) throw new AppError('event_not_found', 404);
    if (action === 'accept') {
      const stamp = buildEventStamp(event);
      if (body?.eventStamp !== stamp) throw new AppError('event_changed', 409);
      if (current.status === 'accepted' && current.event_stamp === stamp) return replay(current);
    }
  } else if (action === 'accept') {
    if (!teaching) throw new AppError('teaching_required', 409);
    const today = localToday(teaching.timezone, now);
    if (!today || current.request_date < today) throw new AppError('assignment_date_closed', 409);
    if (current.request_date === today) {
      const periodMeta = config.periods.find((item) => item.index === current.request_period);
      const end = timeToMinutes(periodMeta?.end);
      const minutes = localMinuteOfDay(teaching.timezone, now);
      if (end !== null && minutes !== null && end <= minutes) {
        throw new AppError('assignment_date_closed', 409);
      }
    }
  }

  const stamp = event ? buildEventStamp(event) : null;
  const digest = `${action}:${expectedVersion}:${stamp ?? ''}`;
  const nowText = new Date().toISOString();
  const updated = rows(await db.from('event_assignments').update({
    status: targetStatus,
    version: expectedVersion + 1,
    event_stamp: stamp ?? current.event_stamp,
    last_request_id: body.requestId,
    last_request_op: action,
    last_request_digest: digest,
    responded_at: nowText,
    updated_at: nowText,
  }).eq('space_id', space.id).eq('id', current.id)
    .eq('target_user_id', userId).eq('version', expectedVersion)
    .select(ASSIGNMENT_COLUMNS));
  if (updated.length === 1) {
    return { assignment: assignmentView(updated[0], event), replayed: false };
  }
  const latest = await readAssignment(db, space.id, body.id);
  if (latest && latest.last_request_id === body.requestId
    && latest.last_request_op === action && latest.status === targetStatus) {
    return { assignment: assignmentView(latest, event), replayed: true };
  }
  throw new AppError('assignment_conflict', 409);
}

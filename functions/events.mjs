// S3 空间事件：负责人创建，普通成员只读“空间公开”事件。
// 私有事件不得出现在任何成员响应、统计或导出中；版本 CAS 阻止旧请求恢复旧可见性。
import { AppError, rows } from './http.mjs';
import { addDays, daysBetween, isValidDate, monthDates, validateMonth } from './calendar.mjs';
import { isUuid } from './validate.mjs';
import { loadRoster } from './membership.mjs';
import {
  buildEventStamp, createEventAssignments, eventRecipientIds, resolveRecipientIds,
} from './assignments.mjs';

export const EVENT_TITLE_MAX_CHARS = 100;
export const EVENT_DESCRIPTION_MAX_CHARS = 500;
export const EVENT_RANGE_MAX_DAYS = 31;
export const EVENT_VISIBILITIES = ['private', 'space', 'invitees'];
export const EVENT_RECIPIENT_SCOPES = ['none', 'all', 'selected'];
export const EVENT_COLUMNS = [
  'id', 'space_id', 'created_by', 'title', 'description', 'start_date', 'end_date',
  'all_day', 'start_time', 'end_time', 'visibility', 'recipient_scope', 'recipient_ids',
  'deleted', 'version', 'created_at', 'updated_at',
].join(',');

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const controlChars = /[\u0000-\u001f\u007f]/;

function boundedText(value, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new AppError('invalid_event_title', 400);
    return null;
  }
  if (typeof value !== 'string') throw new AppError(required ? 'invalid_event_title' : 'invalid_event_description', 400);
  const text = value.trim();
  if (required && !text) throw new AppError('invalid_event_title', 400);
  if ([...text].length > max || controlChars.test(text)) {
    throw new AppError(required ? 'invalid_event_title' : 'invalid_event_description', 400);
  }
  return text || null;
}

function timeMinutes(value) {
  const matched = TIME_PATTERN.exec(value);
  return matched ? Number(matched[1]) * 60 + Number(matched[2]) : null;
}

export function validateEventInput(raw, {
  defaultVisibility = 'private', defaultRecipientScope = 'none',
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('invalid_input', 400);
  const title = boundedText(raw.title, EVENT_TITLE_MAX_CHARS, { required: true });
  const description = boundedText(raw.description, EVENT_DESCRIPTION_MAX_CHARS);
  if (!isValidDate(raw.startDate)) throw new AppError('invalid_event_date', 400);
  const endDate = raw.endDate === undefined || raw.endDate === null || raw.endDate === ''
    ? raw.startDate
    : raw.endDate;
  if (!isValidDate(endDate)) throw new AppError('invalid_event_date', 400);
  const span = daysBetween(endDate, raw.startDate);
  if (span < 0) throw new AppError('event_end_before_start', 400);
  if (span > EVENT_RANGE_MAX_DAYS - 1) throw new AppError('event_range_too_long', 400);

  const allDay = raw.allDay === undefined ? true : raw.allDay;
  if (typeof allDay !== 'boolean') throw new AppError('invalid_event_time', 400);
  let startTime = null;
  let endTime = null;
  if (!allDay) {
    if (typeof raw.startTime !== 'string' || typeof raw.endTime !== 'string') {
      throw new AppError('invalid_event_time', 400);
    }
    const start = timeMinutes(raw.startTime);
    const end = timeMinutes(raw.endTime);
    if (start === null || end === null || end <= start) throw new AppError('invalid_event_time', 400);
    startTime = raw.startTime;
    endTime = raw.endTime;
  }

  const visibility = raw.visibility ?? defaultVisibility;
  if (!EVENT_VISIBILITIES.includes(visibility)) throw new AppError('invalid_event_visibility', 400);
  const recipientScope = raw.recipientScope ?? defaultRecipientScope;
  if (!EVENT_RECIPIENT_SCOPES.includes(recipientScope)) {
    throw new AppError('invalid_event_recipients', 400);
  }
  if (visibility === 'private' && recipientScope !== 'none') {
    throw new AppError('event_private_cannot_notify', 409);
  }
  if (visibility === 'invitees' && recipientScope === 'none') {
    throw new AppError('event_invitees_requires_recipients', 400);
  }
  return {
    title,
    description,
    startDate: raw.startDate,
    endDate,
    allDay,
    startTime,
    endTime,
    visibility,
    recipientScope,
    recipients: Array.isArray(raw.recipients) ? raw.recipients : [],
  };
}

function overlaps(row, startDate, endDate) {
  if (typeof row.start_date !== 'string' || typeof row.end_date !== 'string') return false;
  return row.start_date <= endDate && row.end_date >= startDate;
}

export function eventView(row, viewerId, {
  assignment = null, assignmentSummary = null,
} = {}) {
  const recipientIds = eventRecipientIds(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: row.all_day === true,
    startTime: row.start_time ?? null,
    endTime: row.end_time ?? null,
    visibility: EVENT_VISIBILITIES.includes(row.visibility) ? row.visibility : 'private',
    recipientScope: EVENT_RECIPIENT_SCOPES.includes(row.recipient_scope)
      ? row.recipient_scope
      : 'none',
    recipientCount: recipientIds.length,
    version: Number.isSafeInteger(row.version) ? row.version : 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    createdByViewer: row.created_by === viewerId,
    editable: row.created_by === viewerId,
    assignment: assignment ? {
      id: assignment.id,
      kind: assignment.kind,
      status: assignment.status,
      version: assignment.version,
      requiresReconfirm: assignment.kind === 'event' && assignment.status === 'accepted'
        && assignment.event_stamp !== buildEventStamp(row),
      eventStamp: buildEventStamp(row),
      date: assignment.request_date ?? null,
      period: assignment.request_period ?? null,
    } : null,
    assignmentSummary: row.created_by === viewerId ? assignmentSummary : null,
  };
}

// 只返回当前查看者可见的事件；调用方仍需在路由层确认空间成员身份。
export async function loadVisibleEvents(db, { spaceId, viewerId, startDate, endDate }) {
  const found = rows(await db.from('space_events').select(EVENT_COLUMNS).eq('space_id', spaceId));
  const assignmentRows = rows(await db.from('event_assignments')
    .select('id,space_id,event_id,kind,created_by,target_user_id,request_date,request_period,event_stamp,status,version,created_at,responded_at,updated_at')
    .eq('space_id', spaceId));
  const viewerAssignments = new Map(
    assignmentRows
      .filter((row) => row.target_user_id === viewerId && row.event_id)
      .map((row) => [row.event_id, row]),
  );
  const byEvent = new Map();
  for (const row of assignmentRows) {
    if (!row.event_id) continue;
    const list = byEvent.get(row.event_id) ?? [];
    list.push(row);
    byEvent.set(row.event_id, list);
  }

  return found
    .filter((row) => row.deleted !== true)
    .filter((row) => {
      if (row.created_by === viewerId) return true;
      if (row.visibility === 'space') return true;
      if (row.visibility === 'invitees') {
        const assignment = viewerAssignments.get(row.id);
        return Boolean(assignment) && ['pending', 'accepted'].includes(assignment.status);
      }
      return false;
    })
    .filter((row) => overlaps(row, startDate, endDate))
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))
      || String(a.start_time ?? '').localeCompare(String(b.start_time ?? ''))
      || String(a.title).localeCompare(String(b.title)))
    .map((row) => {
      const summaryRows = byEvent.get(row.id) ?? [];
      const currentStamp = buildEventStamp(row);
      const assignmentSummary = row.created_by === viewerId ? {
        total: summaryRows.length,
        pending: summaryRows.filter((item) => item.status === 'pending').length,
        accepted: summaryRows.filter((item) => item.status === 'accepted'
          && item.event_stamp === currentStamp).length,
        rejected: summaryRows.filter((item) => item.status === 'rejected').length,
        withdrawn: summaryRows.filter((item) => item.status === 'withdrawn').length,
        requiresReconfirm: summaryRows.filter((item) => item.status === 'accepted'
          && item.event_stamp !== currentStamp).length,
      } : null;
      return eventView(row, viewerId, {
        assignment: viewerAssignments.get(row.id) ?? null,
        assignmentSummary,
      });
    });
}

export async function loadVisibleEventsForMonth(db, { spaceId, viewerId, month }) {
  const normalized = validateMonth(month);
  const dates = monthDates(normalized);
  return loadVisibleEvents(db, {
    spaceId, viewerId, startDate: dates[0], endDate: dates[dates.length - 1],
  });
}

export function groupEventsByDate(events, dates) {
  const grouped = new Map(dates.map((date) => [date, []]));
  for (const event of events) {
    for (const date of dates) {
      if (event.startDate <= date && event.endDate >= date) grouped.get(date).push(event);
    }
  }
  return grouped;
}

async function readEventRow(db, spaceId, eventId) {
  const found = rows(await db.from('space_events').select(EVENT_COLUMNS)
    .eq('space_id', spaceId).eq('id', eventId).limit(1));
  return found.length === 1 ? found[0] : null;
}

function sameContent(row, value) {
  return row.title === value.title
    && (row.description ?? null) === value.description
    && row.start_date === value.startDate
    && row.end_date === value.endDate
    && row.all_day === value.allDay
    && (row.start_time ?? null) === value.startTime
    && (row.end_time ?? null) === value.endTime
    && row.visibility === value.visibility
    && (row.recipient_scope ?? 'none') === value.recipientScope;
}

// 客户端提供的 UUID 即事件 ID：同一 ID 的相同内容重放返回原事件，不同内容拒绝复用。
export async function createEvent(db, { space, userId, body }) {
  if (!isUuid(body?.id)) throw new AppError('invalid_event_id', 400);
  const value = validateEventInput(body);
  const roster = value.recipientScope === 'none' ? null : await loadRoster(db, space);
  const recipientIds = value.recipientScope === 'none'
    ? []
    : resolveRecipientIds(roster, userId, value.recipientScope, value.recipients);
  if (value.visibility === 'invitees' && recipientIds.length === 0) {
    throw new AppError('event_invitees_requires_recipients', 400);
  }
  const now = new Date().toISOString();
  const inserted = rows(await db.from('space_events').insertIfAbsent({
    id: body.id,
    space_id: space.id,
    created_by: userId,
    title: value.title,
    description: value.description,
    start_date: value.startDate,
    end_date: value.endDate,
    all_day: value.allDay,
    start_time: value.startTime,
    end_time: value.endTime,
    visibility: value.visibility,
    recipient_scope: value.recipientScope,
    recipient_ids: JSON.stringify(recipientIds),
    deleted: false,
    version: 1,
    created_at: now,
    updated_at: now,
  }, { onConflict: 'id' }).select(EVENT_COLUMNS));
  if (inserted.length === 1) {
    const createdAssignments = await createEventAssignments(db, {
      event: inserted[0], creatorId: userId, recipientIds,
    });
    const assignmentSummary = {
      total: createdAssignments.length,
      pending: createdAssignments.length,
      accepted: 0,
      rejected: 0,
      withdrawn: 0,
      requiresReconfirm: 0,
    };
    return {
      event: eventView(inserted[0], userId, { assignmentSummary }),
      replayed: false,
    };
  }
  const existing = await readEventRow(db, space.id, body.id);
  if (existing && existing.created_by === userId && existing.deleted !== true
    && sameContent(existing, value)
    && JSON.stringify(eventRecipientIds(existing)) === JSON.stringify([...recipientIds].sort())) {
    const stored = eventRecipientIds(existing);
    await createEventAssignments(db, { event: existing, creatorId: userId, recipientIds: stored });
    return { event: eventView(existing, userId), replayed: true };
  }
  throw new AppError('event_reuse_conflict', 409);
}

export async function updateEvent(db, { spaceId, userId, body }) {
  if (!isUuid(body?.id)) throw new AppError('invalid_event_id', 400);
  const version = body?.version;
  if (!Number.isSafeInteger(version) || version < 1) throw new AppError('invalid_version', 400);
  const current = await readEventRow(db, spaceId, body.id);
  if (!current || current.deleted === true) throw new AppError('event_not_found', 404);
  if (current.created_by !== userId) throw new AppError('forbidden', 403);
  if (current.version !== version) throw new AppError('event_conflict', 409);
  if (body?.recipientScope !== undefined
    && body.recipientScope !== (current.recipient_scope ?? 'none')) {
    throw new AppError('event_recipients_locked', 409);
  }
  if (Array.isArray(body?.recipients) && body.recipients.length > 0) {
    throw new AppError('event_recipients_locked', 409);
  }
  const value = validateEventInput(body, {
    defaultVisibility: current.visibility,
    defaultRecipientScope: current.recipient_scope ?? 'none',
  });
  if (eventRecipientIds(current).length > 0 && value.visibility === 'private') {
    throw new AppError('event_private_cannot_notify', 409);
  }
  if (value.visibility === 'invitees' && eventRecipientIds(current).length === 0) {
    throw new AppError('event_invitees_requires_recipients', 400);
  }
  const updated = rows(await db.from('space_events').update({
    title: value.title,
    description: value.description,
    start_date: value.startDate,
    end_date: value.endDate,
    all_day: value.allDay,
    start_time: value.startTime,
    end_time: value.endTime,
    visibility: value.visibility,
    version: version + 1,
    updated_at: new Date().toISOString(),
  }).eq('space_id', spaceId).eq('id', body.id).eq('created_by', userId)
    .eq('version', version).select(EVENT_COLUMNS));
  if (updated.length === 1) return { event: eventView(updated[0], userId), replayed: false };
  const latest = await readEventRow(db, spaceId, body.id);
  if (latest && latest.deleted !== true && sameContent(latest, value) && latest.version === version + 1) {
    return { event: eventView(latest, userId), replayed: true };
  }
  throw new AppError('event_conflict', 409);
}

export async function deleteEvent(db, { spaceId, userId, body }) {
  if (!isUuid(body?.id)) throw new AppError('invalid_event_id', 400);
  const version = body?.version;
  if (!Number.isSafeInteger(version) || version < 1) throw new AppError('invalid_version', 400);
  const current = await readEventRow(db, spaceId, body.id);
  if (!current || current.deleted === true) throw new AppError('event_not_found', 404);
  if (current.created_by !== userId) throw new AppError('forbidden', 403);
  if (current.version !== version) throw new AppError('event_conflict', 409);
  const updated = rows(await db.from('space_events').update({
    deleted: true,
    version: version + 1,
    updated_at: new Date().toISOString(),
  }).eq('space_id', spaceId).eq('id', body.id).eq('created_by', userId)
    .eq('version', version).select(EVENT_COLUMNS));
  if (updated.length === 1) return { ok: true, id: body.id, version: version + 1, replayed: false };
  const latest = await readEventRow(db, spaceId, body.id);
  if (latest && latest.deleted === true && latest.version === version + 1) {
    return { ok: true, id: body.id, version: latest.version, replayed: true };
  }
  throw new AppError('event_conflict', 409);
}

export function eventWeekDates(teaching, weekNumber) {
  const start = addDays(teaching.firstWeekMonday, (weekNumber - 1) * 7);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

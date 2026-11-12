// S3 统一收集解析：普通成员始终计入，负责人只有显式加入后才计入。
// 名单、人数、收集日历和导出共用这里的 subjects，避免各接口各算一套。
import { AppError, rows } from './http.mjs';
import { SHARE_NOTICE_VERSION } from './notices.mjs';
import { loadRoster } from './membership.mjs';
import { isPublishedDocument } from './week-schedule.mjs';
import {
  PERSONAL_STATES, buildWeeklyMap, courseSignature, localToday, monthDates,
  publicTeaching, teachingWeekNumber, validateMonth, weekdayMon1, weeklyValueFromMap,
} from './calendar.mjs';

export const PARTICIPATION_STATUSES = ['unset', 'joined', 'declined'];
export const SHARE_STATUSES = ['accepted', 'declined', 'revoked'];
export const COLLECTION_EXCEPTION_LIMIT = 60000;

function normalizeParticipationStatus(value) {
  return PARTICIPATION_STATUSES.includes(value) ? value : 'unset';
}

export async function readParticipation(db, spaceId, userId) {
  const found = rows(await db.from('collection_participants')
    .select('user_id,status,joined_at,left_at,updated_at')
    .eq('space_id', spaceId).eq('user_id', userId).limit(1));
  return found.length === 1 ? found[0] : null;
}

export function participationView(row) {
  return {
    status: normalizeParticipationStatus(row?.status),
    joinedAt: row?.joined_at ?? null,
    leftAt: row?.left_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function writeParticipationRow(db, spaceId, userId, status) {
  const now = new Date().toISOString();
  const existing = await readParticipation(db, spaceId, userId);
  if (!existing) {
    const created = rows(await db.from('collection_participants').insertIfAbsent({
      space_id: spaceId,
      user_id: userId,
      status,
      joined_at: status === 'joined' ? now : null,
      left_at: status === 'declined' ? now : null,
      updated_at: now,
    }, { onConflict: 'space_id,user_id' }).select('user_id,status,joined_at,left_at,updated_at'));
    if (created.length === 1) return created[0];
  }
  const current = existing ?? await readParticipation(db, spaceId, userId);
  if (current?.status === status) return current;
  const updated = rows(await db.from('collection_participants').update({
    status,
    joined_at: status === 'joined'
      ? (typeof current?.joined_at === 'string' ? current.joined_at : now)
      : (current?.joined_at ?? null),
    left_at: status === 'declined' ? now : null,
    updated_at: now,
  }).eq('space_id', spaceId).eq('user_id', userId)
    .select('user_id,status,joined_at,left_at,updated_at'));
  if (updated.length !== 1) throw new AppError('participation_unconfirmed', 503);
  return updated[0];
}

// 负责人显式加入：只影响收集名单，不改变 spaces.owner_id 或任何成员权限。
export async function joinParticipation(db, spaceId, userId) {
  const existing = await readParticipation(db, spaceId, userId);
  if (existing?.status === 'joined') return existing;
  return writeParticipationRow(db, spaceId, userId, 'joined');
}

export async function declineParticipation(db, spaceId, userId) {
  const existing = await readParticipation(db, spaceId, userId);
  if (existing?.status === 'declined') return existing;
  return writeParticipationRow(db, spaceId, userId, 'declined');
}

export async function readShareConsent(db, spaceId, memberId) {
  const found = rows(await db.from('calendar_share_consents')
    .select('member_id,status,notice_version,accepted_at,declined_at,revoked_at,updated_at')
    .eq('space_id', spaceId).eq('member_id', memberId).limit(1));
  return found.length === 1 ? found[0] : null;
}

export async function loadShareConsents(db, spaceId) {
  const found = rows(await db.from('calendar_share_consents')
    .select('member_id,status,notice_version,accepted_at,declined_at,revoked_at,updated_at')
    .eq('space_id', spaceId));
  return new Map(found.map((row) => [row.member_id, row]));
}

export function shareAccepted(row) {
  return row?.status === 'accepted' && row.notice_version === SHARE_NOTICE_VERSION;
}

export function shareView(row) {
  return {
    status: SHARE_STATUSES.includes(row?.status) ? row.status : 'unset',
    accepted: shareAccepted(row),
    version: row?.notice_version ?? null,
    acceptedAt: shareAccepted(row) ? (row?.accepted_at ?? null) : null,
    declinedAt: row?.declined_at ?? null,
    revokedAt: row?.revoked_at ?? null,
    updatedAt: row?.updated_at ?? null,
    pending: !shareConsentSettled(row),
  };
}

export function shareConsentSettled(row) {
  return Boolean(row) && row.notice_version === SHARE_NOTICE_VERSION
    && SHARE_STATUSES.includes(row.status);
}

// 共享确认与个人例外告知相互独立：确认共享不会写入任何日期例外，撤回也不删除例外。
export async function ensureShareConsent(db, spaceId, memberId) {
  const now = new Date().toISOString();
  const existing = await readShareConsent(db, spaceId, memberId);
  if (shareAccepted(existing)) return existing;
  if (!existing) {
    const created = rows(await db.from('calendar_share_consents').insertIfAbsent({
      space_id: spaceId,
      member_id: memberId,
      status: 'accepted',
      notice_version: SHARE_NOTICE_VERSION,
      accepted_at: now,
      revoked_at: null,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' })
      .select('member_id,status,notice_version,accepted_at,revoked_at,updated_at'));
    if (created.length === 1) return created[0];
  } else {
    const updated = rows(await db.from('calendar_share_consents').update({
      status: 'accepted',
      notice_version: SHARE_NOTICE_VERSION,
      accepted_at: now,
      revoked_at: null,
      updated_at: now,
    }).eq('space_id', spaceId).eq('member_id', memberId)
      .select('member_id,status,notice_version,accepted_at,revoked_at,updated_at'));
    if (updated.length === 1) return updated[0];
  }
  const latest = await readShareConsent(db, spaceId, memberId);
  if (shareAccepted(latest)) return latest;
  throw new AppError('share_unconfirmed', 503);
}

export async function revokeShareConsent(db, spaceId, memberId) {
  const now = new Date().toISOString();
  const existing = await readShareConsent(db, spaceId, memberId);
  if (!existing) {
    const created = rows(await db.from('calendar_share_consents').insertIfAbsent({
      space_id: spaceId,
      member_id: memberId,
      status: 'revoked',
      notice_version: SHARE_NOTICE_VERSION,
      accepted_at: null,
      revoked_at: now,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' })
      .select('member_id,status,notice_version,accepted_at,revoked_at,updated_at'));
    if (created.length === 1) return created[0];
  } else {
    const updated = rows(await db.from('calendar_share_consents').update({
      status: 'revoked',
      revoked_at: now,
      updated_at: now,
    }).eq('space_id', spaceId).eq('member_id', memberId)
      .select('member_id,status,notice_version,accepted_at,revoked_at,updated_at'));
    if (updated.length === 1) return updated[0];
  }
  const latest = await readShareConsent(db, spaceId, memberId);
  if (latest?.status === 'revoked') return latest;
  throw new AppError('share_revoke_unconfirmed', 503);
}

// 拒绝可选共享与撤回同样留在服务端：版本不变时不再重复询问，也不影响课表收集。
export async function declineShareConsent(db, spaceId, memberId) {
  const now = new Date().toISOString();
  const existing = await readShareConsent(db, spaceId, memberId);
  if (!existing) {
    const created = rows(await db.from('calendar_share_consents').insertIfAbsent({
      space_id: spaceId,
      member_id: memberId,
      status: 'declined',
      notice_version: SHARE_NOTICE_VERSION,
      accepted_at: null,
      declined_at: now,
      revoked_at: null,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' })
      .select('member_id,status,notice_version,accepted_at,declined_at,revoked_at,updated_at'));
    if (created.length === 1) return created[0];
  } else {
    const updated = rows(await db.from('calendar_share_consents').update({
      status: 'declined',
      notice_version: SHARE_NOTICE_VERSION,
      declined_at: now,
      updated_at: now,
    }).eq('space_id', spaceId).eq('member_id', memberId)
      .select('member_id,status,notice_version,accepted_at,declined_at,revoked_at,updated_at'));
    if (updated.length === 1) return updated[0];
  }
  const latest = await readShareConsent(db, spaceId, memberId);
  if (latest?.status === 'declined' && latest.notice_version === SHARE_NOTICE_VERSION) return latest;
  throw new AppError('share_decline_unconfirmed', 503);
}

// 唯一收集名单：普通成员全部计入；负责人仅在 status=joined 时计入。
export async function loadCollectionSubjects(db, space) {
  const roster = await loadRoster(db, space);
  const participantRows = rows(await db.from('collection_participants')
    .select('user_id,status,joined_at,left_at,updated_at').eq('space_id', space.id));
  const ownerRow = participantRows.find((row) => row.user_id === space.owner_id) ?? null;
  const ownerParticipation = participationView(ownerRow);

  const subjects = roster.members.map((member) => ({ ...member }));
  if (ownerParticipation.status === 'joined') {
    subjects.push({
      ...roster.owner,
      joinedAt: ownerParticipation.joinedAt ?? roster.owner.joinedAt,
      source: 'owner',
    });
  }
  subjects.sort((a, b) => String(a.inSpaceName ?? '').localeCompare(String(b.inSpaceName ?? '')));

  const documents = rows(await db.from('schedule_documents')
    .select('member_id,revision,published_entries,published_version,published_at')
    .eq('space_id', space.id));
  const documentMap = new Map(documents.map((row) => [row.member_id, row]));
  const withSubmission = subjects.map((subject) => {
    const document = documentMap.get(subject.userId) ?? null;
    return {
      userId: subject.userId,
      role: subject.role,
      inSpaceName: subject.inSpaceName,
      joinedAt: subject.joinedAt,
      source: subject.source,
      document,
      submitted: isPublishedDocument(document),
    };
  });
  const submitted = withSubmission.filter((subject) => subject.submitted).length;
  return {
    roster,
    ownerParticipation,
    subjects: withSubmission,
    documents: documentMap,
    total: withSubmission.length,
    submitted,
    unsubmitted: withSubmission.length - submitted,
  };
}

function emptyCellCounts() {
  return {
    classOccupied: 0, busy: 0, available: 0, noClass: 0,
    unknown: 0, conflict: 0, termOut: 0,
  };
}

function emptyLists() {
  return { class: [], busy: [], available: [], noClass: [], unknown: [], conflict: [], noShare: [] };
}

function emptyBuckets() {
  return { class: [], busy: [], free: [], pending: [] };
}

async function subjectSignature(subject, value, config) {
  if (!value) return null;
  const key = `${value.rule}:${value.courseName ?? ''}`;
  if (subject.signatures.has(key)) return subject.signatures.get(key);
  const signature = await courseSignature(value, config);
  subject.signatures.set(key, signature);
  return signature;
}

function classEntry(subject, value, config) {
  return {
    name: subject.inSpaceName ?? '成员',
    courseName: config.mode === 'courses' ? (value?.courseName ?? null) : null,
  };
}

// 收集日历投影：未确认共享的成员仍暴露已发布周课表的课程占用与没课；
// 只隐藏日期级例外（停课/忙/空），不把没课降级为待确认。
export async function projectCollectionMonth({
  teaching, config, month, collection, shareConsents, exceptions, viewerId, now,
  includeMembers = false, occupancy = null,
}) {
  const normalized = validateMonth(month);
  const dates = monthDates(normalized);
  const publicTerm = publicTeaching(teaching);
  if (!publicTerm) throw new AppError('teaching_required', 409);
  const todayText = localToday(publicTerm.timezone, now);

  const allExceptions = Array.isArray(exceptions) ? exceptions : [];
  if (allExceptions.length > COLLECTION_EXCEPTION_LIMIT) {
    throw new AppError('collection_too_large', 413);
  }
  const prepared = collection.subjects.map((subject) => {
    const share = shareConsents.get(subject.userId) ?? null;
    const shared = subject.userId === viewerId || shareAccepted(share);
    const overlays = new Map();
    for (const row of allExceptions) {
      if (row.member_id !== subject.userId) continue;
      if (typeof row.local_date !== 'string' || !row.local_date.startsWith(`${normalized}-`)) continue;
      if (!Number.isSafeInteger(row.period)) continue;
      overlays.set(`${row.local_date}:${row.period}`, row);
    }
    return {
      ...subject,
      share,
      shareView: shareView(share),
      shared,
      weekly: subject.submitted ? buildWeeklyMap(subject.document.published_entries, config) : null,
      overlays,
      signatures: new Map(),
    };
  });

  const days = [];
  for (const date of dates) {
    const weekday = weekdayMon1(date);
    const inTerm = date >= publicTerm.termStart && date <= publicTerm.termEnd;
    const weekNumber = teachingWeekNumber(publicTerm, date);
    if (!inTerm) {
      days.push({
        date, weekday, weekNumber, inTerm: false, isToday: date === todayText, periods: [],
      });
      continue;
    }

    const periods = [];
    for (const periodMeta of config.periods) {
      const period = periodMeta.index;
      const counts = emptyCellCounts();
      const lists = emptyLists();
      const buckets = emptyBuckets();
      const members = [];
      for (const subject of prepared) {
        const subjectName = subject.inSpaceName ?? '成员';
        if (!subject.submitted) {
          counts.unknown += 1;
          lists.unknown.push(subjectName);
          members.push({ userId: subject.userId, name: subjectName, status: 'unknown' });
          buckets.pending.push({ userId: subject.userId, name: subjectName, reason: 'unsubmitted' });
          continue;
        }
        const value = weekNumber === null ? null : weeklyValueFromMap(
          subject.weekly, date, period, weekNumber,
        );
        if (!subject.shared) {
          if (value) {
            counts.classOccupied += 1;
            lists.class.push(classEntry(subject, value, config));
            members.push({
              userId: subject.userId, name: subjectName, status: 'class_occupied',
              courseName: value.courseName ?? null,
            });
            buckets.class.push({
              userId: subject.userId,
              name: subjectName,
              courseName: config.mode === 'courses' ? (value.courseName ?? null) : null,
            });
          } else {
            counts.noClass += 1;
            lists.noClass.push(subjectName);
            lists.noShare.push(subjectName);
            members.push({ userId: subject.userId, name: subjectName, status: 'no_class' });
            buckets.free.push({ userId: subject.userId, name: subjectName, declared: false });
          }
          continue;
        }

        const row = subject.overlays.get(`${date}:${period}`);
        const overlayActive = Boolean(row) && (row.cancel_class === true
          || PERSONAL_STATES.includes(row.personal_state) && row.personal_state !== 'none');
        const personalState = overlayActive && PERSONAL_STATES.includes(row.personal_state)
          ? row.personal_state
          : 'none';
        let status = 'no_class';

        if (value && overlayActive && row.cancel_class === true) {
          const signature = await subjectSignature(subject, value, config);
          if (row.course_signature === signature) {
            if (personalState === 'busy') status = 'busy';
            else if (personalState === 'available') status = 'available';
            else status = 'no_class';
          } else {
            status = 'conflict';
          }
        } else if (value && overlayActive && row.cancel_class !== true) {
          status = 'conflict';
        } else if (!value && overlayActive && row.cancel_class === true) {
          status = 'conflict';
        } else if (value) {
          status = 'class_occupied';
        } else if (personalState === 'busy') {
          status = 'busy';
        } else if (personalState === 'available') {
          status = 'available';
        }

        // 已接受的事件/负责人安排叠加：课程与冲突优先，其余覆盖为忙碌；
        // 未共享与未提交成员不读取这些来源，避免泄露未授权范围外的信息。
        const cellOccupancy = occupancy instanceof Map
          ? occupancy.get(subject.userId)?.get(`${date}:${period}`) ?? null
          : null;
        const externalBusy = Array.isArray(cellOccupancy?.busy) ? cellOccupancy.busy : [];
        const externalAvailable = Array.isArray(cellOccupancy?.available)
          ? cellOccupancy.available
          : [];
        let busySources = null;
        if (externalBusy.length > 0) {
          busySources = externalBusy.slice();
          if (status !== 'class_occupied' && status !== 'conflict') {
            if (status === 'busy') busySources.unshift({ type: 'personal', label: '个人声明' });
            status = 'busy';
          }
        } else if (externalAvailable.length > 0
          && (status === 'no_class' || status === 'available')) {
          status = 'available';
        }

        const name = subjectName;
        if (status === 'class_occupied') {
          counts.classOccupied += 1;
          lists.class.push(classEntry(subject, value, config));
        } else if (status === 'busy') {
          counts.busy += 1;
          lists.busy.push(name);
        } else if (status === 'available') {
          counts.available += 1;
          lists.available.push(name);
        } else if (status === 'conflict') {
          counts.conflict += 1;
          lists.conflict.push(name);
        } else {
          counts.noClass += 1;
          lists.noClass.push(name);
        }
        members.push({
          userId: subject.userId,
          name,
          status,
          courseName: value?.courseName ?? null,
          declared: status === 'available',
          ...(busySources ? { sources: busySources } : {}),
        });
        if (status === 'class_occupied') {
          buckets.class.push({
            userId: subject.userId,
            name,
            courseName: config.mode === 'courses' ? (value?.courseName ?? null) : null,
            ...(busySources ? { sources: busySources } : {}),
          });
        } else if (status === 'busy') {
          buckets.busy.push({
            userId: subject.userId,
            name,
            sources: busySources ?? [{ type: 'personal', label: '个人声明' }],
          });
        } else if (status === 'available' || status === 'no_class') {
          buckets.free.push({ userId: subject.userId, name, declared: status === 'available' });
        } else if (status === 'conflict') {
          buckets.pending.push({
            userId: subject.userId, name, reason: 'conflict',
            ...(busySources ? { sources: busySources } : {}),
          });
        }
      }
      periods.push({
        period,
        time: { start: periodMeta.start, end: periodMeta.end },
        counts,
        lists,
        groups: {
          class: { count: buckets.class.length, members: buckets.class },
          busy: { count: buckets.busy.length, members: buckets.busy },
          free: {
            count: buckets.free.length,
            declaredCount: buckets.free.filter((member) => member.declared).length,
            members: buckets.free,
          },
          pending: { count: buckets.pending.length, members: buckets.pending },
        },
        ...(includeMembers ? { members } : {}),
      });
    }
    days.push({
      date, weekday, weekNumber, inTerm: true, isToday: date === todayText, periods,
    });
  }

  return {
    state: 'ready',
    month: normalized,
    today: todayText,
    teaching: publicTerm,
    days,
  };
}

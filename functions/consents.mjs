// 日历告知与日期共享的统一读写。确认、拒绝、撤回都落服务端并保留版本与时间；
// 未变更版本不再重复提示，未知授权绝不被解释为“有空”。
import { AppError, rows } from './http.mjs';
import {
  CALENDAR_NOTICE_LEGACY_VERSIONS, CALENDAR_NOTICE_TEXT, CALENDAR_NOTICE_VERSION,
  SHARE_NOTICE_TEXT, SHARE_NOTICE_VERSION,
} from './notices.mjs';

export const CALENDAR_CONSENT_STATUSES = ['accepted', 'declined'];
export const SHARE_CONSENT_STATUSES = ['accepted', 'declined', 'revoked'];

// 只把当前版本视为已确认；旧版本记录保留可审计，但会在下一次登录时重新征求决定。
export function calendarVersionAccepted(version) {
  return version === CALENDAR_NOTICE_VERSION;
}

export function calendarConsentSettled(row) {
  // 旧表只有“已确认”行，status 为空时按 accepted 解释；不会把未知授权当作已确认。
  const status = row?.status ?? 'accepted';
  return Boolean(row) && row.notice_version === CALENDAR_NOTICE_VERSION
    && CALENDAR_CONSENT_STATUSES.includes(status);
}

export function shareConsentSettled(row) {
  return Boolean(row) && row.notice_version === SHARE_NOTICE_VERSION
    && SHARE_CONSENT_STATUSES.includes(row.status);
}

export async function readCalendarConsent(db, spaceId, memberId) {
  const found = rows(await db.from('calendar_consents')
    .select('member_id,notice_version,status,accepted_at,declined_at,updated_at')
    .eq('space_id', spaceId).eq('member_id', memberId).limit(1));
  return found.length === 1 ? found[0] : null;
}

export function calendarConsentView(row) {
  const status = row?.status === 'declined' ? 'declined' : (row ? 'accepted' : 'unset');
  return {
    version: CALENDAR_NOTICE_VERSION,
    accepted: status === 'accepted' && calendarVersionAccepted(row?.notice_version),
    status,
    acceptedVersion: row?.notice_version ?? null,
    acceptedAt: status === 'accepted' ? (row?.accepted_at ?? null) : null,
    declinedAt: row?.declined_at ?? null,
    updatedAt: row?.updated_at ?? null,
    pending: !calendarConsentSettled(row),
  };
}

export async function ensureCalendarConsent(db, spaceId, memberId) {
  const now = new Date().toISOString();
  const existing = await readCalendarConsent(db, spaceId, memberId);
  if (existing?.status !== 'declined' && calendarVersionAccepted(existing?.notice_version)) return existing;
  if (!existing) {
    const created = rows(await db.from('calendar_consents').insertIfAbsent({
      space_id: spaceId,
      member_id: memberId,
      notice_version: CALENDAR_NOTICE_VERSION,
      status: 'accepted',
      accepted_at: now,
      declined_at: null,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' }).select('member_id,notice_version,status'));
    if (created.length === 1) return created[0];
  } else {
    const updated = rows(await db.from('calendar_consents').update({
      notice_version: CALENDAR_NOTICE_VERSION,
      status: 'accepted',
      accepted_at: now,
      declined_at: null,
      updated_at: now,
    }).eq('space_id', spaceId).eq('member_id', memberId)
      .select('member_id,notice_version,status'));
    if (updated.length === 1) return updated[0];
  }
  const latest = await readCalendarConsent(db, spaceId, memberId);
  if (latest?.status !== 'declined' && calendarVersionAccepted(latest?.notice_version)) return latest;
  throw new AppError('consent_unconfirmed', 503);
}

export async function declineCalendarConsent(db, spaceId, memberId) {
  const now = new Date().toISOString();
  const existing = await readCalendarConsent(db, spaceId, memberId);
  if (!existing) {
    const created = rows(await db.from('calendar_consents').insertIfAbsent({
      space_id: spaceId,
      member_id: memberId,
      notice_version: CALENDAR_NOTICE_VERSION,
      status: 'declined',
      // 旧表 accepted_at 为 NOT NULL 且迁移不能删除约束；这里只作非空占位，接口不暴露为确认时间。
      accepted_at: now,
      declined_at: now,
      updated_at: now,
    }, { onConflict: 'space_id,member_id' }).select('member_id,notice_version,status,declined_at'));
    if (created.length === 1) return created[0];
  } else {
    const updated = rows(await db.from('calendar_consents').update({
      notice_version: CALENDAR_NOTICE_VERSION,
      status: 'declined',
      declined_at: now,
      updated_at: now,
    }).eq('space_id', spaceId).eq('member_id', memberId)
      .select('member_id,notice_version,status,declined_at'));
    if (updated.length === 1) return updated[0];
  }
  const latest = await readCalendarConsent(db, spaceId, memberId);
  if (latest?.status === 'declined' && latest.notice_version === CALENDAR_NOTICE_VERSION) return latest;
  throw new AppError('consent_decline_unconfirmed', 503);
}

export function calendarNotice() {
  return { version: CALENDAR_NOTICE_VERSION, text: CALENDAR_NOTICE_TEXT, legacyVersions: CALENDAR_NOTICE_LEGACY_VERSIONS };
}

export function shareNotice() {
  return { version: SHARE_NOTICE_VERSION, text: SHARE_NOTICE_TEXT };
}

export const GENERAL_TERMS = [
  '本工具只收集本人课表、具体日期的停课与忙/有空声明，以及空间负责人创建的安排事件；不收集定位、通讯录、短信、邮箱或平台账号密码。',
  '普通成员只能修改本人课表与本人日期状态；负责人可以查看本空间完整姓名、课程名和（经你确认共享后的）日期状态，但不能代替成员修改课表或声明忙/有空。',
  '“无课”只是课表含义，不等于确认参加活动；“有空”只有本人主动声明或接受安排后才成立；未知授权不会被当作可用。',
  '草稿不计入收集；整表提交后才对负责人可见；首次有效提交会锁定收集模式与作息。',
  '日期共享与日历告知相互独立；你可以拒绝或随时撤回可选共享，课表收集、账号与空间权限不受影响。撤回后后续读取与新导出立即按未共享处理，但已经下载或截图的文件无法收回。',
  '本版本不提供密码找回、短信/邮箱通知或公开报名；站内待办只在登录后显示。',
];

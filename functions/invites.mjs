// 邀请码与容量槽位。邀请码只保存 SHA-256 摘要；容量由每个邀请代次预建的槽位数决定，
// 认领是对单个未认领槽位的条件更新，因此“占用一个名额 + 写入成员信息”是一次行写入。
import { AppError, rows } from './http.mjs';
import { sha256Hex } from './sessions.mjs';
import { validateFullName } from './validate.mjs';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_USES = 50;
export const INVITE_CODE_BYTES = 16;
export const INVITE_CODE_PATTERN = /^[0-9a-f]{32}$/;
export const MAX_SLOT_ATTEMPTS = 8;

export function generateInviteCode() {
  const bytes = new Uint8Array(INVITE_CODE_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 允许粘贴带空格或分组连字符的码；规范化为小写 32 位十六进制。
export function normalizeInviteCode(raw) {
  if (typeof raw !== 'string') throw new AppError('invalid_input', 400);
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '');
  if (!INVITE_CODE_PATTERN.test(normalized)) throw new AppError('invalid_input', 400);
  return normalized;
}

export const hashInviteCode = (code) => sha256Hex(code);

export function validateInSpaceName(raw) {
  return validateFullName(raw);
}

export function formatInviteCode(code) {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

// 把某一代次尚未认领的槽位整体移到负代次，作为“该代次已失效”的持久标记。
// 这是一次带条件的集合 UPDATE；认领也是一次带 generation/claimed=false 条件的行 UPDATE，
// 两者在槽位行上由数据库串行化：认领先完成则不会被失效，失效先完成则认领影响 0 行。
export async function invalidateUnclaimedSlots(db, spaceId, generation) {
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new AppError('invite_slots_unconfirmed', 503);
  }
  // 逐轮执行并回读确认：即使底层把无条件更新限制为单行，也会继续处理剩余槽位；
  // 全部未认领槽位都离开旧代次后才返回，否则失败关闭。
  for (let attempt = 0; attempt <= INVITE_MAX_USES; attempt += 1) {
    rows(await db.from('invite_slots').update({ generation: -generation })
      .eq('space_id', spaceId).eq('generation', generation).eq('claimed', false)
      .select('id'));
    const remaining = rows(await db.from('invite_slots').select('id')
      .eq('space_id', spaceId).eq('generation', generation).eq('claimed', false).limit(1));
    if (remaining.length === 0) return;
  }
  throw new AppError('invite_slots_unconfirmed', 503);
}

// 预建槽位可能因网络失败而部分完成；重试使用 insertIfAbsent，不会重复占用同一槽号。
export async function ensureInviteSlots(db, spaceId, generation, maxUses) {
  for (let slotNo = 1; slotNo <= maxUses; slotNo += 1) {
    const inserted = rows(await db.from('invite_slots').insertIfAbsent({
      id: crypto.randomUUID(),
      space_id: spaceId,
      generation,
      slot_no: slotNo,
      claimed: false,
      claimed_by: null,
      in_space_name: null,
      notice_version: null,
      notice_ack_at: null,
      claimed_at: null,
    }, { onConflict: 'space_id,generation,slot_no' }).select('id'));
    if (inserted.length === 1) continue;
    const existing = rows(await db.from('invite_slots').select('id')
      .eq('space_id', spaceId).eq('generation', generation).eq('slot_no', slotNo).limit(1));
    if (existing.length !== 1) throw new AppError('invite_slots_unconfirmed', 503);
  }
}

export async function readInvite(db, spaceId) {
  const found = rows(await db.from('space_invites')
    .select('space_id,generation,max_uses,expires_at,revoked,created_at,updated_at')
    .eq('space_id', spaceId).limit(1));
  return found.length === 1 ? found[0] : null;
}

export async function inviteSummary(db, invite, now = Date.now()) {
  const slots = rows(await db.from('invite_slots').select('claimed')
    .eq('space_id', invite.space_id).eq('generation', invite.generation));
  const used = slots.filter((slot) => slot.claimed === true).length;
  const expiresAt = Date.parse(invite.expires_at);
  return {
    exists: true,
    active: invite.revoked === false && Number.isFinite(expiresAt) && expiresAt > now,
    revoked: invite.revoked === true,
    generation: invite.generation,
    maxUses: invite.max_uses,
    used,
    remaining: Math.max(0, invite.max_uses - used),
    createdAt: invite.created_at,
    updatedAt: invite.updated_at,
    expiresAt: invite.expires_at,
  };
}

export function emptyInviteSummary() {
  return { exists: false, active: false, revoked: false, generation: null, maxUses: 0, used: 0, remaining: 0 };
}

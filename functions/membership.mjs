// 成员模型唯一入口（S2/S3 的新接口也应经此解析，不要各查一套表）：
// - 负责人由 spaces.owner_id 唯一确定，不写 memberships 行；
// - S1 成员由已认领的 invite_slots 行确定，UNIQUE(space_id, claimed_by) 保证每人一行；
// - 旧 memberships 只在 config 为 null 的旧空间生效，S1 空间即使残留旧行也不授予访问；
// - 优先级：负责人 > 已认领槽位 > 旧成员关系；空间列表、名单和旧接口共用 resolveAccess/loadRoster。
import { AppError, rows } from './http.mjs';

export function isS1Space(space) {
  return space?.config !== null && space?.config !== undefined;
}

export function isLegacySpace(space) {
  return !isS1Space(space);
}

async function findClaim(db, spaceId, userId) {
  const found = rows(await db.from('invite_slots')
    .select('id,in_space_name,notice_version,notice_ack_at,claimed_at,generation')
    .eq('space_id', spaceId).eq('claimed_by', userId).eq('claimed', true).limit(1));
  return found.length === 1 ? found[0] : null;
}

async function findLegacyMembership(db, spaceId, userId) {
  const found = rows(await db.from('memberships').select('space_id,user_id')
    .eq('space_id', spaceId).eq('user_id', userId).limit(1));
  return found.length === 1;
}

export async function ownerDisplayName(db, space) {
  if (typeof space.owner_name === 'string' && space.owner_name.trim()) return space.owner_name.trim();
  const found = rows(await db.from('users').select('full_name').eq('id', space.owner_id).limit(1));
  const fullName = found.length === 1 && typeof found[0].full_name === 'string' ? found[0].full_name.trim() : '';
  return fullName || '负责人';
}

export async function resolveAccess(db, space, userId) {
  if (space.owner_id === userId) {
    return { role: 'owner', inSpaceName: await ownerDisplayName(db, space) };
  }
  const claim = await findClaim(db, space.id, userId);
  if (claim) {
    return {
      role: 'member',
      inSpaceName: typeof claim.in_space_name === 'string' ? claim.in_space_name : null,
      noticeVersion: claim.notice_version ?? null,
      noticeAckAt: claim.notice_ack_at ?? null,
    };
  }
  if (isLegacySpace(space) && await findLegacyMembership(db, space.id, userId)) {
    return { role: 'member', inSpaceName: null };
  }
  return null;
}

// 只负责找出“可能可访问”的空间 ID；角色仍由 resolveAccess 判定，
// 因而 S1 空间里的残留 memberships 行不会出现在列表结果中。
export async function findAccessibleSpaceIds(db, userId) {
  const owned = rows(await db.from('spaces').select('id').eq('owner_id', userId));
  const memberships = rows(await db.from('memberships').select('space_id').eq('user_id', userId));
  const claims = rows(await db.from('invite_slots')
    .select('space_id').eq('claimed_by', userId).eq('claimed', true));
  return [...new Set([
    ...owned.map((row) => row.id),
    ...memberships.map((row) => row.space_id),
    ...claims.map((row) => row.space_id),
  ])];
}

// 负责人和成员的唯一名单来源；槽位优先于旧成员关系，负责人永远只出现一次。
export async function loadRoster(db, space) {
  const names = new Map();
  const members = new Map();
  const ownerName = await ownerDisplayName(db, space);
  names.set(space.owner_id, ownerName);

  const claims = rows(await db.from('invite_slots')
    .select('claimed_by,in_space_name,claimed_at,notice_version,notice_ack_at,generation')
    .eq('space_id', space.id).eq('claimed', true));
  for (const claim of claims) {
    if (typeof claim.claimed_by !== 'string' || claim.claimed_by === space.owner_id) continue;
    if (typeof claim.in_space_name !== 'string' || !claim.in_space_name) continue;
    if (members.has(claim.claimed_by)) continue;
    members.set(claim.claimed_by, {
      userId: claim.claimed_by,
      role: 'member',
      inSpaceName: claim.in_space_name,
      joinedAt: claim.claimed_at ?? null,
      noticeVersion: claim.notice_version ?? null,
      noticeAckAt: claim.notice_ack_at ?? null,
      source: 'slot',
    });
    names.set(claim.claimed_by, claim.in_space_name);
  }

  if (isLegacySpace(space)) {
    const legacy = rows(await db.from('memberships').select('user_id').eq('space_id', space.id));
    for (const row of legacy) {
      if (row.user_id === space.owner_id || members.has(row.user_id)) continue;
      const found = rows(await db.from('users').select('id,full_name').eq('id', row.user_id).limit(1));
      if (found.length !== 1) throw new AppError('database_unavailable', 503);
      const fullName = typeof found[0].full_name === 'string' ? found[0].full_name.trim() : '';
      members.set(row.user_id, {
        userId: row.user_id,
        role: 'member',
        inSpaceName: fullName || null,
        joinedAt: null,
        noticeVersion: null,
        noticeAckAt: null,
        source: 'legacy',
      });
      names.set(row.user_id, fullName || '成员');
    }
  }

  return {
    owner: {
      userId: space.owner_id,
      role: 'owner',
      inSpaceName: ownerName,
      joinedAt: space.created_at ?? null,
      noticeVersion: null,
      noticeAckAt: null,
      source: 'owner',
    },
    members: [...members.values()],
    names,
  };
}

export async function loadMemberNames(db, space, memberIds) {
  const names = (await loadRoster(db, space)).names;
  for (const id of new Set(memberIds)) {
    if (names.has(id)) continue;
    const found = rows(await db.from('users').select('id,full_name').eq('id', id).limit(1));
    if (found.length !== 1) throw new AppError('database_unavailable', 503);
    const fullName = typeof found[0].full_name === 'string' ? found[0].full_name.trim() : '';
    names.set(id, fullName || '成员');
  }
  return names;
}

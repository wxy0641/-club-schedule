-- S0 isolated probe schema. Fictional test data only; no seed DML in the migration.
CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  nickname text,
  full_name text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  password_iterations integer NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE app.sessions (
  token_digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE app.auth_limiter (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL
);

CREATE TABLE app.spaces (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users (id),
  name text NOT NULL,
  mode text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE app.memberships (
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  PRIMARY KEY (space_id, user_id)
);

-- 每个成员在每个空间只有一份整表文档；一次提交是该文档的一次版本条件写入，
-- 多个课程格子作为 JSONB 数组随同一次写入原子替换。
CREATE TABLE app.schedules (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  member_id uuid NOT NULL REFERENCES app.users (id),
  entries jsonb NOT NULL,
  version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (space_id, member_id)
);

CREATE INDEX schedules_space_idx ON app.schedules (space_id);
CREATE INDEX schedules_member_idx ON app.schedules (member_id);

-- S1 additive migration (applied 2026-11-09 as migration 01a1c05e-73fc-78af-882e-e04b9f316218).
-- Kept as a separate section because the migration API only accepts additive DDL.
ALTER TABLE app.spaces ADD COLUMN config jsonb;
ALTER TABLE app.spaces ADD COLUMN owner_name text;

-- 每个空间一条邀请记录：仅存哈希；轮换时 generation 递增并条件更新。
CREATE TABLE app.space_invites (
  space_id uuid PRIMARY KEY REFERENCES app.spaces (id),
  code_hash text NOT NULL UNIQUE,
  generation integer NOT NULL,
  max_uses integer NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- 成员资格以“已认领名额”表示：单行条件更新即完成加入；
-- UNIQUE (space_id, claimed_by) 保证同一用户在同一空间只有一条成员记录，
-- 名额行数即容量上限，并发认领不会超出。
-- 撤销/轮换把旧代次未认领槽位的 generation 改为负数（-旧代次），
-- 认领更新同时带 generation 条件，因此失效与认领在槽位行上由数据库串行化。
-- 已认领槽位即使代次变旧仍保留成员资格。
CREATE TABLE app.invite_slots (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  generation integer NOT NULL,
  slot_no integer NOT NULL,
  claimed boolean NOT NULL,
  claimed_by uuid REFERENCES app.users (id),
  in_space_name text,
  notice_version text,
  notice_ack_at timestamptz,
  claimed_at timestamptz,
  UNIQUE (space_id, generation, slot_no),
  UNIQUE (space_id, claimed_by)
);

CREATE INDEX invite_slots_space_idx ON app.invite_slots (space_id, claimed);
CREATE INDEX invite_slots_claimed_by_idx ON app.invite_slots (claimed_by, claimed);

-- S2a additive migration: one document per (space, member) holding draft, published snapshot,
-- revision CAS, published version and the last idempotency request.
-- entries are [{day, period, weekRule: every|odd|even, courseName?}]; empty array = all-week no class.
-- Draft is never exposed to owners or other members. Config lock is derived from any
-- published_version > 0 document in the space; future removal paths must preserve these rows.
CREATE TABLE app.schedule_documents (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  member_id uuid NOT NULL REFERENCES app.users (id),
  revision integer NOT NULL,
  draft_entries jsonb,
  published_entries jsonb,
  published_version integer NOT NULL,
  draft_updated_at timestamptz,
  published_at timestamptz,
  last_request_id text,
  last_request_op text,
  last_request_digest text,
  updated_at timestamptz NOT NULL,
  UNIQUE (space_id, member_id)
);

CREATE INDEX schedule_documents_space_idx ON app.schedule_documents (space_id);
CREATE INDEX schedule_documents_member_idx ON app.schedule_documents (member_id);

-- S2b additive migration: new spaces keep teaching inside the single spaces.config row so
-- creation stays one atomic insert. Existing S2a spaces set teaching once through an
-- insert-if-absent row keyed by space_id; no existing config is rewritten or unlocked.
CREATE TABLE app.space_teaching (
  space_id uuid PRIMARY KEY REFERENCES app.spaces (id),
  timezone text NOT NULL,
  first_week_monday text NOT NULL,
  term_start text NOT NULL,
  term_end text NOT NULL,
  set_at timestamptz NOT NULL
);

-- One overlay row per (space, member, local date, period). Cancelling class and the personal
-- busy/available statement are independent columns. Empty overlays are retained with an
-- incremented version so restoring defaults cannot reopen an ABA window.
CREATE TABLE app.date_exceptions (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  member_id uuid NOT NULL REFERENCES app.users (id),
  local_date text NOT NULL,
  period integer NOT NULL,
  cancel_class boolean NOT NULL,
  personal_state text NOT NULL,
  course_signature text,
  version integer NOT NULL,
  last_request_id text,
  last_request_op text,
  last_request_digest text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (space_id, member_id, local_date, period)
);

CREATE INDEX date_exceptions_member_idx ON app.date_exceptions (space_id, member_id, local_date);
CREATE INDEX date_exceptions_space_idx ON app.date_exceptions (space_id);

-- Calendar exception notice consent is separate from the join notice and never inherited by S3.
CREATE TABLE app.calendar_consents (
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  member_id uuid NOT NULL REFERENCES app.users (id),
  notice_version text NOT NULL,
  status text NOT NULL,
  accepted_at timestamptz,
  declined_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, member_id)
);

-- S3 additive migration: owner participation is separate from the owner role. A missing row is
-- "unset" (must choose, never silently counted); declined rows keep the owner out of every
-- collection count/query/export while management rights remain unchanged.
CREATE TABLE app.collection_participants (
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  user_id uuid NOT NULL REFERENCES app.users (id),
  status text NOT NULL,
  joined_at timestamptz,
  left_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

-- Date-level sharing is an independent consent from the calendar exception notice.
-- Rows are retained on revoke (status=revoked) so revocation time and notice version stay auditable.
CREATE TABLE app.calendar_share_consents (
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  member_id uuid NOT NULL REFERENCES app.users (id),
  status text NOT NULL,
  notice_version text NOT NULL,
  accepted_at timestamptz,
  declined_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, member_id)
);

-- Owner-authored calendar items. Private rows must never leave the creator's API responses;
-- space-public rows are readable by current members only and never become internet-public.
-- version CAS rejects stale visibility switches so an old request cannot restore old visibility.
CREATE TABLE app.space_events (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  created_by uuid NOT NULL REFERENCES app.users (id),
  title text NOT NULL,
  description text,
  start_date text NOT NULL,
  end_date text NOT NULL,
  all_day boolean NOT NULL,
  start_time text,
  end_time text,
  visibility text NOT NULL,
  -- 接收人快照与公开范围分离：private 事件不得通知；invitees 仅接收人可见。
  recipient_scope text NOT NULL DEFAULT 'none',
  recipient_ids text NOT NULL DEFAULT '[]',
  deleted boolean NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX space_events_space_idx ON app.space_events (space_id, start_date, end_date);
CREATE INDEX space_events_creator_idx ON app.space_events (created_by);

-- 站内安排/邀请的接受记录。事件时间不复制进日期例外；投影只认 event_stamp 与当前事件一致的已接受行。
-- 管理操作保留发起人、目标、发送时间与结果；改期后旧确认自动失效并要求重新确认。
CREATE TABLE app.event_assignments (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES app.spaces (id),
  event_id uuid REFERENCES app.space_events (id),
  kind text NOT NULL,
  request_id text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users (id),
  target_user_id uuid NOT NULL REFERENCES app.users (id),
  request_date text,
  request_period integer,
  event_stamp text,
  status text NOT NULL,
  version integer NOT NULL,
  last_request_id text,
  last_request_op text,
  last_request_digest text,
  created_at timestamptz NOT NULL,
  responded_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (space_id, request_id, target_user_id)
);

CREATE INDEX event_assignments_target_idx ON app.event_assignments (space_id, target_user_id, status);
CREATE INDEX event_assignments_event_idx ON app.event_assignments (space_id, event_id);

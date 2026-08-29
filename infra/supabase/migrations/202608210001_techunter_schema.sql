create schema if not exists techunter;

create type techunter.user_role as enum ('admin', 'maintainer', 'member');
create type techunter.task_status as enum ('draft', 'open', 'active', 'submitted', 'accepted', 'cancelled');
create type techunter.submission_status as enum ('pending', 'reviewing', 'approved', 'changes_requested', 'rejected');
create type techunter.workspace_status as enum ('queued', 'provisioning', 'running', 'stopped', 'failed');
create type techunter.repository_visibility as enum ('public', 'private', 'internal');
create type techunter.account_owner_type as enum ('system', 'project', 'user');
create type techunter.account_bucket as enum ('available', 'reserved');

create table techunter.users (
  id uuid primary key default gen_random_uuid(),
  conexus_user_id uuid unique,
  login text not null unique,
  name text not null,
  avatar_url text,
  email text,
  github_login text unique,
  role techunter.user_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table techunter.sessions (
  token_hash text primary key,
  user_id uuid not null references techunter.users(id) on delete cascade,
  model_credential text,
  model_audience text,
  github_credential text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_expiry_idx on techunter.sessions(user_id, expires_at desc);

create table techunter.projects (
  id uuid primary key default gen_random_uuid(),
  github_repository_id bigint not null unique,
  name text not null,
  description text not null default '',
  repo_owner text not null,
  repo_name text not null,
  clone_url text not null,
  html_url text not null,
  default_branch text not null default 'main',
  source_branch text not null default 'main',
  visibility techunter.repository_visibility not null default 'private',
  head_sha text not null default '',
  imported_by uuid references techunter.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(repo_owner, repo_name)
);

create table techunter.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references techunter.projects(id),
  parent_task_id uuid references techunter.tasks(id),
  root_task_id uuid references techunter.tasks(id),
  title text not null,
  description text not null default '',
  summary text not null default '',
  acceptance_json jsonb not null default '[]'::jsonb,
  scope_json jsonb,
  analysis_json jsonb,
  status techunter.task_status not null default 'draft',
  reward_points bigint not null default 0 check (reward_points >= 0),
  publisher_id uuid not null references techunter.users(id),
  assignee_id uuid references techunter.users(id),
  reviewer_id uuid references techunter.users(id),
  payer_account_id uuid,
  base_sha text not null default '',
  target_branch text not null default 'main',
  github_issue_number bigint,
  github_issue_url text,
  lock_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_project_status_idx on techunter.tasks(project_id, status);
create index tasks_parent_idx on techunter.tasks(parent_task_id);
create index tasks_assignee_status_idx on techunter.tasks(assignee_id, status);

create table techunter.claims (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references techunter.tasks(id),
  user_id uuid not null references techunter.users(id),
  lease_expires_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index claims_active_task_idx on techunter.claims(task_id) where released_at is null;

create table techunter.workspaces (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references techunter.tasks(id),
  user_id uuid not null references techunter.users(id),
  status techunter.workspace_status not null default 'queued',
  provider text not null default 'local_agent' check (provider = 'local_agent'),
  device_id text not null,
  device_label text not null default '',
  head_sha text not null default '',
  setup_log text not null default '',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_task_created_idx on techunter.workspaces(task_id, created_at desc);

create table techunter.submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references techunter.tasks(id),
  author_id uuid not null references techunter.users(id),
  status techunter.submission_status not null default 'pending',
  summary text not null default '',
  test_output text not null default '',
  files_json jsonb not null default '[]'::jsonb,
  pull_request_url text,
  review_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index submissions_task_created_idx on techunter.submissions(task_id, created_at desc);

create table techunter.point_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_type techunter.account_owner_type not null,
  owner_id text not null,
  bucket techunter.account_bucket not null,
  label text not null,
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  unique(owner_type, owner_id, bucket)
);

create table techunter.point_transfers (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  type text not null,
  amount bigint not null check (amount > 0),
  from_account_id uuid not null references techunter.point_accounts(id),
  to_account_id uuid not null references techunter.point_accounts(id),
  task_id uuid references techunter.tasks(id),
  memo text not null default '',
  created_at timestamptz not null default now()
);

create table techunter.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references techunter.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created_idx on techunter.audit_events(created_at desc);

create table techunter.github_deliveries (
  delivery_id text primary key,
  event_name text not null,
  payload_hash text not null,
  processed_at timestamptz not null default now()
);

create or replace function techunter.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_set_updated_at before update on techunter.users
for each row execute procedure techunter.set_updated_at();
create trigger projects_set_updated_at before update on techunter.projects
for each row execute procedure techunter.set_updated_at();
create trigger tasks_set_updated_at before update on techunter.tasks
for each row execute procedure techunter.set_updated_at();
create trigger workspaces_set_updated_at before update on techunter.workspaces
for each row execute procedure techunter.set_updated_at();
create trigger submissions_set_updated_at before update on techunter.submissions
for each row execute procedure techunter.set_updated_at();

create or replace function techunter.ensure_user_accounts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into techunter.point_accounts(owner_type, owner_id, bucket, label)
  values
    ('user', new.id::text, 'available', new.name),
    ('user', new.id::text, 'reserved', new.name || ' 冻结')
  on conflict do nothing;
  return new;
end;
$$;
create trigger users_ensure_accounts after insert on techunter.users
for each row execute procedure techunter.ensure_user_accounts();

create or replace function techunter.ensure_project_accounts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into techunter.point_accounts(owner_type, owner_id, bucket, label)
  values
    ('project', new.id::text, 'available', new.name || ' 项目预算'),
    ('project', new.id::text, 'reserved', new.name || ' 冻结预算')
  on conflict do nothing;
  return new;
end;
$$;
create trigger projects_ensure_accounts after insert on techunter.projects
for each row execute procedure techunter.ensure_project_accounts();

insert into techunter.point_accounts(owner_type, owner_id, bucket, label)
values ('system', 'mint', 'available', '系统发行')
on conflict do nothing;

create or replace function techunter.post_transfer(
  p_idempotency_key text,
  p_type text,
  p_amount bigint,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_task_id uuid,
  p_memo text,
  p_allow_overdraft boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  source_balance bigint;
  transfer_id uuid := gen_random_uuid();
begin
  if p_amount <= 0 then raise exception 'INVALID_TRANSFER_AMOUNT'; end if;
  select id into existing_id from techunter.point_transfers where idempotency_key = p_idempotency_key;
  if existing_id is not null then return existing_id; end if;
  select balance into source_balance from techunter.point_accounts where id = p_from_account_id for update;
  if source_balance is null then raise exception 'SOURCE_ACCOUNT_NOT_FOUND'; end if;
  perform 1 from techunter.point_accounts where id = p_to_account_id for update;
  if not found then raise exception 'DESTINATION_ACCOUNT_NOT_FOUND'; end if;
  if not p_allow_overdraft and source_balance < p_amount then raise exception 'INSUFFICIENT_POINTS'; end if;
  update techunter.point_accounts set balance = balance - p_amount where id = p_from_account_id;
  update techunter.point_accounts set balance = balance + p_amount where id = p_to_account_id;
  insert into techunter.point_transfers(id, idempotency_key, type, amount, from_account_id, to_account_id, task_id, memo)
  values (transfer_id, p_idempotency_key, p_type, p_amount, p_from_account_id, p_to_account_id, p_task_id, p_memo);
  return transfer_id;
end;
$$;

create or replace function techunter.allocate_project_points(p_project_id uuid, p_amount bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_id uuid;
  destination_id uuid;
begin
  if p_amount <= 0 then return; end if;
  select id into source_id from techunter.point_accounts where owner_type = 'system' and owner_id = 'mint' and bucket = 'available';
  select id into destination_id from techunter.point_accounts where owner_type = 'project' and owner_id = p_project_id::text and bucket = 'available';
  perform techunter.post_transfer('project:' || p_project_id || ':initial', 'allocation', p_amount, source_id, destination_id, null, '项目初始预算', true);
end;
$$;

create or replace function techunter.publish_task(
  p_task_id uuid,
  p_actor_id uuid,
  p_reward bigint,
  p_issue_number bigint,
  p_issue_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target techunter.tasks%rowtype;
  parent_reward bigint;
  allocated bigint;
  source_id uuid;
  destination_id uuid;
begin
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null or target.status <> 'draft' or target.scope_json is null then raise exception 'TASK_NOT_PUBLISHABLE'; end if;
  if target.publisher_id <> p_actor_id and not exists(select 1 from techunter.users where id = p_actor_id and role = 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_reward <= 0 then raise exception 'INVALID_REWARD'; end if;
  if target.parent_task_id is not null then
    select reward_points into parent_reward from techunter.tasks where id = target.parent_task_id;
    select coalesce(sum(reward_points), 0) into allocated from techunter.tasks
      where parent_task_id = target.parent_task_id and id <> target.id and status <> 'cancelled';
    if allocated + p_reward > parent_reward then raise exception 'PARENT_BUDGET_EXCEEDED'; end if;
  else
    select id into source_id from techunter.point_accounts where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'available';
    select id into destination_id from techunter.point_accounts where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'reserved';
    perform techunter.post_transfer('task:' || target.id || ':reserve', 'task_reserve', p_reward, source_id, destination_id, target.id, '发布任务：' || target.title, false);
  end if;
  update techunter.tasks set status = 'open', reward_points = p_reward, payer_account_id = target.project_id,
    github_issue_number = p_issue_number, github_issue_url = p_issue_url, lock_version = lock_version + 1
  where id = target.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
  values (p_actor_id, 'task.published', 'task', target.id::text, jsonb_build_object('rewardPoints', p_reward, 'githubIssueNumber', p_issue_number));
end;
$$;

create or replace function techunter.claim_task(p_task_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_id uuid := gen_random_uuid();
begin
  update techunter.tasks set status = 'active', assignee_id = p_user_id, lock_version = lock_version + 1
  where id = p_task_id and status = 'open' and assignee_id is null;
  if not found then raise exception 'TASK_ALREADY_CLAIMED'; end if;
  insert into techunter.claims(id, task_id, user_id, lease_expires_at)
  values (claim_id, p_task_id, p_user_id, now() + interval '48 hours');
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
  values (p_user_id, 'task.claimed', 'task', p_task_id::text, jsonb_build_object('claimId', claim_id));
  return claim_id;
end;
$$;

create or replace function techunter.rollback_claim(p_task_id uuid, p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update techunter.tasks set status = 'open', assignee_id = null, lock_version = lock_version + 1
  where id = p_task_id and status = 'active' and assignee_id = p_user_id;
  update techunter.claims set released_at = now() where task_id = p_task_id and user_id = p_user_id and released_at is null;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
  values (p_user_id, 'github.claim_sync_failed', 'task', p_task_id::text, jsonb_build_object('error', p_reason));
end;
$$;

create or replace function techunter.release_task(p_task_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists(select 1 from techunter.tasks where parent_task_id = p_task_id and status not in ('accepted', 'cancelled')) then
    raise exception 'OPEN_CHILD_TASKS';
  end if;
  update techunter.tasks set status = 'open', assignee_id = null, lock_version = lock_version + 1
  where id = p_task_id and status = 'active' and assignee_id = p_user_id;
  if not found then raise exception 'TASK_NOT_RELEASABLE'; end if;
  update techunter.claims set released_at = now() where task_id = p_task_id and released_at is null;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id)
  values (p_user_id, 'task.released', 'task', p_task_id::text);
end;
$$;

create or replace function techunter.accept_task(p_submission_id uuid, p_reviewer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target techunter.tasks%rowtype;
  submission techunter.submissions%rowtype;
  child_points bigint;
  payout bigint;
  source_id uuid;
  destination_id uuid;
begin
  select * into submission from techunter.submissions where id = p_submission_id for update;
  if submission.id is null or submission.status <> 'approved' then raise exception 'SUBMISSION_NOT_APPROVED'; end if;
  select * into target from techunter.tasks where id = submission.task_id for update;
  if target.status <> 'submitted' then raise exception 'TASK_NOT_SUBMITTED'; end if;
  if target.assignee_id = p_reviewer_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  select coalesce(sum(reward_points), 0) into child_points from techunter.tasks where parent_task_id = target.id and status = 'accepted';
  payout := case when target.parent_task_id is null then greatest(0, target.reward_points - child_points) else target.reward_points end;
  if payout > 0 then
    select id into source_id from techunter.point_accounts where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'reserved';
    select id into destination_id from techunter.point_accounts where owner_type = 'user' and owner_id = target.assignee_id::text and bucket = 'available';
    perform techunter.post_transfer('task:' || target.id || ':settle', 'task_settlement', payout, source_id, destination_id, target.id, '任务验收：' || target.title, false);
  end if;
  update techunter.tasks set status = 'accepted', reviewer_id = p_reviewer_id, lock_version = lock_version + 1 where id = target.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
  values (p_reviewer_id, 'task.accepted', 'task', target.id::text, jsonb_build_object('submissionId', submission.id, 'payout', payout));
  return target.id;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['users','sessions','projects','tasks','claims','workspaces','submissions','point_accounts','point_transfers','audit_events','github_deliveries']
  loop
    execute format('alter table techunter.%I enable row level security', table_name);
  end loop;
end $$;

revoke all on schema techunter from public, anon, authenticated;
revoke all on all tables in schema techunter from public, anon, authenticated;
revoke all on all sequences in schema techunter from public, anon, authenticated;
revoke all on all functions in schema techunter from public, anon, authenticated;

grant usage on schema techunter to service_role;
grant all on all tables in schema techunter to service_role;
grant all on all sequences in schema techunter to service_role;
grant execute on all functions in schema techunter to service_role;

alter default privileges in schema techunter revoke all on tables from public, anon, authenticated;
alter default privileges in schema techunter grant all on tables to service_role;
alter default privileges in schema techunter grant execute on functions to service_role;

-- Durable external work. Payloads contain task data, never credentials.
create table techunter.task_operations (
  id uuid primary key,
  task_id uuid not null references techunter.tasks(id),
  kind text not null check (kind in ('publish', 'submit')),
  actor_id uuid not null references techunter.users(id),
  payload jsonb not null,
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table techunter.task_operations enable row level security;
revoke all on techunter.task_operations from public, anon, authenticated;
grant all on techunter.task_operations to service_role;
create index task_operations_pending on techunter.task_operations(task_id) where completed_at is null;

create function techunter.save_task_analysis(p_task_id uuid, p_actor_id uuid, p_version integer, p_parent_scope jsonb, p_analysis jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; parent techunter.tasks%rowtype;
begin
  select * into parent from techunter.tasks where id = (select parent_task_id from techunter.tasks where id = p_task_id) for update;
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.publisher_id is distinct from p_actor_id and not exists(select 1 from techunter.users where id = p_actor_id and role = 'admin') then raise exception 'FORBIDDEN'; end if;
  if target.id is null or target.status <> 'draft' or target.lock_version is distinct from p_version
    or exists(select 1 from techunter.task_operations where task_id = target.id and completed_at is null)
    then raise exception 'TASK_VERSION_CONFLICT'; end if;
  if parent.scope_json is distinct from p_parent_scope then raise exception 'SCOPE_REVISION_CONFLICT'; end if;
  update techunter.tasks set summary = p_analysis->>'summary', acceptance_json = p_analysis->'acceptanceCriteria',
    scope_json = p_analysis->'scope', analysis_json = p_analysis, reward_points = (p_analysis->>'suggestedPoints')::bigint,
    lock_version = lock_version + 1 where id = target.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id)
    values(p_actor_id, 'task.analyzed', 'task', target.id::text);
end;
$$;

-- Holds prevent two pending publications from promising the same points. Actual
-- ledger reservation still happens only after the GitHub Issue exists.
create function techunter.check_publication_budget(p_task_id uuid, p_reward bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; parent techunter.tasks%rowtype; available bigint; held bigint;
begin
  perform 1 from techunter.projects where id = (select project_id from techunter.tasks where id = p_task_id) for update;
  select * into parent from techunter.tasks where id = (select parent_task_id from techunter.tasks where id = p_task_id) for update;
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if target.status<>'draft' then return; end if;
  if p_reward is null or p_reward <= 0 or p_reward > 100000 then raise exception 'INVALID_REWARD'; end if;
  if target.parent_task_id is null then
    select balance into available from techunter.point_accounts where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'available' for update;
    select coalesce(sum((o.payload->>'reward')::bigint),0) into held from techunter.task_operations o join techunter.tasks t on t.id=o.task_id
      where o.kind='publish' and o.completed_at is null and t.project_id=target.project_id and t.parent_task_id is null and t.id<>target.id;
    if coalesce(available,0) - held < p_reward then raise exception 'INSUFFICIENT_POINTS'; end if;
  else
    if parent.status <> 'active' then raise exception 'TASK_NOT_SUBMITTABLE'; end if;
    select coalesce(sum(case when status='cancelled' then techunter.descendant_settlement_points(id) else reward_points end),0)
      into held from techunter.tasks where parent_task_id=parent.id and id<>target.id and status<>'draft';
    select held + coalesce(sum((o.payload->>'reward')::bigint),0) into held from techunter.task_operations o join techunter.tasks t on t.id=o.task_id
      where o.kind='publish' and o.completed_at is null and t.parent_task_id=parent.id and t.id<>target.id;
    if parent.reward_points - held < p_reward then raise exception 'PARENT_BUDGET_EXCEEDED'; end if;
  end if;
end;
$$;

alter function techunter.publish_task(uuid,uuid,bigint,bigint,text) rename to publish_task_unchecked;
revoke all on function techunter.publish_task_unchecked(uuid,uuid,bigint,bigint,text) from public, anon, authenticated, service_role;
create function techunter.publish_task(p_task_id uuid,p_actor_id uuid,p_reward bigint,p_issue_number bigint,p_issue_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform techunter.check_publication_budget(p_task_id,p_reward);
  if exists(select 1 from techunter.task_operations where task_id=p_task_id and kind='publish' and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  perform techunter.publish_task_unchecked(p_task_id,p_actor_id,p_reward,p_issue_number,p_issue_url);
end;
$$;

create function techunter.begin_task_publication(p_task_id uuid,p_actor_id uuid,p_reward bigint,p_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation techunter.task_operations%rowtype;
begin
  perform techunter.check_publication_budget(p_task_id,p_reward);
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.publisher_id<>p_actor_id and not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  select * into operation from techunter.task_operations where id=p_task_id;
  if operation.id is not null then
    if (operation.payload->>'reward')::bigint<>p_reward then raise exception 'TASK_VERSION_CONFLICT'; end if;
    return operation.id;
  end if;
  if target.status<>'draft' or target.scope_json is null or target.lock_version is distinct from p_version then raise exception 'TASK_VERSION_CONFLICT'; end if;
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload)
    values(target.id,target.id,'publish',p_actor_id,jsonb_build_object('reward',p_reward));
  return target.id;
end;
$$;

create function techunter.lease_task_operation(p_id uuid,p_actor_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.id is null then raise exception 'OPERATION_NOT_FOUND'; end if;
  if operation.actor_id<>p_actor_id and not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  if operation.completed_at is not null then return null; end if;
  if operation.lease_until>clock_timestamp() and operation.lease_token is distinct from p_token then raise exception 'OPERATION_IN_PROGRESS'; end if;
  update techunter.task_operations set lease_token=p_token,lease_until=clock_timestamp()+interval '90 seconds' where id=p_id;
  return operation.payload;
end;
$$;

create function techunter.release_task_operation(p_id uuid,p_token uuid)
returns void language sql security definer set search_path = '' as $$
  update techunter.task_operations set lease_until=null,lease_token=null where id=p_id and lease_token=p_token;
$$;

create function techunter.finish_task_publication(p_id uuid,p_token uuid,p_issue_number bigint,p_issue_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  -- Same lock order as begin: project, parent, task, operation.
  perform techunter.check_publication_budget(p_id,(select (payload->>'reward')::bigint from techunter.task_operations where id=p_id));
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if operation.kind<>'publish' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
  perform techunter.publish_task_unchecked(p_id,operation.actor_id,(operation.payload->>'reward')::bigint,p_issue_number,p_issue_url);
end;
$$;

create function techunter.cancel_task_publication(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.projects where id=(select project_id from techunter.tasks where id=p_id) for update;
  perform 1 from techunter.tasks where id=p_id and status='draft' for update;
  if not found then raise exception 'TASK_VERSION_CONFLICT'; end if;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.kind is distinct from 'publish' or operation.completed_at is not null or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  -- GitHub Issues have already been closed. No ledger transfer was made yet.
  delete from techunter.task_operations where id=p_id;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id) values(operation.actor_id,'task.publication_cancelled','task',p_id::text);
end;
$$;

-- New submissions atomically persist the exact package and remote head that was
-- reviewed. Existing pre-migration submissions can also be resumed below.
create function techunter.begin_submission_operation(p_task_id uuid,p_author_id uuid,p_scope jsonb,p_summary text,p_test_output text,p_files jsonb,p_review jsonb,p_head_sha text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare submission_id uuid;
begin
  submission_id := techunter.begin_submission(p_task_id,p_author_id,p_scope,p_summary,p_test_output,p_files,p_review);
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload)
    values(submission_id,p_task_id,'submit',p_author_id,jsonb_build_object('headSha',p_head_sha,'files',p_files,'review',p_review));
  return submission_id;
end;
$$;

create function techunter.prepare_submission_recovery(p_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare submission techunter.submissions%rowtype; target techunter.tasks%rowtype;
begin
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_id for update of t;
  select * into submission from techunter.submissions where id=p_id for update;
  if submission.author_id is distinct from p_actor_id and not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  if submission.status<>'reviewing' or target.status<>'submitted' or submission.id is distinct from
    (select id from techunter.submissions where task_id=target.id order by created_at desc,id desc limit 1) then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  -- Legacy operations have no captured remote head. Recovery may only reconcile
  -- an existing PR; it must never overwrite an unknown branch snapshot.
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload)
    values(p_id,target.id,'submit',submission.author_id,jsonb_build_object('headSha',null,'files',submission.files_json,'review',submission.review_json)) on conflict do nothing;
end;
$$;

create function techunter.finish_submission_operation(p_id uuid,p_token uuid,p_pull_url text,p_succeeded boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if operation.kind<>'submit' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  perform techunter.finish_submission(p_id,p_succeeded,p_pull_url);
  update techunter.task_operations set completed_at=now() where id=p_id;
end;
$$;

-- A pending publication freezes the draft while GitHub is unavailable. Removing
-- an in-flight submission is rejected as well, so a late worker cannot publish
-- code for a task that was cancelled underneath it.
create function techunter.guard_task_operation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from techunter.task_operations where task_id=old.id and completed_at is null and
    (kind='publish' or tg_op='DELETE' or new.status='cancelled')) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if tg_op='DELETE' then return old; end if;
  if old.status<>'draft' and (new.reward_points is distinct from old.reward_points or new.base_sha is distinct from old.base_sha or new.target_branch is distinct from old.target_branch) then raise exception 'TASK_VERSION_CONFLICT'; end if;
  return new;
end;
$$;
create trigger tasks_guard_operation before update or delete on techunter.tasks for each row execute function techunter.guard_task_operation();

do $$ declare signature text; begin
  foreach signature in array array[
    'save_task_analysis(uuid,uuid,integer,jsonb,jsonb)', 'check_publication_budget(uuid,bigint)',
    'publish_task(uuid,uuid,bigint,bigint,text)', 'begin_task_publication(uuid,uuid,bigint,integer)',
    'lease_task_operation(uuid,uuid,uuid)', 'release_task_operation(uuid,uuid)',
    'finish_task_publication(uuid,uuid,bigint,text)',
    'cancel_task_publication(uuid,uuid)',
    'begin_submission_operation(uuid,uuid,jsonb,text,text,jsonb,jsonb,text)',
    'prepare_submission_recovery(uuid,uuid)', 'finish_submission_operation(uuid,uuid,text,boolean)', 'guard_task_operation()'
  ] loop
    execute 'revoke all on function techunter.' || signature || ' from public, anon, authenticated';
    execute 'grant execute on function techunter.' || signature || ' to service_role';
  end loop;
end $$;

-- Keep one integration branch throughout a task's lifetime, including reclaims.
-- Conflicting historical integration branches need reconciliation before freezing one.
do $$ begin
  if exists(select 1 from techunter.tasks where parent_task_id is not null and status<>'cancelled'
    group by parent_task_id having count(distinct target_branch)>1) then
    raise exception 'TASK_BRANCH_RECONCILIATION_REQUIRED: children of one parent target different branches';
  end if;
end $$;
alter table techunter.tasks add column working_branch text;
-- Backfill metadata without cancelling pending legacy releases/publications.
-- ALTER TABLE holds the table lock until this migration transaction commits.
alter table techunter.tasks disable trigger tasks_guard_operation;
update techunter.tasks t set working_branch = coalesce(
  (select c.target_branch from techunter.tasks c where c.parent_task_id=t.id and c.status<>'cancelled' order by c.created_at desc,c.id desc limit 1),
  (select 'task-' || t.github_issue_number || '-' || coalesce(nullif(trim(both '-' from regexp_replace(lower(u.github_login),'[^a-z0-9-]+','-','g')),''),'user')
   from techunter.users u where u.id=coalesce(t.assignee_id,
     (select c.user_id from techunter.claims c where c.task_id=t.id order by c.created_at desc,c.id desc limit 1)) and u.github_login is not null)
) where t.github_issue_number is not null;
alter table techunter.tasks enable trigger tasks_guard_operation;

create function techunter.freeze_working_branch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.working_branch is not null and new.working_branch is distinct from old.working_branch then raise exception 'TASK_VERSION_CONFLICT'; end if;
  if new.status='active' and new.working_branch is null then new.working_branch := 'task-' || new.id::text; end if;
  return new;
end;
$$;
create trigger tasks_freeze_working_branch before update on techunter.tasks for each row execute function techunter.freeze_working_branch();

alter table techunter.task_operations drop constraint task_operations_kind_check;
alter table techunter.task_operations add constraint task_operations_kind_check
  check(kind in ('publish','submit','release','claim','accept','request_changes','cancel'));
create unique index task_operations_one_pending on techunter.task_operations(task_id) where completed_at is null;

create or replace function techunter.guard_task_operation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from techunter.task_operations where task_id=old.id and completed_at is null and
    (kind<>'submit' or tg_op='DELETE' or new.status='cancelled')) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if tg_op='DELETE' then return old; end if;
  if old.status<>'draft' and (new.reward_points is distinct from old.reward_points or new.base_sha is distinct from old.base_sha or new.target_branch is distinct from old.target_branch) then raise exception 'TASK_VERSION_CONFLICT'; end if;
  return new;
end;
$$;

-- A failed read or lost response after claiming leaves an operation the owner can resume.
create function techunter.begin_task_claim(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation techunter.task_operations%rowtype; claim_id uuid;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  select * into operation from techunter.task_operations where task_id=p_task_id and completed_at is null for update;
  if operation.id is not null then
    if operation.kind='claim' and operation.actor_id=p_actor_id then return operation.id; end if;
    raise exception 'OPERATION_IN_PROGRESS';
  end if;
  if target.status='open' and target.assignee_id is null then
    claim_id := techunter.claim_task(p_task_id,p_actor_id);
  elsif target.status='active' and target.assignee_id=p_actor_id then
    select id into claim_id from techunter.claims where task_id=p_task_id and user_id=p_actor_id and released_at is null;
    if claim_id is null then raise exception 'TASK_ALREADY_CLAIMED'; end if;
    if exists(select 1 from techunter.task_operations where id=claim_id and completed_at is not null) then return null; end if;
    -- Backfill recoverability for pre-migration claims too.
    update techunter.tasks set working_branch=working_branch where id=p_task_id;
  else raise exception 'TASK_ALREADY_CLAIMED'; end if;
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(claim_id,p_task_id,'claim',p_actor_id,'{}');
  return claim_id;
end;
$$;

create function techunter.finish_task_claim(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if p_token is null or operation.kind is distinct from 'claim' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
end;
$$;

-- Legacy RPC entry points must respect the same exclusion as the HTTP service.
alter function techunter.start_submission_review(uuid,uuid,text) rename to start_submission_review_unchecked;
revoke all on function techunter.start_submission_review_unchecked(uuid,uuid,text) from public,anon,authenticated,service_role;
create function techunter.start_submission_review(p_submission_id uuid,p_reviewer_id uuid,p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
  select t.id into target_id from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_submission_id for update of t;
  if exists(select 1 from techunter.task_operations o where o.task_id=target_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  perform techunter.start_submission_review_unchecked(p_submission_id,p_reviewer_id,p_action);
end;
$$;

create function techunter.begin_task_review(p_submission_id uuid,p_actor_id uuid,p_action text,p_reason text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; submission techunter.submissions%rowtype; operation techunter.task_operations%rowtype; operation_id uuid;
begin
  if p_action is null or p_action not in ('accept','request_changes') then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if not exists(select 1 from techunter.users where id=p_actor_id and role in ('admin','maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_submission_id for update of t;
  select * into submission from techunter.submissions where id=p_submission_id for update;
  if target.assignee_id=p_actor_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if submission.id is null or submission.id is distinct from (select id from techunter.submissions where task_id=target.id order by created_at desc,id desc limit 1) then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if target.status='accepted' and p_action='accept' and submission.status='approved' then return null; end if;
  if target.status<>'submitted' or submission.status<>'approved' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  select * into operation from techunter.task_operations where task_id=target.id and completed_at is null for update;
  if operation.id is not null then
    if operation.kind=p_action and operation.payload->>'submissionId'=p_submission_id::text then return operation.id; end if;
    if operation.kind in ('accept','request_changes') then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
    raise exception 'OPERATION_IN_PROGRESS';
  end if;
  perform techunter.start_submission_review_unchecked(p_submission_id,p_actor_id,p_action);
  operation_id := gen_random_uuid();
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(operation_id,target.id,p_action,p_actor_id,
    jsonb_build_object('submissionId',p_submission_id,'reason',p_reason,'phase',case when submission.review_action is null then 'ready' else 'unknown' end));
  return operation_id;
end;
$$;

create function techunter.mark_task_review(p_id uuid,p_token uuid,p_phase text)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'accept' or operation.completed_at is not null or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  if p_phase is null or p_phase not in ('merging','merged') then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if operation.payload->>'phase'<>'merged' then
    update techunter.task_operations set payload=jsonb_set(payload,'{phase}',to_jsonb(p_phase)) where id=p_id;
  end if;
end;
$$;

create function techunter.abort_task_review(p_id uuid,p_token uuid,p_definitely_unmerged boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'accept' or operation.completed_at is not null or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  if operation.payload->>'phase'='merged' or (operation.payload->>'phase'<>'ready' and not p_definitely_unmerged) then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  update techunter.task_operations set completed_at=now(),payload=payload || '{"phase":"not_merged"}'::jsonb where id=p_id;
  update techunter.submissions set review_action=null where id=(operation.payload->>'submissionId')::uuid and status='approved' and review_action='accept';
end;
$$;

create function techunter.finish_task_review(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if p_token is null or operation.kind not in ('accept','request_changes') or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  if operation.kind='accept' and operation.payload->>'phase'<>'merged' then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
  if operation.kind='accept' then
    perform techunter.accept_task((operation.payload->>'submissionId')::uuid,operation.actor_id);
  else
    perform techunter.request_submission_changes((operation.payload->>'submissionId')::uuid,operation.actor_id,operation.payload->>'reason');
  end if;
end;
$$;

alter function techunter.admin_remove_task(uuid,uuid) rename to admin_remove_task_unchecked;
revoke all on function techunter.admin_remove_task_unchecked(uuid,uuid) from public,anon,authenticated,service_role;
create function techunter.admin_remove_task(p_task_id uuid,p_actor_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if exists(select 1 from techunter.task_operations where task_id=p_task_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if target.status='submitted' and exists(select 1 from techunter.submissions where task_id=p_task_id and status='approved' and review_action is not null) then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  return techunter.admin_remove_task_unchecked(p_task_id,p_actor_id);
end;
$$;

create function techunter.begin_task_cancel(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation techunter.task_operations%rowtype; operation_id uuid;
begin
  if not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if target.status='accepted' then raise exception 'TASK_ALREADY_SETTLED'; end if;
  if target.status='cancelled' then return null; end if;
  if target.status='draft' then raise exception 'TASK_NOT_REMOVABLE'; end if;
  select * into operation from techunter.task_operations where task_id=p_task_id and completed_at is null for update;
  if operation.id is not null then
    if operation.kind='cancel' then return operation.id; end if;
    raise exception 'OPERATION_IN_PROGRESS';
  end if;
  if target.status='submitted' and exists(select 1 from techunter.submissions where task_id=p_task_id and status='approved' and review_action is not null) then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id=p_task_id and status not in ('accepted','cancelled')) then raise exception 'OPEN_CHILD_TASKS'; end if;
  operation_id:=gen_random_uuid();
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(operation_id,p_task_id,'cancel',p_actor_id,'{}');
  return operation_id;
end;
$$;

create function techunter.finish_task_cancel(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if p_token is null or operation.kind is distinct from 'cancel' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
  perform techunter.admin_remove_task(operation.task_id,operation.actor_id);
end;
$$;

create function techunter.abort_task_cancel(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'cancel' or operation.completed_at is not null or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now(),payload='{"reason":"pull_already_merged"}'::jsonb where id=p_id;
end;
$$;

-- Failed workspaces also belong to their old claim and cannot be revived on reclaim.
create or replace function techunter.stop_previous_workspaces()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is distinct from old.assignee_id or new.status in ('accepted','cancelled') then
    update techunter.workspaces set status='stopped' where task_id=new.id and status<>'stopped';
  end if;
  return new;
end;
$$;
update techunter.workspaces w set status='stopped' from techunter.tasks t
  where w.task_id=t.id and w.status<>'stopped' and (w.user_id is distinct from t.assignee_id or t.status not in ('active','submitted'));

create function techunter.begin_workspace_submission(p_task_id uuid,p_author_id uuid,p_workspace_id uuid,p_scope jsonb,p_summary text,p_test_output text,p_files jsonb,p_review jsonb,p_head_sha text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from techunter.tasks where id=p_task_id for update;
  if not exists(select 1 from techunter.workspaces where id=p_workspace_id and task_id=p_task_id and user_id=p_author_id and status='running') then raise exception 'WORKSPACE_NOT_READY'; end if;
  return techunter.begin_submission_operation(p_task_id,p_author_id,p_scope,p_summary,p_test_output,p_files,p_review,p_head_sha);
end;
$$;

do $$ declare signature text; begin
  foreach signature in array array[
    'freeze_working_branch()','begin_task_claim(uuid,uuid)','finish_task_claim(uuid,uuid)',
    'start_submission_review(uuid,uuid,text)','begin_task_review(uuid,uuid,text,text)',
    'mark_task_review(uuid,uuid,text)','abort_task_review(uuid,uuid,boolean)','finish_task_review(uuid,uuid)',
    'admin_remove_task(uuid,uuid)','begin_task_cancel(uuid,uuid)','finish_task_cancel(uuid,uuid)','abort_task_cancel(uuid,uuid)',
    'begin_workspace_submission(uuid,uuid,uuid,jsonb,text,text,jsonb,jsonb,text)'
  ] loop
    execute 'revoke all on function techunter.' || signature || ' from public,anon,authenticated';
    execute 'grant execute on function techunter.' || signature || ' to service_role';
  end loop;
end $$;

-- Administrators may finish an interrupted claim for its original assignee.
create or replace function techunter.begin_task_claim(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation techunter.task_operations%rowtype; claim_id uuid;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  select * into operation from techunter.task_operations where task_id=p_task_id and completed_at is null for update;
  if operation.id is not null then
    if operation.kind='claim' and (operation.actor_id=p_actor_id or
      exists(select 1 from techunter.users where id=p_actor_id and role='admin')) then return operation.id; end if;
    raise exception 'OPERATION_IN_PROGRESS';
  end if;
  if target.status='open' and target.assignee_id is null then
    claim_id := techunter.claim_task(p_task_id,p_actor_id);
  elsif target.status='active' and target.assignee_id=p_actor_id then
    select id into claim_id from techunter.claims where task_id=p_task_id and user_id=p_actor_id and released_at is null;
    if claim_id is null then raise exception 'TASK_ALREADY_CLAIMED'; end if;
    if exists(select 1 from techunter.task_operations where id=claim_id and completed_at is not null) then return null; end if;
    update techunter.tasks set working_branch=working_branch where id=p_task_id;
  else raise exception 'TASK_ALREADY_CLAIMED'; end if;
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(claim_id,p_task_id,'claim',p_actor_id,'{}');
  return claim_id;
end;
$$;

-- Cancelling an unfinished claim becomes a durable release, with a NEW operation
-- ID. Stale claim workers can never acquire the release lease or finish the claim.
-- The task remains occupied until GitHub is synchronized by the owner or an admin.
create or replace function techunter.begin_task_release(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation techunter.task_operations%rowtype; operation_id uuid; is_admin boolean;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if target.status<>'active' or target.assignee_id is null then raise exception 'TASK_NOT_RELEASABLE'; end if;
  select * into operation from techunter.task_operations where task_id=p_task_id and completed_at is null for update;
  is_admin := exists(select 1 from techunter.users where id=p_actor_id and role='admin');
  if target.assignee_id is distinct from p_actor_id and not
    (is_admin and coalesce(operation.kind in ('claim','release'),false)) then raise exception 'FORBIDDEN'; end if;
  if operation.kind='release' then return operation.id; end if;
  if operation.id is not null then
    if operation.kind<>'claim' or operation.lease_until>clock_timestamp() then raise exception 'OPERATION_IN_PROGRESS'; end if;
  end if;
  if exists(select 1 from techunter.tasks where parent_task_id=p_task_id and status not in ('accepted','cancelled')) then raise exception 'OPEN_CHILD_TASKS'; end if;
  if operation.id is not null then
    update techunter.task_operations set completed_at=now(),lease_token=null,lease_until=null,
      payload=payload || jsonb_build_object('disposition','release_requested','requestedBy',p_actor_id) where id=operation.id;
  end if;
  operation_id := gen_random_uuid();
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload)
    values(operation_id,p_task_id,'release',target.assignee_id,jsonb_build_object('requestedBy',p_actor_id));
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'task.release_requested','task',p_task_id::text,
      jsonb_build_object('claimOperationId',operation.id,'assigneeId',target.assignee_id));
  return operation_id;
end;
$$;

-- A late finish must not report success for a claim that was superseded by release.
create or replace function techunter.finish_task_claim(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.payload->>'disposition'='release_requested' then raise exception 'OPERATION_LEASE_LOST'; end if;
  if operation.completed_at is not null then return; end if;
  if p_token is null or operation.kind is distinct from 'claim' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
end;
$$;

-- Draft deletion uses the publication lock order and rechecks ownership, remote
-- publication, children and pending operations inside the same transaction.
create function techunter.delete_task_draft(p_task_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype;
begin
  perform 1 from techunter.projects where id=(select project_id from techunter.tasks where id=p_task_id) for update;
  perform 1 from techunter.tasks where id=(select parent_task_id from techunter.tasks where id=p_task_id) for update;
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if target.publisher_id is distinct from p_actor_id and not
    exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  if target.status<>'draft' or target.github_issue_number is not null or target.github_issue_url is not null then raise exception 'TASK_NOT_REMOVABLE'; end if;
  if exists(select 1 from techunter.task_operations where task_id=p_task_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id=p_task_id or root_task_id=p_task_id) then raise exception 'OPEN_CHILD_TASKS'; end if;
  delete from techunter.tasks where id=p_task_id;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'task.draft_deleted','task',p_task_id::text,
      jsonb_build_object('projectId',target.project_id,'title',target.title,'parentTaskId',target.parent_task_id));
end;
$$;

revoke all on function techunter.delete_task_draft(uuid,uuid) from public,anon,authenticated;
grant execute on function techunter.delete_task_draft(uuid,uuid) to service_role;
-- CREATE OR REPLACE preserves the existing service-only privileges of the other functions.

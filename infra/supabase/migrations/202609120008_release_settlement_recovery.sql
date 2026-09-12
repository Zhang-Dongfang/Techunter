-- Pin historical settlement evidence independently of later deliveries/claims.
alter table techunter.tasks add column settlement_submission_id uuid references techunter.submissions(id);

create function techunter.abort_task_release(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'release' or operation.completed_at is not null
    or operation.lease_token is distinct from p_token or operation.lease_until<=clock_timestamp() then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now(),payload=payload || '{"reason":"pull_already_merged"}'::jsonb where id=p_id;
end;
$$;

create or replace function techunter.begin_merged_task_review(p_submission_id uuid,p_actor_id uuid,p_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; submission techunter.submissions%rowtype; operation_id uuid:=gen_random_uuid();
begin
  if not exists(select 1 from techunter.users where id=p_actor_id and role in ('admin','maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_submission_id for update of t;
  select * into submission from techunter.submissions where id=p_submission_id for update;
  if target.assignee_id=p_actor_id or submission.author_id=p_actor_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if submission.id is null or target.status not in ('open','active') or submission.status<>'changes_requested'
    or submission.review_json->>'verdict' is distinct from 'approved' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if target.lock_version is distinct from p_version then raise exception 'TASK_VERSION_CONFLICT'; end if;
  if exists(select 1 from techunter.task_operations where task_id=target.id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id=target.id and status not in ('accepted','cancelled')) then raise exception 'OPEN_CHILD_TASKS'; end if;
  -- The API verifies an already-merged PR and the saved tree before changing a
  -- different owner's assignment. Never settle a historical delivery to a new claimant.
  if target.assignee_id is distinct from submission.author_id then
    update techunter.claims set released_at=coalesce(released_at,now()) where task_id=target.id and released_at is null;
  end if;
  update techunter.submissions set status='approved',review_action='accept' where id=p_submission_id;
  update techunter.tasks set status='submitted',assignee_id=submission.author_id,settlement_submission_id=p_submission_id,
    lock_version=lock_version+1 where id=target.id;
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(operation_id,target.id,'accept',p_actor_id,
    jsonb_build_object('submissionId',p_submission_id,'phase','merged','mergedOnly',true));
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'submission.merged_recovery_started','submission',p_submission_id::text,
      jsonb_build_object('taskId',target.id,'previousAssigneeId',target.assignee_id,'authorId',submission.author_id));
  return operation_id;
end;
$$;

-- A retry uses the pinned historical submission, even if newer deliveries exist.
create or replace function techunter.begin_task_review(p_submission_id uuid,p_actor_id uuid,p_action text,p_reason text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation_id uuid;
begin
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_submission_id for update of t;
  if target.settlement_submission_id=p_submission_id then
    if not exists(select 1 from techunter.users where id=p_actor_id and role in ('admin','maintainer')) then raise exception 'FORBIDDEN'; end if;
    if target.assignee_id=p_actor_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
    if p_action is distinct from 'accept' then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
    if target.status='accepted' then return null; end if;
    select id into operation_id from techunter.task_operations where task_id=target.id and kind='accept'
      and payload->>'submissionId'=p_submission_id::text and completed_at is null;
    if operation_id is null then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  else
    operation_id:=techunter.begin_task_review_before_role_sources(p_submission_id,p_actor_id,p_action,p_reason);
  end if;
  perform techunter.adopt_revoked_task_operation(operation_id,p_actor_id);
  return operation_id;
end;
$$;

revoke all on function techunter.abort_task_release(uuid,uuid) from public,anon,authenticated;
grant execute on function techunter.abort_task_release(uuid,uuid) to service_role;


create or replace function techunter.accept_task(p_submission_id uuid, p_reviewer_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  submission techunter.submissions%rowtype;
  payout bigint;
  source_id uuid;
  destination_id uuid;
begin
  if not exists(select 1 from techunter.users where id = p_reviewer_id and role in ('admin', 'maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id = t.id
    where s.id = p_submission_id for update of t;
  select * into submission from techunter.submissions where id = p_submission_id for update;
  if submission.id is null or submission.status <> 'approved' then raise exception 'SUBMISSION_NOT_APPROVED'; end if;
  if submission.id is distinct from coalesce(target.settlement_submission_id, (select id from techunter.submissions where task_id = target.id order by created_at desc, id desc limit 1)) or target.assignee_id is distinct from submission.author_id then
    raise exception 'SUBMISSION_STATE_CONFLICT';
  end if;
  if target.assignee_id = p_reviewer_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if target.status = 'accepted' then return target.id; end if;
  if target.status <> 'submitted' then raise exception 'TASK_NOT_SUBMITTED'; end if;
  if submission.review_action is distinct from 'accept' then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id = target.id and status not in ('accepted', 'cancelled')) then
    raise exception 'OPEN_CHILD_TASKS';
  end if;
  -- Deduct actual payments at every depth, including descendants of cancelled
  -- tasks. This also avoids paying those descendants again at an ancestor.
  payout := greatest(0, target.reward_points - techunter.descendant_settlement_points(target.id));
  if payout > 0 then
    select id into source_id from techunter.point_accounts where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'reserved';
    select id into destination_id from techunter.point_accounts where owner_type = 'user' and owner_id = target.assignee_id::text and bucket = 'available';
    perform techunter.post_transfer('task:' || target.id || ':settle', 'task_settlement', payout, source_id, destination_id, target.id, '任务验收：' || target.title, false);
  end if;
  update techunter.tasks set status = 'accepted', reviewer_id = p_reviewer_id, lock_version = lock_version + 1 where id = target.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values(p_reviewer_id, 'task.accepted', 'task', target.id::text, jsonb_build_object('submissionId', submission.id, 'payout', payout));
  return target.id;
end;
$$;

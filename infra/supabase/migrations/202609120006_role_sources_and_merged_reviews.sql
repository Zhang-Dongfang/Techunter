-- Keep locally granted roles separate from the current Conexus administrator flag.
-- Legacy connected admins have no grant provenance: treat that elevation as
-- Conexus-derived. Explicit local grants can be recorded in local_role by an operator.
alter table techunter.users add column local_role techunter.user_role not null default 'member';
alter table techunter.users add column conexus_admin boolean not null default false;
update techunter.users set
  local_role=case when conexus_user_id is not null and role='admin' then 'member'::techunter.user_role else role end,
  conexus_admin=(conexus_user_id is not null and role='admin');

create function techunter.derive_user_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Preserve explicit legacy SQL grants through role; local_role is the preferred
  -- way to change local authority, including while Conexus currently grants admin.
  if tg_op='INSERT' then
    if not new.conexus_admin and new.local_role='member' then new.local_role:=new.role; end if;
  elsif new.role is distinct from old.role and new.local_role=old.local_role
    and new.conexus_admin=old.conexus_admin then
    new.local_role:=new.role;
  end if;
  new.role:=case when new.conexus_admin then 'admin'::techunter.user_role else new.local_role end;
  return new;
end;
$$;
create trigger users_derive_role before insert or update on techunter.users
  for each row execute function techunter.derive_user_role();

create or replace function techunter.upsert_conexus_user(p_id uuid,p_email text,p_name text,p_admin boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result techunter.users%rowtype; candidate text := 'hunter-' || replace(p_id::text, '-', '');
begin
  loop
    begin
      insert into techunter.users(conexus_user_id,login,name,email,local_role,conexus_admin)
        values(p_id,candidate,coalesce(nullif(p_name,''),split_part(p_email,'@',1)),p_email,'member',coalesce(p_admin,false))
      on conflict(conexus_user_id) do update set
        name=coalesce(nullif(p_name,''),techunter.users.name),email=p_email,conexus_admin=coalesce(p_admin,false)
      returning * into result;
      return to_jsonb(result);
    exception when unique_violation then
      candidate := 'hunter-' || gen_random_uuid()::text;
    end;
  end loop;
end;
$$;

revoke all on function techunter.derive_user_role() from public,anon,authenticated;
grant execute on function techunter.derive_user_role() to service_role;

-- Finding an externally merged PR must leave the approved submission available
-- for acceptance. Transport errors keep the existing request_changes operation.
create function techunter.abort_task_changes(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'request_changes' or operation.completed_at is not null
    or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now(),payload=payload || '{"phase":"pull_already_merged"}'::jsonb where id=p_id;
  update techunter.submissions set review_action=null where id=(operation.payload->>'submissionId')::uuid
    and status='approved' and review_action='request_changes';
end;
$$;

-- The API verifies that GitHub has already merged this exact PR before invoking
-- recovery. Settlement still requires the saved review tree and scope checks.
create function techunter.begin_merged_task_review(p_submission_id uuid,p_actor_id uuid,p_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; submission techunter.submissions%rowtype; operation_id uuid:=gen_random_uuid();
begin
  if not exists(select 1 from techunter.users where id=p_actor_id and role in ('admin','maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id=t.id where s.id=p_submission_id for update of t;
  select * into submission from techunter.submissions where id=p_submission_id for update;
  if target.assignee_id=p_actor_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if submission.id is null or target.status<>'active' or submission.status<>'changes_requested'
    or submission.review_json->>'verdict' is distinct from 'approved'
    or target.assignee_id is distinct from submission.author_id
    or submission.id is distinct from (select id from techunter.submissions where task_id=target.id order by created_at desc,id desc limit 1)
    then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if target.lock_version is distinct from p_version then raise exception 'TASK_VERSION_CONFLICT'; end if;
  if exists(select 1 from techunter.task_operations where task_id=target.id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id=target.id and status not in ('accepted','cancelled')) then raise exception 'OPEN_CHILD_TASKS'; end if;
  update techunter.submissions set status='approved',review_action='accept' where id=p_submission_id;
  update techunter.tasks set status='submitted',lock_version=lock_version+1 where id=target.id;
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(operation_id,target.id,'accept',p_actor_id,
    jsonb_build_object('submissionId',p_submission_id,'phase','merged','mergedOnly',true));
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'submission.merged_recovery_started','submission',p_submission_id::text,jsonb_build_object('taskId',target.id));
  return operation_id;
end;
$$;

revoke all on function techunter.abort_task_changes(uuid,uuid) from public,anon,authenticated;
revoke all on function techunter.begin_merged_task_review(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function techunter.abort_task_changes(uuid,uuid) to service_role;
grant execute on function techunter.begin_merged_task_review(uuid,uuid,integer) to service_role;

-- A revoked administrator must not strand an already durable review/cancellation.
-- Only a currently authorized caller may adopt an idle operation; decision,
-- evidence, merge phase and original actor remain recorded.
create function techunter.adopt_revoked_task_operation(p_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  if p_id is null then return; end if;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null or operation.actor_id=p_actor_id then return; end if;
  if operation.kind not in ('accept','request_changes','cancel') then raise exception 'FORBIDDEN'; end if;
  if not exists(select 1 from techunter.users where id=p_actor_id and
    (role='admin' or (operation.kind<>'cancel' and role='maintainer'))) then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from techunter.users where id=operation.actor_id and
    (role='admin' or (operation.kind<>'cancel' and role='maintainer'))) then return; end if;
  if operation.lease_until>clock_timestamp() then raise exception 'OPERATION_IN_PROGRESS'; end if;
  update techunter.task_operations set actor_id=p_actor_id,lease_token=null,lease_until=null,
    payload=payload || jsonb_build_object('originalActorId',coalesce(payload->>'originalActorId',operation.actor_id::text)) where id=p_id;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'task.operation_adopted','task',operation.task_id::text,
      jsonb_build_object('operationId',p_id,'previousActorId',operation.actor_id));
end;
$$;
revoke all on function techunter.adopt_revoked_task_operation(uuid,uuid) from public,anon,authenticated,service_role;

alter function techunter.begin_task_review(uuid,uuid,text,text) rename to begin_task_review_before_role_sources;
revoke all on function techunter.begin_task_review_before_role_sources(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function techunter.begin_task_review(p_submission_id uuid,p_actor_id uuid,p_action text,p_reason text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare operation_id uuid;
begin
  operation_id:=techunter.begin_task_review_before_role_sources(p_submission_id,p_actor_id,p_action,p_reason);
  perform techunter.adopt_revoked_task_operation(operation_id,p_actor_id);
  return operation_id;
end;
$$;

alter function techunter.begin_task_cancel(uuid,uuid) rename to begin_task_cancel_before_role_sources;
revoke all on function techunter.begin_task_cancel_before_role_sources(uuid,uuid) from public,anon,authenticated,service_role;
create function techunter.begin_task_cancel(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare operation_id uuid;
begin
  operation_id:=techunter.begin_task_cancel_before_role_sources(p_task_id,p_actor_id);
  perform techunter.adopt_revoked_task_operation(operation_id,p_actor_id);
  return operation_id;
end;
$$;
revoke all on function techunter.begin_task_review(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function techunter.begin_task_cancel(uuid,uuid) from public,anon,authenticated;
grant execute on function techunter.begin_task_review(uuid,uuid,text,text) to service_role;
grant execute on function techunter.begin_task_cancel(uuid,uuid) to service_role;

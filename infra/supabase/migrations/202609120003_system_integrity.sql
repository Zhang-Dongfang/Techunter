-- Authoritative parent authorization also serializes child creation with submit/release.
create function techunter.guard_child_task()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent techunter.tasks%rowtype;
begin
  if new.parent_task_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.parent_task_id is not distinct from old.parent_task_id
    and not (old.status = 'draft' and new.status = 'open') then return new; end if;
  select * into parent from techunter.tasks where id = new.parent_task_id for update;
  if parent.id is null or parent.project_id <> new.project_id or parent.status <> 'active'
    or exists(select 1 from techunter.task_operations where task_id = parent.id and completed_at is null)
    then raise exception 'TASK_NOT_SUBMITTABLE'; end if;
  if parent.assignee_id is distinct from new.publisher_id
    and not exists(select 1 from techunter.users where id = new.publisher_id and role = 'admin') then raise exception 'FORBIDDEN'; end if;
  new.root_task_id := coalesce(parent.root_task_id, parent.id);
  return new;
end;
$$;
create trigger tasks_guard_child before insert or update of parent_task_id, status on techunter.tasks
  for each row execute function techunter.guard_child_task();

-- Reject stale child drafts before reserving points or creating a GitHub Issue.
alter function techunter.check_publication_budget(uuid,bigint) rename to check_publication_budget_unchecked;
revoke all on function techunter.check_publication_budget_unchecked(uuid,bigint) from public,anon,authenticated,service_role;
create function techunter.check_publication_budget(p_task_id uuid,p_reward bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; parent techunter.tasks%rowtype;
begin
  -- Match publication's project -> parent -> task lock order.
  perform 1 from techunter.projects where id=(select project_id from techunter.tasks where id=p_task_id) for update;
  select * into parent from techunter.tasks where id=(select parent_task_id from techunter.tasks where id=p_task_id) for update;
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.status='draft' and target.parent_task_id is not null then
    if parent.status is distinct from 'active' or exists(select 1 from techunter.task_operations where task_id=parent.id and completed_at is null)
      then raise exception 'TASK_NOT_SUBMITTABLE'; end if;
    if parent.assignee_id is distinct from target.publisher_id
      and not exists(select 1 from techunter.users where id=target.publisher_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  end if;
  perform techunter.check_publication_budget_unchecked(p_task_id,p_reward);
end;
$$;

-- Reimport is idempotent; initialization and allocation commit together.
create function techunter.import_project(p_repository jsonb, p_actor_id uuid, p_points bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare project_id uuid;
begin
  insert into techunter.projects(github_repository_id,name,description,repo_owner,repo_name,clone_url,html_url,
    default_branch,source_branch,visibility,head_sha,imported_by)
  values((p_repository->>'githubRepositoryId')::bigint,p_repository->>'name',p_repository->>'description',
    p_repository->>'owner',p_repository->>'name',p_repository->>'cloneUrl',p_repository->>'htmlUrl',
    p_repository->>'defaultBranch',p_repository->>'defaultBranch',(p_repository->>'visibility')::techunter.repository_visibility,
    p_repository->>'headSha',p_actor_id)
  on conflict(github_repository_id) do nothing returning id into project_id;
  if project_id is null then
    select id into project_id from techunter.projects where github_repository_id = (p_repository->>'githubRepositoryId')::bigint;
  elsif p_points > 0 then
    perform techunter.allocate_project_points(project_id, p_points);
  end if;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'project.imported','project',project_id::text,jsonb_build_object('githubRepositoryId',p_repository->'githubRepositoryId'));
  return project_id;
end;
$$;

create function techunter.upsert_conexus_user(p_id uuid, p_email text, p_name text, p_admin boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result techunter.users%rowtype; candidate text := 'hunter-' || replace(p_id::text, '-', '');
begin
  loop
    begin
      insert into techunter.users(conexus_user_id,login,name,email,role)
        values(p_id,candidate,coalesce(nullif(p_name,''),split_part(p_email,'@',1)),p_email,
          case when p_admin then 'admin'::techunter.user_role else 'member'::techunter.user_role end)
      on conflict(conexus_user_id) do update set
        name=coalesce(nullif(p_name,''),techunter.users.name),email=p_email,
        role=case when p_admin then 'admin'::techunter.user_role else techunter.users.role end
      returning * into result;
      return to_jsonb(result);
    exception when unique_violation then
      -- Also tolerate a legacy/manual login that happens to equal the generated ID.
      candidate := 'hunter-' || gen_random_uuid()::text;
    end;
  end loop;
end;
$$;

alter table techunter.task_operations drop constraint task_operations_kind_check;
alter table techunter.task_operations add constraint task_operations_kind_check check(kind in ('publish','submit','release'));
create unique index task_operations_release_pending on techunter.task_operations(task_id) where kind='release' and completed_at is null;

create or replace function techunter.guard_task_operation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from techunter.task_operations where task_id=old.id and completed_at is null and
    (kind in ('publish','release') or tg_op='DELETE' or new.status='cancelled')) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if tg_op='DELETE' then return old; end if;
  if old.status<>'draft' and (new.reward_points is distinct from old.reward_points or new.base_sha is distinct from old.base_sha or new.target_branch is distinct from old.target_branch) then raise exception 'TASK_VERSION_CONFLICT'; end if;
  return new;
end;
$$;

create function techunter.begin_task_release(p_task_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; operation_id uuid;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.status is distinct from 'active' or target.assignee_id is distinct from p_actor_id then raise exception 'TASK_NOT_RELEASABLE'; end if;
  select id into operation_id from techunter.task_operations where task_id=p_task_id and kind='release' and completed_at is null;
  if operation_id is not null then return operation_id; end if;
  if exists(select 1 from techunter.task_operations where task_id=p_task_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id=p_task_id and status not in ('accepted','cancelled')) then raise exception 'OPEN_CHILD_TASKS'; end if;
  operation_id := gen_random_uuid();
  insert into techunter.task_operations(id,task_id,kind,actor_id,payload) values(operation_id,p_task_id,'release',p_actor_id,'{}');
  return operation_id;
end;
$$;

create function techunter.finish_task_release(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.task_operations where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  if operation.completed_at is not null then return; end if;
  if p_token is null or operation.kind is distinct from 'release' or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  update techunter.task_operations set completed_at=now() where id=p_id;
  perform techunter.release_task(operation.task_id,operation.actor_id);
end;
$$;

-- Old device records must never become ready workspaces for a new claim.
create function techunter.stop_previous_workspaces()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is distinct from old.assignee_id or new.status in ('accepted','cancelled') then
    update techunter.workspaces set status='stopped' where task_id=new.id and status in ('queued','provisioning','running');
  end if;
  return new;
end;
$$;
create trigger tasks_stop_workspaces after update of assignee_id,status on techunter.tasks
  for each row execute function techunter.stop_previous_workspaces();
update techunter.workspaces w set status='stopped' from techunter.tasks t
  where w.task_id=t.id and w.status in ('queued','provisioning','running')
    and (w.user_id is distinct from t.assignee_id or t.status not in ('active','submitted'));

create function techunter.create_task_workspace(p_task_id uuid,p_user_id uuid,p_device_id text,p_device_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype; workspace_id uuid;
begin
  select * into target from techunter.tasks where id=p_task_id for update;
  if target.status is distinct from 'active' or target.scope_json is null then raise exception 'TASK_NOT_SUBMITTABLE'; end if;
  if target.assignee_id is distinct from p_user_id then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from techunter.task_operations where task_id=p_task_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  select id into workspace_id from techunter.workspaces where task_id=p_task_id and user_id=p_user_id and device_id=p_device_id
    and status in ('queued','provisioning','running') order by created_at desc limit 1;
  if workspace_id is null then
    insert into techunter.workspaces(task_id,user_id,device_id,device_label) values(p_task_id,p_user_id,p_device_id,p_device_label) returning id into workspace_id;
    insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
      values(p_user_id,'workspace.queued','workspace',workspace_id::text,jsonb_build_object('taskId',p_task_id,'deviceId',p_device_id));
  end if;
  return workspace_id;
end;
$$;

create function techunter.guard_workspace_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target techunter.tasks%rowtype;
begin
  if new.status='stopped' then return new; end if;
  select * into target from techunter.tasks where id=new.task_id for update;
  if target.assignee_id is distinct from new.user_id or target.status<>'active'
    or (tg_op='UPDATE' and old.status='stopped') then raise exception 'WORKSPACE_NOT_READY'; end if;
  return new;
end;
$$;
create trigger workspaces_guard_update before insert or update on techunter.workspaces
  for each row execute function techunter.guard_workspace_update();

-- Always take the task lock before the workspace lock, as release/settlement do.
create function techunter.update_task_workspace(p_id uuid,p_actor_id uuid,p_update jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare workspace techunter.workspaces%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.workspaces where id=p_id) for update;
  select * into workspace from techunter.workspaces where id=p_id for update;
  if workspace.user_id is distinct from p_actor_id then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from techunter.task_operations where task_id=workspace.task_id and completed_at is null) then raise exception 'OPERATION_IN_PROGRESS'; end if;
  if coalesce(p_update->>'status','') not in ('provisioning','running','failed') then raise exception 'WORKSPACE_NOT_READY'; end if;
  update techunter.workspaces set status=(p_update->>'status')::techunter.workspace_status,
    head_sha=coalesce(p_update->>'headSha',head_sha), setup_log=left(coalesce(p_update->>'setupLog',setup_log,''),100000),
    error=p_update->>'error' where id=p_id returning * into workspace;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'workspace.'||workspace.status::text,'workspace',p_id::text,jsonb_build_object('taskId',workspace.task_id,'deviceId',workspace.device_id));
  return to_jsonb(workspace);
end;
$$;

alter table techunter.submissions add column reviewed_tree_sha text;
create function techunter.record_submission_tree(p_id uuid,p_token uuid,p_tree_sha text)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'submit' or operation.completed_at is not null or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  if p_tree_sha is null or p_tree_sha !~ '^[a-f0-9]{40,64}$' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  update techunter.submissions set reviewed_tree_sha=p_tree_sha where id=p_id and (reviewed_tree_sha is null or reviewed_tree_sha=p_tree_sha);
  if not found then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
end;
$$;

do $$ declare signature text; begin
  foreach signature in array array[
    'guard_child_task()','check_publication_budget(uuid,bigint)','import_project(jsonb,uuid,bigint)','upsert_conexus_user(uuid,text,text,boolean)',
    'begin_task_release(uuid,uuid)','finish_task_release(uuid,uuid)','stop_previous_workspaces()',
    'create_task_workspace(uuid,uuid,text,text)','guard_workspace_update()','record_submission_tree(uuid,uuid,text)',
    'update_task_workspace(uuid,uuid,jsonb)'
  ] loop
    execute 'revoke all on function techunter.' || signature || ' from public, anon, authenticated';
    execute 'grant execute on function techunter.' || signature || ' to service_role';
  end loop;
end $$;

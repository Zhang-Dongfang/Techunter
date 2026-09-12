-- GitHub is a repository transport. Scope authorization remains in the control plane.
create table techunter.scope_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references techunter.tasks(id),
  requester_id uuid not null references techunter.users(id),
  scope_revision integer not null check (scope_revision > 0),
  files_json jsonb not null check (jsonb_typeof(files_json) = 'array' and jsonb_array_length(files_json) between 1 and 20),
  reason text not null,
  evidence text not null,
  alternatives text not null,
  validation_plan text not null,
  retry_of uuid references techunter.scope_requests(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'partially_approved', 'rejected', 'withdrawn', 'superseded')),
  approved_paths jsonb not null default '[]'::jsonb,
  reviewer_id uuid references techunter.users(id),
  review_reason text,
  resulting_revision integer,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index scope_requests_one_pending on techunter.scope_requests(task_id) where status = 'pending';
create unique index scope_requests_one_retry on techunter.scope_requests(retry_of)
  where retry_of is not null and status not in ('withdrawn', 'superseded');
create index scope_requests_task_created on techunter.scope_requests(task_id, created_at desc);
alter table techunter.scope_requests enable row level security;
revoke all on techunter.scope_requests from public, anon, authenticated;
grant all on techunter.scope_requests to service_role;

create function techunter.create_scope_request(
  p_task_id uuid, p_actor_id uuid, p_scope jsonb, p_parent_scope jsonb,
  p_files jsonb, p_reason text, p_evidence text, p_alternatives text,
  p_validation_plan text, p_retry_of uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  parent techunter.tasks%rowtype;
  request_id uuid;
begin
  -- Parent first, consistently with approval; compare the exact scope validated by the API.
  select * into parent from techunter.tasks
    where id = (select parent_task_id from techunter.tasks where id = p_task_id) for update;
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  if target.assignee_id is distinct from p_actor_id then raise exception 'FORBIDDEN'; end if;
  if target.status <> 'active' or target.scope_json is null then raise exception 'SCOPE_TASK_NOT_ACTIVE'; end if;
  if target.scope_json is distinct from p_scope or parent.scope_json is distinct from p_parent_scope
    then raise exception 'SCOPE_REVISION_CONFLICT'; end if;
  if target.parent_task_id is not null and (parent.scope_json is null or parent.status not in ('active', 'submitted'))
    then raise exception 'SCOPE_PARENT_UNAVAILABLE'; end if;
  if exists (select 1 from techunter.scope_requests where task_id = target.id and status = 'pending')
    then raise exception 'SCOPE_REQUEST_PENDING'; end if;
  if p_retry_of is not null and (not exists (
    select 1 from techunter.scope_requests where id = p_retry_of and task_id = target.id
      and requester_id = p_actor_id and status in ('rejected', 'partially_approved')
  ) or exists (select 1 from techunter.scope_requests where retry_of = p_retry_of and status not in ('withdrawn', 'superseded')))
    then raise exception 'SCOPE_RETRY_INVALID'; end if;
  insert into techunter.scope_requests(task_id, requester_id, scope_revision, files_json, reason, evidence, alternatives, validation_plan, retry_of)
    values (target.id, p_actor_id, (target.scope_json->>'revision')::integer, p_files,
      p_reason, p_evidence, p_alternatives, p_validation_plan, p_retry_of) returning id into request_id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values (p_actor_id, 'scope.requested', 'scope_request', request_id::text,
      jsonb_build_object('taskId', target.id, 'revision', target.scope_json->'revision', 'retryOf', p_retry_of));
  return request_id;
end;
$$;

create function techunter.decide_scope_request(
  p_task_id uuid, p_request_id uuid, p_actor_id uuid, p_scope jsonb, p_parent_scope jsonb,
  p_decision text, p_approved_paths jsonb, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  parent techunter.tasks%rowtype;
  request techunter.scope_requests%rowtype;
  next_scope jsonb;
  result_status text;
begin
  select * into parent from techunter.tasks
    where id = (select parent_task_id from techunter.tasks where id = p_task_id) for update;
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;
  select * into request from techunter.scope_requests where id = p_request_id and task_id = p_task_id for update;
  if request.id is null then raise exception 'SCOPE_REQUEST_NOT_FOUND'; end if;
  if target.assignee_id = p_actor_id or request.requester_id = p_actor_id then raise exception 'SCOPE_SELF_REVIEW'; end if;
  if target.publisher_id <> p_actor_id and not exists (select 1 from techunter.users where id = p_actor_id and role = 'admin')
    then raise exception 'FORBIDDEN'; end if;
  if request.status <> 'pending' then raise exception 'SCOPE_REQUEST_RESOLVED'; end if;
  if target.status <> 'active' or target.assignee_id is distinct from request.requester_id then raise exception 'SCOPE_TASK_NOT_ACTIVE'; end if;
  if target.scope_json is distinct from p_scope or parent.scope_json is distinct from p_parent_scope
    or request.scope_revision <> (target.scope_json->>'revision')::integer then raise exception 'SCOPE_REVISION_CONFLICT'; end if;
  if p_decision not in ('approve', 'reject') or length(trim(p_reason)) < 5 then raise exception 'SCOPE_DECISION_INVALID'; end if;
  if jsonb_typeof(p_approved_paths) <> 'array' then raise exception 'SCOPE_DECISION_INVALID'; end if;
  if p_decision = 'approve' then
    if target.parent_task_id is not null and (parent.scope_json is null or parent.status not in ('active', 'submitted'))
      then raise exception 'SCOPE_PARENT_UNAVAILABLE'; end if;
    if jsonb_array_length(p_approved_paths) = 0 or exists (
      select 1 from jsonb_array_elements_text(p_approved_paths) granted(path)
      where not exists (select 1 from jsonb_array_elements(request.files_json) requested(file) where file->>'path' = granted.path)
    ) or (select count(distinct path) from jsonb_array_elements_text(p_approved_paths) granted(path)) <> jsonb_array_length(p_approved_paths)
      then raise exception 'SCOPE_DECISION_INVALID'; end if;
    next_scope := jsonb_set(target.scope_json, '{revision}', to_jsonb(request.scope_revision + 1));
    next_scope := jsonb_set(next_scope, '{editablePaths}', (target.scope_json->'editablePaths') || p_approved_paths);
    next_scope := jsonb_set(next_scope, '{readonlyPaths}', coalesce((
      select jsonb_agg(path order by ordinal) from jsonb_array_elements_text(target.scope_json->'readonlyPaths') with ordinality paths(path, ordinal)
      where not (p_approved_paths ? path)
    ), '[]'::jsonb));
    result_status := case when jsonb_array_length(p_approved_paths) = jsonb_array_length(request.files_json) then 'approved' else 'partially_approved' end;
  else
    if jsonb_array_length(p_approved_paths) <> 0 then raise exception 'SCOPE_DECISION_INVALID'; end if;
    result_status := 'rejected';
  end if;
  update techunter.scope_requests set status = result_status, approved_paths = p_approved_paths,
    reviewer_id = p_actor_id, review_reason = p_reason, resolved_at = now(),
    resulting_revision = case when p_decision = 'approve' then request.scope_revision + 1 else null end
    where id = request.id;
  if p_decision = 'approve' then
    update techunter.tasks set scope_json = next_scope,
      analysis_json = case when analysis_json is null then null else jsonb_set(analysis_json, '{scope}', next_scope) end,
      lock_version = lock_version + 1 where id = target.id;
  end if;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values (p_actor_id, 'scope.' || result_status, 'scope_request', request.id::text,
      jsonb_build_object('taskId', target.id, 'approvedPaths', p_approved_paths,
        'reason', p_reason, 'beforeScope', target.scope_json, 'afterScope', coalesce(next_scope, target.scope_json)));
end;
$$;

create function techunter.withdraw_scope_request(p_task_id uuid, p_request_id uuid, p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare request techunter.scope_requests%rowtype;
begin
  -- Use the task lock first to serialize with lifecycle transitions and decisions.
  perform 1 from techunter.tasks where id = p_task_id for update;
  select * into request from techunter.scope_requests where id = p_request_id and task_id = p_task_id for update;
  if request.id is null then raise exception 'SCOPE_REQUEST_NOT_FOUND'; end if;
  if request.requester_id <> p_actor_id then raise exception 'FORBIDDEN'; end if;
  if request.status <> 'pending' then raise exception 'SCOPE_REQUEST_RESOLVED'; end if;
  update techunter.scope_requests set status = 'withdrawn', resolved_at = now() where id = request.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values (p_actor_id, 'scope.withdrawn', 'scope_request', request.id::text, jsonb_build_object('taskId', p_task_id));
end;
$$;

create function techunter.expire_scope_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'active' or new.assignee_id is distinct from old.assignee_id or new.scope_json is distinct from old.scope_json then
    with expired as (
      update techunter.scope_requests set status = 'superseded', resolved_at = now(),
        review_reason = '任务状态、执行者或文件范围已变化，请基于最新范围重新申请。'
        where task_id = new.id and status = 'pending' returning id
    ) insert into techunter.audit_events(action, entity_type, entity_id, payload_json)
      select 'scope.superseded', 'scope_request', id::text, jsonb_build_object('taskId', new.id) from expired;
  end if;
  return new;
end;
$$;
create trigger tasks_expire_scope_requests after update of status, assignee_id, scope_json on techunter.tasks
  for each row execute function techunter.expire_scope_requests();

revoke all on function techunter.create_scope_request(uuid, uuid, jsonb, jsonb, jsonb, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function techunter.decide_scope_request(uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text) from public, anon, authenticated;
revoke all on function techunter.withdraw_scope_request(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function techunter.expire_scope_requests() from public, anon, authenticated;
grant execute on function techunter.create_scope_request(uuid, uuid, jsonb, jsonb, jsonb, text, text, text, text, uuid) to service_role;
grant execute on function techunter.decide_scope_request(uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text) to service_role;
grant execute on function techunter.withdraw_scope_request(uuid, uuid, uuid) to service_role;

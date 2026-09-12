-- Keep the first known PR even if later GitHub synchronization fails.
create function techunter.record_submission_pull(p_id uuid,p_token uuid,p_pull_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype;
begin
  select * into operation from techunter.task_operations where id=p_id for update;
  if p_token is null or operation.kind is distinct from 'submit' or operation.completed_at is not null
    or operation.lease_token is distinct from p_token then raise exception 'OPERATION_LEASE_LOST'; end if;
  if p_pull_url is null or p_pull_url='' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  update techunter.submissions set pull_request_url=p_pull_url where id=p_id;
end;
$$;

create function techunter.begin_merged_task_review_with_pull(p_submission_id uuid,p_actor_id uuid,p_version integer,p_pull_url text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare operation_id uuid;
begin
  if p_pull_url is null or p_pull_url='' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  operation_id:=techunter.begin_merged_task_review(p_submission_id,p_actor_id,p_version);
  update techunter.submissions set pull_request_url=p_pull_url where id=p_submission_id;
  return operation_id;
end;
$$;

-- A disconnected row is retained as a generation fence, not as authorization.
alter table techunter.github_connections alter column credential drop not null;
alter table techunter.github_connections
  add column connection_version uuid not null default gen_random_uuid(),
  add column lease_token uuid,
  add column lease_until timestamptz;

create function techunter.lease_github_connection(p_user_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare connection techunter.github_connections%rowtype;
begin
  if p_token is null then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
  insert into techunter.github_connections(user_id) values(p_user_id) on conflict do nothing;
  select * into connection from techunter.github_connections where user_id=p_user_id for update;
  if connection.lease_until>clock_timestamp() and connection.lease_token is distinct from p_token then return null; end if;
  update techunter.github_connections set lease_token=p_token,lease_until=clock_timestamp()+interval '90 seconds'
    where user_id=p_user_id returning * into connection;
  return to_jsonb(connection);
end;
$$;

create function techunter.release_github_connection(p_user_id uuid,p_token uuid)
returns void language sql security definer set search_path = '' as $$
  update techunter.github_connections set lease_token=null,lease_until=null where user_id=p_user_id and lease_token=p_token;
$$;

create function techunter.renew_github_connection(p_user_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update techunter.github_connections set lease_until=clock_timestamp()+interval '90 seconds'
    where user_id=p_user_id and lease_token=p_token and lease_until>clock_timestamp();
  if not found then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
end;
$$;

create function techunter.save_github_connection(p_user_id uuid,p_token uuid,p_version uuid,p_credentials jsonb,p_identity jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare connection techunter.github_connections%rowtype;
begin
  select * into connection from techunter.github_connections where user_id=p_user_id for update;
  if p_token is null or connection.lease_token is distinct from p_token or connection.connection_version is distinct from p_version
    or connection.lease_until is null or connection.lease_until<=clock_timestamp() then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
  if p_credentials->>'credential' is null then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
  -- Refresh cannot recreate a connection cleared by disconnect.
  if p_identity is null and connection.credential is null then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
  update techunter.github_connections set credential=p_credentials->>'credential',
    access_expires_at=(p_credentials->>'access_expires_at')::timestamptz,
    refresh_credential=p_credentials->>'refresh_credential',refresh_expires_at=(p_credentials->>'refresh_expires_at')::timestamptz,
    connection_version=case when p_identity is null then connection_version else gen_random_uuid() end
    where user_id=p_user_id;
  if p_identity is not null then
    if coalesce(p_identity->>'login','')='' then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
    update techunter.users set github_login=p_identity->>'login',avatar_url=p_identity->>'avatarUrl' where id=p_user_id;
    insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
      values(p_user_id,'auth.github_connected','user',p_user_id::text,jsonb_build_object('githubLogin',p_identity->>'login'));
  end if;
end;
$$;

create function techunter.disconnect_github_connection(p_user_id uuid,p_token uuid,p_version uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update techunter.github_connections set credential=null,access_expires_at=null,refresh_credential=null,refresh_expires_at=null,
    connection_version=gen_random_uuid()
    where user_id=p_user_id and lease_token=p_token and connection_version=p_version and lease_until>clock_timestamp();
  if not found then raise exception 'GITHUB_CONNECTION_CHANGED'; end if;
  update techunter.users set github_login=null,avatar_url=null where id=p_user_id;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id)
    values(p_user_id,'auth.github_disconnected','user',p_user_id::text);
end;
$$;

-- Count in PostgreSQL, independently of PostgREST's maximum returned row count.
create function techunter.review_queue_count(p_user_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select (select count(*) from techunter.tasks t where t.status='submitted' and t.assignee_id<>p_user_id
    and exists(select 1 from techunter.submissions s where s.task_id=t.id and s.status='approved'))
    + (select count(*) from techunter.scope_requests r join techunter.tasks t on t.id=r.task_id
       where r.status='pending' and t.assignee_id<>p_user_id and (t.publisher_id=p_user_id
         or exists(select 1 from techunter.users u where u.id=p_user_id and u.role='admin')));
$$;

do $$ declare signature text; begin
  foreach signature in array array[
    'record_submission_pull(uuid,uuid,text)', 'begin_merged_task_review_with_pull(uuid,uuid,integer,text)',
    'lease_github_connection(uuid,uuid)', 'release_github_connection(uuid,uuid)', 'renew_github_connection(uuid,uuid)',
    'save_github_connection(uuid,uuid,uuid,jsonb,jsonb)', 'disconnect_github_connection(uuid,uuid,uuid)', 'review_queue_count(uuid)'
  ] loop
    execute 'revoke all on function techunter.' || signature || ' from public,anon,authenticated';
    execute 'grant execute on function techunter.' || signature || ' to service_role';
  end loop;
end $$;

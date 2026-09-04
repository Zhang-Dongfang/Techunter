create or replace function techunter.admin_remove_task(p_task_id uuid, p_actor_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target techunter.tasks%rowtype;
  source_id uuid;
  destination_id uuid;
  settled_child_points bigint := 0;
  refund_points bigint := 0;
begin
  if not exists (
    select 1 from techunter.users where id = p_actor_id and role = 'admin'
  ) then
    raise exception 'FORBIDDEN';
  end if;

  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null then raise exception 'TASK_NOT_FOUND'; end if;

  if target.status = 'accepted' then raise exception 'TASK_ALREADY_SETTLED'; end if;
  if target.status = 'cancelled' then raise exception 'TASK_ALREADY_CANCELLED'; end if;

  if target.status = 'draft' then
    if exists (
      select 1 from techunter.tasks
      where parent_task_id = target.id or root_task_id = target.id
    ) then
      raise exception 'OPEN_CHILD_TASKS';
    end if;

    delete from techunter.tasks where id = target.id and status = 'draft';
    if not found then raise exception 'TASK_NOT_REMOVABLE'; end if;

    insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values (
      p_actor_id,
      'task.draft_deleted',
      'task',
      target.id::text,
      jsonb_build_object('projectId', target.project_id, 'title', target.title)
    );
    return 'deleted';
  end if;

  if exists (
    select 1 from techunter.tasks
    where parent_task_id = target.id and status not in ('accepted', 'cancelled')
  ) then
    raise exception 'OPEN_CHILD_TASKS';
  end if;

  if target.parent_task_id is null then
    select coalesce(sum(reward_points), 0) into settled_child_points
    from techunter.tasks
    where parent_task_id = target.id and status = 'accepted';
    refund_points := greatest(0, target.reward_points - settled_child_points);

    if refund_points > 0 then
      select id into source_id from techunter.point_accounts
      where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'reserved';
      select id into destination_id from techunter.point_accounts
      where owner_type = 'project' and owner_id = target.project_id::text and bucket = 'available';
      perform techunter.post_transfer(
        'task:' || target.id || ':cancel',
        'task_refund',
        refund_points,
        source_id,
        destination_id,
        target.id,
        '取消任务：' || target.title,
        false
      );
    end if;
  end if;

  update techunter.claims
  set released_at = coalesce(released_at, now())
  where task_id = target.id and released_at is null;

  update techunter.workspaces
  set status = 'stopped', error = coalesce(error, '任务已由管理员取消。')
  where task_id = target.id and status in ('queued', 'provisioning', 'running');

  update techunter.tasks
  set status = 'cancelled', lock_version = lock_version + 1
  where id = target.id and status in ('open', 'active', 'submitted');
  if not found then raise exception 'TASK_NOT_REMOVABLE'; end if;

  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
  values (
    p_actor_id,
    'task.cancelled_by_admin',
    'task',
    target.id::text,
    jsonb_build_object(
      'projectId', target.project_id,
      'title', target.title,
      'previousStatus', target.status,
      'refundPoints', refund_points
    )
  );
  return 'cancelled';
end;
$$;

revoke all on function techunter.admin_remove_task(uuid, uuid) from public, anon, authenticated;
grant execute on function techunter.admin_remove_task(uuid, uuid) to service_role;

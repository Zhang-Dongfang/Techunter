-- Submission state changes are atomic; external GitHub work can be retried.
alter table techunter.submissions add column review_action text
  check (review_action in ('accept', 'request_changes'));

create function techunter.descendant_settlement_points(p_task_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  with recursive descendants as (
    select id from techunter.tasks where parent_task_id = p_task_id
    union
    select child.id from techunter.tasks child join descendants parent on child.parent_task_id = parent.id
  )
  select coalesce(sum(amount), 0)::bigint from techunter.point_transfers
    where type = 'task_settlement' and task_id in (select id from descendants);
$$;

create function techunter.begin_submission(
  p_task_id uuid, p_author_id uuid, p_scope jsonb, p_summary text,
  p_test_output text, p_files jsonb, p_review jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  submission_id uuid := gen_random_uuid();
begin
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null or target.status <> 'active' or target.assignee_id is distinct from p_author_id then
    raise exception 'TASK_NOT_SUBMITTABLE';
  end if;
  if target.scope_json is distinct from p_scope then raise exception 'SCOPE_REVISION_CONFLICT'; end if;
  if exists(select 1 from techunter.tasks where parent_task_id = target.id and status not in ('accepted', 'cancelled')) then
    raise exception 'OPEN_CHILD_TASKS';
  end if;
  if not exists(select 1 from techunter.workspaces where task_id = target.id and user_id = p_author_id and status = 'running') then
    raise exception 'WORKSPACE_NOT_READY';
  end if;
  insert into techunter.submissions(id, task_id, author_id, status, summary, test_output, files_json, review_json, created_at)
    values(submission_id, target.id, p_author_id, 'reviewing', p_summary, p_test_output, p_files, p_review, clock_timestamp());
  update techunter.tasks set status = 'submitted', lock_version = lock_version + 1 where id = target.id;
  return submission_id;
end;
$$;

create function techunter.finish_submission(p_submission_id uuid, p_succeeded boolean, p_pull_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  submission techunter.submissions%rowtype;
  next_status techunter.submission_status;
begin
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id = t.id
    where s.id = p_submission_id for update of t;
  select * into submission from techunter.submissions where id = p_submission_id for update;
  if target.id is null or submission.id is null or target.status <> 'submitted' or submission.status <> 'reviewing' or
    submission.id is distinct from (select id from techunter.submissions where task_id = target.id order by created_at desc, id desc limit 1) then
    raise exception 'SUBMISSION_STATE_CONFLICT';
  end if;
  next_status := case when p_succeeded and submission.review_json->>'verdict' = 'approved'
    then 'approved'::techunter.submission_status else 'changes_requested'::techunter.submission_status end;
  update techunter.submissions set status = next_status, pull_request_url = p_pull_url where id = submission.id;
  if next_status = 'changes_requested' then
    update techunter.tasks set status = 'active', lock_version = lock_version + 1 where id = target.id;
  end if;
end;
$$;

-- Reserve a review decision before calling GitHub. The opposite decision cannot
-- race a merge, and an uncertain external outcome must resume the same action.
create function techunter.start_submission_review(p_submission_id uuid, p_reviewer_id uuid, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  submission techunter.submissions%rowtype;
begin
  if p_action is null or p_action not in ('accept', 'request_changes') then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if not exists(select 1 from techunter.users where id = p_reviewer_id and role in ('admin', 'maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id = t.id
    where s.id = p_submission_id for update of t;
  select * into submission from techunter.submissions where id = p_submission_id for update;
  if target.assignee_id = p_reviewer_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if submission.id is null or submission.id is distinct from
    (select id from techunter.submissions where task_id = target.id order by created_at desc, id desc limit 1) then
    raise exception 'SUBMISSION_STATE_CONFLICT';
  end if;
  if p_action = 'accept' and target.status = 'accepted' and submission.status = 'approved' then return; end if;
  if target.status <> 'submitted' or submission.status <> 'approved' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if submission.review_action is not null and submission.review_action <> p_action then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  update techunter.submissions set review_action = p_action where id = submission.id;
end;
$$;

create function techunter.request_submission_changes(p_submission_id uuid, p_reviewer_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target techunter.tasks%rowtype;
  submission techunter.submissions%rowtype;
begin
  if not exists(select 1 from techunter.users where id = p_reviewer_id and role in ('admin', 'maintainer')) then raise exception 'FORBIDDEN'; end if;
  select t.* into target from techunter.tasks t join techunter.submissions s on s.task_id = t.id
    where s.id = p_submission_id for update of t;
  select * into submission from techunter.submissions where id = p_submission_id for update;
  if target.assignee_id = p_reviewer_id then raise exception 'SELF_REVIEW_FORBIDDEN'; end if;
  if submission.id is null or submission.id is distinct from
    (select id from techunter.submissions where task_id = target.id order by created_at desc, id desc limit 1) then
    raise exception 'SUBMISSION_STATE_CONFLICT';
  end if;
  if submission.review_action is distinct from 'request_changes' then raise exception 'REVIEW_ACTION_CONFLICT'; end if;
  if target.status = 'active' and submission.status = 'changes_requested' then return; end if;
  if target.status <> 'submitted' or submission.status <> 'approved' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  update techunter.submissions set status = 'changes_requested' where id = submission.id;
  update techunter.tasks set status = 'active', lock_version = lock_version + 1 where id = target.id;
  insert into techunter.audit_events(actor_id, action, entity_type, entity_id, payload_json)
    values(p_reviewer_id, 'submission.changes_requested', 'submission', submission.id::text, jsonb_build_object('reason', p_reason));
end;
$$;

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
  if submission.id is distinct from (select id from techunter.submissions where task_id = target.id order by created_at desc, id desc limit 1) then
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

revoke all on function techunter.descendant_settlement_points(uuid) from public, anon, authenticated;
revoke all on function techunter.begin_submission(uuid, uuid, jsonb, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function techunter.finish_submission(uuid, boolean, text) from public, anon, authenticated;
revoke all on function techunter.start_submission_review(uuid, uuid, text) from public, anon, authenticated;
revoke all on function techunter.request_submission_changes(uuid, uuid, text) from public, anon, authenticated;
grant execute on function techunter.descendant_settlement_points(uuid) to service_role;
grant execute on function techunter.begin_submission(uuid, uuid, jsonb, text, text, jsonb, jsonb) to service_role;
grant execute on function techunter.finish_submission(uuid, boolean, text) to service_role;
grant execute on function techunter.start_submission_review(uuid, uuid, text) to service_role;
grant execute on function techunter.request_submission_changes(uuid, uuid, text) to service_role;

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
  parent techunter.tasks%rowtype;
  parent_reward bigint;
  allocated bigint;
  source_id uuid;
  destination_id uuid;
begin
  select * into parent from techunter.tasks where id = (select parent_task_id from techunter.tasks where id = p_task_id) for update;
  select * into target from techunter.tasks where id = p_task_id for update;
  if target.id is null or target.status <> 'draft' or target.scope_json is null then raise exception 'TASK_NOT_PUBLISHABLE'; end if;
  if target.publisher_id <> p_actor_id and not exists(select 1 from techunter.users where id = p_actor_id and role = 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  if p_reward <= 0 then raise exception 'INVALID_REWARD'; end if;
  if target.parent_task_id is not null then
    if parent.status <> 'active' then raise exception 'TASK_NOT_SUBMITTABLE'; end if;
    parent_reward := parent.reward_points;
    select coalesce(sum(case when status = 'cancelled' then techunter.descendant_settlement_points(id) else reward_points end), 0)
      into allocated from techunter.tasks where parent_task_id = target.parent_task_id and id <> target.id and status <> 'draft';
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
    settled_child_points := techunter.descendant_settlement_points(target.id);
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

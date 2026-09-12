-- Withdrawal is a durable intent on the existing submission operation. A retry
-- must close/reconcile PRs, never resume publishing a package being withdrawn.
create function techunter.mark_submission_withdrawal(p_id uuid,p_actor_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype; submission techunter.submissions%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.submissions where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  select * into submission from techunter.submissions where id=p_id for update;
  if submission.author_id is distinct from p_actor_id and not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  if p_token is null or operation.kind is distinct from 'submit' or operation.completed_at is not null
    or operation.lease_token is distinct from p_token or operation.lease_until is null or operation.lease_until<=clock_timestamp() then raise exception 'OPERATION_LEASE_LOST'; end if;
  if submission.status is distinct from 'reviewing' then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if operation.payload->>'withdrawRequested'='true' then return; end if;
  update techunter.task_operations set payload=payload || '{"withdrawRequested":true}'::jsonb where id=p_id;
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id)
    values(p_actor_id,'submission.withdrawal_requested','submission',p_id::text);
end;
$$;

create function techunter.finish_submission_withdrawal(p_id uuid,p_actor_id uuid,p_token uuid,p_pull_url text,p_merged boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare operation techunter.task_operations%rowtype; submission techunter.submissions%rowtype;
begin
  perform 1 from techunter.tasks where id=(select task_id from techunter.submissions where id=p_id) for update;
  select * into operation from techunter.task_operations where id=p_id for update;
  select * into submission from techunter.submissions where id=p_id for update;
  if submission.author_id is distinct from p_actor_id and not exists(select 1 from techunter.users where id=p_actor_id and role='admin') then raise exception 'FORBIDDEN'; end if;
  if p_token is null or operation.kind is distinct from 'submit' or operation.completed_at is not null
    or operation.lease_token is distinct from p_token or operation.lease_until is null or operation.lease_until<=clock_timestamp() then raise exception 'OPERATION_LEASE_LOST'; end if;
  if operation.payload->>'withdrawRequested' is distinct from 'true' or p_merged is null then raise exception 'SUBMISSION_STATE_CONFLICT'; end if;
  if p_merged and (submission.review_json->>'verdict' is distinct from 'approved'
    or submission.reviewed_tree_sha is null or coalesce(p_pull_url,'')='') then raise exception 'SUBMISSION_NOT_APPROVED'; end if;
  -- The API has verified GitHub. No refunds, branch rewrites or assignment changes.
  perform techunter.finish_submission_operation(p_id,p_token,coalesce(p_pull_url,submission.pull_request_url),p_merged);
  insert into techunter.audit_events(actor_id,action,entity_type,entity_id,payload_json)
    values(p_actor_id,'submission.withdrawal_completed','submission',p_id::text,jsonb_build_object('merged',p_merged));
end;
$$;

revoke all on function techunter.mark_submission_withdrawal(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function techunter.finish_submission_withdrawal(uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function techunter.mark_submission_withdrawal(uuid,uuid,uuid) to service_role;
grant execute on function techunter.finish_submission_withdrawal(uuid,uuid,uuid,text,boolean) to service_role;

# Techunter Supabase

Techunter uses the existing Supabase project as its shared control-plane database, but owns the isolated `techunter` schema.

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Add `techunter` to **Project Settings → API → Exposed schemas**. The migration grants the schema only to `service_role`; `anon` and `authenticated` receive no table access. All browser and desktop traffic must go through the Railway `techunter-api` service.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the desktop or Web environment.

The current release requires all migrations in filename order, ending with [`202609120009_submission_withdrawal.sql`](migrations/202609120009_submission_withdrawal.sql). Stop old API writes (including authentication), apply the migration, replace API processes, and update Desktop. Submissions require the UUID `workspaceId` of the current user's running workspace; old clients must be upgraded.

Migration 009 adds durable submission withdrawal without changing existing rows or ledger entries. Authors and admins can use **撤回交付** (`POST /api/submissions/:id/withdraw`) for an interrupted reviewing submission. The intent is recorded under the submission's existing lease; both withdrawal and ordinary resume requests then continue closing/reconciling delivery PRs. Read/close failures retain the operation. Unmerged PRs are closed before returning the task to active; the assignee, branch contents, saved evidence and reserved points remain intact. A merged PR matching the approved saved tree and scope is restored for normal acceptance and original-author settlement. Missing or mismatched evidence stays protected from cancellation/refund. Do not run an older API concurrently because it cannot interpret withdrawal intent.

GitHub token refresh is now requested only by operations that use GitHub. A refresh outage does not prevent Dashboard, account reads or Conexus renewal; existing connection leases still serialize refresh/connect/disconnect. OAuth authorization now requests `workflow` so workflow changes can be delivered. Existing OAuth connections need **重新连接 GitHub** to add that scope; GitHub App installations instead need the corresponding Workflows write permission. The Desktop waits for a changed connection generation when reconnecting, rather than mistaking the old connection for success.

Migration 008 pins historical settlement to `tasks.settlement_submission_id`. Release closes delivery PRs before returning the task to the market, checks for merges before and after writes, and aborts the release if a merge won. Transport failures retain the release operation for retry. The working branch and its accepted child work remain intact.

For old released/reassigned tasks, the updated Desktop lists eligible historical deliveries under **核对合并并恢复验收**. Recovery requires an open/active task without another pending operation or unfinished child tasks, an approved original review, and an already merged PR matching its saved tree and current scope. Restoring a different author requires saved tree evidence; verification happens before reassignment. The transaction restores the original author, stops the replaced claimant's workspaces, closes their active claim, pins the selected submission even if newer deliveries exist, and records the previous assignee in the audit. Subsequent retries reuse that evidence and the existing settlement idempotency key. The original author and current claimant cannot review the delivery themselves. If a newer delivery is submitted, first resolve its review; historical recovery never discards a pending operation.

Migration alone does not change assignments or move points. It does not reopen accepted/cancelled tasks or reverse historical refunds. Those records still require GitHub and ledger reconciliation. Do not run an old API concurrently: it cannot interpret pinned historical settlement evidence.

Migration 007 preserves the first known submission PR before later Issue synchronization, and supports recovering merged PRs even after their head branches were deleted. Cancellation checks historical PRs associated with the task branch, including when the stored PR URL is missing. Retry **恢复提交** for reviewing submissions, or **核对合并并恢复验收** for an active task's latest changes-requested submission with an approved original review. Recovery validates the saved tree and scope and never initiates a new merge through the latter route. Mismatched evidence or unavailable GitHub history keeps the operation blocked from refunds until reconciled.

Already cancelled/refunded historical tasks are not automatically reopened or charged again. Inspect these candidates against GitHub and the actual ledger before deciding any corrective transfer:

```sql
select t.id,t.working_branch,s.id as submission_id,s.pull_request_url,s.reviewed_tree_sha,p.repo_owner,p.repo_name
from techunter.tasks t join techunter.projects p on p.id=t.project_id
join lateral (select * from techunter.submissions where task_id=t.id order by created_at desc,id desc limit 1) s on true
where t.status='cancelled' and s.review_json->>'verdict'='approved';
```

GitHub connections retain a row with empty credentials after disconnect, so an older browser callback cannot recreate the connection. Existing encrypted credentials survive migration. Refresh, connect and disconnect use a renewable 90-second database lease; concurrent requests wait up to 35 seconds, then return a retryable busy error. A crashed instance releases its lease by expiry. If GitHub consumed a refresh token but the new token was lost before persistence, the user may need to reconnect; stale results cannot overwrite a disconnected/rebound generation. Do not run the old API concurrently, because its direct upsert/delete paths do not implement these fences. Browser authorization pages opened before upgrading must be restarted; existing Techunter sessions remain valid.

Task and project lists use ascending immutable-ID cursors within the API; display ordering is applied after reading. Related users/projects are also paginated, including when the configured row limit is below 100. Updating a task's timestamp during traversal no longer moves it past an offset. These requests are not a transaction-wide snapshot of all concurrent status changes. Desktop retains the complete-list contract, and `review_queue_count` aggregates review counts in PostgreSQL independently of PostgREST's row limit.

Migration 006 separates `users.local_role` from `users.conexus_admin`; `role` is the effective role maintained by a trigger. Successful Conexus login/authorization refresh updates the Conexus flag in either direction. A locally granted maintainer/admin role survives Conexus demotion. This is synchronization at login/refresh, not a new upstream revocation webhook.

Historical connected admins have no recorded grant provenance. The migration keeps their current effective admin role but treats its source as Conexus, with `local_role='member'`. Existing maintainers and admins without a Conexus ID retain their local role. Before resuming API traffic, inspect the following rows; for accounts that have an independently granted local admin role, explicitly set `local_role='admin'` for their verified ID. Do not blanket-convert all inherited admins into permanent local admins, which would retain the original demotion defect.

```sql
select id, login, conexus_user_id, role, local_role, conexus_admin
from techunter.users where conexus_admin;
-- Only for a verified independent local grant:
-- update techunter.users set local_role='admin' where id='<verified-user-uuid>';
```

Changes requests check the PR before and after GitHub Issue synchronization. A merged PR leaves the approved submission available for acceptance. Migration 008 extends the earlier latest-delivery recovery to released/reassigned tasks and older eligible submissions as described above. A mismatch or missing evidence never authorizes a refund or payment to a replacement claimant.

After an operation's original reviewer is demoted, an authorized reviewer (or admin for cancellation) may adopt it once its lease is released or expired. The original actor, chosen action and merge phase remain recorded; a live lease cannot be taken over. New helper functions remain unavailable to browser database roles.

New claims check the caller's GitHub repository write permission before occupying a task. Existing pending claims can be resumed by their assignee or an administrator using **恢复认领**; administrator recovery preserves the original assignee. Either may choose **撤销认领** (`POST /api/tasks/:id/release`) after the current request releases its lease or the 90-second crash lease expires. This creates a separate durable release operation and keeps the task occupied until GitHub synchronization succeeds. If the original user no longer has permission, an administrator with repository write access can use **恢复释放**. Branch history and the reserved reward are preserved. Do not clear pending operations directly in the database to bypass an uncertain external result.

Draft authors can delete their own unpublished drafts, including child drafts, through **删除草稿** (`DELETE /api/tasks/:id`). A pending publication must first be withdrawn; deleting published tasks still requires an administrator and follows the existing cancellation/refund workflow. Draft deletion checks ownership, children and pending operations in the same transaction as deletion. The shared Agent also preserves concrete new-file paths authorized by the parent scope, even when they do not exist in the frozen checkout yet.

Claims, acceptance, changes requests, cancellation, publication, submission, and release share one pending operation per task. Retry the same action in Desktop after a failed request; process-crash leases expire within 90 seconds. Cancellation cannot refund a task with pending acceptance. Confirmed merge rejection clears the acceptance intent and permits changes requests; transport failures retain it until acceptance can reconcile the result. A merged PR also prevents cancellation, even when merged outside Techunter. Recovery never needs stored GitHub or model credentials.

Tasks keep an immutable `working_branch` across release and reassignment. Migration preserves existing branches by using a child's integration target or the latest claim's GitHub login. Before upgrading, reconcile any historical parent whose non-cancelled children target different branches; the migration raises `TASK_BRANCH_RECONCILIATION_REQUIRED` rather than silently choosing and losing work. You can identify these records with:

```sql
select parent_task_id, array_agg(distinct target_branch) as targets
from techunter.tasks
where parent_task_id is not null and status <> 'cancelled'
group by parent_task_id having count(distinct target_branch) > 1;
```

The migration does not rewrite Git history or restore externally deleted branches. If an old review already has an uncertain merge outcome, retry acceptance; an externally changed or missing review snapshot may require reconciliation of the actual PR and saved evidence before settlement. Do not clear review intent or refund such tasks merely because a request timed out.

Failed workspaces are stopped along with running ones when a claim ends. Desktop chooses its own device's workspace; the API revalidates that exact workspace after model review. The previous `202609120003_system_integrity.sql` migration also enforces parent-assignee/admin authorization, atomic imports, and atomic Conexus user initialization.

Release now keeps a durable operation and the current claim until GitHub synchronization succeeds. Retry **释放任务** after a failed request (or `POST /api/tasks/:id/release`); a crashed process's lease expires within 90 seconds. Delivery packages preserve bytes and Git executable modes. New submissions persist the reviewed Git tree, and acceptance rejects any PR whose tree changed after review, even when the new edits remain in scope. Ask for changes and submit again to review a new snapshot. Approved submissions predating this migration are checked by reconstructing their saved package using the previous publisher's file-mode rules; they cannot bypass snapshot verification.

Webhooks remain an audit feed. Direct Issue/PR edits do not perform central settlement; use Desktop and the API-backed workflow for task actions.

The scope reconsideration feature requires `migrations/202609080001_scope_requests.sql` before deploying the updated API. It adds service-only request history, atomic approval/withdrawal functions, and invalidation on task lifecycle changes. See [the feature design](../../docs/scope-reconsideration.md) for the GitHub transport boundary and API contract.

The submission recovery fixes require `migrations/202609120001_submission_recovery.sql` **before deploying the updated API**. The migration adds atomic submission/review transitions and calculates task payouts and cancellation refunds from actual descendant ledger payments at every task depth. It preserves existing ledger entries; it does not retroactively debit users who were overpaid by an older version.

The next migration, `migrations/202609120002_durable_task_operations.sql`, is required **before deploying this API and Desktop update**. It adds publication budget holds, optimistic analysis writes, and durable operations with renewable 90-second leases. Operation payloads contain delivery evidence but never GitHub or model credentials. Desktop submissions now include the remote head synchronized by the workspace; older Desktop clients must be updated before submitting.

Model failures leave tasks active. GitHub or database transport failures preserve the submission package and its completed model review. Use **恢复提交** in the updated Desktop (or `POST /api/submissions/:id/resume`) to continue after reconnecting. A crashed process's lease expires within 90 seconds. Recovery uses saved evidence without consuming a new model authorization. The GitHub adapter reuses the submitted tree and existing PR, rather than overwriting a changed remote head. Legacy reviewing submissions are also recoverable when the remote still matches their frozen base or saved package; a conflicting head or missing review returns the task to active for a fresh delivery.

Pending publications can be resumed through **恢复发布**. The requested reward remains fixed and its budget is held across restarts. **撤回发布** closes any matching GitHub Issue before releasing the hold and allowing draft edits. Issue creation responses lost in transit are reconciled by the persisted task marker. After the Issue exists, the original atomic publication function records the ledger reservation exactly once.

Once a human review starts, retry the same review action after an external-service failure: acceptance resumes an already merged PR and settles at most once; an opposite review action is blocked while the original action is pending. Historical overpayments still require a separate ledger reconciliation; these migrations do not invent corrective transfers. Roll out the migration first, replace the API processes, then update Desktop; do not run the old API against live task writes during the rollout.

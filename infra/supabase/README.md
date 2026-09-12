# Techunter Supabase

Techunter uses the existing Supabase project as its shared control-plane database, but owns the isolated `techunter` schema.

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Add `techunter` to **Project Settings → API → Exposed schemas**. The migration grants the schema only to `service_role`; `anon` and `authenticated` receive no table access. All browser and desktop traffic must go through the Railway `techunter-api` service.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the desktop or Web environment.

The current release requires all migrations in filename order, ending with [`202609120005_claim_recovery_and_drafts.sql`](migrations/202609120005_claim_recovery_and_drafts.sql). Stop old API task writes, apply the migration, replace API processes, and update Desktop. Submissions require the UUID `workspaceId` of the current user's running workspace; old clients must be upgraded.

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

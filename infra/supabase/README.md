# Techunter Supabase

Techunter uses the existing Supabase project as its shared control-plane database, but owns the isolated `techunter` schema.

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Add `techunter` to **Project Settings → API → Exposed schemas**. The migration grants the schema only to `service_role`; `anon` and `authenticated` receive no table access. All browser and desktop traffic must go through the Railway `techunter-api` service.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the desktop or Web environment.

The latest system integrity fixes require `migrations/202609120003_system_integrity.sql` after all earlier migrations. Stop old API task writes, apply the migration, replace API processes, and update Desktop and CLI. This migration enforces parent-assignee/admin authorization for child creation and publication, makes project imports and Conexus user initialization atomic, and invalidates workspaces from previous claims without removing local files.

Release now keeps a durable operation and the current claim until GitHub synchronization succeeds. Retry **释放任务** after a failed request (or `POST /api/tasks/:id/release`); a crashed process's lease expires within 90 seconds. Delivery packages preserve bytes and Git executable modes. New submissions persist the reviewed Git tree, and acceptance rejects any PR whose tree changed after review, even when the new edits remain in scope. Ask for changes and submit again to review a new snapshot. Approved submissions predating this migration are checked by reconstructing their saved package using the previous publisher's file-mode rules; they cannot bypass snapshot verification.

The CLI's Central API origin must be configured explicitly; Conexus login and a matching GitHub connection are required. Independent GitHub Issues remain supported using atomic claim refs. Webhooks remain an audit feed: direct Issue/PR edits and old CLI clients do not perform central settlement. Upgrade every participating client and use the API-backed workflow for central tasks.

The scope reconsideration feature requires `migrations/202609080001_scope_requests.sql` before deploying the updated API. It adds service-only request history, atomic approval/withdrawal functions, and invalidation on task lifecycle changes. See [the feature design](../../docs/scope-reconsideration.md) for the GitHub transport boundary and API contract.

The submission recovery fixes require `migrations/202609120001_submission_recovery.sql` **before deploying the updated API**. The migration adds atomic submission/review transitions and calculates task payouts and cancellation refunds from actual descendant ledger payments at every task depth. It preserves existing ledger entries; it does not retroactively debit users who were overpaid by an older version.

The next migration, `migrations/202609120002_durable_task_operations.sql`, is required **before deploying this API and Desktop update**. It adds publication budget holds, optimistic analysis writes, and durable operations with renewable 90-second leases. Operation payloads contain delivery evidence but never GitHub or model credentials. Desktop submissions now include the remote head synchronized by the workspace; older Desktop clients must be updated before submitting.

Model failures leave tasks active. GitHub or database transport failures preserve the submission package and its completed model review. Use **恢复提交** in the updated Desktop (or `POST /api/submissions/:id/resume`) to continue after reconnecting. A crashed process's lease expires within 90 seconds. Recovery uses saved evidence without consuming a new model authorization. The GitHub adapter reuses the submitted tree and existing PR, rather than overwriting a changed remote head. Legacy reviewing submissions are also recoverable when the remote still matches their frozen base or saved package; a conflicting head or missing review returns the task to active for a fresh delivery.

Pending publications can be resumed through **恢复发布**. The requested reward remains fixed and its budget is held across restarts. **撤回发布** closes any matching GitHub Issue before releasing the hold and allowing draft edits. Issue creation responses lost in transit are reconciled by the persisted task marker. After the Issue exists, the original atomic publication function records the ledger reservation exactly once.

Once a human review starts, retry the same review action after an external-service failure: acceptance resumes an already merged PR and settles at most once; an opposite review action is blocked while the original action is pending. Historical overpayments still require a separate ledger reconciliation; these migrations do not invent corrective transfers. Roll out the migration first, replace the API processes, then update Desktop; do not run the old API against live task writes during the rollout.

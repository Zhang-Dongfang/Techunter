# Techunter Supabase

Techunter uses the existing Supabase project as its shared control-plane database, but owns the isolated `techunter` schema.

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Add `techunter` to **Project Settings → API → Exposed schemas**. The migration grants the schema only to `service_role`; `anon` and `authenticated` receive no table access. All browser and desktop traffic must go through the Railway `techunter-api` service.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the desktop or Web environment.

The scope reconsideration feature requires `migrations/202609080001_scope_requests.sql` before deploying the updated API. It adds service-only request history, atomic approval/withdrawal functions, and invalidation on task lifecycle changes. See [the feature design](../../docs/scope-reconsideration.md) for the GitHub transport boundary and API contract.

The submission recovery fixes require `migrations/202609120001_submission_recovery.sql` **before deploying the updated API**. The migration adds atomic submission/review transitions and calculates task payouts and cancellation refunds from actual descendant ledger payments at every task depth. It preserves existing ledger entries; it does not retroactively debit users who were overpaid by an older version.

Model errors now leave tasks active. GitHub submission errors return the task to active for another delivery attempt. Once a human review starts, retry the same review action after an external-service failure: acceptance resumes an already merged PR and settles at most once; an opposite review action is blocked while the original action is pending. Old tasks stuck in `submitted` with a `reviewing` submission require inspection before recovery, since an older deployment may already have published a PR. Historical overpayments also require a separate ledger reconciliation; this migration does not invent corrective transfers.

# Techunter Supabase

Techunter uses the existing Supabase project as its shared control-plane database, but owns the isolated `techunter` schema.

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Add `techunter` to **Project Settings → API → Exposed schemas**. The migration grants the schema only to `service_role`; `anon` and `authenticated` receive no table access. All browser and desktop traffic must go through the Railway `techunter-api` service.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the desktop or Web environment.

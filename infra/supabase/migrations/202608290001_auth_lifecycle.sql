create table techunter.github_connections (
  user_id uuid primary key references techunter.users(id) on delete cascade,
  credential text not null,
  access_expires_at timestamptz,
  refresh_credential text,
  refresh_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger github_connections_set_updated_at before update on techunter.github_connections
for each row execute procedure techunter.set_updated_at();

alter table techunter.sessions
  add column idle_expires_at timestamptz,
  add column model_credential_expires_at timestamptz;

update techunter.sessions
set
  model_credential_expires_at = expires_at,
  expires_at = created_at + interval '30 days',
  idle_expires_at = least(created_at + interval '30 days', now() + interval '7 days');

alter table techunter.sessions
  alter column idle_expires_at set not null;

insert into techunter.github_connections(user_id, credential, created_at, updated_at)
select distinct on (user_id)
  user_id,
  github_credential,
  created_at,
  now()
from techunter.sessions
where github_credential is not null
order by user_id, created_at desc
on conflict (user_id) do update
set credential = excluded.credential, updated_at = now();

alter table techunter.sessions drop column github_credential;

alter table techunter.github_connections enable row level security;

revoke all on table techunter.github_connections from public, anon, authenticated;
grant all on table techunter.github_connections to service_role;

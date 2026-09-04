alter table techunter.projects
  add column if not exists source_branch text;

update techunter.projects
set source_branch = default_branch
where source_branch is null or btrim(source_branch) = '';

alter table techunter.projects
  alter column source_branch set default 'main',
  alter column source_branch set not null;

comment on column techunter.projects.source_branch is
  'GitHub branch used for future task analysis and frozen task base SHAs; default_branch remains repository metadata.';

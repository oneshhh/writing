-- Run this in Supabase SQL Editor before deploying the multi-manager app changes.

create table if not exists public.project_managers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  manager_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'manager' check (role in ('owner', 'manager')),
  status text not null default 'active' check (status in ('active', 'removed')),
  invited_by uuid references public.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  unique (project_id, manager_id)
);

create index if not exists project_managers_project_id_idx
  on public.project_managers(project_id);

create index if not exists project_managers_manager_id_idx
  on public.project_managers(manager_id);

create table if not exists public.project_manager_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  token text not null unique,
  created_by uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  max_uses integer not null default 20 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  created_at timestamptz not null default now()
);

create index if not exists project_manager_invites_project_id_idx
  on public.project_manager_invites(project_id);

create index if not exists project_manager_invites_token_idx
  on public.project_manager_invites(token);

insert into public.project_managers (project_id, manager_id, role, status, invited_by)
select p.id, p.created_by, 'owner', 'active', p.created_by
from public.projects p
where p.created_by is not null
on conflict (project_id, manager_id) do update
set role = excluded.role,
    status = 'active';

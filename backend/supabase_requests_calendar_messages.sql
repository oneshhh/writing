-- Run this in Supabase SQL Editor after the multi-manager migration.
-- It adds request workflows, planner/calendar notes, encrypted messages, and organisation groundwork.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('admin', 'manager', 'writer')),
  status text not null default 'active' check (status in ('active', 'removed')),
  joined_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

alter table public.users add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.projects add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create table if not exists public.project_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references public.users(id) on delete cascade,
  title text not null,
  brief text,
  reference_links text[] not null default '{}',
  additional_payment numeric(12,2),
  due_at timestamptz,
  send_scope text not null default 'group' check (send_scope in ('group', 'personal')),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'closed')),
  accepted_by uuid references public.users(id) on delete set null,
  accepted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_requests_project_id_idx
  on public.project_requests(project_id);

create index if not exists project_requests_created_by_idx
  on public.project_requests(created_by);

create table if not exists public.project_request_recipients (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.project_requests(id) on delete cascade,
  writer_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  responded_at timestamptz,
  response_note text,
  created_at timestamptz not null default now(),
  unique (request_id, writer_id)
);

create index if not exists project_request_recipients_writer_id_idx
  on public.project_request_recipients(writer_id);

create table if not exists public.calendar_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  note text,
  event_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_notes_user_date_idx
  on public.calendar_notes(user_id, event_date);

create table if not exists public.encrypted_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete cascade,
  recipient_id uuid references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  audience text not null default 'direct' check (audience in ('direct', 'project')),
  cipher_text text not null,
  iv text not null,
  salt text not null,
  algorithm text not null default 'AES-GCM/PBKDF2',
  created_at timestamptz not null default now()
);

create index if not exists encrypted_messages_sender_id_idx
  on public.encrypted_messages(sender_id);

create index if not exists encrypted_messages_recipient_id_idx
  on public.encrypted_messages(recipient_id);

create index if not exists encrypted_messages_project_id_idx
  on public.encrypted_messages(project_id);

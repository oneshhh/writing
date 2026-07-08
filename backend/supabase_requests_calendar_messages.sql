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
alter table public.users add column if not exists public_key_jwk jsonb;
alter table public.users add column if not exists public_key_updated_at timestamptz;
alter table public.users add column if not exists last_active_at timestamptz;
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
  algorithm text not null default 'AES-GCM/RSA-OAEP-256',
  encrypted_keys jsonb not null default '{}'::jsonb,
  delivery_status text not null default 'delivered' check (delivery_status in ('delivered', 'read', 'failed')),
  read_by jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists encrypted_messages_sender_id_idx
  on public.encrypted_messages(sender_id);

create index if not exists encrypted_messages_recipient_id_idx
  on public.encrypted_messages(recipient_id);

create index if not exists encrypted_messages_project_id_idx
  on public.encrypted_messages(project_id);

alter table public.encrypted_messages
  alter column algorithm set default 'AES-GCM/RSA-OAEP-256';

alter table public.encrypted_messages
  add column if not exists encrypted_keys jsonb not null default '{}'::jsonb;

alter table public.encrypted_messages
  add column if not exists delivery_status text not null default 'delivered';

alter table public.encrypted_messages
  add column if not exists read_by jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'encrypted_messages_delivery_status_check'
      and conrelid = 'public.encrypted_messages'::regclass
  ) then
    alter table public.encrypted_messages
      add constraint encrypted_messages_delivery_status_check
      check (delivery_status in ('delivered', 'read', 'failed'));
  end if;
end $$;

do $$
begin
  if to_regclass('public.user_public_keys') is not null then
    execute $migrate_user_keys$
      update public.users u
      set
        public_key_jwk = k.public_key_jwk,
        public_key_updated_at = coalesce(k.updated_at, now())
      from public.user_public_keys k
      where u.id = k.user_id
        and u.public_key_jwk is null
    $migrate_user_keys$;
  end if;

  if to_regclass('public.encrypted_message_keys') is not null then
    execute $migrate_message_keys$
      update public.encrypted_messages m
      set encrypted_keys = coalesce(m.encrypted_keys, '{}'::jsonb) || k.keys
      from (
        select message_id, jsonb_object_agg(user_id::text, encrypted_key) as keys
        from public.encrypted_message_keys
        group by message_id
      ) k
      where m.id = k.message_id
    $migrate_message_keys$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Optional cleanup after confirming old messages/keys are no longer needed:
-- drop table if exists public.encrypted_message_keys;
-- drop table if exists public.user_public_keys;

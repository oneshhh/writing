create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key,
  unique_id text unique not null,
  email text unique not null,
  full_name text not null,
  role text not null check (role in ('admin', 'manager', 'writer')),
  avatar_url text,
  organization_id text,
  is_active boolean not null default true,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references users(id) on delete set null,
  organization_id text,
  title text not null,
  description text,
  status text not null default 'active',
  ai_check_enabled boolean not null default false,
  plagiarism_check_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_managers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  manager_id uuid not null references users(id) on delete cascade,
  role text not null default 'manager',
  status text not null default 'active',
  invited_by uuid references users(id) on delete set null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_id, manager_id)
);

create table if not exists project_manager_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  token text not null unique,
  created_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  max_uses integer not null default 20,
  used_count integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists project_writers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  writer_id uuid not null references users(id) on delete cascade,
  price_per_article numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, writer_id)
);

create table if not exists project_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  accepted_by uuid references users(id) on delete set null,
  title text not null,
  brief text,
  reference_links jsonb not null default '[]'::jsonb,
  additional_payment numeric(12,2),
  due_at timestamptz,
  send_scope text not null default 'group',
  status text not null default 'open',
  accepted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  unique_id text unique not null,
  project_id uuid not null references projects(id) on delete cascade,
  writer_id uuid not null references users(id) on delete cascade,
  request_id uuid references project_requests(id) on delete set null,
  request_title text,
  title text not null,
  short_description text,
  long_description text,
  article_type text,
  seo_tags jsonb not null default '[]'::jsonb,
  status text not null default 'draft',
  manager_note text,
  ai_score numeric(8,4),
  ai_check jsonb,
  plagiarism_score numeric(8,4),
  plagiarism_check jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz
);

create table if not exists project_request_recipients (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references project_requests(id) on delete cascade,
  writer_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending',
  responded_at timestamptz,
  response_note text,
  submitted_at timestamptz,
  fulfilled_at timestamptz,
  linked_article_id uuid references articles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (request_id, writer_id)
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  writer_id uuid not null references users(id) on delete cascade,
  article_id uuid references articles(id) on delete set null,
  request_id uuid references project_requests(id) on delete set null,
  request_title text,
  amount numeric(12,2) not null default 0,
  status text not null default 'pending',
  payment_id text,
  proof_url text,
  paid_by uuid references users(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  payload jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists calendar_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  title text not null,
  note text,
  event_date date not null,
  created_at timestamptz not null default now()
);

create table if not exists encrypted_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  organization_id text,
  audience text not null default 'direct',
  cipher_text text not null,
  iv text not null default '',
  salt text not null default '',
  algorithm text not null default 'plain',
  encrypted_keys jsonb not null default '{}'::jsonb,
  delivery_status text not null default 'delivered',
  read_by jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_role_active on users(role, is_active);
create index if not exists idx_projects_created_by on projects(created_by);
create index if not exists idx_project_managers_manager on project_managers(manager_id, status);
create index if not exists idx_project_writers_writer on project_writers(writer_id);
create index if not exists idx_project_requests_project on project_requests(project_id, created_at desc);
create index if not exists idx_articles_project on articles(project_id, created_at desc);
create index if not exists idx_articles_writer on articles(writer_id, created_at desc);
create index if not exists idx_articles_request on articles(request_id);
create index if not exists idx_articles_status on articles(status, submitted_at desc);
create index if not exists idx_request_recipients_writer on project_request_recipients(writer_id, status);
create index if not exists idx_payments_project on payments(project_id, created_at desc);
create index if not exists idx_payments_writer on payments(writer_id, created_at desc);
create index if not exists idx_notifications_user on notifications(user_id, created_at desc);
create index if not exists idx_calendar_notes_user on calendar_notes(user_id, event_date);
create index if not exists idx_encrypted_messages_project on encrypted_messages(project_id, created_at desc);
create index if not exists idx_encrypted_messages_direct on encrypted_messages(sender_id, recipient_id, created_at desc);

-- Run this in Supabase SQL Editor before using request-linked article submissions.
-- It links articles to project requests and tracks which writer fulfilled which request.

alter table public.articles
  add column if not exists request_id uuid references public.project_requests(id) on delete set null;

alter table public.articles
  add column if not exists request_title text;

create index if not exists articles_request_id_idx
  on public.articles(request_id);

create unique index if not exists articles_request_writer_unique_idx
  on public.articles(request_id, writer_id)
  where request_id is not null;

alter table public.project_request_recipients
  add column if not exists linked_article_id uuid references public.articles(id) on delete set null;

alter table public.project_request_recipients
  add column if not exists submitted_at timestamptz;

alter table public.project_request_recipients
  add column if not exists fulfilled_at timestamptz;

create index if not exists project_request_recipients_linked_article_id_idx
  on public.project_request_recipients(linked_article_id);

notify pgrst, 'reload schema';

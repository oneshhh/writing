-- Run this in Supabase SQL Editor before enabling request-bonus payments.
-- It extends payments so accepted writing requests can create pending bonus rows.

alter table public.payments
  add column if not exists request_id uuid references public.project_requests(id) on delete set null;

alter table public.payments
  add column if not exists request_title text;

alter table public.payments
  add column if not exists payment_reason text not null default 'article'
  check (payment_reason in ('article', 'request_bonus'));

do $$
begin
  begin
    alter table public.payments
      alter column article_id drop not null;
  exception
    when others then
      null;
  end;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payments_article_or_request_check'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_article_or_request_check
      check (article_id is not null or request_id is not null);
  end if;
end $$;

create index if not exists payments_request_id_idx
  on public.payments(request_id);

update public.payments
set payment_reason = case
  when article_id is null then 'request_bonus'
  else 'article'
end
where payment_reason is null
   or payment_reason not in ('article', 'request_bonus');

notify pgrst, 'reload schema';

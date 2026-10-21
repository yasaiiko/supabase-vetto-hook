-- Optional: signups the hook let through without a verdict (Vetto slow, down
-- or rate limited). Only used when REVIEW_UNCHECKED_SIGNUPS=true.
-- The hook writes with the service role. No client access: RLS is on with no
-- policies and anon/authenticated have no grants. Read it from the SQL editor
-- (supabase/queries/review-unchecked-signups.sql).

create table if not exists public.signups_pending_review (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  email text not null,
  domain text not null,
  ip inet,
  -- why the hook allowed it unchecked: timeout | unreachable | dns_error | deferred
  reason text not null,
  -- background re-check of the domain with a longer timeout, after the hook answered
  recheck_status text,
  recheck_mx text[] not null default '{}',
  recheck_disposable boolean,
  reviewed_at timestamptz
);

create index if not exists signups_pending_review_created_at on public.signups_pending_review (created_at desc);

alter table public.signups_pending_review enable row level security;
revoke all on public.signups_pending_review from anon, authenticated;

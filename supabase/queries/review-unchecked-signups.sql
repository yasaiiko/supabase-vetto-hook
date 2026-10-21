-- Weekly review of signups the hook let through unchecked.
-- Run in Dashboard → SQL Editor. Each query stands alone.

-- 1. Same network, again and again: IPv4 /24 (IPv6 /48) with 3+ unchecked signups.
select
  network(set_masklen(ip, case when family(ip) = 4 then 24 else 48 end)) as network,
  count(*) as signups,
  count(distinct domain) as domains,
  (array_agg(distinct domain))[1:5] as sample_domains,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from public.signups_pending_review
where created_at > now() - interval '7 days' and ip is not null
group by 1
having count(*) >= 3
order by signups desc;

-- 2. Same mail provider behind many domains: MX hosts grouped by their last two
--    labels (mx1.provider.net → provider.net). One provider serving lots of
--    unrelated new domains is how throwaway operators usually look.
select
  substring(mx from '([^.]+\.[^.]+)\.?$') as mx_provider,
  count(distinct domain) as domains,
  count(distinct id) as signups,
  (array_agg(distinct domain))[1:5] as sample_domains
from public.signups_pending_review, unnest(recheck_mx) as mx
where created_at > now() - interval '7 days'
group by 1
having count(distinct domain) >= 2
order by domains desc;

-- 3. Domains that were still slow or unresolved on the re-check (8 s, after the
--    hook answered). Slow DNS that stays slow is the strongest sign of all.
select domain, count(*) as signups, array_agg(distinct recheck_status) as recheck, max(created_at) as last_seen
from public.signups_pending_review
where created_at > now() - interval '7 days' and recheck_status in ('timeout', 'unreachable', 'error', 'deferred')
group by domain
order by signups desc;

-- 4. Users the re-check says the hook would have blocked, if it had answered in time.
select r.created_at, r.email, r.reason, r.recheck_status, r.recheck_disposable, u.id as user_id
from public.signups_pending_review r
left join auth.users u on lower(u.email) = lower(r.email)
where r.reviewed_at is null
  and (r.recheck_disposable or r.recheck_status in ('nxdomain', 'no_mx_a', 'null_mx', 'no_mail'))
order by r.created_at desc;

-- Mark rows as handled:
-- update public.signups_pending_review set reviewed_at = now() where id in (...);

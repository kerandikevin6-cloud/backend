-- ============================================================================
-- Site consoles: a console that sees one site and nothing else
-- Run after 025. Idempotent, safe to re-run.
-- ============================================================================
--
-- rivonbinary.com is hidden from the main console (025). It now has its own
-- console at rivonbinary.com/superadmin, on this same API, which shows only
-- Rivon: its users, its deposits, its withdrawals, its tickets, its KYC
-- queue, its copy keys, its sessions, its staff and its audit trail.
--
-- Which site a console request is for is decided by the API (src/lib/
-- site.js, consoleScope): the console's origin when that origin is a hidden
-- site, and always profiles.console_site when the staff account has one.
-- An account with console_site set sees that site only, from any console.
--
-- What a row's site is:
--   a user        profiles.domain_host
--   a deposit     the site it was made through, else its user's site
--   anything else (withdrawal, ticket, KYC, event) its user's site
--   a copy key    the site it was made for, else its redeemer's, else its
--                 maker's
-- A missing host means novibinary.com, the site everything predates.
-- ============================================================================

-- ---------- who is locked to a site ----------
alter table public.profiles   add column if not exists console_site text;
alter table public.hosts      add column if not exists domain_host  text;
alter table public.copy_keys  add column if not exists domain_host  text;
alter table public.admin_audit add column if not exists site        text;

create index if not exists profiles_console_site_idx on public.profiles (console_site)
  where console_site is not null;
create index if not exists admin_audit_site_idx on public.admin_audit (site, created_at desc);

-- ---------- rows with their site ----------
-- security_invoker: the views read with the caller's rights, so anon and
-- authenticated get nothing through them even before the revokes below.
create or replace view public.admin_site_payments with (security_invoker = true) as
  select p.*, coalesce(p.domain_host, pr.domain_host, 'novibinary.com') as site
    from public.payments p
    left join public.profiles pr on pr.id = p.user_id;

create or replace view public.admin_site_withdrawals with (security_invoker = true) as
  select w.*, coalesce(pr.domain_host, 'novibinary.com') as site
    from public.withdrawal_requests w
    left join public.profiles pr on pr.id = w.user_id;

create or replace view public.admin_site_tickets with (security_invoker = true) as
  select t.*, coalesce(pr.domain_host, 'novibinary.com') as site
    from public.support_tickets t
    left join public.profiles pr on pr.id = t.user_id;

create or replace view public.admin_site_kyc with (security_invoker = true) as
  select k.*, coalesce(pr.domain_host, 'novibinary.com') as site
    from public.kyc_submissions k
    left join public.profiles pr on pr.id = k.user_id;

create or replace view public.admin_site_events with (security_invoker = true) as
  select e.*, coalesce(pr.domain_host, 'novibinary.com') as site
    from public.system_events e
    join public.profiles pr on pr.id = e.user_id;

create or replace view public.admin_site_copy_keys with (security_invoker = true) as
  select k.*,
         coalesce(k.domain_host, rd.domain_host, mk.console_site, mk.domain_host,
                  'novibinary.com') as site
    from public.copy_keys k
    left join public.profiles rd on rd.id = k.redeemed_by
    left join public.profiles mk on mk.id = k.created_by;

revoke all on public.admin_site_payments    from public, anon, authenticated;
revoke all on public.admin_site_withdrawals from public, anon, authenticated;
revoke all on public.admin_site_tickets     from public, anon, authenticated;
revoke all on public.admin_site_kyc         from public, anon, authenticated;
revoke all on public.admin_site_events      from public, anon, authenticated;
revoke all on public.admin_site_copy_keys   from public, anon, authenticated;
grant select on public.admin_site_payments    to service_role;
grant select on public.admin_site_withdrawals to service_role;
grant select on public.admin_site_tickets     to service_role;
grant select on public.admin_site_kyc         to service_role;
grant select on public.admin_site_events      to service_role;
grant select on public.admin_site_copy_keys   to service_role;

-- ---------- one site's figures ----------
-- The same definitions as admin_stats / admin_daily / domain_figures (025),
-- with "visible" replaced by "on this site".
create or replace function public.admin_stats_site(p_host text)
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  with mine as (
    select pr.* from public.profiles pr
     where coalesce(pr.domain_host, 'novibinary.com') = p_host
  ),
  real_deposits as (
    select p.status, p.amount_minor
      from public.payments p
      join public.profiles pr on pr.id = p.user_id
     where p.direction = 'deposit'
       and p.provider  = 'payhero'
       and pr.role = 'customer' and pr.tier = 'standard'
       and coalesce(p.domain_host, pr.domain_host, 'novibinary.com') = p_host
  ),
  real_payouts as (
    select w.status, w.amount_minor, w.created_at
      from public.withdrawal_requests w
      join mine pr on pr.id = w.user_id
     where w.method <> 'mpesa_demo'
       and pr.role = 'customer' and pr.tier = 'standard'
  )
  select jsonb_build_object(
    'users',            (select count(*) from mine
                          where role = 'customer' and tier = 'standard'),
    'activeUsers',      (select count(*) from mine
                          where role = 'customer' and tier = 'standard' and status = 'active'),
    'suspended',        (select count(*) from mine where status = 'suspended'),
    'kycPending',       (select count(*) from mine where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(a.balance_minor),0)
                           from public.accounts a
                           join mine pr on pr.id = a.user_id
                          where a.kind = 'real'
                            and pr.role = 'customer' and pr.tier = 'standard'),
    'depositsMinor',    (select coalesce(sum(amount_minor),0) from real_deposits where status = 'success'),
    'depositCount',     (select count(*) from real_deposits where status = 'success'),
    'failedCount',      (select count(*) from real_deposits where status = 'failed'),
    'pendingCount',     (select count(*) from real_deposits where status = 'pending'),
    'payoutsPending',   (select count(*) from real_payouts where status = 'pending'),
    'payoutsPendingMinor',
                        (select coalesce(sum(amount_minor),0) from real_payouts where status = 'pending'),
    'paidOutMinor',     (select coalesce(sum(amount_minor),0) from real_payouts where status = 'paid'),
    'oldestPending',    (select min(created_at) from real_payouts where status = 'pending')
  );
$$;

create or replace function public.admin_daily_site(p_host text, p_days integer default 14)
returns table (day date, deposits_minor bigint, withdrawals_minor bigint, signups integer)
language sql
security definer set search_path = public
stable
as $$
  with days as (
    select generate_series(
      (current_date - (p_days - 1)),
      current_date,
      interval '1 day'
    )::date as day
  )
  select
    d.day,
    coalesce((select sum(p.amount_minor) from public.payments p
               join public.profiles pr on pr.id = p.user_id
               where p.direction = 'deposit' and p.status = 'success'
                 and p.provider = 'payhero'
                 and pr.role = 'customer' and pr.tier = 'standard'
                 and coalesce(p.domain_host, pr.domain_host, 'novibinary.com') = p_host
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles pr on pr.id = w.user_id
               where w.status = 'paid' and w.method <> 'mpesa_demo'
                 and pr.role = 'customer' and pr.tier = 'standard'
                 and coalesce(pr.domain_host, 'novibinary.com') = p_host
                 and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day
                 and pr.role = 'customer' and pr.tier = 'standard'
                 and coalesce(pr.domain_host, 'novibinary.com') = p_host), 0)::integer
  from days d
  order by d.day;
$$;

create or replace function public.domain_figures_site(p_host text)
returns table (
  host text, label text, status text,
  users integer, deposits_minor bigint, withdrawals_minor bigint
)
language sql
security definer set search_path = public
stable
as $$
  select
    d.host, d.label, d.status,
    coalesce((select count(*) from public.profiles p
               where coalesce(p.domain_host, 'novibinary.com') = d.host), 0)::integer,
    coalesce((select sum(pay.amount_minor) from public.payments pay
               join public.profiles p on p.id = pay.user_id
              where coalesce(pay.domain_host, p.domain_host, 'novibinary.com') = d.host
                and pay.direction = 'deposit' and pay.status = 'success'), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               join public.profiles p on p.id = w.user_id
              where coalesce(p.domain_host, 'novibinary.com') = d.host
                and w.status = 'paid'), 0)::bigint
  from public.domains d
  where d.host = p_host;
$$;

revoke all on function public.admin_stats_site(text)          from public, anon, authenticated;
revoke all on function public.admin_daily_site(text, integer) from public, anon, authenticated;
revoke all on function public.domain_figures_site(text)       from public, anon, authenticated;
grant execute on function public.admin_stats_site(text)          to service_role;
grant execute on function public.admin_daily_site(text, integer) to service_role;
grant execute on function public.domain_figures_site(text)       to service_role;

-- the API reads the new views and columns straight away
notify pgrst, 'reload schema';

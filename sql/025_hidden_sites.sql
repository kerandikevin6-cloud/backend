-- ============================================================================
-- Hidden sites: a front end whose money the console does not show
-- Run after 024. Idempotent, safe to re-run.
-- ============================================================================
--
-- rivonbinary.com is run on this backend for an owner who does not want its
-- money visible in the console. Its domain stays LIVE, so the API keeps
-- answering it (CORS) and every feature keeps working: sign-up, trading,
-- deposits, handset (M-Pesa clone) settings, withdrawals and their approval.
-- What changes for a hidden site:
--   * the Domains page does not list it (and so the deposits site filter
--     does not offer it)
--   * the dashboard figures and the daily chart leave its money out
-- The API also keeps its deposits off the Deposits page and the money
-- history off its users' pages (backend src/lib/site.js, HIDDEN_HOSTS).
--
-- Money belongs to a hidden site when the deposit was made through it, or
-- when the account was opened on it.
-- ============================================================================

alter table public.domains
  add column if not exists hidden boolean not null default false;

insert into public.domains (host, label, status, hidden) values
  ('rivonbinary.com', 'RivonBinary', 'live', true)
on conflict (host) do update set hidden = true, status = 'live';

create or replace function public.is_hidden_host(p_host text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (select 1 from public.domains where host = p_host and hidden);
$$;

-- An account opened on a hidden site.
create or replace function public.is_hidden_user(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles pr
      join public.domains d on d.host = pr.domain_host and d.hidden
     where pr.id = p_user
  );
$$;

-- Standard customers on a visible site: the only money the figures count.
create or replace function public.is_real_customer(p_user uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
     where id = p_user and role = 'customer' and tier = 'standard'
  ) and not public.is_hidden_user(p_user);
$$;

create or replace function public.admin_stats()
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  with visible as (
    select pr.* from public.profiles pr
     where not exists (select 1 from public.domains d
                        where d.host = pr.domain_host and d.hidden)
  ),
  real_deposits as (
    select p.status, p.amount_minor
      from public.payments p
      join visible pr on pr.id = p.user_id
     where p.direction = 'deposit'
       and p.provider  = 'payhero'
       and pr.role = 'customer' and pr.tier = 'standard'
       and not public.is_hidden_host(p.domain_host)
  ),
  real_payouts as (
    select w.status, w.amount_minor, w.created_at
      from public.withdrawal_requests w
      join visible pr on pr.id = w.user_id
     where w.method <> 'mpesa_demo'
       and pr.role = 'customer' and pr.tier = 'standard'
  )
  select jsonb_build_object(
    'users',            (select count(*) from visible
                          where role = 'customer' and tier = 'standard'),
    'activeUsers',      (select count(*) from visible
                          where role = 'customer' and tier = 'standard' and status = 'active'),
    'suspended',        (select count(*) from visible where status = 'suspended'),
    'kycPending',       (select count(*) from public.profiles where kyc_status = 'pending'),
    'heldMinor',        (select coalesce(sum(a.balance_minor),0)
                           from public.accounts a
                           join visible pr on pr.id = a.user_id
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

create or replace function public.admin_daily(p_days integer default 14)
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
               where p.direction = 'deposit' and p.status = 'success'
                 and p.provider = 'payhero'
                 and public.is_real_customer(p.user_id)
                 and not public.is_hidden_host(p.domain_host)
                 and p.settled_at::date = d.day), 0)::bigint,
    coalesce((select sum(w.amount_minor) from public.withdrawal_requests w
               where w.status = 'paid' and w.method <> 'mpesa_demo'
                 and public.is_real_customer(w.user_id)
                 and w.settled_at::date = d.day), 0)::bigint,
    coalesce((select count(*) from public.profiles pr
               where pr.created_at::date = d.day
                 and pr.role = 'customer' and pr.tier = 'standard'
                 and not public.is_hidden_user(pr.id)), 0)::integer
  from days d
  order by d.day;
$$;

-- The Domains page: every site but the hidden ones. Same figures as 020.
create or replace function public.domain_figures()
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
  where not d.hidden
  order by d.created_at;
$$;

revoke all on function public.is_hidden_host(text)   from public, anon, authenticated;
revoke all on function public.is_hidden_user(uuid)   from public, anon, authenticated;
revoke all on function public.is_real_customer(uuid) from public, anon, authenticated;
revoke all on function public.admin_stats()          from public, anon, authenticated;
revoke all on function public.admin_daily(integer)   from public, anon, authenticated;
revoke all on function public.domain_figures()       from public, anon, authenticated;
grant execute on function public.is_hidden_host(text)   to service_role;
grant execute on function public.is_hidden_user(uuid)   to service_role;
grant execute on function public.is_real_customer(uuid) to service_role;
grant execute on function public.admin_stats()          to service_role;
grant execute on function public.admin_daily(integer)   to service_role;
grant execute on function public.domain_figures()       to service_role;

-- ============================================================================
-- Session hosts and real session earnings
-- Run after 001-022. Idempotent, safe to re-run.
-- ============================================================================
--
-- 1. hosts: the people who run live sessions (TikTok and the like). They
--    sign in to their own page, /host/ on the console, with a username and
--    password made here by an admin. They are NOT staff and have no Supabase
--    account, so their sign-in cannot open the console or read anything but
--    their own sessions.
-- 2. sessions.host_id: which host ran a session.
-- 3. session_figures now measures the margin from the trades table, which
--    it could not do when it was written (stake volume was hard-coded to 0).
--    Every figure counts real money only: standard customer accounts, real
--    trading balance, no demo-mode trades and no M-Pesa clone wallet money.
-- ============================================================================

create table if not exists public.hosts (
  id             uuid        primary key default gen_random_uuid(),
  name           text        not null,
  username       text        not null,
  password_hash  text        not null,
  status         text        not null default 'active' check (status in ('active', 'disabled')),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);

create unique index if not exists hosts_username_key on public.hosts (lower(username));

alter table public.hosts enable row level security;
-- No policies: reached through the service role only.

alter table public.sessions
  add column if not exists host_id uuid references public.hosts(id) on delete set null;

create index if not exists sessions_host_idx on public.sessions (host_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Figures for one session. Margin and stake are in the trading currency
-- (USD minor units); the API converts them to shillings for display.
-- ---------------------------------------------------------------------------
create or replace function public.session_figures(p_session_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
stable
as $$
declare
  s public.sessions;
  v_from timestamptz;
  v_to timestamptz;
  v_deposits bigint;
  v_deposit_count integer;
  v_withdrawals bigint;
  v_stake bigint;
  v_payout bigint;
  v_signups integer;
  v_trades integer;
begin
  select * into s from public.sessions where id = p_session_id;
  if s is null then return null; end if;

  v_from := s.started_at;
  v_to := coalesce(s.ended_at, now());

  select coalesce(sum(p.amount_minor), 0), count(*)
    into v_deposits, v_deposit_count
    from public.payments p
    join public.profiles pr on pr.id = p.user_id
   where p.direction = 'deposit' and p.status = 'success'
     and p.provider <> 'mpesa_demo'
     and pr.role = 'customer' and pr.tier = 'standard'
     and p.settled_at between v_from and v_to;

  select coalesce(sum(w.amount_minor), 0) into v_withdrawals
    from public.withdrawal_requests w
    join public.profiles pr on pr.id = w.user_id
   where w.status = 'paid' and w.method <> 'mpesa_demo'
     and pr.role = 'customer' and pr.tier = 'standard'
     and w.settled_at between v_from and v_to;

  select coalesce(count(*), 0) into v_signups
    from public.profiles
   where role = 'customer'
     and created_at between v_from and v_to;

  -- The house's margin: stakes taken less what was paid back out, on real
  -- balances of standard customers. Staged (demo-mode) trades are excluded.
  select coalesce(sum(t.stake_minor), 0), coalesce(sum(t.payout_minor), 0), count(*)
    into v_stake, v_payout, v_trades
    from public.trades t
    join public.profiles pr on pr.id = t.user_id
   where t.account_kind = 'real'
     and not t.demo_mode
     and pr.role = 'customer' and pr.tier = 'standard'
     and t.settled_at between v_from and v_to;

  return jsonb_build_object(
    'depositsMinor',         v_deposits,
    'depositCount',          v_deposit_count,
    'withdrawalsMinor',      v_withdrawals,
    'stakeVolumeUsdMinor',   v_stake,
    'marginUsdMinor',        v_stake - v_payout,
    'signups',               v_signups,
    'trades',                v_trades
  );
end;
$$;

revoke all on function public.session_figures(uuid) from public, anon, authenticated;
grant execute on function public.session_figures(uuid) to service_role;

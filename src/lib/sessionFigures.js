/* ============================================================
   A session row with its figures, for the console and the host page.
   Margin and stake come from the trades table in dollars (sql/023)
   and are shown in shillings, like the deposits and the boost spend.
   Before 023 is run the database still returns the old shape, which
   is read as it was.
   ============================================================ */
import { admin } from './supabase.js';
import { env } from '../config/env.js';

export async function withFigures(row) {
  const { data } = await admin.rpc('session_figures', { p_session_id: row.id });
  const f = data || {};
  const rate = Number(env.USD_RATE_KES) || 1;
  const kes = usd => Math.round(Number(usd || 0) * rate);
  return {
    id: row.id,
    channel: row.channel,
    handler: row.handler,
    hostId: row.host_id || null,
    domain: row.domain_host,
    note: row.note,
    adSpendMinor: Number(row.ad_spend_minor),
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    depositsMinor: Number(f.depositsMinor || 0),
    depositCount: Number(f.depositCount || 0),
    withdrawalsMinor: Number(f.withdrawalsMinor || 0),
    stakeVolumeMinor: f.stakeVolumeUsdMinor != null ? kes(f.stakeVolumeUsdMinor) : Number(f.stakeVolumeMinor || 0),
    marginMinor: f.marginUsdMinor != null ? kes(f.marginUsdMinor) : Number(f.marginMinor || 0),
    signups: Number(f.signups || 0),
    trades: Number(f.trades || 0)
  };
}

/* ============================================================
   Trade history

   Read and record settled contracts, so a person's history follows them
   between devices instead of living in one browser's localStorage.

   What this is not: a source of truth about money. Contracts are still
   decided in the browser, so a row here is the client's account of what
   happened. It is recorded, shown back, and never allowed near a
   balance — see the note at the top of sql/007_trades.sql.

   Both routes run as the signed-in user through req.db, not through the
   service role, so row level security is what enforces "your own" rather
   than a filter in this file that somebody could later forget.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/errors.js';

const router = Router();

/* Amounts arrive in minor units, like every other amount in this API. */
const tradeSchema = z.object({
  clientRef: z.string().min(1).max(64),
  accountKind: z.enum(['real', 'demo']).default('demo'),
  symbol: z.string().min(1).max(32),
  symbolName: z.string().max(120).optional(),
  contractType: z.string().min(1).max(32),
  side: z.string().max(32).optional(),
  barrier: z.coerce.number().int().min(0).max(9).nullable().optional(),
  stakeMinor: z.coerce.number().int().min(0),
  payoutMinor: z.coerce.number().int().min(0).default(0),
  profitMinor: z.coerce.number().int(),
  currency: z.string().length(3).default('USD'),
  status: z.enum(['won', 'lost']),
  ticks: z.coerce.number().int().min(0).max(100).optional(),
  entrySpot: z.coerce.number().optional(),
  exitSpot: z.coerce.number().optional(),
  openedAt: z.coerce.date(),
  settledAt: z.coerce.date()
});

function publicTrade(t) {
  return {
    id: t.id,
    ref: t.client_ref,
    account: t.account_kind,
    symbol: t.symbol,
    symbolName: t.symbol_name,
    type: t.contract_type,
    side: t.side,
    barrier: t.barrier,
    stakeMinor: t.stake_minor,
    payoutMinor: t.payout_minor,
    profitMinor: t.profit_minor,
    currency: t.currency,
    status: t.status,
    ticks: t.ticks,
    openedAt: t.opened_at,
    settledAt: t.settled_at
  };
}

/* ---------------- list ----------------
   Newest first, paged by cursor rather than offset: a history grows at
   the end being read from, and an offset silently repeats rows when it
   does. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    let q = req.db
      .from('trades')
      .select('*')
      .order('settled_at', { ascending: false })
      .limit(limit + 1);

    if (req.query.account === 'real' || req.query.account === 'demo') {
      q = q.eq('account_kind', req.query.account);
    }
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!isNaN(before)) q = q.lt('settled_at', before.toISOString());
    }

    const { data, error } = await q;
    if (error) throw new HttpError(500, 'history_failed', error.message);

    const rows = data || [];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;

    res.json({
      ok: true,
      trades: page.map(publicTrade),
      /* The cursor is the last row's timestamp: ask for what settled
         before it. */
      nextBefore: more && page.length ? page[page.length - 1].settled_at : null
    });
  } catch (err) { next(err); }
});

/* ---------------- record ----------------
   Accepts one or many. The browser sends a batch on load — everything it
   has that the server has not seen — and one at a time after that.

   Re-sending is expected and harmless: (user_id, client_ref) is unique,
   so a retry over a flaky connection conflicts rather than duplicating,
   and a conflict is reported as success because the row is there, which
   is what the caller wanted. */
router.post('/',
  requireAuth,
  validate(z.object({
    trades: z.array(tradeSchema).min(1).max(200)
  })),
  async (req, res, next) => {
    try {
      const rows = req.body.trades.map(t => ({
        user_id: req.user.id,
        client_ref: t.clientRef,
        account_kind: t.accountKind,
        symbol: t.symbol,
        symbol_name: t.symbolName || null,
        contract_type: t.contractType,
        side: t.side || null,
        barrier: t.barrier ?? null,
        stake_minor: t.stakeMinor,
        payout_minor: t.payoutMinor,
        profit_minor: t.profitMinor,
        currency: t.currency,
        status: t.status,
        ticks: t.ticks ?? null,
        entry_spot: t.entrySpot ?? null,
        exit_spot: t.exitSpot ?? null,
        opened_at: t.openedAt.toISOString(),
        settled_at: t.settledAt.toISOString()
      }));

      /* ignoreDuplicates: a re-send is not an error. */
      const { data, error } = await req.db
        .from('trades')
        .upsert(rows, { onConflict: 'user_id,client_ref', ignoreDuplicates: true })
        .select();

      if (error) throw new HttpError(500, 'record_failed', error.message);

      res.status(201).json({
        ok: true,
        recorded: (data || []).length,
        sent: rows.length
      });
    } catch (err) { next(err); }
  });

export default router;

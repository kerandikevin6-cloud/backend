/* ============================================================
   Admin API — everything the operator console reads and writes.
   Every route is behind requireStaff, and every write is audited.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireStaff, requireRole, audit } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { notFound, badRequest, HttpError } from '../lib/errors.js';
import { reconcile } from './deposits.routes.js';

const router = Router();
router.use(requireStaff);

/* ---------------- who am I ---------------- */
router.get('/me', (req, res) => {
  res.json({
    ok: true,
    operator: {
      id: req.operator.id,
      email: req.operator.email,
      name: req.operator.display_name || 'Operator',
      role: req.operator.role
    }
  });
});

/* ---------------- dashboard ---------------- */
router.get('/stats', async (req, res, next) => {
  try {
    const { data, error } = await admin.rpc('admin_stats');
    if (error) throw new HttpError(500, 'stats_failed', error.message);
    res.json({ ok: true, stats: data });
  } catch (err) { next(err); }
});

router.get('/daily', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
    const { data, error } = await admin.rpc('admin_daily', { p_days: days });
    if (error) throw new HttpError(500, 'daily_failed', error.message);
    res.json({
      ok: true,
      daily: (data || []).map(r => ({
        day: r.day,
        depositsMinor: Number(r.deposits_minor),
        withdrawalsMinor: Number(r.withdrawals_minor),
        signups: Number(r.signups)
      }))
    });
  } catch (err) { next(err); }
});

/* ---------------- users ---------------- */
router.get('/users', async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let q = admin
      .from('profiles')
      .select('id,email,display_name,phone,country,kyc_status,status,role,' +
              'referral_code,trades_count,created_at,last_seen_at', { count: 'exact' })
      .eq('role', 'customer')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.kyc && req.query.kyc !== 'all') q = q.eq('kyc_status', req.query.kyc);
    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);

    /* Search hits the fields an operator actually has in front of them
       when someone is on the phone: a name, an address, or a number. */
    const term = (req.query.q || '').trim();
    if (term) {
      const safe = term.replace(/[%,()]/g, '');
      q = q.or(`display_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'users_failed', error.message);

    /* Balances come from a second query keyed by id rather than a join,
       so one missing account row cannot drop a user off the list. */
    const ids = (data || []).map(u => u.id);
    const balances = {};
    if (ids.length) {
      const { data: accounts } = await admin
        .from('accounts').select('user_id,kind,balance_minor').in('user_id', ids);
      for (const a of accounts || []) {
        balances[a.user_id] = balances[a.user_id] || {};
        balances[a.user_id][a.kind] = Number(a.balance_minor);
      }
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      users: (data || []).map(u => publicUser(u, balances[u.id]))
    });
  } catch (err) { next(err); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const { data: profile } = await admin
      .from('profiles').select('*').eq('id', req.params.id).maybeSingle();
    if (!profile) throw notFound('No such user');

    const [{ data: accounts }, { data: payments }, { data: withdrawals }] = await Promise.all([
      admin.from('accounts').select('kind,currency,balance_minor').eq('user_id', profile.id),
      admin.from('payments').select('*').eq('user_id', profile.id)
        .order('created_at', { ascending: false }).limit(10),
      admin.from('withdrawal_requests').select('*').eq('user_id', profile.id)
        .order('created_at', { ascending: false }).limit(10)
    ]);

    const balances = {};
    for (const a of accounts || []) balances[a.kind] = Number(a.balance_minor);

    res.json({
      ok: true,
      user: publicUser(profile, balances),
      payments: (payments || []).map(publicPayment),
      withdrawals: (withdrawals || []).map(publicWithdrawal)
    });
  } catch (err) { next(err); }
});

/* Identity decisions and suspensions change what a person can do with
   their money, so they are admin-only and always audited. */
router.patch('/users/:id',
  requireRole('admin', 'operator'),
  validate(z.object({
    kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    reason: z.string().max(300).optional()
  })),
  async (req, res, next) => {
    try {
      if (req.params.id === req.operator.id) {
        throw badRequest('You cannot change your own access from here.');
      }

      const patch = {};
      if (req.body.kycStatus) patch.kyc_status = req.body.kycStatus;
      if (req.body.status) {
        patch.status = req.body.status;
        patch.suspended_reason = req.body.status === 'suspended' ? (req.body.reason || null) : null;
      }
      if (!Object.keys(patch).length) throw badRequest('Nothing to change');

      const { data, error } = await admin
        .from('profiles').update(patch).eq('id', req.params.id).select().maybeSingle();
      if (error) throw new HttpError(400, 'update_failed', error.message);
      if (!data) throw notFound('No such user');

      await audit(req, 'user.update', req.params.id, { patch, reason: req.body.reason || null });
      res.json({ ok: true, user: publicUser(data) });
    } catch (err) { next(err); }
  });

/* ---------------- payments ---------------- */
router.get('/payments', async (req, res, next) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 120);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let q = admin
      .from('payments')
      .select('*', { count: 'exact' })
      .eq('direction', 'deposit')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);
    if (req.query.provider && req.query.provider !== 'all') q = q.eq('provider', req.query.provider);

    const term = (req.query.q || '').trim();
    if (term) q = q.ilike('reference', `%${term.replace(/[%,()]/g, '')}%`);

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'payments_failed', error.message);

    const ids = [...new Set((data || []).map(p => p.user_id))];
    const people = {};
    if (ids.length) {
      const { data: profiles } = await admin
        .from('profiles').select('id,display_name,email').in('id', ids);
      for (const p of profiles || []) people[p.id] = p;
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      payments: (data || []).map(p => publicPayment(p, people[p.user_id]))
    });
  } catch (err) { next(err); }
});

/* Ask the provider again. This is the fix for the one failure that
   actually costs money: the customer paid, the callback was lost, and
   nothing credited. */
router.post('/payments/:id/recheck',
  requireRole('admin', 'finance', 'operator'),
  async (req, res, next) => {
    try {
      const { data: payment } = await admin
        .from('payments').select('*').eq('id', req.params.id).maybeSingle();
      if (!payment) throw notFound('No such payment');

      await reconcile(payment);
      await audit(req, 'payment.recheck', payment.id, { reference: payment.reference });

      const { data: fresh } = await admin
        .from('payments').select('*').eq('id', payment.id).single();
      res.json({ ok: true, payment: publicPayment(fresh) });
    } catch (err) { next(err); }
  });

/* ---------------- withdrawals ---------------- */
router.get('/withdrawals', async (req, res, next) => {
  try {
    let q = admin
      .from('withdrawal_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Number(req.query.limit) || 120));

    if (req.query.status && req.query.status !== 'all') q = q.eq('status', req.query.status);

    const { data, error, count } = await q;
    if (error) throw new HttpError(500, 'withdrawals_failed', error.message);

    const ids = [...new Set((data || []).map(w => w.user_id))];
    const people = {};
    if (ids.length) {
      const { data: profiles } = await admin
        .from('profiles')
        .select('id,display_name,email,phone,kyc_status,status,trades_count')
        .in('id', ids);
      for (const p of profiles || []) people[p.id] = p;
    }

    res.json({
      ok: true,
      total: count ?? (data || []).length,
      withdrawals: (data || []).map(w => publicWithdrawal(w, people[w.user_id]))
    });
  } catch (err) { next(err); }
});

/* Approving says "this money has been sent". It does not send it — the
   transfer happens on the payment rail, by hand for now. Marking it
   paid before it is sent would be a lie the ledger then tells forever. */
router.post('/withdrawals/:id/approve',
  requireRole('admin', 'finance'),
  validate(z.object({ note: z.string().max(300).optional() })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin.rpc('settle_withdrawal', {
        p_request_id: req.params.id,
        p_actor: req.operator.id,
        p_note: req.body.note || null
      });
      if (error) throw new HttpError(400, 'approve_failed', error.message);

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw notFound('No such request');

      await audit(req, 'withdrawal.approve', request.id, {
        amountMinor: request.amount_minor, note: req.body.note || null
      });
      res.json({ ok: true, request: publicWithdrawal(request) });
    } catch (err) { next(err); }
  });

router.post('/withdrawals/:id/reject',
  requireRole('admin', 'finance'),
  validate(z.object({ note: z.string().max(300).optional() })),
  async (req, res, next) => {
    try {
      /* release_withdrawal puts the held funds back on the balance. */
      const { data, error } = await admin.rpc('release_withdrawal', {
        p_request_id: req.params.id,
        p_status: 'rejected',
        p_note: req.body.note || 'rejected in the console'
      });
      if (error) throw new HttpError(400, 'reject_failed', error.message);

      const request = Array.isArray(data) ? data[0] : data;
      if (!request) throw notFound('No such request');

      await audit(req, 'withdrawal.reject', request.id, {
        amountMinor: request.amount_minor, note: req.body.note || null
      });
      res.json({ ok: true, request: publicWithdrawal(request) });
    } catch (err) { next(err); }
  });

/* ---------------- audit trail ---------------- */
router.get('/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const { data } = await admin
      .from('admin_audit').select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Number(req.query.limit) || 100));
    res.json({ ok: true, entries: data || [] });
  } catch (err) { next(err); }
});

/* ---------------- shapes ---------------- */
function publicUser(u, balances) {
  return {
    id: u.id,
    name: u.display_name || (u.email || '').split('@')[0],
    email: u.email,
    phone: u.phone,
    country: u.country,
    kyc: u.kyc_status,
    status: u.status,
    role: u.role,
    referralCode: u.referral_code,
    trades: u.trades_count || 0,
    balanceMinor: balances?.real ?? 0,
    demoMinor: balances?.demo ?? 0,
    joined: u.created_at,
    lastSeen: u.last_seen_at
  };
}

function publicPayment(p, person) {
  return {
    id: p.id,
    reference: p.reference,
    userId: p.user_id,
    userName: person?.display_name || null,
    userEmail: person?.email || null,
    provider: p.provider,
    providerLabel: p.provider === 'payhero' ? 'M-Pesa' : 'Card',
    method: p.provider === 'payhero' ? 'mpesa' : 'card',
    amountMinor: Number(p.amount_minor),
    currency: p.currency,
    creditedMinor: p.credited_minor == null ? null : Number(p.credited_minor),
    status: p.status,
    failureReason: p.failure_reason,
    created: p.created_at,
    settled: p.settled_at
  };
}

function publicWithdrawal(w, person) {
  return {
    id: w.id,
    userId: w.user_id,
    userName: person?.display_name || null,
    userEmail: person?.email || null,
    userKyc: person?.kyc_status || null,
    userStatus: person?.status || null,
    userPhone: person?.phone || null,
    userTrades: person?.trades_count || 0,
    amountMinor: Number(w.amount_minor),
    currency: w.currency,
    method: w.method,
    destination: w.destination?.phone || w.destination?.accountNumber || '',
    status: w.status,
    created: w.created_at,
    settled: w.settled_at
  };
}

export default router;

/* ============================================================
   Admin API — everything the operator console reads and writes.
   Every route is behind requireStaff, and every write is audited.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireStaff, requireRole, audit, STAFF_ROLES } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { notFound, badRequest, conflict, HttpError } from '../lib/errors.js';
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
  requireRole('super_admin', 'admin', 'manager', 'operator'),
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
  requireRole('super_admin', 'admin', 'manager', 'finance', 'operator'),
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
  requireRole('super_admin', 'admin', 'manager', 'finance'),
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
  requireRole('super_admin', 'admin', 'manager', 'finance'),
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

/* ---------------- domains ---------------- */
router.get('/domains', async (req, res, next) => {
  try {
    const { data, error } = await admin.rpc('domain_figures');
    if (error) throw new HttpError(500, 'domains_failed', error.message);
    res.json({
      ok: true,
      domains: (data || []).map(d => ({
        host: d.host,
        label: d.label,
        status: d.status,
        users: Number(d.users),
        depositsMinor: Number(d.deposits_minor),
        withdrawalsMinor: Number(d.withdrawals_minor),
        netMinor: Number(d.deposits_minor) - Number(d.withdrawals_minor)
      }))
    });
  } catch (err) { next(err); }
});

router.post('/domains',
  requireRole('admin', 'super_admin', 'manager'),
  validate(z.object({
    host: z.string().trim().toLowerCase()
      .transform(v => v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .refine(v => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v), 'That does not look like a domain'),
    label: z.string().trim().max(40).optional().default('New'),
    status: z.enum(['live', 'paused']).default('paused')
  })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin
        .from('domains').insert(req.body).select().single();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          throw conflict('That domain is already listed');
        }
        throw new HttpError(400, 'domain_failed', error.message);
      }
      await audit(req, 'domain.create', data.host, { label: data.label });
      res.status(201).json({ ok: true, domain: data });
    } catch (err) { next(err); }
  });

router.patch('/domains/:host',
  requireRole('admin', 'super_admin', 'manager'),
  validate(z.object({
    status: z.enum(['live', 'paused']).optional(),
    label: z.string().trim().max(40).optional()
  })),
  async (req, res, next) => {
    try {
      /* Taking the last live host offline makes the product unreachable
         for everyone, so it is refused here and not only in the UI. */
      if (req.body.status === 'paused') {
        const { count } = await admin
          .from('domains').select('host', { count: 'exact', head: true }).eq('status', 'live');
        if ((count || 0) < 2) {
          throw conflict('That is the only domain still serving traffic');
        }
      }

      const { data, error } = await admin
        .from('domains').update(req.body).eq('host', req.params.host).select().maybeSingle();
      if (error) throw new HttpError(400, 'domain_failed', error.message);
      if (!data) throw notFound('No such domain');

      await audit(req, 'domain.update', data.host, req.body);
      res.json({ ok: true, domain: data });
    } catch (err) { next(err); }
  });

/* ---------------- marketing sessions ---------------- */
async function withFigures(row) {
  const { data } = await admin.rpc('session_figures', { p_session_id: row.id });
  const f = data || {};
  return {
    id: row.id,
    channel: row.channel,
    handler: row.handler,
    domain: row.domain_host,
    note: row.note,
    adSpendMinor: Number(row.ad_spend_minor),
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    depositsMinor: Number(f.depositsMinor || 0),
    withdrawalsMinor: Number(f.withdrawalsMinor || 0),
    stakeVolumeMinor: Number(f.stakeVolumeMinor || 0),
    marginMinor: Number(f.marginMinor || 0),
    signups: Number(f.signups || 0),
    trades: Number(f.trades || 0)
  };
}

router.get('/sessions', async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('sessions').select('*')
      .order('started_at', { ascending: false })
      .limit(Math.min(100, Number(req.query.limit) || 40));
    if (error) throw new HttpError(500, 'sessions_failed', error.message);
    res.json({ ok: true, sessions: await Promise.all((data || []).map(withFigures)) });
  } catch (err) { next(err); }
});

router.post('/sessions',
  requireRole('admin', 'super_admin', 'manager', 'marketing', 'session_handler'),
  validate(z.object({
    channel: z.string().trim().min(1, 'Pick a channel'),
    handler: z.string().trim().min(1, 'Who is hosting it?'),
    domain: z.string().trim().optional(),
    note: z.string().trim().max(200).optional(),
    adSpendMinor: z.coerce.number().int().min(0)
  })),
  async (req, res, next) => {
    try {
      const { data, error } = await admin.from('sessions').insert({
        channel: req.body.channel,
        handler: req.body.handler,
        domain_host: req.body.domain || null,
        note: req.body.note || null,
        ad_spend_minor: req.body.adSpendMinor,
        started_by: req.operator.id
      }).select().single();

      if (error) {
        /* The partial unique index is what actually guarantees one live
           session; this turns its error into something readable. */
        if (/sessions_one_live|duplicate|unique/i.test(error.message)) {
          throw conflict('A session is already running. End it first.');
        }
        throw new HttpError(400, 'session_failed', error.message);
      }

      await audit(req, 'session.start', data.id, { channel: data.channel });
      res.status(201).json({ ok: true, session: await withFigures(data) });
    } catch (err) { next(err); }
  });

router.post('/sessions/:id/end',
  requireRole('admin', 'super_admin', 'manager', 'marketing', 'session_handler'),
  async (req, res, next) => {
    try {
      const { data, error } = await admin
        .from('sessions')
        .update({ status: 'ended', ended_at: new Date().toISOString(), ended_by: req.operator.id })
        .eq('id', req.params.id).eq('status', 'live')
        .select().maybeSingle();
      if (error) throw new HttpError(400, 'session_failed', error.message);
      if (!data) throw notFound('No session is running');

      await audit(req, 'session.end', data.id, { channel: data.channel });
      res.json({ ok: true, session: await withFigures(data) });
    } catch (err) { next(err); }
  });

/* ---------------- staff ----------------
   The assignable roles are STAFF_ROLES, imported so there is one list
   rather than two that drift. */

router.get('/staff', requireRole('admin', 'super_admin', 'manager'), async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('id,email,display_name,role,status,created_at,last_seen_at')
      .neq('role', 'customer')
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, 'staff_failed', error.message);
    res.json({
      ok: true,
      staff: (data || []).map(p => ({
        id: p.id, name: p.display_name || (p.email || '').split('@')[0],
        email: p.email, role: p.role, status: p.status,
        created: p.created_at, lastSeen: p.last_seen_at
      }))
    });
  } catch (err) { next(err); }
});

/* An invitation, not a password. Nobody should ever be in a position to
   know another person's credentials. */
router.post('/staff',
  requireRole('super_admin'),
  validate(z.object({
    email: z.string().trim().toLowerCase().email('That does not look like an email address'),
    name: z.string().trim().min(1, 'Enter their name').max(80),
    role: z.enum(STAFF_ROLES)
  })),
  async (req, res, next) => {
    try {
      const { data: existing } = await admin
        .from('profiles').select('id,role').eq('email', req.body.email).maybeSingle();

      if (existing && existing.role !== 'customer') {
        throw conflict('That address is already an admin');
      }

      let userId = existing?.id;
      if (!userId) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(req.body.email, {
          data: { full_name: req.body.name }
        });
        if (error) throw new HttpError(400, 'invite_failed', error.message);
        userId = data.user.id;
      }

      const { data: profile, error: pErr } = await admin
        .from('profiles')
        .update({ role: req.body.role, display_name: req.body.name })
        .eq('id', userId).select().maybeSingle();
      if (pErr) throw new HttpError(400, 'invite_failed', pErr.message);

      await audit(req, 'staff.invite', userId, { email: req.body.email, role: req.body.role });
      res.status(201).json({
        ok: true,
        staff: {
          id: userId, name: req.body.name, email: req.body.email,
          role: req.body.role, status: profile?.status || 'active',
          created: profile?.created_at, lastSeen: null
        }
      });
    } catch (err) { next(err); }
  });

router.patch('/staff/:id',
  requireRole('super_admin'),
  validate(z.object({
    role: z.enum(STAFF_ROLES.concat(['customer'])).optional(),
    status: z.enum(['active', 'suspended']).optional()
  })),
  async (req, res, next) => {
    try {
      if (req.params.id === req.operator.id) {
        throw badRequest('You cannot change your own access from here.');
      }

      /* Losing the last super admin locks this page for everybody, and
         there is no route back from inside the console. */
      const losingSuper = req.body.role && req.body.role !== 'super_admin';
      const suspending = req.body.status === 'suspended';
      if (losingSuper || suspending) {
        const { data: target } = await admin
          .from('profiles').select('role').eq('id', req.params.id).maybeSingle();
        if (target?.role === 'super_admin') {
          const { count } = await admin
            .from('profiles').select('id', { count: 'exact', head: true })
            .eq('role', 'super_admin').eq('status', 'active');
          if ((count || 0) < 2) throw conflict('There has to be at least one super admin.');
        }
      }

      const { data, error } = await admin
        .from('profiles').update(req.body).eq('id', req.params.id).select().maybeSingle();
      if (error) throw new HttpError(400, 'staff_failed', error.message);
      if (!data) throw notFound('No such admin');

      await audit(req, 'staff.update', req.params.id, req.body);
      res.json({
        ok: true,
        staff: {
          id: data.id, name: data.display_name, email: data.email,
          role: data.role, status: data.status,
          created: data.created_at, lastSeen: data.last_seen_at
        }
      });
    } catch (err) { next(err); }
  });

/* ---------------- audit trail ---------------- */
router.get('/audit', requireRole('super_admin', 'admin'), async (req, res, next) => {
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

/* ============================================================
   Deposits
   Both rails follow the same shape:

     1. Write a pending payment row FIRST, with our own reference.
     2. Ask the provider to collect.
     3. Return; the balance does not move.

   Step 1 comes before step 2 on purpose. If the provider succeeds but
   our response never arrives, the callback still finds a row to settle.
   The other order loses money.

   Nothing in this file credits an account. Only a verified webhook does,
   through settle_deposit() in the database.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { env } from '../config/env.js';
import { newReference } from '../lib/reference.js';
import { events } from '../lib/events.js';
import { normalisePhone } from '../lib/phone.js';
import { formatMinor } from '../lib/money.js';
import * as paystack from '../services/paystack.js';
import * as payhero from '../services/payhero.js';

const router = Router();

const amountMinor = z.coerce.number().int()
  .refine(v => v >= env.MIN_DEPOSIT_MINOR,
    `Minimum deposit is ${formatMinor(env.MIN_DEPOSIT_MINOR)}`)
  .refine(v => v <= env.MAX_DEPOSIT_MINOR,
    `Maximum deposit is ${formatMinor(env.MAX_DEPOSIT_MINOR)}`);

async function createPending({ userId, provider, amount_minor, currency, phone }) {
  const reference = newReference(provider === 'payhero' ? 'MP' : 'CD');
  const { data, error } = await admin
    .from('payments')
    .insert({
      user_id: userId,
      direction: 'deposit',
      provider,
      reference,
      amount_minor,
      currency,
      phone: phone || null,
      status: 'pending'
    })
    .select()
    .single();

  if (error) throw new Error(`could not record payment: ${error.message}`);
  return data;
}

/* ---------------- M-Pesa, via PayHero ---------------- */
router.post('/mpesa',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor,
    phone: z.string().min(6, 'Enter your M-Pesa number'),
    currency: z.string().length(3).default('KES')
  })),
  async (req, res, next) => {
    let payment;
    try {
      const { data: profile } = await admin
        .from('profiles').select('country,display_name')
        .eq('id', req.user.id).single();

      const phone = normalisePhone(req.body.phone, profile?.country || 'KE');
      if (!phone) throw badRequest('That phone number does not look right', {
        phone: 'Enter the number in full, for example 0712345678'
      });

      payment = await createPending({
        userId: req.user.id,
        provider: 'payhero',
        amount_minor: req.body.amountMinor,
        currency: req.body.currency,
        phone
      });

      const result = await payhero.stkPush({
        phone,
        amountMinor: payment.amount_minor,
        reference: payment.reference,
        name: profile?.display_name
      });

      await admin.from('payments')
        .update({
          provider_ref: result?.reference || result?.CheckoutRequestID || null,
          raw: result
        })
        .eq('id', payment.id);

      res.status(202).json({
        ok: true,
        status: 'pending',
        reference: payment.reference,
        message: 'Check your phone for the M-Pesa prompt and enter your PIN.'
      });
    } catch (err) {
      /* The push never left. Close the row so it cannot sit pending
         forever and be picked up by reconciliation. */
      if (payment) {
        await admin.rpc('fail_payment', {
          p_payment_id: payment.id,
          p_reason: err.message?.slice(0, 300) || 'stk push failed',
          p_raw: null
        }).catch(() => {});
      }
      events.error('payhero', 'STK push failed: ' + (err.message || 'unknown'), {
        userId: req.user.id,
        reference: payment?.reference,
        context: { amountMinor: req.body.amountMinor }
      });
      next(err);
    }
  });

/* ---------------- Card, via Paystack ---------------- */
router.post('/card',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor,
    currency: z.string().length(3).default('KES')
  })),
  async (req, res, next) => {
    let payment;
    try {
      payment = await createPending({
        userId: req.user.id,
        provider: 'paystack',
        amount_minor: req.body.amountMinor,
        currency: req.body.currency
      });

      const result = await paystack.initializeTransaction({
        email: req.user.email,
        amountMinor: payment.amount_minor,
        currency: payment.currency,
        reference: payment.reference,
        metadata: { user_id: req.user.id, payment_id: payment.id }
      });

      await admin.from('payments')
        .update({ provider_ref: result.reference || null, raw: result })
        .eq('id', payment.id);

      res.status(201).json({
        ok: true,
        status: 'pending',
        reference: payment.reference,
        checkoutUrl: result.authorization_url,
        accessCode: result.access_code
      });
    } catch (err) {
      if (payment) {
        await admin.rpc('fail_payment', {
          p_payment_id: payment.id,
          p_reason: err.message?.slice(0, 300) || 'initialize failed',
          p_raw: null
        }).catch(() => {});
      }
      events.error('paystack', 'Could not open a checkout: ' + (err.message || 'unknown'), {
        userId: req.user.id,
        reference: payment?.reference,
        context: { amountMinor: req.body.amountMinor }
      });
      next(err);
    }
  });

/* ---------------- polling ----------------
   The browser sits on the waiting screen and polls this. If a callback
   was lost, asking the provider directly here is what rescues the
   deposit. */
router.get('/:reference', requireAuth, async (req, res, next) => {
  try {
    const { data: payment } = await admin
      .from('payments').select('*')
      .eq('reference', req.params.reference)
      .eq('user_id', req.user.id)          // never another user's payment
      .maybeSingle();

    if (!payment) throw notFound('No such payment');

    if (payment.status === 'pending') {
      await reconcile(payment).catch(() => {});
      const { data: fresh } = await admin
        .from('payments').select('*').eq('id', payment.id).single();
      return res.json({ ok: true, payment: publicPayment(fresh) });
    }

    res.json({ ok: true, payment: publicPayment(payment) });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data } = await req.db
      .from('payments')
      .select('*')
      .eq('direction', 'deposit')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ ok: true, payments: (data || []).map(publicPayment) });
  } catch (err) { next(err); }
});

/* Ask the provider what happened, then settle or fail accordingly.
   Exported so a scheduled job can sweep stale pendings too. */
export async function reconcile(payment) {
  const { localToUsdMinor } = await import('../lib/money.js');

  if (payment.provider === 'paystack') {
    const tx = await paystack.verifyTransaction(payment.reference);
    if (tx.status === 'success') {
      /* Trust the provider's amount, not ours: it is what was actually
         collected. */
      const credited = localToUsdMinor(tx.amount, tx.currency || payment.currency);
      await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: String(tx.id || tx.reference),
        p_credited_minor: credited,
        p_raw: tx
      });
    } else if (['failed', 'abandoned', 'reversed'].includes(tx.status)) {
      await admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: tx.gateway_response || tx.status,
        p_raw: tx
      });
    }
    return;
  }

  if (payment.provider === 'payhero') {
    const tx = await payhero.transactionStatus(payment.reference);
    const info = payhero.readCallback(tx);
    if (payhero.isSuccess(info.status)) {
      const collectedMinor = info.amount != null
        ? Math.round(Number(info.amount) * 100)
        : payment.amount_minor;
      await admin.rpc('settle_deposit', {
        p_payment_id: payment.id,
        p_provider_ref: info.providerRef,
        p_credited_minor: localToUsdMinor(collectedMinor, payment.currency),
        p_raw: tx
      });
    } else if (payhero.isFailure(info.status)) {
      await admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: info.status || 'failed',
        p_raw: tx
      });
    }
  }
}

function publicPayment(p) {
  return {
    reference: p.reference,
    status: p.status,
    amountMinor: p.amount_minor,
    currency: p.currency,
    creditedMinor: p.credited_minor,
    provider: p.provider,
    failureReason: p.failure_reason,
    createdAt: p.created_at,
    settledAt: p.settled_at
  };
}

export default router;

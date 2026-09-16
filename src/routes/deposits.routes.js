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
import * as demo from '../services/mpesaDemo.js';
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

      /* The fork. A VIP settles against the companion handset instead of
         against PayHero, and the customer's browser never knows the
         difference: same endpoint, same request, same shape back. The
         decision is made here, from the database, rather than being
         something the client can ask for. */
      if (await demo.tierOf(req.user.id) === 'vip') {
        return depositFromHandset(req, res, { phone, profile });
      }

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

      /* Recorded on the way out, not only when it breaks. "The push was
         accepted and here is exactly what they said" is the line that
         settles an argument about whether a prompt was ever sent. */
      events.info('payhero', 'STK push accepted for ' + phone.slice(0, 6) + '***', {
        userId: req.user.id,
        reference: payment.reference,
        context: { amountMinor: payment.amount_minor, response: result }
      });

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

/* ---------------- the VIP demo rail ----------------
   Where the Standard path raises a real STK push and waits for a
   callback, this takes the money off the handset and settles at once.

   Order matters, and it is the opposite of the real path's. The phone is
   debited FIRST: if the deposit then fails to book or settle, the phone
   is refunded, so a failure cannot leave a demo down a balance it never
   traded with. On the real path the payment row is written first,
   because there the risk runs the other way, money taken with nothing to
   settle against. Same principle, different direction: never leave the
   customer short. */
async function depositFromHandset(req, res, { phone, profile }) {
  const amountMinor = req.body.amountMinor;
  const reference = newReference('VIP');
  let payment;

  /* 1. Take it off the phone. */
  let moved;
  try {
    moved = await demo.move({
      userId: req.user.id,
      kind: 'DEPOSIT',
      amountMinor,
      direction: 'OUT',
      title: 'Pay to Novi',
      subtitle: 'Trading deposit',
      reference
    });
  } catch (err) {
    if (err instanceof demo.InsufficientFunds || err instanceof demo.NoWallet) throw err;
    events.error('mpesa-demo', 'Could not debit the handset: ' + (err.message || 'unknown'), {
      userId: req.user.id, reference
    });
    throw err;
  }

  const refund = () => demo.move({
    userId: req.user.id,
    kind: 'REVERSAL',
    amountMinor,
    direction: 'IN',
    title: 'Reversal, Novi',
    subtitle: 'Deposit could not be completed',
    reference
  }).catch(() => undefined);

  /* 2. Put it on the trading balance, through the same function a real
        deposit uses, so the ledger cannot tell the two apart. */
  try {
    payment = await createPending({
      userId: req.user.id,
      provider: 'mpesa_demo',
      amount_minor: amountMinor,
      currency: req.body.currency,
      phone
    });

    const { localToUsdMinor } = await import('../lib/money.js');
    const { error: settleError } = await admin.rpc('settle_deposit', {
      p_payment_id: payment.id,
      p_provider_ref: moved.tx.reference,
      p_credited_minor: localToUsdMinor(amountMinor, req.body.currency),
      p_raw: { rail: 'mpesa_demo', balanceAfterMinor: moved.balanceMinor }
    });
    if (settleError) throw new Error(settleError.message);
  } catch (err) {
    await refund();
    if (payment) {
      await admin.rpc('fail_payment', {
        p_payment_id: payment.id,
        p_reason: 'demo rail could not settle',
        p_raw: null
      }).catch(() => {});
    }
    events.error('mpesa-demo', 'Deposit failed after the handset was debited, refunded: ' +
      (err.message || 'unknown'), { userId: req.user.id, reference });
    throw err;
  }

  events.info('mpesa-demo', 'VIP deposit settled from the handset', {
    userId: req.user.id,
    reference,
    context: { amountMinor, balanceAfterMinor: moved.balanceMinor }
  });

  /* Answered as settled rather than pending, because it is: there is no
     callback coming. The browser's poll finds it already successful. */
  return res.status(201).json({
    ok: true,
    status: 'success',
    rail: 'demo',
    reference: payment.reference,
    creditedMinor: amountMinor,
    handset: {
      balanceMinor: moved.balanceMinor,
      fulizaUsedMinor: moved.fulizaUsedMinor,
      fulizaLimitMinor: moved.fulizaLimitMinor
    },
    message: 'Paid from your M-Pesa. The balance is on your account now.'
  });
}

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
      /* Not swallowed. A reconcile that throws on every poll is exactly
         the shape of "the money left my phone and the screen still says
         waiting" — and with the error discarded there was nothing
         anywhere to say so. */
      await reconcile(payment).catch(err => {
        events.error('payhero', 'Could not confirm ' + payment.reference +
          ': ' + (err?.message || 'unknown'), {
          userId: req.user.id,
          reference: payment.reference,
          context: { provider: payment.provider, providerRef: payment.provider_ref }
        });
      });
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
    const found = await payhero.findTransaction(payment);
    const tx = found.body;
    const info = found.info;

    if (!info || !info.status) {
      /* Asked with every handle we have and none of them named a status.
         Worth recording: a payment the customer says they made, that the
         provider will not confirm, is the case that needs a human. */
      events.warn('payhero', 'Status lookup returned nothing for ' + payment.reference, {
        reference: payment.reference,
        context: { tried: [payment.provider_ref, payment.reference].filter(Boolean), response: tx }
      });
      return;
    }

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
    } else {
      /* Neither success nor failure we recognise — still in flight, or a
         status word we have not seen. Recorded so an unknown one shows up
         here rather than as a customer waiting on a spinner. */
      events.info('payhero', 'Payment still unsettled: status "' + info.status + '"', {
        reference: payment.reference,
        context: { handle: found.handle, status: info.status }
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

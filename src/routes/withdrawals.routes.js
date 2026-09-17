/* ============================================================
   Withdrawals
   A request holds the funds immediately, then waits for a human. It is
   deliberately not automatic: an auto-payout endpoint is the single
   most valuable thing an attacker can find in a trading product, and
   the delay costs an honest customer under an hour.

   The hold is what stops the same balance being requested twice while
   the first request is still in review — see hold_for_withdrawal().
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import { badRequest, forbidden, notFound, conflict, HttpError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { formatMinor } from '../lib/money.js';
import { normalisePhone } from '../lib/phone.js';
import { events } from '../lib/events.js';
import * as demo from '../services/mpesaDemo.js';

const router = Router();

router.post('/',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor: z.coerce.number().int()
      .refine(v => v >= env.MIN_WITHDRAWAL_MINOR,
        `Minimum withdrawal is ${formatMinor(env.MIN_WITHDRAWAL_MINOR, 'USD')}`),
    method: z.enum(['mpesa', 'bank', 'card', 'usdt']).default('mpesa'),
    phone: z.string().optional(),
    /* The country the customer picked on the field. Only a hint: the
       number is normalised from its own dialling code first. */
    country: z.string().length(2).optional(),
    bank: z.object({
      accountName: z.string().min(2),
      accountNumber: z.string().min(4),
      bankCode: z.string().min(2)
    }).optional(),
    /* Bank, name and account number: a payout is a transfer into an
       account, not a reverse card charge. Somebody who deposited by
       phone has no card to send it back to. A card number is
       deliberately not accepted here, and could not be used for a payout
       if it were. */
    card: z.object({
      bank: z.string().min(2).max(80),
      name: z.string().min(2).max(80),
      account: z.string().regex(/^[0-9]{6,20}$/)
    }).optional(),
    address: z.string().min(20).max(120).optional(),
    network: z.string().max(40).optional()
  })),
  async (req, res, next) => {
    try {
      const { data: profile } = await admin
        .from('profiles').select('kyc_status,country,phone,tier')
        .eq('id', req.user.id).single();

      /* A VIP funded from the prop wallet, so their payout goes back to
         the prop wallet. This is what closes the loop: fake money in,
         fake money out, and no route at all from a VIP balance to real
         cash. Before this the two rails met here, and the only thing
         stopping a staged win being paid in shillings was a person
         noticing on the review screen.

         Taken before the identity check on purpose. Verifying a document
         to move a prop balance is theatre, and asking for one is how a
         demonstration stalls. */
      if (profile?.tier === 'vip') {
        return withdrawToHandset(req, res, { profile });
      }

      /* Identity first. This is a regulatory requirement, not a product
         preference, and it is cheaper to enforce before the money is
         held than to unwind afterwards. */
      if (profile?.kyc_status !== 'verified') {
        throw forbidden('Verify your identity before your first withdrawal.');
      }

      let destination;
      if (req.body.method === 'mpesa') {
        const phone = normalisePhone(
          req.body.phone || profile.phone,
          req.body.country || profile.country || 'KE');
        if (!phone) throw badRequest('We need the M-Pesa number to pay out to', {
          phone: 'Enter the number in full, for example 0712345678'
        });
        destination = { phone };
      } else if (req.body.method === 'card') {
        if (!req.body.card) throw badRequest('Tell us where to send it', {
          card: 'Enter the bank, the name and the account number'
        });
        destination = req.body.card;
      } else if (req.body.method === 'usdt') {
        if (!req.body.address) throw badRequest('Enter the wallet address', {
          address: 'A payout to the wrong address cannot be reversed'
        });
        destination = { address: req.body.address, network: req.body.network || 'TRC-20' };
      } else {
        if (!req.body.bank) throw badRequest('Enter the bank account details');
        destination = req.body.bank;
      }

      /* One open request at a time. Two pending payouts is how people
         end up double-paid when an operator approves both. */
      const { data: existing } = await admin
        .from('withdrawal_requests')
        .select('id')
        .eq('user_id', req.user.id)
        .in('status', ['pending', 'approved'])
        .limit(1);

      if (existing?.length) {
        throw conflict('You already have a withdrawal in progress. It will clear within the hour.');
      }

      /* The hold and the row are written in one database transaction, so
         a crash cannot debit without recording why. */
      const { data, error } = await admin.rpc('hold_for_withdrawal', {
        p_user_id: req.user.id,
        p_amount_minor: req.body.amountMinor,
        p_method: req.body.method,
        p_destination: destination
      });

      if (error) {
        if (/insufficient funds/i.test(error.message)) {
          throw badRequest('That is more than your available balance', {
            amountMinor: 'Not enough funds'
          });
        }
        throw new HttpError(400, 'withdrawal_failed', error.message);
      }

      const request = Array.isArray(data) ? data[0] : data;

      res.status(201).json({
        ok: true,
        request: publicRequest(request),
        message: 'Requested. Payouts are reviewed and sent within the hour.'
      });
    } catch (err) { next(err); }
  });

/* ---------------- the VIP demo rail ----------------
   The mirror of depositFromHandset. The trading balance is debited
   through the same function a real request uses, so the ledger reads the
   same, and the money lands on the handset instead of in a queue for
   somebody to pay by hand.

   Order is the reverse of the deposit's, and for the same reason: debit
   the side that can be put back. The balance is held first, and if the
   handset then cannot be credited the hold is released, so a failure
   cannot leave a demo holding a balance that is neither on the account
   nor on the phone. */
async function withdrawToHandset(req, res, next) {
  const amountMinor = req.body.amountMinor;

  /* 1. Take it off the trading balance, and settle the request in the
        same breath: there is nobody to review a payout that is not real,
        and a pending row nobody will ever action is worse than no row. */
  const { data, error } = await admin.rpc('hold_for_withdrawal', {
    p_user_id: req.user.id,
    p_amount_minor: amountMinor,
    p_method: 'mpesa_demo',
    p_destination: { rail: 'mpesa_demo' }
  });

  if (error) {
    if (/insufficient funds/i.test(error.message)) {
      throw badRequest('That is more than your available balance', {
        amountMinor: 'Not enough funds'
      });
    }
    throw new HttpError(400, 'withdrawal_failed', error.message);
  }

  const request = Array.isArray(data) ? data[0] : data;

  /* 2. Put it on the phone. */
  let moved;
  try {
    moved = await demo.move({
      userId: req.user.id,
      kind: 'WITHDRAWAL',
      amountMinor,
      direction: 'IN',
      title: 'Received from Novi',
      subtitle: 'Trading withdrawal'
    });
  } catch (err) {
    /* release_withdrawal takes a status, not an actor: 'cancelled' is
       what puts the held amount back on the balance. */
    await admin.rpc('release_withdrawal', {
      p_request_id: request.id,
      p_status: 'cancelled',
      p_note: 'demo rail could not credit the handset'
    }).catch(() => {});
    events.error('mpesa-demo', 'Withdrawal failed after the balance was held, released: ' +
      (err.message || 'unknown'), { userId: req.user.id, context: { amountMinor } });
    throw err;
  }

  /* reviewed_by stays null on purpose: nobody reviewed this, the rail
     paid it. A staff id here would be a person's name against a payout
     they never saw. */
  await admin.rpc('settle_withdrawal', {
    p_request_id: request.id,
    p_actor: null,
    p_note: 'Paid to the M-Pesa demo handset'
  }).catch(() => {});

  events.info('mpesa-demo', 'VIP withdrawal paid onto the handset', {
    userId: req.user.id,
    context: { amountMinor, balanceAfterMinor: moved.balanceMinor }
  });

  return res.status(201).json({
    ok: true,
    status: 'paid',
    rail: 'demo',
    request: publicRequest(request),
    handset: {
      balanceMinor: moved.balanceMinor,
      fulizaUsedMinor: moved.fulizaUsedMinor
    },
    message: 'Sent to your M-Pesa. It is on the phone now.'
  });
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data } = await req.db
      .from('withdrawal_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ ok: true, requests: (data || []).map(publicRequest) });
  } catch (err) { next(err); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data } = await req.db
      .from('withdrawal_requests').select('*')
      .eq('id', req.params.id).maybeSingle();
    if (!data) throw notFound('No such request');
    res.json({ ok: true, request: publicRequest(data) });
  } catch (err) { next(err); }
});

/* Cancelling returns the held funds, through the same function an
   operator's rejection uses. */
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const { data: existing } = await admin
      .from('withdrawal_requests').select('id,user_id,status')
      .eq('id', req.params.id).maybeSingle();

    if (!existing || existing.user_id !== req.user.id) throw notFound('No such request');
    if (existing.status !== 'pending') {
      throw conflict('That request is already being processed.');
    }

    const { data, error } = await admin.rpc('release_withdrawal', {
      p_request_id: req.params.id,
      p_status: 'cancelled',
      p_note: 'cancelled by the account holder'
    });
    if (error) throw new HttpError(400, 'cancel_failed', error.message);

    res.json({ ok: true, request: publicRequest(Array.isArray(data) ? data[0] : data) });
  } catch (err) { next(err); }
});

function publicRequest(r) {
  return {
    id: r.id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    method: r.method,
    status: r.status,
    createdAt: r.created_at,
    settledAt: r.settled_at
  };
}

export default router;

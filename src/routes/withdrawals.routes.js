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
import { normalisePhone } from '../lib/phone.js';
import { formatMinor } from '../lib/money.js';

const router = Router();

router.post('/',
  requireAuth,
  paymentLimiter,
  validate(z.object({
    amountMinor: z.coerce.number().int()
      .refine(v => v >= env.MIN_WITHDRAWAL_MINOR,
        `Minimum withdrawal is ${formatMinor(env.MIN_WITHDRAWAL_MINOR, 'USD')}`),
    method: z.enum(['mpesa', 'bank']).default('mpesa'),
    phone: z.string().optional(),
    bank: z.object({
      accountName: z.string().min(2),
      accountNumber: z.string().min(4),
      bankCode: z.string().min(2)
    }).optional()
  })),
  async (req, res, next) => {
    try {
      const { data: profile } = await admin
        .from('profiles').select('kyc_status,country,phone')
        .eq('id', req.user.id).single();

      /* Identity first. This is a regulatory requirement, not a product
         preference, and it is cheaper to enforce before the money is
         held than to unwind afterwards. */
      if (profile?.kyc_status !== 'verified') {
        throw forbidden('Verify your identity before your first withdrawal.');
      }

      let destination;
      if (req.body.method === 'mpesa') {
        const phone = normalisePhone(req.body.phone || profile.phone, profile.country || 'KE');
        if (!phone) throw badRequest('We need the M-Pesa number to pay out to', {
          phone: 'Enter the number in full, for example 0712345678'
        });
        destination = { phone };
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

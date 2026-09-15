/* ============================================================
   PayHero — M-Pesa STK push
   Docs: https://payhero.co.ke (dashboard → API)

   PayHero authenticates with HTTP Basic: base64(api_username:api_password).

   IMPORTANT: unlike Paystack, PayHero does not sign its callbacks. There
   is nothing in the payload that proves it came from them. Two things
   compensate, and both matter:

     1. The callback URL carries a secret path token, derived from a key
        only this server holds, that only we and PayHero know. A caller
        without it is rejected.
     2. We never trust the amount or status in the callback body. It is
        treated purely as a nudge to go and ask PayHero what happened,
        and the answer from that query is what settles the payment.

   Amounts: PayHero takes whole shillings, NOT cents. Everything else in
   this codebase is in minor units, so the conversion happens here and
   is the only place it should ever happen.
   ============================================================ */
import { env, payheroToken, payheroCallbackSecret } from '../config/env.js';
import { upstream } from '../lib/errors.js';

async function call(path, options = {}) {
  if (!payheroToken) {
    throw upstream('M-Pesa is not configured on this server');
  }

  let res;
  try {
    res = await fetch(`${env.PAYHERO_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Basic ${payheroToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
  } catch {
    throw upstream('Could not reach the M-Pesa provider');
  }

  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    throw upstream(body.error_message || body.message || `PayHero returned ${res.status}`);
  }
  return body;
}

/**
 * Send the STK prompt to the customer's handset.
 *
 * @param {string} phone      254XXXXXXXXX
 * @param {number} amountMinor  cents — converted to shillings here
 * @param {string} reference  our reference, echoed back on the callback
 */
export async function stkPush({ phone, amountMinor, reference, name }) {
  const amount = Math.round(amountMinor / 100);   // PayHero wants shillings

  return call('/payments', {
    method: 'POST',
    body: JSON.stringify({
      amount,
      phone_number: phone,
      channel_id: Number(env.PAYHERO_CHANNEL_ID) || undefined,
      provider: 'm-pesa',
      external_reference: reference,
      customer_name: name || undefined,
      callback_url: callbackUrl()
    })
  });
}

/**
 * The authoritative answer. Called after a callback arrives, and also by
 * the reconcile job for payments whose callback never showed up — mobile
 * money callbacks do get lost, and a deposit that silently never lands
 * is the worst failure this system can have.
 */
export async function transactionStatus(reference) {
  return call(`/transaction-status?reference=${encodeURIComponent(reference)}`);
}

export function callbackUrl() {
  return `${env.API_URL}/webhooks/payhero/${payheroCallbackSecret}`;
}

/**
 * PayHero's payload shape has varied between accounts and versions, so
 * pull the few fields we need defensively rather than assuming one
 * layout. Everything here is a hint only — status is confirmed by
 * transactionStatus() before any money moves.
 */
export function readCallback(body) {
  const r = body?.response || body?.data || body || {};
  return {
    reference: r.ExternalReference || r.external_reference || r.reference || null,
    providerRef: r.MpesaReceiptNumber || r.mpesa_receipt_number ||
                 r.CheckoutRequestID || r.transaction_reference || null,
    status: String(r.Status || r.status || '').toLowerCase(),
    amount: r.Amount ?? r.amount ?? null,
    phone: r.Phone || r.phone_number || null
  };
}

export function isSuccess(status) {
  return ['success', 'completed', 'successful'].includes(String(status || '').toLowerCase());
}

export function isFailure(status) {
  return ['failed', 'cancelled', 'canceled', 'timeout', 'expired']
    .includes(String(status || '').toLowerCase());
}

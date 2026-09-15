/* ============================================================
   Paystack — card deposits
   Docs: https://paystack.com/docs/api/transaction/

   Two things matter here and nowhere else in the codebase:

   1. Amount is in the currency's minor unit. KES 100 is 10000. Sending
      100 would charge one shilling and nobody would notice until a
      customer complained.
   2. The webhook signature is an HMAC SHA-512 of the RAW request body.
      Parse the body first and the bytes change, the signature fails,
      and every deposit silently stops settling. See webhooks.routes.js
      for the express.raw mounting that keeps this working.
   ============================================================ */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { upstream } from '../lib/errors.js';

const API = 'https://api.paystack.co';

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
  } catch (cause) {
    throw upstream('Could not reach Paystack');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw upstream(body.message || `Paystack returned ${res.status}`);
  }
  return body.data;
}

/**
 * Start a card payment. Returns the hosted checkout URL to send the
 * person to; we never see their card number, which keeps this service
 * out of PCI scope.
 */
export async function initializeTransaction({ email, amountMinor, currency, reference, metadata }) {
  return call('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount: amountMinor,              // already minor units
      currency,
      reference,
      callback_url: `${env.APP_URL}/index.html?deposit=${encodeURIComponent(reference)}`,
      metadata: metadata || {}
    })
  });
}

/**
 * Ask Paystack what actually happened. The webhook is the trigger, but
 * this is the truth: we re-verify before crediting so a forged or
 * replayed callback cannot invent a successful payment.
 */
export async function verifyTransaction(reference) {
  return call(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Constant-time signature check. A plain === leaks timing information
 * about how much of the digest matched.
 */
export function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

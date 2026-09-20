/* ============================================================
   Celcom Africa — the SMS gateway

   One job: hand a message to Celcom and report honestly whether it was
   accepted. Nothing in here knows what an M-Pesa message looks like;
   that lives in mpesaSms.js, so the gateway can be swapped for another
   one without touching a single word of customer-facing text.

   Two rules, both learned the hard way on rails like this one:

     * sending must never be the reason a request fails. Every call here
       resolves — a refused SMS is logged, not thrown, because a deposit
       that settled is still a deposit that settled.
     * not configured is a state, not an error. With no credentials the
       service simply reports 'off' and the demo runs silently, which is
       what a laptop with no .env should do.

   The API is documented at celcomafrica.com. The response is a JSON
   envelope with a responses[] array; the code key is spelled
   "response-code" in most replies and "respose-code" in some, which is
   their typo rather than ours, so both are read.
   ============================================================ */
import { env } from '../config/env.js';
import { events } from '../lib/events.js';
import { normalisePhone } from '../lib/phone.js';

const TIMEOUT_MS = 8000;

/* Both credentials and a sender ID, or there is nothing to send with.
   Partial configuration is treated as none: a half-set gateway that
   fails on every message is worse than one that never tries. */
export function smsConfigured() {
  return !!(env.CELCOM_API_KEY && env.CELCOM_PARTNER_ID && env.CELCOM_SHORTCODE);
}

export function smsSender() {
  return env.CELCOM_SHORTCODE || null;
}

/* Their code lives under one of two spellings, and arrives as a string
   as often as a number. */
function codeOf(entry) {
  const raw = entry?.['response-code'] ?? entry?.['respose-code'] ?? entry?.code;
  return Number(raw);
}

/**
 * Send one message to one handset.
 *
 * Never throws. Resolves to { ok, status, detail, messageId }, where
 * status is one of:
 *   sent    — the gateway accepted it
 *   off     — no credentials here
 *   refused — the gateway answered, and said no (bad number, no credit)
 *   down    — it did not answer
 *
 * @param {string} to       any shape a Kenyan types; normalised here
 * @param {string} message  the text, as the handset will read it
 */
export async function sendSms(to, message) {
  if (!smsConfigured()) {
    return { ok: false, status: 'off', detail: 'No Celcom credentials set' };
  }

  const mobile = normalisePhone(to, 'KE');
  if (!mobile) {
    return { ok: false, status: 'refused', detail: `Not a phone number: ${to}` };
  }

  const body = {
    apikey: env.CELCOM_API_KEY,
    partnerID: env.CELCOM_PARTNER_ID,
    shortcode: env.CELCOM_SHORTCODE,
    mobile,
    message: String(message || '').slice(0, 900)
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${env.CELCOM_BASE_URL}/sendsms/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }

    if (!parsed) {
      return {
        ok: false,
        status: res.ok ? 'refused' : 'down',
        detail: `HTTP ${res.status}: ${text.slice(0, 160) || 'empty reply'}`
      };
    }

    /* A single send still comes back inside the array. */
    const entry = Array.isArray(parsed.responses) ? parsed.responses[0] : parsed;
    const code = codeOf(entry);
    const detail = entry?.['response-description'] ||
                   entry?.['respose-description'] || `code ${code}`;

    if (code === 200) {
      return { ok: true, status: 'sent', detail, messageId: entry?.messageid ?? null };
    }
    /* 1001–1010 are their credential and balance errors; all of them are
       an answer, so none of them is 'down'. */
    return { ok: false, status: 'refused', detail: `${detail} (${code || 'no code'})` };
  } catch (err) {
    return {
      ok: false,
      status: 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send, and write the outcome to the event log. The caller gets the
 * result back but is expected to ignore it: this is the fire-and-forget
 * door, used by anything on a money path.
 */
export async function sendSmsLogged(to, message, { userId, reference, what } = {}) {
  const out = await sendSms(to, message);

  if (out.status === 'off') return out;          /* silence is configured */

  if (out.ok) {
    events.info('sms', `Sent ${what || 'a message'} to the handset`, {
      userId, reference, context: { to, status: out.status, messageId: out.messageId }
    });
  } else {
    events.warn('sms', `Could not send ${what || 'a message'}: ${out.detail}`, {
      userId, reference, context: { to, status: out.status }
    });
  }
  return out;
}

/* ---------------- health ----------------
   Celcom publishes no status endpoint, so this asks the delivery-report
   endpoint about a message ID that cannot exist. What is being tested is
   whether the gateway answers and whether it accepts the credentials —
   that the lookup finds nothing is the expected result, not a failure.
   The same shape as the PayHero probe next door, for the same reason. */
export async function checkSms() {
  const started = Date.now();
  if (!smsConfigured()) {
    return { status: 'off', detail: 'No Celcom credentials set', ms: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${env.CELCOM_BASE_URL}/getdlr/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        apikey: env.CELCOM_API_KEY,
        partnerID: env.CELCOM_PARTNER_ID,
        messageID: '0'
      }),
      signal: controller.signal
    });

    const text = await res.text();
    const ms = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      return { status: 'auth', detail: 'API key rejected', ms };
    }
    if (res.status >= 500) return { status: 'down', detail: `HTTP ${res.status}`, ms };
    if (/invalid.*(api|key|partner)/i.test(text)) {
      return { status: 'auth', detail: 'API key rejected', ms };
    }
    return { status: 'live', detail: `Sender ${env.CELCOM_SHORTCODE}`, ms };
  } catch (err) {
    return {
      status: 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable'),
      ms: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

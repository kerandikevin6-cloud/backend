/* ============================================================
   Africa's Talking — the other SMS gateway

   Same four questions as celcom.js, so sms.js can hold the two in a list
   and take whichever is configured. This one is second in that list: it
   is here because a sandbox account can be had in a minute and a
   registered Celcom sender ID cannot, which makes it the one to test a
   demo on before the real credentials exist.

   Two things about it worth knowing before a presentation:

     * The sandbox sends to nobody. A message to a sandbox app is
       accepted, billed to nothing and delivered only to the simulator on
       their dashboard — it will never reach the phone in the room. For
       that, a live app and a live API key.
     * Without a registered sender ID the message arrives from
       AFRICASTKNG, their shared shortcode. Fine for a test, wrong for a
       demo where the text is meant to read as coming from us.

   Form-encoded rather than JSON, and the API key rides in a header
   rather than the body: that is their v1 API, not a preference.
   ============================================================ */
import { env } from '../config/env.js';

export const label = "Africa's Talking";
const TIMEOUT_MS = 8000;

export function configured() {
  return !!(env.AFRICASTALKING_USERNAME && env.AFRICASTALKING_API_KEY);
}

/* Their default when nothing is registered. Named here rather than left
   blank so the console can show what a message will actually say it came
   from, which is the thing an operator needs to check. */
const SHARED = 'AFRICASTKNG';

export function sender() {
  return env.AFRICASTALKING_SENDER_ID || SHARED;
}

/* A sandbox username only works against the sandbox host, and a live one
   only against the live host. Deriving it from the username rather than
   asking for a second setting removes the one mistake this pair can
   make: a live key pointed at the sandbox answers politely and delivers
   nothing. */
function baseUrl() {
  return env.AFRICASTALKING_USERNAME === 'sandbox'
    ? 'https://api.sandbox.africastalking.com/version1'
    : 'https://api.africastalking.com/version1';
}

export function isSandbox() {
  return env.AFRICASTALKING_USERNAME === 'sandbox';
}

/* 100 processed, 101 sent, 102 queued — all three mean they have it.
   The rest are theirs to explain, and the ones worth naming are named:
   a presentation that fails on 405 should say "no credit" rather than
   "code 405". */
const ACCEPTED = new Set([100, 101, 102]);
const REASONS = {
  401: 'Held for risk review',
  402: 'That sender ID is not registered',
  403: 'The number is not a valid phone number',
  404: 'That kind of number is not supported',
  405: 'Not enough credit on the account',
  406: 'The number has blacklisted this sender',
  407: 'Could not be routed to the network',
  409: 'Do not disturb rejected it',
  500: 'Their server errored',
  501: 'Their gateway errored',
  502: 'Rejected by the network'
};

export async function send(mobile, message) {
  const body = new URLSearchParams({
    username: env.AFRICASTALKING_USERNAME,
    /* They want it international, with the plus. sms.js hands over bare
       digits, which is the one shape every caller here agrees on. */
    to: '+' + mobile,
    message
  });
  if (env.AFRICASTALKING_SENDER_ID) body.set('from', env.AFRICASTALKING_SENDER_ID);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl()}/messaging`, {
      method: 'POST',
      headers: {
        apiKey: env.AFRICASTALKING_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body,
      signal: controller.signal
    });

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: 'refused',
        detail: `${isSandbox() ? 'sandbox' : 'live'} host refused the key ` +
          `(HTTP ${res.status}${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 90) : ''})`
      };
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    if (!parsed) {
      return {
        ok: false,
        status: res.ok ? 'refused' : 'down',
        detail: `HTTP ${res.status}: ${text.slice(0, 160) || 'empty reply'}`
      };
    }

    const data = parsed.SMSMessageData || {};
    const first = Array.isArray(data.Recipients) ? data.Recipients[0] : null;

    /* No recipient at all means it was not even attempted, and the
       summary line is the only thing that says why — usually an invalid
       number or a sender ID they will not accept. */
    if (!first) {
      return {
        ok: false,
        status: 'refused',
        detail: data.Message || 'The gateway accepted nothing'
      };
    }

    const code = Number(first.statusCode);
    if (ACCEPTED.has(code)) {
      return {
        ok: true,
        status: 'sent',
        detail: `${first.status || 'Success'}${first.cost ? ', ' + first.cost : ''}` +
          (isSandbox() ? ' (sandbox — it reaches the simulator, not the phone)' : ''),
        messageId: first.messageId || null
      };
    }
    return {
      ok: false,
      status: 'refused',
      detail: `${REASONS[code] || first.status || 'Refused'} (${code || 'no code'})`
    };
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

/* The balance on the account: authenticated, cheap, and the number an
   operator actually wants before a demo — a gateway with no credit is
   "live" by every other measure and will still send nothing. */
export async function check() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${baseUrl()}/user?username=` +
      encodeURIComponent(env.AFRICASTALKING_USERNAME);
    const res = await fetch(url, {
      headers: { apiKey: env.AFRICASTALKING_API_KEY, Accept: 'application/json' },
      signal: controller.signal
    });

    /* Their own words, not ours. "API key rejected" is true and useless:
       the same 401 comes back for a key from the wrong app, a key with a
       stray space in it, and a live key sent to the sandbox host, and an
       operator staring at a tile cannot tell those apart. Whatever they
       said goes on the row, along with which host was asked — that pair
       is usually the whole diagnosis. */
    const text = await res.text();
    const where = isSandbox() ? 'sandbox' : 'live';

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'auth',
        detail: `${where} host refused the key (HTTP ${res.status}` +
          `${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 90) : ''})`
      };
    }
    if (res.status >= 500) return { status: 'down', detail: `HTTP ${res.status}` };

    let body = {};
    try { body = JSON.parse(text); } catch { /* not fatal: only the balance */ }
    const balance = body?.UserData?.balance;
    return {
      status: 'live',
      detail: `Africa's Talking (${where}), sender ${sender()}` +
        (balance ? `, ${balance}` : '')
    };
  } catch (err) {
    return {
      status: 'down',
      detail: err?.name === 'AbortError'
        ? `No answer within ${TIMEOUT_MS / 1000}s`
        : (err?.message || 'Unreachable')
    };
  } finally {
    clearTimeout(timer);
  }
}

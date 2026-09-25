/* ============================================================
   The Novi Wallet text

   Every movement on the demo rail ends with a message on the handset:
   without it the wallet app is a screen that changes by itself, and the
   moment an audience recognises — the text arriving a second after the
   PIN — is missing.

   These are Novi's own notifications, in the style a bank uses when it
   tells you about money it moved: a reference of ours, "Dear <name>",
   what happened, the wallet balance after it, a sign-off. They are not
   M-PESA messages and do not pretend to be: no Safaricom wording, no
   M-PESA receipt number, no Safaricom links. The sender is whatever the
   gateway has registered for this account, never MPESA.

   The balance quoted is the demo wallet's own, read off the movement that
   produced the text, so the message and the wallet app always agree.
   ============================================================ */
import crypto from 'node:crypto';
import { sendSmsLogged, smsConfigured } from './sms.js';
import { events } from '../lib/events.js';

/* Who the trading side of the rail is, as the texts name it. */
const MERCHANT = 'Novi Markets Ltd';
const SIGN_OFF = 'Trade smart with Novi.';

/* KES 2,000.00 */
function kes(minor) {
  return 'KES ' + (Number(minor || 0) / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/* 25-09-2026 05:15 AM, in Nairobi whatever timezone the server is in. */
function stamp(at) {
  const when = at ? new Date(at) : new Date();
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).formatToParts(when).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${(p.dayPeriod || '').toUpperCase()}`;
}

/* Our reference: N and eleven characters, the same for the same
   transaction every time it is asked for. */
function novRef(tx) {
  const seed = String(tx.reference || tx.id || tx.at || Date.now());
  return 'N' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 11).toUpperCase();
}

/* 071****678 from 254712345678. */
function maskedNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 9) return '';
  const local = d.startsWith('254') ? '0' + d.slice(3) : d;
  return local.slice(0, 3) + '****' + local.slice(-3);
}

function firstName(wallet) {
  const n = String(wallet?.holderName || wallet?.name || '').trim().split(/\s+/)[0];
  /* A wallet with no name set carries a placeholder, not a person. */
  return n && !/m-?pesa/i.test(n) ? n : 'Customer';
}

/* What is owed on the wallet's overdraft, when anything is. */
function overdraftLine(usedMinor) {
  if (!usedMinor || usedMinor <= 0) return '';
  return ` Overdraft outstanding: ${kes(usedMinor)}.`;
}

/**
 * The text for one statement row.
 *
 * @param {object} tx      a row as mpesaDemo shapes it
 * @param {object} wallet  the wallet it moved on, for the holder's name and number
 * @param {number} fulizaUsedMinor  what is owed on the overdraft after the move
 */
export function messageFor(tx, wallet, fulizaUsedMinor = 0) {
  const head = `Ref:${novRef(tx)}: Dear ${firstName(wallet)},`;
  const when = stamp(tx.at);
  const amount = kes(Math.abs(tx.amountMinor));
  const balance = `Wallet balance: ${kes(tx.balanceAfterMinor)}.`;
  const owed = overdraftLine(fulizaUsedMinor);
  const number = maskedNumber(wallet?.phone);
  const from = (tx.subtitle || '').trim();
  const tail = ` ${balance}${owed} ${SIGN_OFF}`;

  switch (tx.kind) {
    /* Money leaving the wallet for the trading account. */
    case 'DEPOSIT':
      return `${head} ${amount} has been paid from your wallet${number ? ' ' + number : ''}` +
        ` to ${MERCHANT} at ${when}.` + tail;

    /* A payout from the trading account arriving in the wallet. */
    case 'WITHDRAWAL':
      return `${head} You have received ${amount} in your wallet from ${MERCHANT}` +
        ` at ${when}.` + tail;

    /* Money sent into the wallet by somebody else. */
    case 'RECEIVE':
      return `${head} You have received ${amount} in your wallet from ${from || 'a sender'}` +
        ` at ${when}.` + tail;

    /* Cash taken out at an agent. */
    case 'AGENT_WITHDRAWAL':
      return `${head} You have withdrawn ${amount} from your wallet at ${from || 'an agent'}` +
        ` at ${when}.` + tail;

    /* A deposit that could not be completed, put back. */
    case 'REVERSAL':
      return `${head} Your payment of ${amount} to ${MERCHANT} could not be completed` +
        ` and has been returned to your wallet at ${when}.` + tail;

    case 'FULIZA_REPAY':
      return `${head} ${amount} of your wallet overdraft has been repaid at ${when}.` + tail;

    default:
      return `${head} ${amount} moved on your wallet at ${when}.` + tail;
  }
}

/**
 * Send the text for a movement. Fire and forget: the caller has already
 * moved the money, and an SMS that does not go out must not unwind a
 * transaction that did.
 *
 * @param {object} wallet  the wallet after the move — it carries the phone
 * @param {object} moved   what mpesaDemo.move() returned
 */
export async function notifyMovement(wallet, moved) {
  try {
    if (!smsConfigured()) return { ok: false, status: 'off' };
    if (!wallet?.phone) {
      events.warn('sms', 'No number on this demo wallet, nothing sent', {
        userId: wallet?.userId, reference: moved?.tx?.reference
      });
      return { ok: false, status: 'off', detail: 'Wallet has no phone number' };
    }

    return await sendSmsLogged(
      wallet.phone,
      messageFor(moved.tx, wallet, moved.fulizaUsedMinor),
      {
        userId: wallet.userId,
        reference: moved.tx.reference,
        what: `a Novi Wallet ${String(moved.tx.kind).toLowerCase()} text`
      }
    );
  } catch (err) {
    /* Belt and braces: this function is called without await in places,
       and an unhandled rejection from a text message must not be what
       takes the process down mid-demo. */
    events.error('sms', 'Wallet text threw: ' + (err?.message || 'unknown'), {
      userId: wallet?.userId
    });
    return { ok: false, status: 'down', detail: err?.message || 'unknown' };
  }
}

/* What an operator sends to themselves before the room fills up, to
   prove the sender works and the number is right. Not a transaction. */
export function testMessage(name) {
  return `Dear ${String(name || '').trim().split(/\s+/)[0] || 'Customer'}, this is a test from ${MERCHANT}.` +
    ' Your Novi Wallet is set up and its texts will arrive on this number.';
}

export { MERCHANT };

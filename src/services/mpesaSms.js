/* ============================================================
   The M-Pesa confirmation text

   Every movement on the demo rail ends the way a real one does: with a
   message on the handset. Without it the clone app is a screen that
   changes by itself, and the half of the flow an audience actually
   recognises — the text arriving a second after the PIN — is missing.

   The wording here is copied from Safaricom's, spacing included, because
   the spacing is part of what makes it recognisable: "Confirmed." with
   no space after it, "New M-PESA balance" capitalised that way, the date
   as 20/9/26 rather than 2026-09-20. Read one out loud next to a real
   one before changing a comma.

   What this is not: it is not a way to make a prop balance look like
   money to somebody who did not ask to see a demo. The sender ID is
   whatever the gateway has registered for this account — never MPESA,
   which is Safaricom's and cannot be sent from anyway — so a message
   that arrives is attributable to us. See the note in mpesaDemo.js.
   ============================================================ */
import { sendSmsLogged, smsConfigured } from './sms.js';
import { events } from '../lib/events.js';

/* Who the handset sees on the other side of the transaction. The
   trading side of the rail, named as a till would be. */
const MERCHANT = 'NOVI MARKETS';

/* Safaricom quotes shillings as Ksh1,234.00. */
function ksh(minor) {
  return 'Ksh' + (Number(minor || 0) / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/* 20/9/26 at 4:15 PM, in Nairobi, whatever timezone the server thinks
   it is in. A demo in Nairobi reading a timestamp in UTC is the kind of
   detail that gets noticed from the back of the room. */
function stamp(at) {
  const when = at ? new Date(at) : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    day: 'numeric', month: 'numeric', year: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(when).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  /* en-GB pads the day and month to two digits; Safaricom does not, and
     20/9/26 next to 20/09/26 is exactly the sort of difference somebody
     in the front row notices. */
  const trim = v => String(Number(v));
  const date = `${trim(parts.day)}/${trim(parts.month)}/${parts.year}`;
  const time = `${parts.hour}:${parts.minute} ${(parts.dayPeriod || '').toUpperCase()}`;
  return { date, time };
}

/* The overdraft line, when there is one to report. Real M-Pesa appends
   it to the same message rather than sending a second one. */
function fulizaLine(usedMinor) {
  if (!usedMinor || usedMinor <= 0) return '';
  return ` Fuliza M-PESA amount is ${ksh(usedMinor)}.` +
    ` Interest charged Ksh0.00.` +
    ` Total Fuliza M-PESA outstanding amount is ${ksh(usedMinor)}.`;
}

/**
 * The text for one statement row.
 *
 * @param {object} tx      a row as mpesaDemo shapes it
 * @param {object} wallet  the wallet it moved on, for the holder's name
 * @param {number} fulizaUsedMinor  what is owed after the move
 */
export function messageFor(tx, wallet, fulizaUsedMinor = 0) {
  const { date, time } = stamp(tx.at);
  const ref = tx.reference;
  const amount = ksh(Math.abs(tx.amountMinor));
  const balance = ksh(tx.balanceAfterMinor);
  const fuliza = fulizaLine(fulizaUsedMinor);
  const counterparty = (tx.subtitle || '').trim();

  switch (tx.kind) {
    /* Money leaving the phone for the trading account: a till payment,
       which is what it would be in life. */
    case 'DEPOSIT':
      return `${ref} Confirmed. ${amount} paid to ${MERCHANT}.` +
        ` on ${date} at ${time}.New M-PESA balance is ${balance}.` +
        ` Transaction cost, Ksh0.00.` + fuliza;

    /* A payout arriving from the trading account. */
    case 'WITHDRAWAL':
      return `${ref} Confirmed.You have received ${amount} from ${MERCHANT}` +
        ` on ${date} at ${time} New M-PESA balance is ${balance}.` + fuliza;

    /* Cash off the phone at an agent. The agent's number and name sit
       where Safaricom puts them, and the demo's own subtitle supplies
       whatever the operator typed. */
    case 'AGENT_WITHDRAWAL':
      return `${ref} Confirmed.on ${date} at ${time} Withdraw ${amount} from` +
        ` ${counterparty || 'Agent'} New M-PESA balance is ${balance}.` +
        ` Transaction cost, Ksh0.00.` + fuliza;

    case 'RECEIVE':
      return `${ref} Confirmed.You have received ${amount} from` +
        ` ${counterparty || MERCHANT} on ${date} at ${time}` +
        ` New M-PESA balance is ${balance}.` + fuliza;

    /* A deposit that could not be completed, put back. The customer sees
       the money return and is told why, which is the whole point of
       sending this one rather than letting the balance quietly change. */
    case 'REVERSAL':
      return `${ref} Confirmed. Reversal of transaction ${ref} has been` +
        ` successfully processed on ${date} at ${time}. ${amount} has been` +
        ` credited to your M-PESA account. New M-PESA balance is ${balance}.`;

    case 'FULIZA_REPAY':
      return `${ref} Confirmed. ${amount} of your Fuliza M-PESA has been repaid` +
        ` on ${date} at ${time}. New M-PESA balance is ${balance}.` + fuliza;

    default:
      return `${ref} Confirmed. ${amount} on ${date} at ${time}.` +
        ` New M-PESA balance is ${balance}.` + fuliza;
  }
}

/**
 * Send the confirmation for a movement. Fire and forget: the caller has
 * already moved the money, and an SMS that does not go out must not
 * unwind a transaction that did.
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
        what: `an M-PESA ${String(moved.tx.kind).toLowerCase()} confirmation`
      }
    );
  } catch (err) {
    /* Belt and braces: this function is called without await in places,
       and an unhandled rejection from a text message must not be what
       takes the process down mid-demo. */
    events.error('sms', 'Confirmation text threw: ' + (err?.message || 'unknown'), {
      userId: wallet?.userId
    });
    return { ok: false, status: 'down', detail: err?.message || 'unknown' };
  }
}

/* What an operator sends to themselves before the room fills up, to
   prove the sender ID is live and the number is right. Deliberately not
   a fake transaction: nobody should be able to point at a test and say
   it looked exactly like money arriving. */
export function testMessage(name) {
  return `Hello ${name || 'there'}, this is a test from ${MERCHANT}.` +
    ' Your M-PESA demo handset is set up and confirmation messages will' +
    ' arrive on this number.';
}

export { MERCHANT };

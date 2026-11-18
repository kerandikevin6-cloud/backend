/* Which of our sites a request came from.

   One API serves more than one front end (novibinary.com and
   zenobinary.com), and the console needs to say which site an account
   was opened on and which site a deposit was made through. The browser
   sends the page's origin with every cross-site call, so that is what is
   read. It is only trusted when it is an origin we already allow: any
   other value is something a script typed, not one of our sites. */
import { originKnown } from './origins.js';

/* The site everything belonged to before a second one existed. A row
   with no host recorded is read as this one. */
export const PRIMARY_HOST = 'novibinary.com';

export function siteHost(req) {
  const raw = req.get('origin') || req.get('referer') || '';
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!originKnown(url.origin)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  /* A developer's machine is not a site anyone signed up on. */
  if (host === 'localhost' || host === '127.0.0.1') return null;
  return host;
}

/* Sites whose money the console does not show (sql/025_hidden_sites.sql).
   They stay live and work in full; only the console's money views leave
   them out: the Deposits page, and the money history on their users'
   pages. Withdrawal requests still show, so they can be approved. */
export const HIDDEN_HOSTS = (process.env.HIDDEN_SITES || 'rivonbinary.com')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

export function isHiddenHost(host) {
  return !!host && HIDDEN_HOSTS.includes(String(host).toLowerCase());
}

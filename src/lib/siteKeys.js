/* Sites that bring their own provider accounts.

   One API, several front ends. Most share the Novi accounts, but a site
   listed here can have its own PayHero account: its settings are the
   usual names with the site's prefix in front, set on Render beside the
   shared ones.

     rivonbinary.com   RIVON_PAYHERO_BASIC_TOKEN
                       (or RIVON_PAYHERO_API_USERNAME + RIVON_PAYHERO_API_PASSWORD)
                       RIVON_PAYHERO_CHANNEL_ID

   Until a site's own keys are set it uses the shared ones, so nothing
   stops working in between. The token and the channel are taken as a
   pair: a site with its own token but no channel of its own is refused
   rather than pushed into the shared account's channel.

   Add a site with SITE_KEY_PREFIXES, e.g. "rivonbinary.com=RIVON,x.com=X". */
import { env } from '../config/env.js';

const PREFIXES = Object.fromEntries(
  (process.env.SITE_KEY_PREFIXES || 'rivonbinary.com=RIVON')
    .split(',')
    .map(pair => pair.split('=').map(s => String(s || '').trim()))
    .filter(([host, prefix]) => host && prefix)
    .map(([host, prefix]) => [host.toLowerCase().replace(/^www\./, ''), prefix.toUpperCase()])
);

function own(prefix, name) {
  const v = process.env[`${prefix}_${name}`];
  return v && v.trim() ? v.trim() : '';
}

function basicToken(raw, user, pass) {
  const value = String(raw || '').replace(/^Basic\s+/i, '').trim();
  if (value) {
    try {
      if (Buffer.from(value, 'base64').toString('utf8').includes(':')) return value;
    } catch { /* falls through to the pair */ }
  }
  return user && pass ? Buffer.from(`${user}:${pass}`).toString('base64') : '';
}

/**
 * The PayHero account a site's payments go through.
 * @returns {{ token: string, channelId: string, owner: string }}
 *   owner is the prefix ("RIVON") when the site's own keys are in use,
 *   'shared' otherwise. Never the secret itself.
 */
export function payheroFor(site, sharedToken) {
  const prefix = site && PREFIXES[String(site).toLowerCase().replace(/^www\./, '')];
  if (prefix) {
    const token = basicToken(
      own(prefix, 'PAYHERO_BASIC_TOKEN'),
      own(prefix, 'PAYHERO_API_USERNAME'),
      own(prefix, 'PAYHERO_API_PASSWORD')
    );
    if (token) return { token, channelId: own(prefix, 'PAYHERO_CHANNEL_ID'), owner: prefix };
  }
  return { token: sharedToken, channelId: env.PAYHERO_CHANNEL_ID, owner: 'shared' };
}

/** For the boot log: which sites have their own PayHero account set. */
export function payheroOwners(sharedToken) {
  return Object.entries(PREFIXES).map(([host, prefix]) => {
    const c = payheroFor(host, sharedToken);
    return c.owner === 'shared'
      ? `${host}: shared account (${prefix}_PAYHERO_* not set)`
      : `${host}: own account, channel ${c.channelId || 'NOT SET — its M-Pesa will refuse'}`;
  });
}

/* ============================================================
   The host page's API (/host)

   A host signs in with the username and password an admin made for
   them and sees their own sessions and what each one earned. Nothing
   else: no customers, no boost spend, no other host's sessions.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { unauthorized, forbidden, HttpError } from '../lib/errors.js';
import { checkPassword, signHostToken, verifyHostToken } from '../lib/hosts.js';
import { withFigures } from '../lib/sessionFigures.js';

const router = Router();

router.post('/login', authLimiter,
  validate(z.object({
    username: z.string().trim().min(1, 'Enter your username'),
    password: z.string().min(1, 'Enter your password')
  })),
  async (req, res, next) => {
    try {
      const { data: host } = await admin
        .from('hosts').select('*')
        .ilike('username', req.body.username.replace(/[%_\\]/g, ''))
        .maybeSingle();
      if (!host || !checkPassword(req.body.password, host.password_hash)) {
        throw unauthorized('That username and password do not match.');
      }
      if (host.status !== 'active') throw forbidden('This account is switched off.');
      res.json({ ok: true, token: await signHostToken(host.id), host: { name: host.name } });
    } catch (err) { next(err); }
  });

async function requireHost(req, _res, next) {
  try {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    if (!token || String(scheme).toLowerCase() !== 'bearer') throw unauthorized();
    let id;
    try { id = await verifyHostToken(token); }
    catch (e) { throw unauthorized('Your sign-in has expired. Sign in again.'); }
    /* Read on every request, so switching a host off takes effect at once. */
    const { data: host } = await admin
      .from('hosts').select('id,name,username,status').eq('id', id).maybeSingle();
    if (!host) throw unauthorized();
    if (host.status !== 'active') throw forbidden('This account is switched off.');
    req.hostUser = host;
    next();
  } catch (err) { next(err); }
}

router.get('/me', requireHost, async (req, res, next) => {
  try {
    const { data, error } = await admin
      .from('sessions').select('*')
      .eq('host_id', req.hostUser.id)
      .order('started_at', { ascending: false })
      .limit(200);
    if (error) throw new HttpError(500, 'sessions_failed', error.message);

    admin.from('hosts').update({ last_seen_at: new Date().toISOString() })
      .eq('id', req.hostUser.id).then(() => {}, () => {});

    const sessions = (await Promise.all((data || []).map(withFigures))).map(s => ({
      id: s.id, channel: s.channel, domain: s.domain, note: s.note,
      status: s.status, startedAt: s.startedAt, endedAt: s.endedAt,
      signups: s.signups, depositCount: s.depositCount, depositsMinor: s.depositsMinor,
      trades: s.trades, stakeVolumeMinor: s.stakeVolumeMinor, earningsMinor: s.marginMinor
    }));
    res.json({ ok: true, host: { name: req.hostUser.name, username: req.hostUser.username }, sessions });
  } catch (err) { next(err); }
});

export default router;

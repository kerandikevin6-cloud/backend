/* ============================================================
   Authentication
   The browser holds a Supabase access token. We verify it with
   Supabase on every request rather than trusting a decoded JWT, so a
   revoked or expired session stops working immediately.
   ============================================================ */
import { admin, asUser } from '../lib/supabase.js';
import { unauthorized } from '../lib/errors.js';

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

export async function requireAuth(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized();

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) throw unauthorized('That session has expired. Sign in again.');

    req.user = data.user;
    req.accessToken = token;
    req.db = asUser(token);      // reads run under row level security
    next();
  } catch (err) {
    next(err);
  }
}

/* Attaches the user when a token is present, but does not demand one. */
export async function optionalAuth(req, _res, next) {
  const token = bearer(req);
  if (!token) return next();
  const { data } = await admin.auth.getUser(token);
  if (data?.user) {
    req.user = data.user;
    req.accessToken = token;
    req.db = asUser(token);
  }
  next();
}

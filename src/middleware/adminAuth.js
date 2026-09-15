/* ============================================================
   Operator access
   Two gates, not one: a valid session, and a staff role read from the
   database on every request. Roles are never taken from the JWT — a
   token issued before someone was demoted would still carry the old
   claim, and that is exactly the request you do not want to honour.
   ============================================================ */
import { admin } from '../lib/supabase.js';
import { unauthorized, forbidden } from '../lib/errors.js';

const STAFF = ['operator', 'finance', 'admin'];

export async function requireStaff(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (!token || scheme.toLowerCase() !== 'bearer') throw unauthorized();

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) throw unauthorized('That session has expired. Sign in again.');

    const { data: profile } = await admin
      .from('profiles')
      .select('id,email,display_name,role,status')
      .eq('id', data.user.id)
      .single();

    if (!profile || !STAFF.includes(profile.role)) {
      /* Deliberately vague. Confirming that an endpoint exists but is
         out of reach is more than an outsider needs to know. */
      throw forbidden('This account cannot use the console.');
    }
    if (profile.status === 'suspended') {
      throw forbidden('This account is suspended.');
    }

    req.user = data.user;
    req.operator = profile;
    req.accessToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

/* Some actions should be narrower than "staff". Finance can move money;
   only an admin can change what another account is allowed to do. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.operator || !roles.includes(req.operator.role)) {
      return next(forbidden('Your role does not allow that.'));
    }
    next();
  };
}

/* Every write is recorded. Logging must never be the reason an action
   fails, so a failure here is swallowed after being logged. */
export async function audit(req, action, subject, detail) {
  try {
    await admin.from('admin_audit').insert({
      actor_id: req.operator?.id || null,
      actor_email: req.operator?.email || null,
      action,
      subject: subject || null,
      detail: detail || null
    });
  } catch (err) {
    req.log?.error({ err, action }, 'could not write audit row');
  }
}

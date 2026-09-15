/* ============================================================
   Auth — thin wrapper over Supabase Auth
   Supabase owns the passwords, the hashing, the tokens and the reset
   mail. This layer exists to normalise errors into the shape the front
   end already expects, and to avoid leaking which addresses exist.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { anon, admin } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, resetLimiter } from '../middleware/rateLimit.js';
import { badRequest, unauthorized, HttpError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { normalisePhone } from '../lib/phone.js';

const router = Router();

/* The same rules the browser enforces. Checked again here because a
   client-side check is a convenience, not a control. */
const password = z.string()
  .min(8, 'Use at least 8 characters')
  .refine(v => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Include an upper and a lower case letter')
  .refine(v => /\d/.test(v), 'Include a number')
  .refine(v => /[^A-Za-z0-9]/.test(v), 'Include a symbol');

const email = z.string().trim().toLowerCase().email('That does not look like an email address');

/* ---------------- create account ---------------- */
router.post('/signup',
  authLimiter,
  validate(z.object({
    email,
    password,
    name: z.string().trim().min(1, 'Enter your name').max(80),
    phone: z.string().optional(),
    country: z.string().length(2).optional().default('KE'),
    referralCode: z.string().trim().max(16).optional()
  })),
  async (req, res, next) => {
    try {
      const { email: mail, password: pass, name, phone, country, referralCode } = req.body;

      const { data, error } = await anon.auth.signUp({
        email: mail,
        password: pass,
        options: {
          data: { full_name: name, country },
          emailRedirectTo: `${env.APP_URL}/login.html?confirmed=1`
        }
      });

      if (error) {
        /* Supabase says "User already registered". Saying that back is an
           account-enumeration oracle, so the message stays neutral. */
        if (/already/i.test(error.message)) {
          return res.status(200).json({
            ok: true,
            needsConfirmation: true,
            message: 'Check your email to finish setting up your account.'
          });
        }
        throw new HttpError(400, 'signup_failed', error.message);
      }

      /* The trigger in 001_schema.sql has already created the profile and
         both balances. Fill in the extras it could not know. */
      if (data.user) {
        const patch = {};
        if (phone) patch.phone = normalisePhone(phone, country) || null;
        if (country) patch.country = country;

        if (referralCode) {
          const { data: referrer } = await admin
            .from('profiles').select('id')
            .eq('referral_code', referralCode.toUpperCase())
            .maybeSingle();
          /* Ignore a code that does not resolve — a typo should not stop
             someone opening an account. */
          if (referrer && referrer.id !== data.user.id) patch.referred_by = referrer.id;
        }

        if (Object.keys(patch).length) {
          await admin.from('profiles').update(patch).eq('id', data.user.id);
        }
      }

      res.status(201).json({
        ok: true,
        needsConfirmation: !data.session,
        session: data.session ? publicSession(data.session) : null,
        user: data.user ? { id: data.user.id, email: data.user.email } : null
      });
    } catch (err) { next(err); }
  });

/* ---------------- sign in ---------------- */
router.post('/login',
  authLimiter,
  validate(z.object({ email, password: z.string().min(1, 'Enter your password') })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.signInWithPassword({
        email: req.body.email,
        password: req.body.password
      });

      /* One message for a wrong password and for an unknown address, so
         this endpoint cannot be used to discover who has an account. */
      if (error || !data.session) {
        if (/confirm/i.test(error?.message || '')) {
          throw new HttpError(403, 'email_unconfirmed',
            'Confirm your email address first. Check your inbox.');
        }
        throw unauthorized('That email and password do not match.');
      }

      res.json({ ok: true, session: publicSession(data.session), user: publicUser(data.user) });
    } catch (err) { next(err); }
  });

/* ---------------- Google ----------------
   The browser never posts Google credentials here. We hand back the
   consent URL, Supabase handles the exchange, and the browser comes back
   with a session in the URL fragment. */
router.get('/google', async (req, res, next) => {
  try {
    const redirectTo = `${env.APP_URL}/login.html?oauth=1`;
    const { data, error } = await anon.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true }
    });
    if (error) throw new HttpError(502, 'oauth_failed', error.message);
    res.json({ ok: true, url: data.url });
  } catch (err) { next(err); }
});

/* Exchange a PKCE code for a session, for flows that return a code
   rather than a fragment. */
router.post('/callback',
  validate(z.object({ code: z.string().min(10) })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.exchangeCodeForSession(req.body.code);
      if (error || !data.session) throw unauthorized('That sign-in link is no longer valid.');
      res.json({ ok: true, session: publicSession(data.session), user: publicUser(data.user) });
    } catch (err) { next(err); }
  });

/* ---------------- forgot / reset password ---------------- */
router.post('/forgot-password',
  resetLimiter,
  validate(z.object({ email })),
  async (req, res, next) => {
    try {
      await anon.auth.resetPasswordForEmail(req.body.email, {
        redirectTo: `${env.APP_URL}/reset-password.html`
      });
      /* Always the same answer, whether or not the address is on file. */
      res.json({
        ok: true,
        message: 'If that address has an account, a reset link is on its way.'
      });
    } catch (err) { next(err); }
  });

/* The browser arrives at reset-password.html holding a recovery token.
   It sends that token here with the new password. */
router.post('/reset-password',
  authLimiter,
  validate(z.object({ accessToken: z.string().min(10), password })),
  async (req, res, next) => {
    try {
      const { data: userData, error: userErr } =
        await admin.auth.getUser(req.body.accessToken);
      if (userErr || !userData?.user) {
        throw unauthorized('That reset link has expired. Request a new one.');
      }

      const { error } = await admin.auth.admin.updateUserById(userData.user.id, {
        password: req.body.password
      });
      if (error) throw new HttpError(400, 'reset_failed', error.message);

      res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
    } catch (err) { next(err); }
  });

/* ---------------- change password while signed in ---------------- */
router.post('/change-password',
  requireAuth,
  authLimiter,
  validate(z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password
  })),
  async (req, res, next) => {
    try {
      /* Re-authenticate first. Without this, a stolen access token is
         enough to take the account over permanently. */
      const { error: checkErr } = await anon.auth.signInWithPassword({
        email: req.user.email,
        password: req.body.currentPassword
      });
      if (checkErr) throw badRequest('Your current password is not right', {
        currentPassword: 'That is not your current password'
      });

      const { error } = await admin.auth.admin.updateUserById(req.user.id, {
        password: req.body.password
      });
      if (error) throw new HttpError(400, 'update_failed', error.message);

      res.json({ ok: true, message: 'Password updated' });
    } catch (err) { next(err); }
  });

/* ---------------- session ---------------- */
router.get('/session', requireAuth, async (req, res, next) => {
  try {
    const { data: profile } = await req.db
      .from('profiles')
      .select('id,email,display_name,phone,country,kyc_status,referral_code')
      .eq('id', req.user.id)
      .single();

    const { data: accounts } = await req.db
      .from('accounts')
      .select('kind,currency,balance_minor')
      .eq('user_id', req.user.id);

    res.json({ ok: true, user: publicUser(req.user), profile, accounts: accounts || [] });
  } catch (err) { next(err); }
});

router.post('/refresh',
  validate(z.object({ refreshToken: z.string().min(10) })),
  async (req, res, next) => {
    try {
      const { data, error } = await anon.auth.refreshSession({
        refresh_token: req.body.refreshToken
      });
      if (error || !data.session) throw unauthorized('Session expired. Sign in again.');
      res.json({ ok: true, session: publicSession(data.session) });
    } catch (err) { next(err); }
  });

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await admin.auth.admin.signOut(req.accessToken);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* Only what the client needs. No provider tokens, no raw metadata. */
function publicSession(session) {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || null
  };
}

export default router;

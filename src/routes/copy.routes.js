/* ============================================================
   Copy trading

   Switched on per account with a key staff issue from the console.
   The key is checked, spent and the account flagged in one database
   transaction (redeem_copy_key in sql/015), so the same key cannot be
   used twice however the requests race.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, badRequest, conflict } from '../lib/errors.js';
import { events } from '../lib/events.js';

const router = Router();

/* A key is short enough to guess at, so guessing is made slow. Keyed by
   IP here; the route below also needs a signed-in account. */
const keyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again shortly.' } }
});

router.post('/activate',
  keyLimiter,
  requireAuth,
  validate(z.object({ key: z.string().trim().min(4).max(64) })),
  async (req, res, next) => {
    try {
      const { error } = await admin.rpc('redeem_copy_key', {
        p_user_id: req.user.id,
        p_key: req.body.key
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('KEY_USED')) {
          throw conflict('That key has already been used on another account.', { key: 'Already used' });
        }
        if (msg.includes('KEY_INVALID')) {
          throw badRequest('That key is not valid. Check it and try again.', { key: 'Not valid' });
        }
        throw new HttpError(500, 'activate_failed', msg);
      }

      events.info('copy', 'Copy trading activated with a key', { userId: req.user.id });
      res.json({ ok: true, copyActive: true });
    } catch (err) { next(err); }
  });

/* Whether this account has copy trading on. /auth/session carries the
   same flag; this is for a page that only needs this one fact. */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('profiles').select('copy_active').eq('id', req.user.id).single();
    if (error) throw new HttpError(500, 'copy_failed', error.message);
    res.json({ ok: true, copyActive: !!data?.copy_active });
  } catch (err) { next(err); }
});

export default router;

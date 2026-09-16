/* ============================================================
   Verification

   The customer's half. The document itself never passes through here:
   the browser uploads it straight into a private Supabase Storage bucket
   with its own token, into a folder named after its user id, and then
   tells us the path. So a passport photo never sits in a request log, an
   error report, or this service's memory.

   What we accept is proof of address. Government ID is deliberately not
   collected yet, and the interface says so rather than hiding the option
   — see the note at the top of sql/010.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, HttpError } from '../lib/errors.js';
import { events } from '../lib/events.js';

const router = Router();

function publicSubmission(s) {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    note: s.note,
    at: s.created_at,
    reviewedAt: s.reviewed_at
  };
}

/* ---------------- what this account has already sent ---------------- */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from('kyc_submissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw new HttpError(500, 'kyc_failed', error.message);

    const rows = (data || []).map(publicSubmission);
    res.json({
      ok: true,
      submissions: rows,
      pending: rows.some(r => r.status === 'pending')
    });
  } catch (err) { next(err); }
});

/* ---------------- hand one in ----------------
   The path is checked against the caller rather than trusted. It arrives
   from the browser, and a browser can send any string: without this,
   somebody could point their submission at another customer's folder and
   have staff review a document that is not theirs. */
router.post('/',
  requireAuth,
  validate(z.object({
    path: z.string().min(3).max(300),
    mimeType: z.string().max(80).optional(),
    byteSize: z.coerce.number().int().min(1).max(8 * 1024 * 1024).optional()
  })),
  async (req, res, next) => {
    try {
      const path = req.body.path.replace(/^\/+/, '');
      const owner = path.split('/')[0];
      if (owner !== req.user.id) {
        throw badRequest('That document does not belong to this account.');
      }

      const { data, error } = await admin
        .from('kyc_submissions')
        .insert({
          user_id: req.user.id,
          kind: 'proof_of_address',
          storage_path: path,
          mime_type: req.body.mimeType || null,
          byte_size: req.body.byteSize || null
        })
        .select()
        .single();

      if (error) {
        /* The partial unique index: one open submission per person. */
        if (/duplicate key|kyc_submissions_one_pending/i.test(error.message)) {
          throw conflict('You already have a document under review.');
        }
        throw new HttpError(500, 'kyc_failed', error.message);
      }

      /* Pending is set here rather than by the browser, which is the
         point of the whole route: the old flow let the customer's own
         page decide it was verified. */
      await admin.from('profiles')
        .update({ kyc_status: 'pending' })
        .eq('id', req.user.id);

      events.info('kyc', 'Proof of address submitted', { userId: req.user.id });

      res.status(201).json({ ok: true, submission: publicSubmission(data) });
    } catch (err) { next(err); }
  });

export default router;

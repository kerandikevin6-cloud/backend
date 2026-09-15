/* ============================================================
   Configuration

   Only two kinds of value live in the environment:

     * secrets — keys that must never be committed
     * per-deployment addresses — the URLs, which differ between
       local and Render

   Everything else is a constant and lives here, in code. A limit like
   the minimum deposit is a product decision, not a deployment one:
   putting it in the environment means the rule can silently differ
   between two running copies of the same service, and nobody notices
   until a customer is refused on one and not the other.
   ============================================================ */
import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

/* ---------- Supabase project ----------
   The URL and the publishable key are public by design: the key is
   bound by row level security and already ships in the browser bundle.
   Keeping them here rather than in .env means one less thing to set up
   and one less thing to get wrong. An env var still overrides, so a
   second project (staging, a fork) needs no code change. */
const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://avzuiwqkqyhsjanjwtrx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_aGZeOzRTqbvY2P6NgEVliQ_d_rh_pvn';

/* ---------- product rules ----------
   Minor units (cents). 10000 = KES 100.00 */
const RULES = {
  MIN_DEPOSIT_MINOR: 1000,         /* KES 10 — lowered for live testing */
  MAX_DEPOSIT_MINOR: 15000000,     /* KES 150,000 */
  MIN_WITHDRAWAL_MINOR: 100000,    /* USD 1,000 in cents */

  /* Local currency per 1 USD. A fixed rate is fine to launch on, but it
     leaks value in one direction as the real rate moves — replace it
     with a rates feed before volumes grow. */
  USD_RATE_KES: 129,

  /* Render puts a proxy in front of the service, so the real client IP
     arrives in X-Forwarded-For. Without this, rate limiting sees one
     address for every request and throttles everybody at once. */
  TRUST_PROXY: 1,
  LOG_LEVEL: 'info'
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),

  /* Where the browser app lives, and where this service can be reached.
     Payment providers post callbacks to API_URL, so it has to be a real
     public address once deployed — see the fallbacks below, which mean
     neither normally has to be set by hand on Render. */
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  CORS_ORIGINS: z.string().default(''),

  /* Bypasses row level security. Server only, always. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  /* Paystack: the secret key is all that is needed. Transactions are
     created through the API with the amount, so there is no hosted
     payment page to configure, and nothing Paystack-shaped runs in the
     browser, so there is no public key to publish. */
  PAYSTACK_SECRET_KEY: z.string().min(10),

  /* PayHero: HTTP Basic. Either paste a ready-made token or give the
     username and password and let the server build it. */
  PAYHERO_API_USERNAME: z.string().optional().default(''),
  PAYHERO_API_PASSWORD: z.string().optional().default(''),
  PAYHERO_BASIC_TOKEN: z.string().optional().default(''),
  PAYHERO_CHANNEL_ID: z.string().optional().default('')
});

/* ---------- URL fallbacks ----------
   Render exports RENDER_EXTERNAL_URL for every web service: the real
   public address of this instance. That is exactly what API_URL is, so
   take it from there rather than making somebody paste it in and risk a
   payment callback pointed at the wrong host.

   APP_URL is the front end, which this service cannot know, so it falls
   back to the first allowed CORS origin (which is the front end, by
   definition) and only then to the API's own address. Set it explicitly
   once the site has a domain. */
const firstOrigin = (process.env.CORS_ORIGINS || '')
  .split(',').map(v => v.trim()).filter(Boolean)[0];

const API_URL = process.env.API_URL || process.env.RENDER_EXTERNAL_URL || undefined;
const APP_URL = process.env.APP_URL || firstOrigin || API_URL || undefined;

const parsed = schema.safeParse({ ...process.env, API_URL, APP_URL });

if (!parsed.success) {
  const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
  console.error('Configuration is incomplete:\n' + lines.join('\n') +
    '\n\nCopy .env.example to .env and fill it in.' +
    '\nOn Render these are set under Environment, not in a file.');
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ...RULES,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PAYHERO_BASE_URL: 'https://backend.payhero.co.ke/api/v2'
};

export const isProd = env.NODE_ENV === 'production';

export const corsOrigins = env.CORS_ORIGINS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* PayHero authenticates with HTTP Basic. */
export const payheroToken =
  env.PAYHERO_BASIC_TOKEN ||
  (env.PAYHERO_API_USERNAME && env.PAYHERO_API_PASSWORD
    ? Buffer.from(`${env.PAYHERO_API_USERNAME}:${env.PAYHERO_API_PASSWORD}`).toString('base64')
    : '');

/* ---------- PayHero callback secret ----------
   PayHero does not sign its callbacks, so the callback URL carries a
   secret path segment instead. Rather than being one more thing to set,
   it is derived from a secret the service already holds — stable across
   restarts and across instances, and never written down anywhere.

   One consequence worth knowing: rotating the service-role key changes
   this URL, so the callback registered with PayHero has to be updated
   at the same time. The boot log prints the current one. */
export const payheroCallbackSecret = crypto
  .createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
  .update('payhero:callback:v1')
  .digest('hex')
  .slice(0, 40);

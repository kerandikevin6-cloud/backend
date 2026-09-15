/* ============================================================
   Environment
   Read once, validated once. A missing secret fails the boot with a
   readable message rather than surfacing as a 500 on someone's first
   deposit.
   ============================================================ */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  CORS_ORIGINS: z.string().default(''),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  PAYSTACK_SECRET_KEY: z.string().min(10),
  PAYSTACK_PUBLIC_KEY: z.string().optional().default(''),
  PAYSTACK_PAYMENT_PAGE: z.string().optional().default(''),

  PAYHERO_BASE_URL: z.string().url().default('https://backend.payhero.co.ke/api/v2'),
  PAYHERO_API_USERNAME: z.string().optional().default(''),
  PAYHERO_API_PASSWORD: z.string().optional().default(''),
  PAYHERO_BASIC_TOKEN: z.string().optional().default(''),
  PAYHERO_CHANNEL_ID: z.string().optional().default(''),
  PAYHERO_CALLBACK_SECRET: z.string().min(8),

  MIN_DEPOSIT_MINOR: z.coerce.number().int().default(10000),
  MAX_DEPOSIT_MINOR: z.coerce.number().int().default(15000000),
  MIN_WITHDRAWAL_MINOR: z.coerce.number().int().default(100000),
  USD_RATE_KES: z.coerce.number().default(129),

  TRUST_PROXY: z.coerce.number().default(1),
  LOG_LEVEL: z.string().default('info')
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
  console.error('Configuration is incomplete:\n' + lines.join('\n') +
    '\n\nCopy .env.example to .env and fill it in.');
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

export const corsOrigins = env.CORS_ORIGINS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* PayHero authenticates with HTTP Basic. Accept a ready-made token, or
   build one from the username and password. */
export const payheroToken =
  env.PAYHERO_BASIC_TOKEN ||
  (env.PAYHERO_API_USERNAME && env.PAYHERO_API_PASSWORD
    ? Buffer.from(`${env.PAYHERO_API_USERNAME}:${env.PAYHERO_API_PASSWORD}`).toString('base64')
    : '');

/* ============================================================
   Nexas API
   Express in front of Supabase, with Paystack and PayHero for money.

   Mounting order matters in one place: the Paystack webhook needs the
   raw request body to check its signature, so it is registered before
   express.json() gets a chance to consume the stream.
   ============================================================ */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import pino from 'pino';

import { env, corsOrigins } from './config/env.js';
import { callbackUrl as payheroCallbackUrl } from './services/payhero.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import depositRoutes from './routes/deposits.routes.js';
import withdrawalRoutes from './routes/withdrawals.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';
import adminRoutes from './routes/admin.routes.js';

const logger = pino({
  level: env.LOG_LEVEL,
  /* Anything that could carry a secret is stripped before it is written.
     Logs get shipped, searched and pasted into tickets. */
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.accessToken',
      'req.body.refreshToken'
    ],
    censor: '[redacted]'
  }
});

const app = express();

app.set('trust proxy', env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(pinoHttp({ logger }));
app.use(helmet());

app.use(cors({
  origin(origin, cb) {
    /* No Origin header means a server-to-server call or a health probe,
       which CORS does not govern. */
    if (!origin) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} is not allowed`));
  },
  credentials: true,
  maxAge: 86400
}));

/* ---- webhooks come first: raw body, no rate limit ----
   Rate limiting a provider's retries would turn a transient blip into
   lost settlements. */
app.use('/webhooks/paystack', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/webhooks', express.json({ limit: '1mb' }), webhookRoutes);

/* ---- everything else ---- */
app.use(express.json({ limit: '256kb' }));
app.use(generalLimiter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'nexas-api', env: env.NODE_ENV, time: new Date().toISOString() });
});

app.get('/config', (_req, res) => {
  /* What the browser is allowed to know: the limits it should enforce
     before bothering the server. No keys — nothing payment-shaped runs
     in the browser. */
  res.json({
    ok: true,
    minDepositMinor: env.MIN_DEPOSIT_MINOR,
    maxDepositMinor: env.MAX_DEPOSIT_MINOR,
    minWithdrawalMinor: env.MIN_WITHDRAWAL_MINOR,
    usdRateKes: env.USD_RATE_KES
  });
});

app.use('/auth', authRoutes);
app.use('/deposits', depositRoutes);
app.use('/withdrawals', withdrawalRoutes);
app.use('/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`nexas-api listening on ${env.PORT} (${env.NODE_ENV})`);
  /* The PayHero callback is derived rather than configured, so the only
     way to know it is to be told. Printed once, into the server log. */
  logger.info(`paystack webhook   ${env.API_URL}/webhooks/paystack`);
  logger.info(`payhero callback   ${payheroCallbackUrl()}`);
});

/* Render sends SIGTERM on deploy. Finish in-flight requests rather than
   dropping someone mid-deposit. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}

export default app;

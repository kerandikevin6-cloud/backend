# Nexas API

Express service in front of Supabase, with Paystack (cards) and PayHero (M-Pesa).

## Getting it running

```bash
cd backend
npm install
cp .env.example .env     # fill it in
npm run dev
```

Then in Supabase → SQL editor, run `sql/001_schema.sql` and `sql/002_policies.sql`, in that order.

## Endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | email, password, name, optional phone + referralCode |
| POST | `/auth/login` | returns access and refresh tokens |
| GET  | `/auth/google` | returns the consent URL to redirect to |
| POST | `/auth/callback` | exchanges a PKCE code for a session |
| POST | `/auth/forgot-password` | always answers the same, whether or not the address exists |
| POST | `/auth/reset-password` | accessToken from the emailed link, plus the new password |
| POST | `/auth/change-password` | signed in; re-checks the current password |
| GET  | `/auth/session` | profile and balances |
| POST | `/auth/refresh` | new access token |
| POST | `/auth/logout` | |

### Deposits
| Method | Path | Notes |
|---|---|---|
| POST | `/deposits/mpesa` | `{ amountMinor, phone }` → STK push |
| POST | `/deposits/card` | `{ amountMinor }` → Paystack checkout URL |
| GET  | `/deposits/:reference` | poll while the waiting screen is up |
| GET  | `/deposits` | recent deposits |

### Withdrawals
| Method | Path | Notes |
|---|---|---|
| POST | `/withdrawals` | holds the funds, queues for review |
| GET  | `/withdrawals` | list |
| POST | `/withdrawals/:id/cancel` | releases the hold |

### Webhooks
| Method | Path | Notes |
|---|---|---|
| POST | `/webhooks/paystack` | HMAC SHA-512 over the raw body |
| POST | `/webhooks/payhero/:secret` | secret in the path; PayHero does not sign |

## How money moves

Nothing in a route handler changes a balance. A deposit goes:

1. `POST /deposits/*` writes a **pending** payment row with our own reference, **then** calls the provider. That order is deliberate: if the provider succeeds but our response is lost, the callback still finds a row to settle.
2. The provider calls a webhook. The signature (Paystack) or path secret (PayHero) is checked.
3. We ask the provider's API what actually happened rather than believing the payload.
4. `settle_deposit()` credits the balance and writes a ledger entry **in one transaction**, and returns early if the payment is already settled — so a replayed webhook is a no-op.

Two things follow from this that are worth not undoing later:

- **Amounts are integers in minor units everywhere.** KES 100 is `10000`. Floats drift, and a balance that drifts is a support queue.
- **Balances are only writable through the SQL functions.** `002_policies.sql` grants no `UPDATE` on `accounts` and no `INSERT` on `ledger_entries` to anyone, so even a leaked anon key cannot write itself money.

## Deploying to Render

`render.yaml` is a blueprint — point Render at the repo and set the secrets in the dashboard.

**Use a paid instance.** Free services sleep, and a sleeping service misses payment webhooks. A missed webhook is a customer who paid and did not get credited.

After the first deploy:

1. Nothing to do for `API_URL` — it defaults to Render's own `RENDER_EXTERNAL_URL`, so callbacks point at the live service from the first boot. Set it explicitly only behind a custom domain. `APP_URL` defaults to the first `CORS_ORIGINS` entry.
2. Paystack dashboard → Settings → Webhooks → `https://<service>.onrender.com/webhooks/paystack`.
3. PayHero callback → the URL printed in the boot log as `payhero callback`. It is derived from the service-role key rather than configured, so it is stable across restarts and instances — but rotating that key changes it, and the dashboard has to be updated at the same time.
4. Supabase → Authentication → URL Configuration → add your site URL and redirect URLs.
5. Supabase → Authentication → Providers → Google: add the client ID and secret, and set the callback to `https://<project>.supabase.co/auth/v1/callback`.

## The first super admin

There is no endpoint that grants admin, and there should not be: an
endpoint that can make the first super admin can make the second one for
somebody else, and it stays reachable from the internet forever after.
The first one is made by hand, once, in the Supabase SQL editor — where
the only way in is your own Supabase password.

1. Run `sql/005_roles.sql`. It widens `profiles.role` to the seven roles
   the console actually assigns; before it, creating a `manager` fails on
   a CHECK constraint left over from `003`.
2. Create the account the normal way — sign up on the site, or Supabase →
   Authentication → Users → Add user with **Auto Confirm** on. The profile
   row is written by the `handle_new_user` trigger, and it must exist
   before step 3 can update anything.
3. Promote it:

   ```sql
   update public.profiles
      set role = 'super_admin', status = 'active'
    where lower(email) = lower('you@example.com');
   ```

4. Confirm, then sign in to the console. This should return one row:

   ```sql
   select email, role, status from public.profiles where role <> 'customer';
   ```

Everyone else is created from the console: Admins → New, which only a
`super_admin` can reach. `005` also installs a trigger that refuses to
demote or suspend the last active super admin — not a grant, just a
refusal to let the console lock everybody out.

## Connecting the front end

`assets/js/api.js` already has the seam:

```html
<script>window.NEXAS_API = "https://nexas-api.onrender.com";</script>
```

## Still to do before real money

- [ ] A scheduled sweep calling `reconcile()` on payments pending more than ~10 minutes. Mobile-money callbacks do get lost, and a deposit that silently never lands is the worst failure here.
- [ ] Replace the fixed `USD_RATE_KES` with a rates feed; a stale rate leaks value in one direction.
- [ ] An operator surface for approving payouts (`release_withdrawal` is written and ready).
- [ ] Move contracts and the price feed server-side. While the browser decides trade outcomes, anyone can edit their own balance in devtools — everything above only secures the *money in and out*.
- [ ] Paystack Transfers for automated payouts, once your account is approved for them.

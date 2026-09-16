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
4. Supabase, Authentication, URL Configuration:

   **Site URL** `https://novibinary.com`

   **Redirect URLs** (one per line). These are the three addresses this
   service asks Supabase to send people back to, so they are the three
   that have to be allowed. A wildcard covers them, but listing them is
   worth the extra minute: a wildcard also allows every future page,
   including ones nobody meant to make a landing spot for an auth token.

   ```
   https://novibinary.com/login
   https://novibinary.com/reset-password
   https://novibinary.com
   ```

   For previews and local work, add what you actually use:
   `http://localhost:5500/**`, `https://*.vercel.app/**`.
5. Supabase → Authentication → Providers → Google: add the client ID and secret, and set the callback to `https://<project>.supabase.co/auth/v1/callback`.

## When something is not working

The console's **Logs** page is the first place to look. It shows, at the
top, whether this service can currently reach Supabase, Paystack and
PayHero — each probe is an authenticated call, so a green light means the
credentials work, not merely that the hostname resolves. A dependency can
report `key` rather than `down`, which is the difference between "they
are having an outage" and "our key was rotated".

Underneath is `system_events`: the things worth acting on. A refused
origin, a webhook whose signature did not verify, an STK push that never
left. It is not a copy of the request log — that stays on the host, where
nothing in the console can read it and a deploy erases it.

The most common failure is a browser call that never arrives, reported by
the site as "could not reach Nexas". Nine times in ten that is CORS: the
origin is not in `CORS_ORIGINS`, the browser refuses to send the request,
and the reason never reaches JavaScript. The Logs page records every
refused origin with the address that was turned away, so the fix is to
read the line and add that origin. Preview deploys change hostname every
build, so `CORS_ORIGINS` accepts one wildcard label —
`https://*.vercel.app` — alongside exact origins.

## The first super admin

There is no endpoint that grants admin, and there should not be: an
endpoint that can make the first super admin can make the second one for
somebody else, and it stays reachable from the internet forever after.
The first one is made by hand, once, in the Supabase SQL editor — where
the only way in is your own Supabase password.

1. Run `sql/005_roles.sql`, `sql/006_events.sql` (the Logs page),
   `sql/007_trades.sql` (trade history) and `sql/008_vip_mpesa.sql`
   (the VIP demo rail). It widens `profiles.role` to the seven roles
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

## The VIP demo rail

Every account is **Standard** by default and moves real money. An admin can
promote one to **VIP**, and a VIP's deposits settle against a companion M-Pesa
clone app instead of PayHero: the money comes off a handset in the room and
lands on the trading balance in real time, so a deposit can be shown working
without anybody spending a shilling.

Run `sql/008_vip_mpesa.sql`. It adds `profiles.tier`, the two wallet tables and
the functions that move them.

**Setting one up**, in the console, on the user's drawer:

1. **Make VIP.** The tier alone changes nothing a customer can see.
2. **Set the handset**: a four digit PIN, the balance the phone will show, and
   the Fuliza limit. Tier and wallet are separate on purpose, because they fail
   separately, and "VIP with no wallet" is a state an operator needs to see
   rather than infer from a deposit that will not work.
3. The customer types that PIN into the M-Pesa app **once**. It is exchanged
   for a device token the phone keeps, so the binding survives the app closing.

| Route | Who calls it | Auth |
| --- | --- | --- |
| `POST /mpesa/link` | An unlinked handset | The PIN itself, rate limited |
| `GET /mpesa/account` | The handset, polling | Device token |
| `POST /mpesa/agent-withdraw` | The handset | Device token |
| `POST /mpesa/receive` | The handset | Device token |
| `POST /mpesa/reset` | Between rehearsals | Device token |
| `POST /deposits/mpesa` | A VIP's terminal | The normal customer token; the tier is checked server side |

The deposit endpoint is **the same one Standard accounts use**. The fork happens
inside it, from the database, so the browser cannot ask to be on the demo rail
and a customer demoted mid-session stops being on it immediately.

### Fuliza

The limit is set per wallet by an admin rather than derived from the balance,
because here it is a thing being demonstrated rather than simulated. It behaves
as the real product does: money out that the balance cannot cover draws the
shortfall from the limit and floors the balance at zero, money in repays what is
owed before it touches the balance, and a debit past balance-plus-remaining-limit
is refused outright.

### The line this must not cross

The wallet is a presentation prop. It touches no PayHero credential and no
Paystack key, it is reachable only for accounts an admin has marked VIP, and
Standard accounts remain the only path real money takes. The PIN is stored in
plain text **deliberately**: it is assigned by an admin, never chosen by a
customer, so it cannot be anyone's real M-Pesa PIN, and the console has to read
it back to tell them what to type. If it ever gates anything real it needs
hashing and rate limiting first.

A VIP deposit still writes a `payments` row and still settles through
`settle_deposit`, so it appears in the ledger and the console exactly as a real
one does. The provider is `mpesa_demo`, which is how you tell them apart.

## Trade history is the client's account, not the server's

`/trades` records settled contracts so a person's history survives the
browser it was made in. It is not evidence. Contracts are still decided
client side, so a row says what that browser reported — anyone can open
devtools and write themselves a winning history.

Two things keep that contained, and both are in the schema rather than in
a convention somebody can forget: nothing in `trades` can reach a balance
(no trigger, no function, no path to `accounts` or `ledger_entries`), and
a row is immutable once written (no UPDATE or DELETE policy for anyone).

When settlement moves server side this table becomes the record of what
the server decided, and only the insert policy changes.

## Still to do before real money

- [ ] A scheduled sweep calling `reconcile()` on payments pending more than ~10 minutes. Mobile-money callbacks do get lost, and a deposit that silently never lands is the worst failure here.
- [ ] Replace the fixed `USD_RATE_KES` with a rates feed; a stale rate leaks value in one direction.
- [ ] An operator surface for approving payouts (`release_withdrawal` is written and ready).
- [ ] Move contracts and the price feed server-side. While the browser decides trade outcomes, anyone can edit their own balance in devtools — everything above only secures the *money in and out*.
- [ ] Paystack Transfers for automated payouts, once your account is approved for them.

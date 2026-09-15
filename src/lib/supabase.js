/* ============================================================
   Supabase clients
   Two of them, on purpose:

   admin  - service-role key, bypasses row level security. Used for
            everything that moves money. Must never leave this process.
   asUser - anon key plus the caller's access token, so row level
            security applies. Used when reading a user's own data, which
            means a bug in a filter cannot leak another user's rows.
   ============================================================ */
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

/* A client with no session, for sign-up / sign-in / reset flows. */
export const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export function asUser(accessToken) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

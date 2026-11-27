/* Short passwords, down to a 4-digit PIN.

   Supabase will not store a password under 6 characters, so anything
   shorter than 8 is lengthened with a fixed suffix before it reaches
   Supabase. Customers only ever type the short form.

   Passwords of 8 or more go through unchanged, so every account made
   under the old rules (8+ characters) signs in exactly as before.

   PIN_SUFFIX must never change once accounts exist: every short
   password is stored with it, and a new suffix would lock them all out. */
const SUFFIX = process.env.PIN_SUFFIX || '~ts.pin.v1#Qe7';

export function authPassword(p) {
  const s = String(p);
  return s.length < 8 ? s + SUFFIX : s;
}

/* Sign in with a password as the customer typed it. A short password is
   tried lengthened first, then as typed, in case an older account was
   made with 6 or 7 characters before this existed. */
export async function signInPassword(client, email, password) {
  const first = await client.auth.signInWithPassword({ email, password: authPassword(password) });
  if (!first.error || String(password).length >= 8) return first;
  const second = await client.auth.signInWithPassword({ email, password: String(password) });
  return second.error ? first : second;
}
